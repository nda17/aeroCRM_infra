#!/usr/bin/env node
// Target host only. Run under release.lock before switching compatible backend images.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const [sha, expectedEnvHash] = process.argv.slice(2);
const image = `aerocrm/crm-sales:${sha}`;
const envFile = '/opt/aerocrm/env/migrations/crm-sales.env';
const baseline = '20260920000000_init_aerocrm';
const commerce = '20260923010000_sales_commerce';
const migrations = {
  [baseline]: 'e9cf8e4a39ea31ea0663edea98e8fe97ebb50ee68be9bc1e8b3f8d8d3a6c2c9a',
  [commerce]: '04b371cfb2664da21cd6ffc3f62de88f2a7bf3b64f3bfec2b8ab6f7aaf84f433'
};
const expectedAclChecksum = '0faa50613ba6edbf8332a1c5a31e9530c9b9baeee2603557e9ddaa8364e8f0f1';
const newTablePrivileges = {
  commerce_catalog_items: ['SELECT', 'INSERT', 'UPDATE'],
  commerce_deal_lines: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  commerce_quotes: ['SELECT', 'INSERT'],
  commerce_payments: ['SELECT', 'INSERT'],
  commerce_import_previews: ['SELECT', 'INSERT', 'UPDATE'],
  commerce_commands: ['SELECT', 'INSERT'],
  commerce_events: ['SELECT', 'INSERT']
};
const runtimeRole = 'aerocrm_crm_sales_runtime';
const backupRole = 'aerocrm_crm_sales_backup';

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
const literal = value => `'${value.replaceAll("'", "''")}'`;
const identifier = value => {
  assert(/^[a-z_][a-z0-9_]*$/.test(value), 'Invalid SQL identifier');
  return `"${value}"`;
};
function inspect(password, query) {
  return JSON.parse(run('CRM Sales database inspection', 'docker', [
    'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD',
    '--entrypoint', 'psql', 'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', '5432', '-U', 'aerocrm_crm_sales_migration',
    '-d', 'aerocrm_crm_sales', '-c', query
  ], { env: { ...process.env, PGPASSWORD: password } }));
}
function migrationRows(password) {
  return inspect(password, `SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.migration_name), '[]'::json)::text
    FROM (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
      rolled_back_at IS NOT NULL AS rolled_back FROM crm_sales._prisma_migrations) m;`);
}
function verifyMigrations(rows, expectedNames) {
  assert.deepEqual(rows.map(row => row.migration_name), expectedNames,
    'Unexpected CRM Sales migration history');
  for (const row of rows) {
    assert.equal(row.checksum, migrations[row.migration_name],
      `CRM Sales migration checksum mismatch: ${row.migration_name}`);
    assert(row.finished === true && row.rolled_back === false,
      `Incomplete CRM Sales migration: ${row.migration_name}`);
  }
}
function buildAclSql(manifest) {
  const tableNames = Object.keys(manifest.tables);
  const sql = ['BEGIN;', "SET LOCAL lock_timeout = '5s';", "SET LOCAL statement_timeout = '30s';"];
  for (const [table, privileges] of Object.entries(newTablePrivileges)) {
    assert.deepEqual(manifest.tables[table], privileges,
      `Unexpected CRM Sales ACL manifest privileges: ${table}`);
    const relation = `${identifier('crm_sales')}.${identifier(table)}`;
    sql.push(`REVOKE ALL ON TABLE ${relation} FROM PUBLIC, ${identifier(runtimeRole)}, ${identifier(backupRole)};`);
    sql.push(`GRANT ${privileges.join(', ')} ON TABLE ${relation} TO ${identifier(runtimeRole)};`);
    sql.push(`GRANT SELECT ON TABLE ${relation} TO ${identifier(backupRole)};`);
  }
  assert(manifest.routines.includes('reject_commerce_immutable_mutation'),
    'CRM Sales immutable-history routine missing from ACL manifest');
  sql.push(`REVOKE ALL ON FUNCTION crm_sales.reject_commerce_immutable_mutation()
    FROM PUBLIC, ${identifier(runtimeRole)}, ${identifier(backupRole)};`);
  sql.push(`DO $verify$ BEGIN
    IF (SELECT array_agg(c.relname::text ORDER BY c.relname::text)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='crm_sales' AND c.relkind IN ('r','p','v','m','f'))
      IS DISTINCT FROM ARRAY[${tableNames.map(literal).sort().join(',')}]::text[]
      THEN RAISE EXCEPTION 'CRM Sales table inventory mismatch'; END IF;
    IF (SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname::text),'{}'::text[])
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='crm_sales' AND c.relkind='S')
      IS DISTINCT FROM ARRAY[${Object.keys(manifest.sequences).map(literal).sort().join(',')}]::text[]
      THEN RAISE EXCEPTION 'CRM Sales sequence inventory mismatch'; END IF;
    IF (SELECT coalesce(array_agg(t.typname::text ORDER BY t.typname::text),'{}'::text[])
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='crm_sales' AND t.typtype='e')
      IS DISTINCT FROM ARRAY[${manifest.types.map(literal).sort().join(',')}]::text[]
      THEN RAISE EXCEPTION 'CRM Sales enum inventory mismatch'; END IF;
    IF (SELECT coalesce(array_agg(DISTINCT p.proname::text ORDER BY p.proname::text),'{}'::text[])
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='crm_sales')
      IS DISTINCT FROM ARRAY[${manifest.routines.map(literal).sort().join(',')}]::text[]
      THEN RAISE EXCEPTION 'CRM Sales routine inventory mismatch'; END IF;`);
  for (const [table, privileges] of Object.entries(newTablePrivileges)) {
    const relation = `crm_sales.${table}`;
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
      const runtimeExpected = privileges.includes(privilege) ? 'true' : 'false';
      const backupExpected = privilege === 'SELECT' ? 'true' : 'false';
      sql.push(`IF has_table_privilege(${literal(runtimeRole)},${literal(relation)},${literal(privilege)}) IS DISTINCT FROM ${runtimeExpected}
        OR has_table_privilege(${literal(backupRole)},${literal(relation)},${literal(privilege)}) IS DISTINCT FROM ${backupExpected}
        THEN RAISE EXCEPTION 'CRM Sales table ACL mismatch: ${table} ${privilege}'; END IF;`);
    }
  }
  sql.push(`IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='crm_sales' AND table_name='pipelines' AND column_name='version')
      OR NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='crm_sales' AND table_name='deals' AND column_name='amount_mode')
      THEN RAISE EXCEPTION 'CRM Sales commerce columns are missing'; END IF;
    IF has_function_privilege(${literal(runtimeRole)},'crm_sales.reject_commerce_immutable_mutation()','EXECUTE')
      OR has_function_privilege(${literal(backupRole)},'crm_sales.reject_commerce_immutable_mutation()','EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_proc p,
        LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE p.oid='crm_sales.reject_commerce_immutable_mutation()'::regprocedure
          AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
      THEN RAISE EXCEPTION 'CRM Sales immutable-history routine ACL mismatch'; END IF;
    END $verify$;`, 'COMMIT;');
  return sql.join('\n');
}
function applyAcl(password, manifest) {
  run('CRM Sales commerce ACL apply and verification', 'docker', [
    'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD', '--entrypoint', 'psql',
    'postgres:18', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '5432',
    '-U', 'aerocrm_crm_sales_migration', '-d', 'aerocrm_crm_sales', '-c', buildAclSql(manifest)
  ], { env: { ...process.env, PGPASSWORD: password } });
}

