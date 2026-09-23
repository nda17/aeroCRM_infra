#!/usr/bin/env node
// Target host only, under release.lock. The repair mode runs before a closure-enabled image switch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const owners = ['billing', 'crm-access', 'crm-customers', 'crm-intake', 'crm-sales', 'identity', 'notification-delivery'];
const migrationName = '20260923030000_workspace_closure';
const resolvedCrmAccessBaselineAttempt = Object.freeze({
  migration_name: '20260920000000_init_aerocrm',
  checksum: '2a7fdd85882cc55b6893d2024f920788c1ea03e1d8497ad218770558ebce0793',
  started_at_utc: '2026-09-19T22:05:46.748634Z',
  finished_at_utc: null,
  rolled_back_at_utc: '2026-09-19T22:07:20.080831Z',
  applied_steps_count: 0
});
const inventory = JSON.parse(fs.readFileSync(new URL('./workspace-closure-reviewed-inventory.json', import.meta.url)));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const literal = value => `'${value.replaceAll("'", "''")}'`;
const ident = value => {
  assert(/^[a-z_]+$/.test(value), 'Invalid database identifier');
  return `"${value}"`;
};
function run(label, executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024, ...options
    }).trim();
  } catch {
    throw new Error(`${label} failed; private command output suppressed`);
  }
}
function privateIdentity(service) {
  const schema = service.replaceAll('-', '_');
  const file = `/opt/aerocrm/env/migrations/${service}.env`;
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    fs.realpathSync(file) === file, `Private migration env must be regular mode 0600: ${service}`);
  const bytes = fs.readFileSync(file);
  let values;
  try { values = parseEnv(bytes.toString('utf8')); }
  catch { throw new Error(`Invalid private migration env: ${service}`); }
  const key = `${schema.toUpperCase()}_DATABASE_URL`;
  assert.deepEqual(Object.keys(values).sort(), [key, 'NODE_ENV'].sort(), `Unexpected migration env fields: ${service}`);
  assert.equal(values.NODE_ENV, 'production', `Production migration mode required: ${service}`);
  let url;
  try { url = new URL(values[key]); }
  catch { throw new Error(`Invalid migration URL: ${service}`); }
  assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' &&
    (!url.port || url.port === '5432') && url.pathname === `/aerocrm_${schema}` &&
    decodeURIComponent(url.username) === `aerocrm_${schema}_migration` && !!url.password &&
    !url.hash && Object.entries({ schema, connection_limit: '1', pool_timeout: '10', connect_timeout: '10' })
      .every(([name, value]) => url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === value) &&
    [...url.searchParams.keys()].length === 4, `Unexpected database identity: ${service}`);
  return { service, schema, database: `aerocrm_${schema}`, role: `aerocrm_${schema}_migration`,
    runtime: `aerocrm_${schema}_runtime`, backup: `aerocrm_${schema}_backup`,
    password: decodeURIComponent(url.password), values, bytes };
}
function inspect(owner, query) {
  return JSON.parse(run(`${owner.service} database inspection`, 'docker', [
    'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD', '--entrypoint', 'psql',
    'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
    '-p', '5432', '-U', owner.role, '-d', owner.database, '-c', query
  ], { env: { ...process.env, PGPASSWORD: owner.password } }));
}
function sql(owner, query) {
  run(`${owner.service} closure ACL`, 'docker', [
    'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD', '--entrypoint', 'psql',
    'postgres:18', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
    '-p', '5432', '-U', owner.role, '-d', owner.database, '-c', query
  ], { env: { ...process.env, PGPASSWORD: owner.password } });
}
function migrationRows(owner) {
  return inspect(owner, `SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.migration_name, m.started_at_utc), '[]'::json)::text
    FROM (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
      rolled_back_at IS NOT NULL AS rolled_back,
      to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at_utc,
      to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at_utc,
      to_char(rolled_back_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS rolled_back_at_utc,
      applied_steps_count FROM ${ident(owner.schema)}._prisma_migrations) m;`);
}
function isResolvedCrmAccessBaselineAttempt(owner, row) {
  return owner.service === 'crm-access' &&
    Object.entries(resolvedCrmAccessBaselineAttempt).every(([key, value]) => row[key] === value);
}
function verifyRows(owner, rows, complete) {
  const resolved = rows.filter(row => isResolvedCrmAccessBaselineAttempt(owner, row));
  assert(resolved.length <= 1, 'Unexpected duplicate resolved CRM Access baseline attempt');
  const active = rows.filter(row => !isResolvedCrmAccessBaselineAttempt(owner, row));
  const expected = Object.entries(inventory.owners[owner.service].migrations);
  const allowed = complete ? expected : expected.slice(0, -1);
  assert.deepEqual(active.map(row => row.migration_name), allowed.map(([name]) => name),
    `Unexpected migration history: ${owner.service}`);
  for (const [index, row] of active.entries()) {
    assert.equal(row.checksum, allowed[index][1], `Migration checksum mismatch: ${owner.service}/${row.migration_name}`);
    assert(row.finished === true && row.rolled_back === false, `Incomplete migration: ${owner.service}/${row.migration_name}`);
  }
}
function imageInventory(owner, sha) {
  const image = `aerocrm/${owner.service}:${sha}`;
  const revision = run(`${owner.service} image revision`, 'docker', ['image', 'inspect',
    '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image]);
  assert.equal(revision, sha, `Image revision mismatch: ${owner.service}`);
  const observed = JSON.parse(run(`${owner.service} image inventory`, 'docker', [
    'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
    `const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma';
     const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
     console.log(JSON.stringify({migrations:Object.fromEntries(fs.readdirSync(root+'/migrations',{withFileTypes:true})
       .filter(x=>x.isDirectory()).map(x=>[x.name,hash(fs.readFileSync(root+'/migrations/'+x.name+'/migration.sql'))])),
       aclSha256:hash(fs.readFileSync(root+'/database-access.json')),
       acl:JSON.parse(fs.readFileSync(root+'/database-access.json','utf8'))}));`
  ]));
  assert.deepEqual(observed.migrations, inventory.owners[owner.service].migrations,
    `Reviewed migration inventory differs: ${owner.service}`);
  assert.equal(observed.aclSha256, inventory.owners[owner.service].aclSha256,
    `Reviewed ACL inventory differs: ${owner.service}`);
  assert.equal(observed.acl.version, 1);
  assert.equal(observed.acl.service, owner.service);
  assert.deepEqual(observed.acl.tables.workspace_closure_fences, ['SELECT', 'INSERT', 'UPDATE']);
  assert(observed.acl.routines.includes('assert_workspace_open'));
  return observed.acl;
}
function applyClosureAcl(owner, acl) {
  const newTables = owner.service === 'crm-access'
    ? ['workspace_closure_fences', 'crm_workspace_closures'] : ['workspace_closure_fences'];
  const statements = ['BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='30s';"];
  for (const table of newTables) {
    const permissions = acl.tables[table];
    assert.deepEqual(permissions, ['SELECT', 'INSERT', 'UPDATE'], `Unexpected closure ACL: ${owner.service}/${table}`);
    const relation = `${ident(owner.schema)}.${ident(table)}`;
    statements.push(`REVOKE ALL ON TABLE ${relation} FROM PUBLIC, ${ident(owner.runtime)}, ${ident(owner.backup)};`);
    statements.push(`GRANT ${permissions.join(', ')} ON TABLE ${relation} TO ${ident(owner.runtime)};`);
    statements.push(`GRANT SELECT ON TABLE ${relation} TO ${ident(owner.backup)};`);
  }
  const allClosureRoutines = inventory.owners[owner.service].closureRoutines;
  assert(allClosureRoutines.length >= 2 && allClosureRoutines.every(signature =>
    /^[a-z_]+\((?:uuid)?\)$/.test(signature) && acl.routines.includes(signature.split('(')[0])),
  `Closure routines missing: ${owner.service}`);
  for (const routine of allClosureRoutines) {
    const [name, args] = routine.split('(');
    const signature = `${ident(owner.schema)}.${ident(name)}(${args.slice(0, -1)})`;
    statements.push(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, ${ident(owner.runtime)}, ${ident(owner.backup)};`);
    if ((acl.routineExecute || []).includes(routine))
      statements.push(`GRANT EXECUTE ON FUNCTION ${signature} TO ${ident(owner.runtime)};`);
  }
  statements.push('COMMIT;');
  sql(owner, statements.join('\n'));
  const state = inspect(owner, `SELECT json_build_object(
    'schemaOwner', (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=${literal(owner.schema)}),
    'tables', (SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.name), '[]'::json) FROM
      (SELECT c.relname AS name, has_table_privilege(${literal(owner.runtime)},c.oid,'SELECT') AS runtime_select,
        has_table_privilege(${literal(owner.runtime)},c.oid,'INSERT') AS runtime_insert,
        has_table_privilege(${literal(owner.runtime)},c.oid,'UPDATE') AS runtime_update,
        has_table_privilege(${literal(owner.runtime)},c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS runtime_forbidden,
        has_table_privilege(${literal(owner.backup)},c.oid,'SELECT') AS backup_select,
        has_table_privilege(${literal(owner.backup)},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS backup_forbidden
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=${literal(owner.schema)} AND c.relname IN (${newTables.map(literal).join(',')})) t),
    'routines', (SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.name), '[]'::json) FROM
      (SELECT p.proname AS name, has_function_privilege(${literal(owner.runtime)},p.oid,'EXECUTE') AS runtime_execute,
        has_function_privilege(${literal(owner.backup)},p.oid,'EXECUTE') AS backup_execute,
        EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname=${literal(owner.schema)} AND p.proname IN (${allClosureRoutines.map(r => literal(r.split('(')[0])).join(',')})) r),
    'triggers', (SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.table_name,t.name), '[]'::json) FROM
      (SELECT c.relname AS table_name, tg.tgname AS name, tg.tgenabled AS enabled,
        p.proname AS routine FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=tg.tgfoid
       WHERE n.nspname=${literal(owner.schema)} AND NOT tg.tgisinternal
         AND (tg.tgname LIKE '%workspace_closure%' OR tg.tgname LIKE 'guard_crm_dispatch_scope' OR tg.tgname LIKE 'guard_acceptance_%')) t)
  )::text;`);
  assert.equal(state.schemaOwner, owner.role, `Schema owner mismatch: ${owner.service}`);
  assert.equal(state.tables.length, newTables.length, `Closure table inventory mismatch: ${owner.service}`);
  for (const table of state.tables) assert(table.runtime_select && table.runtime_insert && table.runtime_update &&
    !table.runtime_forbidden && table.backup_select && !table.backup_forbidden,
  `Closure table privilege mismatch: ${owner.service}/${table.name}`);
  assert.equal(state.routines.length, allClosureRoutines.length, `Closure routine inventory mismatch: ${owner.service}`);
  for (const routine of state.routines) assert(routine.runtime_execute ===
    (acl.routineExecute || []).includes(`${routine.name}(uuid)`) &&
    !routine.backup_execute && !routine.public_execute,
  `Closure routine privilege mismatch: ${owner.service}/${routine.name}`);
  assert(state.triggers.length === inventory.owners[owner.service].closureTriggerCount &&
    state.triggers.every(trigger => trigger.enabled === 'O'),
    `Closure triggers missing or disabled: ${owner.service}`);
}

function repairIdentityWorkspaceAcl(sha, expectedIdentityEnvHash, deps = {}) {
  assert.equal(inventory.schemaVersion, 1, 'Reviewed closure inventory version differs');
  assert(/^[a-f0-9]{40}$/.test(sha) && /^[a-f0-9]{64}$/.test(expectedIdentityEnvHash),
    'Exact SHA and Identity migration env hash required');
  const owner = (deps.privateIdentity || privateIdentity)('identity');
  assert.equal(sha256(owner.bytes), expectedIdentityEnvHash, 'Identity migration env hash mismatch');
  const acl = (deps.imageInventory || imageInventory)(owner, sha);
  (deps.verifyRows || verifyRows)(owner, (deps.migrationRows || migrationRows)(owner), true);
  assert.deepEqual(acl.tables.workspaces, ['SELECT', 'INSERT', 'UPDATE'],
    'Reviewed Identity workspace ACL differs');
  assert(!acl.columnPrivileges?.workspaces, 'Unexpected Identity workspace column grants');
  const stateQuery = `SELECT json_build_object(
    'schemaOwner', (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='identity'),
    'tableOwner', (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='identity' AND c.relname='workspaces' AND c.relkind='r'),
    'closureTriggers', (SELECT COUNT(*)=3 FROM pg_trigger tg
      JOIN pg_class c ON c.oid=tg.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=tg.tgfoid
      WHERE n.nspname='identity' AND tg.tgenabled='O' AND p.prosecdef AND
        ((c.relname='workspaces' AND tg.tgname='workspace_closure_reactivation_guard' AND
            p.proname='guard_workspace_reactivation') OR
         (c.relname='workspace_members' AND tg.tgname='workspace_closure_member_guard' AND
            p.proname='guard_workspace_admission') OR
         (c.relname='workspace_invitations' AND tg.tgname='workspace_closure_invitation_guard' AND
            p.proname='guard_workspace_admission')) AND
        pg_get_userbyid(p.proowner)='aerocrm_identity_migration'),
    'runtimeSelect', has_table_privilege('aerocrm_identity_runtime','identity.workspaces','SELECT'),
    'runtimeInsert', has_table_privilege('aerocrm_identity_runtime','identity.workspaces','INSERT'),
    'runtimeUpdate', has_table_privilege('aerocrm_identity_runtime','identity.workspaces','UPDATE'),
    'runtimeForbidden', has_table_privilege('aerocrm_identity_runtime','identity.workspaces',
      'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
    'publicPrivileges', EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE n.nspname='identity' AND c.relname='workspaces' AND a.grantee=0),
    'backupSelect', has_table_privilege('aerocrm_identity_backup','identity.workspaces','SELECT'),
    'backupForbidden', has_table_privilege('aerocrm_identity_backup','identity.workspaces',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))::text;`;
  const before = (deps.inspect || inspect)(owner, stateQuery);
  assert(before.schemaOwner === owner.role && before.tableOwner === owner.role &&
    before.closureTriggers === true &&
    before.runtimeSelect === true && before.runtimeInsert === true &&
    before.runtimeForbidden === false && before.publicPrivileges === false &&
    before.backupSelect === true &&
    before.backupForbidden === false, 'Identity workspace ACL baseline differs');
  (deps.sql || sql)(owner, `BEGIN;
    SET LOCAL lock_timeout='5s';
    SET LOCAL statement_timeout='30s';
    DO $guard$ BEGIN
      IF current_database() <> 'aerocrm_identity' OR current_user <> 'aerocrm_identity_migration'
        OR (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='identity' AND c.relname='workspaces' AND c.relkind='r') <> current_user
      THEN RAISE EXCEPTION 'Identity workspace ACL target changed'; END IF;
    END $guard$;
    GRANT UPDATE ON TABLE identity.workspaces TO aerocrm_identity_runtime;
    DO $verify$ BEGIN
      IF NOT has_table_privilege('aerocrm_identity_runtime','identity.workspaces','UPDATE')
      THEN RAISE EXCEPTION 'Identity workspace UPDATE grant failed'; END IF;
    END $verify$;
    COMMIT;`);
  const after = (deps.inspect || inspect)(owner, stateQuery);
  assert.deepEqual(after, { ...before, runtimeUpdate: true },
    'Identity workspace ACL repair postflight differs');
  return true;
}

if (process.argv.length === 3 && process.argv[2] === '--policy-self-test') {
  assert.equal(inventory.schemaVersion, 1);
  assert.deepEqual(Object.keys(inventory.owners).sort(), owners);
  for (const service of owners) {
    const migrations = Object.entries(inventory.owners[service].migrations);
    assert.equal(migrations.at(-1)[0], migrationName);
    assert(migrations.every(([, hash]) => /^[a-f0-9]{64}$/.test(hash)));
    assert(/^[a-f0-9]{64}$/.test(inventory.owners[service].aclSha256));
    assert(inventory.owners[service].closureRoutines.length >= 2);
    assert(inventory.owners[service].closureTriggerCount >= 2);
    const owner = { service };
    const rows = migrations.map(([migration_name, checksum]) => ({ migration_name, checksum, finished: true, rolled_back: false }));
    verifyRows(owner, rows, true);
    verifyRows(owner, rows.slice(0, -1), false);
    assert.throws(() => verifyRows(owner, [{ ...rows[0], checksum: '0'.repeat(64) }], false));
    assert.throws(() => verifyRows(owner, [{ ...rows[0], finished: false, rolled_back: true }, ...rows.slice(1)], true));
    if (service === 'crm-access') {
      verifyRows(owner, [resolvedCrmAccessBaselineAttempt, ...rows], true);
      verifyRows(owner, [resolvedCrmAccessBaselineAttempt, ...rows.slice(0, -1)], false);
      assert.throws(() => verifyRows(owner, [resolvedCrmAccessBaselineAttempt, resolvedCrmAccessBaselineAttempt, ...rows], true),
        /Unexpected duplicate resolved CRM Access baseline attempt/);
      for (const changed of [
        { checksum: '0'.repeat(64) },
        { started_at_utc: '2026-09-19T22:05:46.748635Z' },
        { rolled_back_at_utc: null },
        { applied_steps_count: 1 }
      ])
        assert.throws(() => verifyRows(owner, [{ ...resolvedCrmAccessBaselineAttempt, ...changed }, ...rows], true),
          /Unexpected migration history/);
    } else {
      assert.throws(() => verifyRows(owner, [resolvedCrmAccessBaselineAttempt, ...rows], true),
        /Unexpected migration history/);
    }
  }
  const fixtureBytes = Buffer.from('identity-closure-acl-policy');
  const fixtureSha = 'a'.repeat(40);
  const fixtureHash = sha256(fixtureBytes);
  const fixtureRows = Object.entries(inventory.owners.identity.migrations).map(([migration_name, checksum]) =>
    ({ migration_name, checksum, finished: true, rolled_back: false }));
  const fixtureState = { schemaOwner: 'aerocrm_identity_migration',
    tableOwner: 'aerocrm_identity_migration', closureTriggers: true,
    runtimeSelect: true, runtimeInsert: true, runtimeUpdate: false,
    runtimeForbidden: false, publicPrivileges: false,
    backupSelect: true, backupForbidden: false };
  function repairFixture(changes = {}) {
    const statements = [];
    let reads = 0;
    const options = {
      privateIdentity: () => ({ service: 'identity', role: 'aerocrm_identity_migration', bytes: fixtureBytes }),
      imageInventory: () => changes.acl || { tables: { workspaces: ['SELECT', 'INSERT', 'UPDATE'] } },
      migrationRows: () => changes.rows || fixtureRows,
      inspect: () => reads++ === 0 ? (changes.state || fixtureState) :
        { ...(changes.state || fixtureState), runtimeUpdate: true },
      sql: (_owner, statement) => statements.push(statement)
    };
    return { options, statements };
  }
  const first = repairFixture();
  assert(repairIdentityWorkspaceAcl(fixtureSha, fixtureHash, first.options));
  assert.equal(first.statements.length, 1);
  assert.equal((first.statements[0].match(/\bGRANT\b/g) || []).length, 1);
  assert(first.statements[0].includes('GRANT UPDATE ON TABLE identity.workspaces TO aerocrm_identity_runtime'));
  assert(!/\b(?:CREATE|ALTER|DROP|REVOKE)\b/.test(first.statements[0]));
  const repeated = repairFixture({ state: { ...fixtureState, runtimeUpdate: true } });
  assert(repairIdentityWorkspaceAcl(fixtureSha, fixtureHash, repeated.options));
  assert.equal(repeated.statements.length, 1);
  for (const [hash, changes] of [
    ['0'.repeat(64), {}],
    [fixtureHash, { acl: { tables: { workspaces: ['SELECT', 'INSERT'] } } }],
    [fixtureHash, { rows: fixtureRows.slice(0, -1) }],
    [fixtureHash, { state: { ...fixtureState, closureTriggers: false } }],
    [fixtureHash, { state: { ...fixtureState, publicPrivileges: true } }]
  ]) {
    const fixture = repairFixture(changes);
    assert.throws(() => repairIdentityWorkspaceAcl(fixtureSha, hash, fixture.options));
    assert.equal(fixture.statements.length, 0);
  }
  console.log('Workspace closure migration policy fixtures verified');
  process.exit(0);
}

assert.equal(process.platform, 'linux', 'Closure migration must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
if (process.argv[2] === '--repair-identity-workspace-acl') {
  assert.equal(process.argv.length, 5, 'Expected exact SHA and Identity migration env hash');
  repairIdentityWorkspaceAcl(...process.argv.slice(3));
  console.log('Identity workspace runtime UPDATE ACL verified');
  process.exit(0);
}
assert.equal(process.argv.length, 4, 'Expected exact SHA and seven-env aggregate hash');
const [sha, expectedEnvHash] = process.argv.slice(2);
assert(/^[a-f0-9]{40}$/.test(sha) && /^[a-f0-9]{64}$/.test(expectedEnvHash), 'Exact SHA and private aggregate hash required');
assert.equal(inventory.schemaVersion, 1);
assert.deepEqual(Object.keys(inventory.owners).sort(), owners);
const identities = owners.map(privateIdentity);
const envLines = identities.map(owner => `${sha256(owner.bytes)}  ./${owner.service}.env\n`).join('');
assert.equal(sha256(envLines), expectedEnvHash, 'Private closure migration env aggregate hash mismatch');
for (const owner of identities) {
  const acl = imageInventory(owner, sha);
  const before = migrationRows(owner);
  const complete = before.some(row => row.migration_name === migrationName);
  verifyRows(owner, before, complete);
  if (!complete) {
    run(`${owner.service} Prisma migration`, 'docker', [
      'run', '--rm', '--network', 'host', '--env', 'NODE_ENV', '--env', `${owner.schema.toUpperCase()}_DATABASE_URL`,
      '--entrypoint', 'node', `aerocrm/${owner.service}:${sha}`,
      'node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'
    ], { env: { ...process.env, ...owner.values } });
  }
  verifyRows(owner, migrationRows(owner), true);
  applyClosureAcl(owner, acl);
  console.log(`Closure migration and ACL verified: ${owner.service}`);
}
