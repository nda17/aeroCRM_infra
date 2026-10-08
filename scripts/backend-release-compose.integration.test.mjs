import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEffectiveConfig } from './backend-release-state.mjs';
import { messengerTempSql, withMessengerTemp } from './backend-storage-prisma-recovery.mjs';

const infraRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeSource = path.join(infraRoot, 'compose/backend.yml');
const apps = ['api-gateway', 'billing', 'operations'];
const roles = ['api-gateway', 'billing-api', 'billing-worker', 'operations-worker'];
const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const project = `aerocrm-selective-${process.pid}`;
let fixture;
let composeFile;
const variables = sha => ({ ...process.env, IMAGE_SHA: sha });
const run = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', ...options });

let dockerAvailable = false;
try { run(['info'], { stdio: 'ignore' }); dockerAvailable = true; } catch {}
const requireDocker = process.env.REQUIRE_DOCKER_COMPOSE_TEST === 'true';

const messengerMigrationSql = `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Keep the empty-history proof valid until the new CHECK is committed.
LOCK TABLE crm_access.crm_chat_attachments IN ACCESS EXCLUSIVE MODE;
LOCK TABLE crm_access.crm_team_command_receipts IN SHARE MODE;

-- Deparse the exact applied expression with this PostgreSQL version rather
-- than accepting a CHECK by name or relying on version-specific cast spelling.
CREATE TEMP TABLE messenger_storage_legacy_check (
 private_object_key varchar(200), workspace_id uuid, conversation_id uuid, id uuid,
 CONSTRAINT expected_legacy_key CHECK(private_object_key='chat/'||workspace_id::text||'/'||conversation_id::text||'/'||id::text)
) ON COMMIT DROP;

DO $$
DECLARE
 key_column smallint;
 key_check record;
 expected_definition text;
BEGIN
 IF EXISTS (SELECT 1 FROM crm_access.crm_chat_attachments) THEN
  RAISE EXCEPTION 'Messenger prefix migration requires empty attachment history, including DELETED rows';
 END IF;
 IF EXISTS (SELECT 1 FROM crm_access.crm_team_command_receipts WHERE command_type='chat.upload') THEN
  RAISE EXCEPTION 'Messenger prefix migration requires no chat.upload receipts';
 END IF;

 SELECT attnum INTO STRICT key_column FROM pg_attribute
 WHERE attrelid='crm_access.crm_chat_attachments'::regclass
  AND attname='private_object_key' AND NOT attisdropped;
 IF (SELECT count(*) FROM pg_constraint
     WHERE conrelid='crm_access.crm_chat_attachments'::regclass
      AND contype='c' AND key_column=ANY(conkey)) <> 1 THEN
  RAISE EXCEPTION 'Unexpected attachment object key CHECK inventory';
 END IF;
 SELECT conname, convalidated, connoinherit, pg_get_constraintdef(oid) AS definition
 INTO STRICT key_check FROM pg_constraint
 WHERE conrelid='crm_access.crm_chat_attachments'::regclass
  AND contype='c' AND key_column=ANY(conkey);
 SELECT pg_get_constraintdef(oid) INTO STRICT expected_definition
 FROM pg_constraint WHERE conrelid='pg_temp.messenger_storage_legacy_check'::regclass
  AND conname='expected_legacy_key';
 IF NOT key_check.convalidated OR key_check.connoinherit
    OR key_check.definition IS DISTINCT FROM expected_definition THEN
  RAISE EXCEPTION 'Attachment object key CHECK differs from the exact applied legacy contract';
 END IF;

 EXECUTE format('ALTER TABLE crm_access.crm_chat_attachments DROP CONSTRAINT %I', key_check.conname);
 EXECUTE format('ALTER TABLE crm_access.crm_chat_attachments ADD CONSTRAINT %I CHECK(private_object_key=''messenger/''||workspace_id::text||''/''||conversation_id::text||''/''||id::text)', key_check.conname);
END $$;
COMMIT;
`;
assert.equal(createHash('sha256').update(messengerMigrationSql).digest('hex'),
  '394f86ac5af5c20c2d6df6d84ac9220e7f40bc73af18e5b0d5781cb9285ef039',
  'embedded PostgreSQL fixture must remain byte-identical to immutable messenger migration SQL');