if (process.argv.length === 3 && process.argv[2] === '--policy-self-test') {
  const valid = name => ({ migration_name: name, checksum: migrations[name],
    finished: true, rolled_back: false });
  verifyMigrations([valid(baseline)], [baseline]);
  verifyMigrations([valid(baseline), valid(commerce)], [baseline, commerce]);
  assert.throws(() => verifyMigrations([valid(commerce)], [baseline]),
    /Unexpected CRM Sales migration history/);
  assert.throws(() => verifyMigrations([{ ...valid(baseline), checksum: '0'.repeat(64) }],
    [baseline]), /checksum mismatch/);
  assert.throws(() => verifyMigrations([{ ...valid(baseline), finished: false }],
    [baseline]), /Incomplete CRM Sales migration/);
  const manifest = { tables: newTablePrivileges, sequences: {}, types: [],
    routines: ['reject_commerce_immutable_mutation'] };
  const acl = buildAclSql(manifest);
  assert(acl.includes('GRANT SELECT, INSERT ON TABLE "crm_sales"."commerce_payments"'));
  assert(acl.includes('REVOKE ALL ON FUNCTION crm_sales.reject_commerce_immutable_mutation()'));
  assert.throws(() => buildAclSql({ ...manifest, tables: {
    ...manifest.tables, commerce_payments: ['SELECT', 'INSERT', 'DELETE']
  } }), /Unexpected CRM Sales ACL manifest privileges/);
  console.log('CRM Sales release migration policy fixtures verified');
  process.exit(0);
}

