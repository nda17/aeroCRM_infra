#!/usr/bin/env node
// Target host only. Run under release.lock before switching compatible backend images.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const [sha, expectedEnvHash] = process.argv.slice(2);
const image = `aerocrm/crm-access:${sha}`;
const envFile = '/opt/aerocrm/env/migrations/crm-access.env';
const runtimeEnvFiles = [
  '/opt/aerocrm/env/backend/crm-access-api.env',
  '/opt/aerocrm/env/backend/crm-access-worker.env',
  '/opt/aerocrm/env/backend/crm-access-outbox-publisher.env'
];
const migrations = {
  '20260920000000_init_aerocrm': '5d808f9caf72a4aba765564b148e32cac62b5fc59e6efa09430c4f7faa4fbd14',
  '20260921020000_add_crm_custom_member_role': '2c8223b38d456cb7eddf54289f26305c1874e92c25403b3525dd6fe4cb7f6514',
  '20260921020100_crm_custom_roles': '5658f47ff4673c0d45ce61abd3e5fe5459dff9645d02dba9382224bb4234b876'
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
const sha256 = value => createHash('sha256').update(value).digest('hex');
function inspect(password, query) {
  return JSON.parse(run('CRM Access database inspection', 'docker', [
    'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD',
    '--entrypoint', 'psql', 'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', '5432', '-U', 'aerocrm_crm_access_migration',
    '-d', 'aerocrm_crm_access', '-c', query
  ], { env: { ...process.env, PGPASSWORD: password } }));
}
function migrationRows(password) {
  return inspect(password, `SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.migration_name), '[]'::json)::text
    FROM (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
      rolled_back_at IS NOT NULL AS rolled_back FROM crm_access._prisma_migrations) m;`);
}
function verifyMigrations(rows, expectedNames) {
  assert.deepEqual(rows.map(row => row.migration_name), expectedNames,
    'Unexpected CRM Access migration history');
  for (const row of rows) {
    assert.equal(row.checksum, migrations[row.migration_name],
      `CRM Access migration checksum mismatch: ${row.migration_name}`);
    assert(row.finished === true && row.rolled_back === false,
      `Incomplete CRM Access migration: ${row.migration_name}`);
  }
}
function readPrivateEnv(file) {
  const fileStat = fs.lstatSync(file);
  assert(fileStat.isFile() && !fileStat.isSymbolicLink() && (fileStat.mode & 0o777) === 0o600 &&
    fs.realpathSync(file) === file, `Expected private regular env file with mode 0600: ${file}`);
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

assert.equal(process.platform, 'linux', 'CRM Access migration must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
assert.equal(process.argv.length, 4, 'Expected exact SHA and private env hash');
assert(/^[a-f0-9]{40}$/.test(sha), 'Exact target SHA required');
assert(/^[a-f0-9]{64}$/.test(expectedEnvHash), 'Private env hash required');
const stat = fs.lstatSync(envFile);
assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
  fs.realpathSync(envFile) === envFile, 'Expected private regular crm-access.env with mode 0600');
const envBytes = fs.readFileSync(envFile);
assert.equal(sha256(envBytes), expectedEnvHash, 'CRM Access migration env hash mismatch');
let values;
try { values = parseEnv(envBytes.toString('utf8')); }
catch { throw new Error('Invalid private CRM Access migration env'); }
assert.deepEqual(Object.keys(values).sort(), ['CRM_ACCESS_DATABASE_URL', 'NODE_ENV'],
  'Unexpected CRM Access migration env fields');
assert.equal(values.NODE_ENV, 'production', 'CRM Access migration requires production mode');
let url;
try { url = new URL(values.CRM_ACCESS_DATABASE_URL); }
catch { throw new Error('Invalid CRM Access migration database URL'); }
assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' &&
  (!url.port || url.port === '5432') && url.pathname === '/aerocrm_crm_access' &&
  decodeURIComponent(url.username) === 'aerocrm_crm_access_migration' && !!url.password &&
  !url.hash && Object.entries({ schema: 'crm_access', connection_limit: '1', pool_timeout: '10',
    connect_timeout: '10' }).every(([key, value]) =>
    url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value) &&
  [...url.searchParams.keys()].length === 4,
  'CRM Access migration URL must name the loopback database, migration role and schema');
for (const file of runtimeEnvFiles) {
  const runtime = readPrivateEnv(file);
  assert.equal(runtime.CRM_ACCESS_CUSTOM_ROLES_ENABLED, 'false',
    'Initial custom-role migration requires the write gate to remain false');
}
const password = decodeURIComponent(url.password);
const revision = run('CRM Access image revision inspection', 'docker', ['image', 'inspect',
  '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image]);
assert.equal(revision, sha, 'CRM Access image revision mismatch');
const imageMigrations = JSON.parse(run('CRM Access image migration inspection', 'docker', [
  'run', '--rm', '--entrypoint', 'node', image, '-e',
  `const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma/migrations';
   console.log(JSON.stringify(fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory())
    .map(x=>({name:x.name,checksum:crypto.createHash('sha256').update(fs.readFileSync(root+'/'+x.name+'/migration.sql')).digest('hex')}))
    .sort((a,b)=>a.name.localeCompare(b.name))));`
]));
assert.deepEqual(imageMigrations,
  Object.entries(migrations).map(([name, checksum]) => ({ name, checksum })),
  'CRM Access image migration files differ from reviewed inventory');
const before = migrationRows(password);
assert([1, 2, 3].includes(before.length), 'Unexpected custom-role migration history');
verifyMigrations(before, Object.keys(migrations).slice(0, before.length));
run('CRM Access Prisma migration', 'docker', [
  'run', '--rm', '--network', 'host', '--env', 'NODE_ENV', '--env', 'CRM_ACCESS_DATABASE_URL',
  '--entrypoint', 'node', image, 'node_modules/prisma/build/index.js', 'migrate', 'deploy',
  '--schema', 'prisma/schema.prisma'
], { env: { ...process.env, ...values } });
verifyMigrations(migrationRows(password), Object.keys(migrations));
run('CRM Access custom-role ACL apply', 'docker', [
  'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD', '--entrypoint', 'psql', 'postgres:18',
  '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '5432',
  '-U', 'aerocrm_crm_access_migration', '-d', 'aerocrm_crm_access', '-c',
  `BEGIN;
   REVOKE ALL ON TABLE crm_access.crm_custom_roles FROM PUBLIC, aerocrm_crm_access_runtime, aerocrm_crm_access_backup;
   REVOKE ALL ON FUNCTION crm_access.is_valid_custom_role_permissions(text[]) FROM PUBLIC, aerocrm_crm_access_runtime, aerocrm_crm_access_backup;
   GRANT SELECT, INSERT, UPDATE ON TABLE crm_access.crm_custom_roles TO aerocrm_crm_access_runtime;
   GRANT SELECT ON TABLE crm_access.crm_custom_roles TO aerocrm_crm_access_backup;
   GRANT EXECUTE ON FUNCTION crm_access.is_valid_custom_role_permissions(text[]) TO aerocrm_crm_access_runtime;
   COMMIT;`
], { env: { ...process.env, PGPASSWORD: password } });
const contract = inspect(password, `SELECT json_build_object(
  'customEnum', EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='crm_access' AND t.typname='CrmMemberRole' AND e.enumlabel='CUSTOM'),
  'table', to_regclass('crm_access.crm_custom_roles') IS NOT NULL,
  'constraints', (SELECT count(*)=7 FROM pg_constraint c
    WHERE c.conrelid='crm_access.crm_custom_roles'::regclass AND c.conname IN (
      'crm_custom_roles_pkey','crm_custom_roles_id_workspace_id_key','crm_custom_roles_version_check',
      'crm_custom_roles_name_check','crm_custom_roles_name_key_check','crm_custom_roles_scope_check',
      'crm_custom_roles_permissions_check')),
  'activeNameIndex', EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='crm_access'
    AND tablename='crm_custom_roles' AND indexname='crm_custom_roles_active_name_key'
    AND indexdef LIKE '%UNIQUE INDEX%WHERE (archived_at IS NULL)'),
  'memberBinding', (SELECT count(*)=2 FROM pg_constraint WHERE conrelid='crm_access.crm_workspace_members'::regclass
    AND conname IN ('crm_workspace_members_custom_role_binding_check','crm_workspace_members_custom_role_id_workspace_id_fkey')),
  'invitationBinding', (SELECT count(*)=2 FROM pg_constraint WHERE conrelid='crm_access.crm_invitation_intents'::regclass
    AND conname IN ('crm_invitation_intents_custom_role_binding_check','crm_invitation_intents_custom_role_id_workspace_id_fkey')),
  'runtimeGrants', has_table_privilege('aerocrm_crm_access_runtime','crm_access.crm_custom_roles','SELECT')
    AND has_table_privilege('aerocrm_crm_access_runtime','crm_access.crm_custom_roles','INSERT')
    AND has_table_privilege('aerocrm_crm_access_runtime','crm_access.crm_custom_roles','UPDATE')
    AND NOT has_table_privilege('aerocrm_crm_access_runtime','crm_access.crm_custom_roles','DELETE')
    AND has_function_privilege('aerocrm_crm_access_runtime','crm_access.is_valid_custom_role_permissions(text[])','EXECUTE'),
  'backupGrants', has_table_privilege('aerocrm_crm_access_backup','crm_access.crm_custom_roles','SELECT')
    AND NOT has_table_privilege('aerocrm_crm_access_backup','crm_access.crm_custom_roles','INSERT')
    AND NOT has_function_privilege('aerocrm_crm_access_backup','crm_access.is_valid_custom_role_permissions(text[])','EXECUTE'),
  'publicFunctionRevoked', NOT EXISTS (SELECT 1 FROM pg_proc p,
    LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid='crm_access.is_valid_custom_role_permissions(text[])'::regprocedure
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE'))::text;`);
assert.deepEqual(contract, { customEnum: true, table: true, constraints: true, activeNameIndex: true,
  memberBinding: true, invitationBinding: true, runtimeGrants: true, backupGrants: true,
  publicFunctionRevoked: true }, 'CRM Access custom-role schema or grants incomplete');
console.log('CRM Access custom-role migrations and runtime grants verified');