test('Docker Compose changes selected app process roles, retains other containers, repeats cleanly, and rolls back', {
  skip: dockerAvailable ? false : requireDocker ? false : 'Docker daemon is not available on this workstation'
}, t => {
  if (requireDocker) assert(dockerAvailable, 'CI requires a working Docker daemon for the Compose regression');
  fixture = mkdtempSync(path.join(tmpdir(), 'aerocrm-compose-regression-'));
  const composeDir = path.join(fixture, 'compose');
  composeFile = path.join(composeDir, 'backend.yml');
  t.after(() => {
    try { run(['compose', '-p', project, '-f', composeFile, 'down', '--remove-orphans'], { stdio: 'ignore' }); } catch {}
    try { run(['image', 'rm', ...apps.flatMap(app => [`aerocrm/${app}:${oldSha}`, `aerocrm/${app}:${newSha}`])], { stdio: 'ignore' }); } catch {}
    rmSync(fixture, { recursive: true, force: true });
  });

  mkdirSync(composeDir, { recursive: true });
  mkdirSync(path.join(fixture, 'env/backend'), { recursive: true });
  mkdirSync(path.join(fixture, 'secrets'), { recursive: true });
  writeFileSync(composeFile, readFileSync(composeSource));
  writeFileSync(path.join(composeDir, 'rabbitmq.conf'), '');
  writeFileSync(path.join(fixture, 'secrets/database-backup-provenance-private-key.pem'), 'test fixture only\n');
  const composeText = readFileSync(composeSource, 'utf8');
  for (const match of composeText.matchAll(/^\s+env_file:\s+\.\.\/env\/backend\/([^\s]+)$/gm)) {
    writeFileSync(path.join(fixture, 'env/backend', match[1]), 'SYNTHETIC_COMPOSE_TEST=true\n');
  }
  const dockerfile = path.join(fixture, 'Dockerfile');
  writeFileSync(dockerfile, [
    'FROM busybox:1.36',
    'ARG REVISION',
    'LABEL org.opencontainers.image.revision="$REVISION"',
    'ENTRYPOINT ["sh", "-c", "exec sleep 86400"]',
    ''
  ].join('\n'));
  for (const app of apps) for (const sha of [oldSha, newSha]) {
    run(['build', '--build-arg', `REVISION=${sha}`, '--tag', `aerocrm/${app}:${sha}`,
      '--file', dockerfile, fixture], { stdio: 'inherit' });
  }

  // Production receives saved artifacts, so provenance binds the imported image ID.
  const tags = apps.flatMap(app => [`aerocrm/${app}:${oldSha}`, `aerocrm/${app}:${newSha}`]);
  const archive = path.join(fixture, 'backend-images.tar');
  run(['image', 'save', '--output', archive, ...tags], { stdio: 'inherit' });
  run(['image', 'rm', ...tags], { stdio: 'inherit' });
  run(['image', 'load', '--input', archive], { stdio: 'inherit' });
  const importedIds = Object.fromEntries(tags.map(tag => {
    const id = JSON.parse(run(['image', 'inspect', tag]))[0].Id;
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    return [tag, id];
  }));
  run(['image', 'rm', ...tags], { stdio: 'inherit' });
  run(['image', 'load', '--input', archive], { stdio: 'inherit' });
  for (const tag of tags) assert.equal(JSON.parse(run(['image', 'inspect', tag]))[0].Id, importedIds[tag],
    `re-importing the same artifact must preserve its immutable image identity: ${tag}`);

  const compose = (env, action) => run(['compose', '-p', project, '-f', composeFile, ...action], {
    env: { ...variables(newSha), ...env }, stdio: 'pipe'
  });
  const snapshot = () => Object.fromEntries(roles.map(role => {
    const id = compose({}, ['ps', '-q', role]).trim();
    assert.match(id, /^[a-f0-9]{64}$/, `Compose did not report a running ${role} container`);
    const container = JSON.parse(run(['inspect', id]))[0];
    const loaded = JSON.parse(run(['image', 'inspect', container.Config.Image]))[0];
    assert.equal(loaded.Id, importedIds[container.Config.Image], 'Runtime tag must resolve to its imported artifact identity');
    assert.equal(container.Image, loaded.Id, 'Running container and imported image inspect IDs must match exactly');
    assert.equal(loaded.Config.Labels['org.opencontainers.image.revision'], container.Config.Image.split(':').at(-1));
    return [role, { id, image: container.Config.Image, imageId: container.Image,
      running: container.State.Running, inspection: container }];
  }));

  const assertSnapshotEffectiveConfig = (env, containers, name) => {
    const stored = path.join(fixture, 'releases/backend-configs', name);
    mkdirSync(path.join(stored, 'compose'), { recursive: true });
    mkdirSync(path.join(stored, 'env/backend'), { recursive: true });
    for (const file of readdirSync(path.join(fixture, 'env/backend')))
      writeFileSync(path.join(stored, 'env/backend', file), readFileSync(path.join(fixture, 'env/backend', file)));
    // Mirror the controller: private snapshot env, stable live bind sources.
    const rendered = composeText.replaceAll('./rabbitmq.conf:', `${composeDir}/rabbitmq.conf:`)
      .replaceAll('../secrets/', `${fixture}/secrets/`);
    const expected = path.join(stored, 'compose/effective-check.yml');
    writeFileSync(expected, rendered);
    const plan = JSON.parse(run(['compose', '-p', project, '-f', expected, 'config', '--format', 'json'],
      { env: { ...variables(newSha), ...env }, stdio: 'pipe' }));
    for (const role of roles) {
      const imageConfig = JSON.parse(run(['image', 'inspect', containers[role].imageId]))[0].Config;
      assertEffectiveConfig(plan.services[role], imageConfig, containers[role].inspection, role);
      const drifted = structuredClone(containers[role].inspection);
      drifted.Config.Env.push('UNREVIEWED_CONFIG_DRIFT=1');
      assert.throws(() => assertEffectiveConfig(plan.services[role], imageConfig, drifted, role), /environment drift/);
    }
  };

  const unchanged = { API_GATEWAY_IMAGE_SHA: oldSha, OPERATIONS_IMAGE_SHA: oldSha };
  compose({ ...unchanged, BILLING_IMAGE_SHA: oldSha }, ['up', '-d', ...roles]);
  const baseline = snapshot();
  assertSnapshotEffectiveConfig({ ...unchanged, BILLING_IMAGE_SHA: oldSha }, baseline, 'baseline');
  assert(roles.every(role => baseline[role].running));
  assert.equal(baseline['api-gateway'].image, `aerocrm/api-gateway:${oldSha}`);
  assert.equal(baseline['billing-api'].image, `aerocrm/billing:${oldSha}`);
  assert.equal(baseline['billing-worker'].image, `aerocrm/billing:${oldSha}`);
  const workerMounts = JSON.parse(run(['inspect', baseline['operations-worker'].id]))[0].Mounts;
  assert(workerMounts.some(mount => mount.Source === path.join(fixture,
    'secrets/database-backup-provenance-private-key.pem') &&
    mount.Destination === '/run/secrets/database-backup-provenance-private-key-source' && !mount.RW),
  'operations-worker must retain its stable read-only provenance-key mount');

  compose({ ...unchanged, BILLING_IMAGE_SHA: newSha }, ['up', '-d', ...roles]);
  const released = snapshot();
  assertSnapshotEffectiveConfig({ ...unchanged, BILLING_IMAGE_SHA: newSha }, released, 'released');
  assert.equal(released['api-gateway'].id, baseline['api-gateway'].id,
    'unchanged service must keep its existing container');
  assert.equal(released['operations-worker'].id, baseline['operations-worker'].id,
    'unchanged operations worker must keep its stable container and bind mount');
  for (const role of ['billing-api', 'billing-worker']) {
    assert.notEqual(released[role].id, baseline[role].id, `${role} must be recreated with the changed image`);
    assert.equal(released[role].image, `aerocrm/billing:${newSha}`);
    assert.equal(released[role].imageId, released['billing-api'].imageId,
      'process roles from one app must run the same immutable image');
  }

  compose({ ...unchanged, BILLING_IMAGE_SHA: newSha }, ['up', '-d', ...roles]);
  const repeated = snapshot();
  assertSnapshotEffectiveConfig({ ...unchanged, BILLING_IMAGE_SHA: newSha }, repeated, 'same-content-different-snapshot-directory');
  for (const role of roles) assert.equal(repeated[role].id, released[role].id,
    `repeating the same desired manifest must keep ${role} container`);

  compose({ ...unchanged, BILLING_IMAGE_SHA: oldSha }, ['up', '-d', ...roles]);
  const rolledBack = snapshot();
  assertSnapshotEffectiveConfig({ ...unchanged, BILLING_IMAGE_SHA: oldSha }, rolledBack, 'rollback');
  assert.equal(rolledBack['api-gateway'].id, released['api-gateway'].id,
    'rollback must preserve the unaffected service container');
  assert.equal(rolledBack['operations-worker'].id, released['operations-worker'].id,
    'rollback must preserve the unaffected operations worker container');
  for (const role of ['billing-api', 'billing-worker']) {
    assert.notEqual(rolledBack[role].id, released[role].id, `${role} must be recreated during rollback`);
    assert.equal(rolledBack[role].image, `aerocrm/billing:${oldSha}`);
    assert.equal(rolledBack[role].imageId, baseline[role].imageId);
  }
});

