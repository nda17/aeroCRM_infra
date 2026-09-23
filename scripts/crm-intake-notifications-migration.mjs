#!/usr/bin/env node
// Target host only. Run under release.lock before switching compatible backend images.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const [sha, expectedEnvHash] = process.argv.slice(2);
const image = `aerocrm/crm-intake:${sha}`;
const envFile = '/opt/aerocrm/env/migrations/crm-intake.env';
const baseline = '20260920000000_init_aerocrm';
const notificationDefault = '20260923020000_inbox_notification_id_default';
const migrations = {
  [baseline]: '0fdf108713220e0f25a8ef0561ea8f4fe79e6e50c9f1090890447d4fbdf6c10d',
  [notificationDefault]: 'ae29292abdfca9a89bae67d23624c31e53c817bb85a68b8b8a48b7381f798ca8'
};
const expectedAclChecksum = 'c61dd3caf01f5d4ccf52ae10bfbc8739505a5bf95709a215395b671719a0555c';
const runtimeRole = 'aerocrm_crm_intake_runtime';
const backupRole = 'aerocrm_crm_intake_backup';

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
const sha256 = value => createHash('sha256').update(value).digest('hex');
function inspect(password, query) {
  return JSON.parse(run('CRM Intake database inspection', 'docker', [
    'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD', '--entrypoint', 'psql',
    'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
    '-p', '5432', '-U', 'aerocrm_crm_intake_migration', '-d', 'aerocrm_crm_intake', '-c', query
  ], { env: { ...process.env, PGPASSWORD: password } }));
}
function migrationRows(password) {
  return inspect(password, `SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.migration_name), '[]'::json)::text
    FROM (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
      rolled_back_at IS NOT NULL AS rolled_back FROM crm_intake._prisma_migrations) m;`);
}
function verifyMigrations(rows, expectedNames) {
  assert.deepEqual(rows.map(row => row.migration_name), expectedNames,
    'Unexpected CRM Intake migration history');
  for (const row of rows) {
    assert.equal(row.checksum, migrations[row.migration_name],
      `CRM Intake migration checksum mismatch: ${row.migration_name}`);
    assert(row.finished === true && row.rolled_back === false,
      `Incomplete CRM Intake migration: ${row.migration_name}`);
  }
}
function verifyAclManifest(acl) {
  assert.equal(acl.version, 1);
  assert.equal(acl.service, 'crm-intake');
  assert.deepEqual(acl.tables.inbox_entries, ['SELECT', 'INSERT', 'UPDATE']);
  assert.deepEqual(acl.tables.inbox_notifications, ['SELECT', 'INSERT']);
  assert.deepEqual(acl.tables.inbox_notification_reads, ['SELECT', 'INSERT', 'UPDATE']);
  assert(acl.routines.includes('record_inbox_notification'));
}
function verifySchema(password) {
  const result = inspect(password, `SELECT json_build_object(
    'default', pg_get_expr(def.adbin, def.adrelid),
    'notNull', att.attnotnull,
    'uuidType', att.atttypid = 'uuid'::regtype,
    'trigger', EXISTS (SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = 'crm_intake.inbox_entries'::regclass
        AND t.tgname = 'inbox_entries_notification' AND NOT t.tgisinternal
        AND t.tgenabled = 'O'
        AND t.tgfoid = 'crm_intake.record_inbox_notification()'::regprocedure
        AND pg_get_triggerdef(t.oid) LIKE '%AFTER INSERT%FOR EACH ROW%'),
    'triggerBody', EXISTS (SELECT 1 FROM pg_proc p
      WHERE p.oid = 'crm_intake.record_inbox_notification()'::regprocedure
        AND p.prosrc LIKE '%INSERT INTO crm_intake.inbox_notifications(workspace_id, entry_id)%'),
    'runtimeEntryInsert', has_table_privilege('${runtimeRole}', 'crm_intake.inbox_entries', 'INSERT'),
    'runtimeNotificationSelect', has_table_privilege('${runtimeRole}', 'crm_intake.inbox_notifications', 'SELECT'),
    'runtimeNotificationInsert', has_table_privilege('${runtimeRole}', 'crm_intake.inbox_notifications', 'INSERT'),
    'runtimeNotificationUpdate', has_table_privilege('${runtimeRole}', 'crm_intake.inbox_notifications', 'UPDATE'),
    'runtimeNotificationDelete', has_table_privilege('${runtimeRole}', 'crm_intake.inbox_notifications', 'DELETE'),
    'backupNotificationSelect', has_table_privilege('${backupRole}', 'crm_intake.inbox_notifications', 'SELECT'),
    'backupNotificationWrite', has_table_privilege('${backupRole}', 'crm_intake.inbox_notifications', 'INSERT,UPDATE,DELETE')
  )::text FROM pg_attribute att
  LEFT JOIN pg_attrdef def ON def.adrelid = att.attrelid AND def.adnum = att.attnum
  WHERE att.attrelid = 'crm_intake.inbox_notifications'::regclass
    AND att.attname = 'id' AND NOT att.attisdropped;`);
  assert(/^(?:pg_catalog\.)?gen_random_uuid\(\)$/.test(result.default));
  assert(result.notNull && result.uuidType && result.trigger && result.triggerBody);
  assert(result.runtimeEntryInsert && result.runtimeNotificationSelect && result.runtimeNotificationInsert);
  assert(!result.runtimeNotificationUpdate && !result.runtimeNotificationDelete);
  assert(result.backupNotificationSelect && !result.backupNotificationWrite);
}