assert.equal(process.platform, 'linux', 'CRM Sales migration must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
assert.equal(process.argv.length, 4, 'Expected exact SHA and private env hash');
assert(/^[a-f0-9]{40}$/.test(sha), 'Exact target SHA required');
assert(/^[a-f0-9]{64}$/.test(expectedEnvHash), 'Private env hash required');
assert(/^[a-f0-9]{64}$/.test(migrations[commerce]) && /^[a-f0-9]{64}$/.test(expectedAclChecksum),
  'Reviewed CRM Sales inventory checksums are required');
const envStat = fs.lstatSync(envFile);
assert(envStat.isFile() && !envStat.isSymbolicLink() &&
  (envStat.mode & 0o777) === 0o600 && fs.realpathSync(envFile) === envFile,
  'Expected private regular crm-sales.env with mode 0600');
const envBytes = fs.readFileSync(envFile);
assert.equal(sha256(envBytes), expectedEnvHash, 'CRM Sales migration env hash mismatch');
let values;
try { values = parseEnv(envBytes.toString('utf8')); }
catch { throw new Error('Invalid private CRM Sales migration env'); }
assert.deepEqual(Object.keys(values).sort(), ['CRM_SALES_DATABASE_URL', 'NODE_ENV'],
  'Unexpected CRM Sales migration env fields');
assert.equal(values.NODE_ENV, 'production', 'CRM Sales migration requires production mode');
let url;
try { url = new URL(values.CRM_SALES_DATABASE_URL); }
catch { throw new Error('Invalid CRM Sales migration database URL'); }
assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' &&
  (!url.port || url.port === '5432') && url.pathname === '/aerocrm_crm_sales' &&
  decodeURIComponent(url.username) === 'aerocrm_crm_sales_migration' && !!url.password &&
  !url.hash && Object.entries({ schema: 'crm_sales', connection_limit: '1', pool_timeout: '10',
    connect_timeout: '10' }).every(([key, value]) =>
    url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value) &&
  [...url.searchParams.keys()].length === 4,
  'CRM Sales migration URL must name the loopback database, migration role and schema');
const password = decodeURIComponent(url.password);

const revision = run('CRM Sales image revision inspection', 'docker', ['image', 'inspect',
  '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image]);
assert.equal(revision, sha, 'CRM Sales image revision mismatch');
const imageInventory = JSON.parse(run('CRM Sales image migration inventory inspection', 'docker', [
  'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
  `const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma/migrations';
   const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
   console.log(JSON.stringify({migrations:fs.readdirSync(root,{withFileTypes:true})
     .filter(x=>x.isDirectory()).map(x=>({name:x.name,checksum:hash(fs.readFileSync(root+'/'+x.name+'/migration.sql'))}))
     .sort((a,b)=>a.name.localeCompare(b.name)),
     aclChecksum:hash(fs.readFileSync('/app/prisma/database-access.json')),
     acl:JSON.parse(fs.readFileSync('/app/prisma/database-access.json','utf8'))}));`
]));
assert.deepEqual(imageInventory.migrations,
  Object.entries(migrations).map(([name, checksum]) => ({ name, checksum }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  'CRM Sales image migration files differ from reviewed inventory');
assert.equal(imageInventory.aclChecksum, expectedAclChecksum,
  'CRM Sales image ACL manifest differs from reviewed inventory');
assert(imageInventory.acl.version === 1 && imageInventory.acl.service === 'crm-sales',
  'CRM Sales image ACL manifest identity mismatch');
const before = migrationRows(password);
assert([1, 2].includes(before.length), 'Unexpected CRM Sales migration history');
verifyMigrations(before, Object.keys(migrations).slice(0, before.length));
run('CRM Sales Prisma migration', 'docker', [
  'run', '--rm', '--network', 'host', '--env', 'NODE_ENV', '--env', 'CRM_SALES_DATABASE_URL',
  '--entrypoint', 'node', image, 'node_modules/prisma/build/index.js', 'migrate', 'deploy',
  '--schema', 'prisma/schema.prisma'
], { env: { ...process.env, ...values } });
verifyMigrations(migrationRows(password), Object.keys(migrations));
applyAcl(password, imageInventory.acl);
console.log('CRM Sales commerce migration and ACL verified');