test('PostgreSQL 18 requires narrowly scoped TEMP for the migration role and restores ACLs after failure and success', {
  skip: dockerAvailable ? false : requireDocker ? false : 'Docker daemon is not available on this workstation'
}, t => {
  if (requireDocker) assert(dockerAvailable, 'CI requires PostgreSQL 18 Docker for the storage migration privilege regression');
  const name = `aerocrm-storage-prisma-${process.pid}-${randomUUID().slice(0, 8)}`;
  let containerStarted = false;
  t.after(() => {
    if (containerStarted) { try { run(['rm', '--force', name], { stdio: 'ignore' }); } catch {} }
  });
  try { run(['image', 'inspect', 'postgres:18'], { stdio: 'ignore' }); }
  catch { run(['pull', 'postgres:18'], { stdio: 'inherit' }); }
  run(['run', '--detach', '--name', name, '--network', 'none', '--env', 'POSTGRES_PASSWORD=fixture-only',
    '--env', 'POSTGRES_DB=aerocrm_crm_access', 'postgres:18'], { stdio: 'pipe' });
  containerStarted = true;
  const psql = (user, sql) => run(['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', user, '-d', 'aerocrm_crm_access'], { input: sql });
  const psqlAdmin = sql => psql('postgres', sql);
  const runMigration = () => run(['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'aerocrm_crm_access_migration', '-d', 'aerocrm_crm_access'], { input: messengerMigrationSql });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { run(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'aerocrm_crm_access'], { stdio: 'ignore' }); break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
  assert(Date.now() < deadline, 'PostgreSQL 18 fixture did not become ready');
  psqlAdmin(`CREATE ROLE aerocrm_crm_access_db_owner LOGIN;
CREATE ROLE aerocrm_crm_access_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE aerocrm_crm_access_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE aerocrm_crm_access_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER DATABASE aerocrm_crm_access OWNER TO aerocrm_crm_access_db_owner;
REVOKE TEMPORARY ON DATABASE aerocrm_crm_access FROM PUBLIC, aerocrm_crm_access_migration,
  aerocrm_crm_access_runtime, aerocrm_crm_access_backup;
GRANT CONNECT ON DATABASE aerocrm_crm_access TO aerocrm_crm_access_migration,
  aerocrm_crm_access_runtime, aerocrm_crm_access_backup;
CREATE SCHEMA crm_access AUTHORIZATION aerocrm_crm_access_migration;`);
  psql('aerocrm_crm_access_migration', `CREATE TABLE crm_access.crm_chat_attachments (
  id uuid NOT NULL, workspace_id uuid NOT NULL, conversation_id uuid NOT NULL,
  private_object_key varchar(200) NOT NULL,
  CONSTRAINT crm_chat_attachments_private_object_key_check CHECK(private_object_key='chat/'||workspace_id::text||'/'||conversation_id::text||'/'||id::text),
  state varchar(16) NOT NULL
);
CREATE TABLE crm_access.crm_team_command_receipts (command_type varchar(64) NOT NULL);`);
  const snapshot = () => JSON.parse(psqlAdmin(`SELECT json_build_object(
    'effectiveTemp', json_build_object(
      'migration',has_database_privilege('aerocrm_crm_access_migration',current_database(),'TEMP'),
      'runtime',has_database_privilege('aerocrm_crm_access_runtime',current_database(),'TEMP'),
      'backup',has_database_privilege('aerocrm_crm_access_backup',current_database(),'TEMP')),
    'acl',(SELECT COALESCE(json_agg(json_build_array(grantee,privilege_type,is_grantable)
      ORDER BY grantee,privilege_type),'[]'::json) FROM aclexplode(
      (SELECT datacl FROM pg_database WHERE datname=current_database()))
      WHERE grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_access_migration'),
        (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_access_runtime'),
        (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_access_backup')))
    )::text;`));
  const schemaState = () => JSON.parse(psqlAdmin(`SELECT json_build_object(
    'legacyCheck',EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='crm_access.crm_chat_attachments'::regclass
      AND conname='crm_chat_attachments_private_object_key_check'
      AND pg_get_constraintdef(oid) LIKE '%chat/%'),
    'legacyDefinition',(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='crm_access.crm_chat_attachments'::regclass
      AND conname='crm_chat_attachments_private_object_key_check' AND pg_get_constraintdef(oid) LIKE '%chat/%'),
    'messengerCheck',EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='crm_access.crm_chat_attachments'::regclass
      AND conname='crm_chat_attachments_private_object_key_check'
      AND pg_get_constraintdef(oid) LIKE '%messenger/%'),
    'attachments',(SELECT count(*) FROM crm_access.crm_chat_attachments),
    'uploadReceipts',(SELECT count(*) FROM crm_access.crm_team_command_receipts WHERE command_type='chat.upload'))::text;`));
  const before = snapshot();
  assert.deepEqual(before.effectiveTemp, { migration: false, runtime: false, backup: false });
  assert.equal(before.acl.some(([grantee, privilege]) => grantee === 0 && privilege === 'TEMPORARY'), false,
    'PUBLIC must not confer TEMP to the migration role');
  const migrationRole = JSON.parse(psqlAdmin(`SELECT json_build_object('databaseOwner',pg_get_userbyid(d.datdba)='aerocrm_crm_access_db_owner',
    'schemaOwner',pg_get_userbyid(n.nspowner)='aerocrm_crm_access_migration',
    'schemaCreate',has_schema_privilege('aerocrm_crm_access_migration','crm_access','CREATE'),
    'databaseCreate',has_database_privilege('aerocrm_crm_access_migration',current_database(),'CREATE'),
    'superuser',r.rolsuper,'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,'inherit',r.rolinherit)
    FROM pg_database d JOIN pg_roles r ON r.rolname='aerocrm_crm_access_migration'
    JOIN pg_namespace n ON n.nspname='crm_access' WHERE d.datname=current_database();`));
  assert.deepEqual(migrationRole, { databaseOwner: true, schemaOwner: true, schemaCreate: true,
    databaseCreate: false, superuser: false, createdb: false, createrole: false, inherit: false });
  const preGrant = schemaState();
  assert.equal(createHash('sha256').update(preGrant.legacyDefinition).digest('hex'),
    'b9bffbc5b27a8529aa74bdc2049ab6484cf5b53611b52beac718f1104a1b9afa',
    'PostgreSQL 18 fixture must start from the exact audited legacy CHECK');
  assert.throws(runMigration, error => /permission denied to create temporary tables/i.test(String(error.stderr)));
  assert.deepEqual(schemaState(), preGrant, 'TEMP-denied migration must roll back without changing history or the old CHECK');
  assert.deepEqual(snapshot(), before, 'failed TEMP-denied attempt must not alter database ACLs');

  psqlAdmin("INSERT INTO crm_access.crm_team_command_receipts(command_type) VALUES ('chat.upload');");
  assert.throws(() => withMessengerTemp({ grant: () => psqlAdmin(messengerTempSql(true)), run: runMigration,
    revoke: () => psqlAdmin(messengerTempSql(false)),
    verifyRevoked: () => assert.equal(snapshot().effectiveTemp.migration, false) }),
  error => /requires no chat\.upload receipts/i.test(String(error.stderr)));
  assert.deepEqual(snapshot(), before, 'migration failure must restore migration TEMP and preserve PUBLIC/runtime/backup ACLs');
  const failedGuard = schemaState();
  assert.equal(failedGuard.legacyCheck, true);
  assert.equal(failedGuard.messengerCheck, false);
  assert.equal(failedGuard.attachments, 0);
  assert.equal(failedGuard.uploadReceipts, 1);
  psqlAdmin("DELETE FROM crm_access.crm_team_command_receipts WHERE command_type='chat.upload';");

  withMessengerTemp({ grant: () => psqlAdmin(messengerTempSql(true)), run: runMigration,
    revoke: () => psqlAdmin(messengerTempSql(false)),
    verifyRevoked: () => assert.equal(snapshot().effectiveTemp.migration, false) });
  const migrated = schemaState();
  assert.equal(migrated.legacyCheck, false);
  assert.equal(migrated.messengerCheck, true);
  assert.equal(migrated.attachments, 0);
  assert.equal(migrated.uploadReceipts, 0);
  assert.deepEqual(snapshot(), before, 'successful migration must leave TEMP and all other database ACLs at baseline');
});