if (process.argv.length === 3 && process.argv[2] === '--policy-self-test') {
  const valid = name => ({ migration_name: name, checksum: migrations[name], finished: true, rolled_back: false });
  verifyMigrations([valid(baseline)], [baseline]);
  verifyMigrations([valid(baseline), valid(notificationDefault)], [baseline, notificationDefault]);
  assert.throws(() => verifyMigrations([valid(notificationDefault)], [baseline]), /Unexpected CRM Intake migration history/);
  assert.throws(() => verifyMigrations([{ ...valid(baseline), checksum: '0'.repeat(64) }], [baseline]), /checksum mismatch/);
  assert.throws(() => verifyMigrations([{ ...valid(baseline), finished: false }], [baseline]), /Incomplete CRM Intake migration/);
  verifyAclManifest({ version: 1, service: 'crm-intake', tables: {
    inbox_entries: ['SELECT', 'INSERT', 'UPDATE'], inbox_notifications: ['SELECT', 'INSERT'],
    inbox_notification_reads: ['SELECT', 'INSERT', 'UPDATE']
  }, routines: ['record_inbox_notification'] });
  console.log('CRM Intake notification migration policy fixtures verified');
  process.exit(0);
}

assert.equal(process.platform, 'linux', 'CRM Intake migration must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
assert.equal(process.argv.length, 4, 'Expected exact SHA and private env hash');
assert(/^[a-f0-9]{40}$/.test(sha), 'Exact target SHA required');
assert(/^[a-f0-9]{64}$/.test(expectedEnvHash), 'Private env hash required');
const envStat = fs.lstatSync(envFile);
assert(envStat.isFile() && !envStat.isSymbolicLink() &&
  (envStat.mode & 0o777) === 0o600 && fs.realpathSync(envFile) === envFile,
  'Expected private regular crm-intake.env with mode 0600');
const envBytes = fs.readFileSync(envFile);
assert.equal(sha256(envBytes), expectedEnvHash, 'CRM Intake migration env hash mismatch');
let values;
try { values = parseEnv(envBytes.toString('utf8')); }
catch { throw new Error('Invalid private CRM Intake migration env'); }
assert.deepEqual(Object.keys(values).sort(), ['CRM_INTAKE_DATABASE_URL', 'NODE_ENV'],
  'Unexpected CRM Intake migration env fields');
assert.equal(values.NODE_ENV, 'production', 'CRM Intake migration requires production mode');
let url;
try { url = new URL(values.CRM_INTAKE_DATABASE_URL); }
catch { throw new Error('Invalid CRM Intake migration database URL'); }
assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' &&
  (!url.port || url.port === '5432') && url.pathname === '/aerocrm_crm_intake' &&
  decodeURIComponent(url.username) === 'aerocrm_crm_intake_migration' && !!url.password &&
  !url.hash && Object.entries({ schema: 'crm_intake', connection_limit: '1', pool_timeout: '10',
    connect_timeout: '10' }).every(([key, value]) =>
    url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value) &&
  [...url.searchParams.keys()].length === 4,
  'CRM Intake migration URL must name the loopback database, migration role and schema');
const password = decodeURIComponent(url.password);
const revision = run('CRM Intake image revision inspection', 'docker', ['image', 'inspect',
  '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image]);
assert.equal(revision, sha, 'CRM Intake image revision mismatch');
const inventory = JSON.parse(run('CRM Intake image inventory inspection', 'docker', [
  'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
  `const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma/migrations';
   const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
   console.log(JSON.stringify({migrations:fs.readdirSync(root,{withFileTypes:true})
     .filter(x=>x.isDirectory()).map(x=>({name:x.name,checksum:hash(fs.readFileSync(root+'/'+x.name+'/migration.sql'))}))
     .sort((a,b)=>a.name.localeCompare(b.name)),
     aclChecksum:hash(fs.readFileSync('/app/prisma/database-access.json')),
     acl:JSON.parse(fs.readFileSync('/app/prisma/database-access.json','utf8'))}));`
]));
assert.deepEqual(inventory.migrations,
  Object.entries(migrations).map(([name, checksum]) => ({ name, checksum }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  'CRM Intake image migration files differ from reviewed inventory');
assert.equal(inventory.aclChecksum, expectedAclChecksum,
  'CRM Intake image ACL manifest differs from reviewed inventory');
verifyAclManifest(inventory.acl);
const before = migrationRows(password);
assert([1, 2].includes(before.length), 'Unexpected CRM Intake migration history');
verifyMigrations(before, Object.keys(migrations).slice(0, before.length));
run('CRM Intake Prisma migration', 'docker', [
  'run', '--rm', '--network', 'host', '--env', 'NODE_ENV', '--env', 'CRM_INTAKE_DATABASE_URL',
  '--entrypoint', 'node', image, 'node_modules/prisma/build/index.js', 'migrate', 'deploy',
  '--schema', 'prisma/schema.prisma'
], { env: { ...process.env, ...values } });
verifyMigrations(migrationRows(password), Object.keys(migrations));
verifySchema(password);
console.log('CRM Intake notification default migration and ACL verified');
