#!/usr/bin/env node
// Reviewed additive CRM Sales migration; invoked under the canonical backend release lock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const [sha, expectedEnvHash] = process.argv.slice(2);
const inspectReadOnly = sha === '--inspect-read-only';
const service = 'crm-sales';
const image = `aerocrm/${service}:${sha}`;
const envFile = '/opt/aerocrm/env/migrations/crm-sales.env';
const migrations = [
  ['20260920000000_init_aerocrm', 'e9cf8e4a39ea31ea0663edea98e8fe97ebb50ee68be9bc1e8b3f8d8d3a6c2c9a'],
  ['20260923010000_sales_commerce', '04b371cfb2664da21cd6ffc3f62de88f2a7bf3b64f3bfec2b8ab6f7aaf84f433'],
  ['20260923030000_workspace_closure', 'bb118b4953dbb143cd79e8c6b1c453958c88a38ac709bc57e1c33235c29e7d4a'],
  ['20261001000000_crm_file_imports', 'd2c22df0df205a6b877db8cbc63cd79ad282597503f2cef7ae296a1bc668cd3a'],
  ['20261004000000_planner_customization', '36c56d3211d194b511b433222568ed3b9ae0d6f46b0bf45b41afe65b3f9289ad'],
  ['20261005000000_interaction_results', '1d1c8a5544ed021ca18f74c240530f715d6e5086c9c889fb8977ff8a0037fd75'],
  ['20261007030000_meeting3_workflows', 'cff0bc656ed9067d4301c9810f54ecdb14190469a78456e1234cb1c048b26062'],
  ['20261013000000_reminder_delivery_foreign_keys', '196d9b7073b3d64cfcc64e619f7c864a2385aedf5086067245ed5ef3c3819aa8'],
  ['20261014010000_stage_next_action_templates', '4b46859b917757ddbfb4e14cfe17cbbfbf8a5e11a8dc5de083c743a7d02a138b']
];
const aclSha256 = 'e43d8f2afcbb3b36039a1ce5cb310e99a1830ed0fcd5c4a1be0a6259112fc0b3';

function run(label, executable, args, options = {}) {
  try {
    return execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...options }).trim();
  } catch {
    throw new Error(`${label} failed; private command output suppressed`);
  }
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function query(password, sql) {
  return JSON.parse(run('CRM Sales read-only inspection', 'docker', [
    'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD', '--entrypoint', 'psql',
    'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '5432',
    '-U', 'aerocrm_crm_sales_migration', '-d', 'aerocrm_crm_sales', '-c', sql
  ], { env: { ...process.env, PGPASSWORD: password } }));
}
function history(password) {
  return query(password, `SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.migration_name), '[]'::json)::text
    FROM (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
      rolled_back_at IS NOT NULL AS rolled_back FROM crm_sales._prisma_migrations) m;`);
}
function verifyHistory(rows, expectedLength) {
  assert.equal(rows.length, expectedLength, 'Unexpected CRM Sales migration history length');
  rows.forEach((row, index) => {
    assert.deepEqual(Object.keys(row).sort(), ['checksum', 'finished', 'migration_name', 'rolled_back']);
    assert.equal(row.migration_name, migrations[index][0], 'CRM Sales migration order mismatch');
    assert.equal(row.checksum, migrations[index][1], `CRM Sales migration checksum mismatch: ${row.migration_name}`);
    assert(row.finished === true && row.rolled_back === false, `CRM Sales migration incomplete: ${row.migration_name}`);
  });
}
const expectedColumns = [
  { name: 'next_action_delay_hours', type: 'integer', nullable: true,
    default: null, generated: '', identity: '' },
  { name: 'next_action_title', type: 'character varying(200)', nullable: true,
    default: null, generated: '', identity: '' }
];
const expectedConstraint = {
  name: 'pipeline_stages_next_action_template_check', kind: 'c', validated: true,
  relation: 'crm_sales.pipeline_stages',
  definition: "CHECK ((((next_action_title IS NULL) AND (next_action_delay_hours IS NULL)) OR ((next_action_title IS NOT NULL) AND (next_action_delay_hours IS NOT NULL) AND (state = 'OPEN'::crm_sales.\"CrmPipelineStageState\") AND (btrim((next_action_title)::text) <> ''::text) AND ((next_action_title)::text !~ '[[:cntrl:]]'::text) AND ((next_action_delay_hours >= 1) AND (next_action_delay_hours <= 2160)))))"
};
function verifySchema(schema, present) {
  assert.deepEqual(Object.keys(schema).sort(), ['columns', 'constraints']);
  assert.deepEqual(schema.columns, present ? expectedColumns : [],
    'Unexpected CRM Sales next-action columns');
  assert.deepEqual(schema.constraints, present ? [expectedConstraint] : [],
    'Unexpected CRM Sales next-action constraint');
}
function schema(password) {
  return query(password, `SELECT json_build_object(
    'columns', (SELECT COALESCE(json_agg(json_build_object('name', a.attname,
      'type', format_type(a.atttypid, a.atttypmod), 'nullable', NOT a.attnotnull,
      'default', pg_get_expr(d.adbin,d.adrelid), 'generated', a.attgenerated, 'identity', a.attidentity)
      ORDER BY a.attname), '[]'::json)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='crm_sales.pipeline_stages'::regclass
        AND a.attname IN ('next_action_title', 'next_action_delay_hours') AND a.attnum > 0 AND NOT a.attisdropped),
    'constraints', (SELECT COALESCE(json_agg(json_build_object('name', c.conname,
      'kind', c.contype, 'validated', c.convalidated, 'relation', c.conrelid::regclass::text,
      'definition', pg_get_constraintdef(c.oid))), '[]'::json)
      FROM pg_constraint c WHERE c.conrelid='crm_sales.pipeline_stages'::regclass
        AND c.conname='pipeline_stages_next_action_template_check'))::text;`);
}
const expectedSecurity = {
  tables: [
    { relation: 'crm_sales.pipelines', runtime: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      backup: ['SELECT'], columnGrants: 0, unexpectedGrants: 0, grantOptions: 0 },
    { relation: 'crm_sales.pipeline_stages', runtime: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      backup: ['SELECT'], columnGrants: 0, unexpectedGrants: 0, grantOptions: 0 },
    { relation: 'crm_sales.workspace_closure_fences', runtime: ['INSERT', 'SELECT', 'UPDATE'],
      backup: ['SELECT'], columnGrants: 0, unexpectedGrants: 0, grantOptions: 0 }
  ],
  triggers: [
    { relation: 'crm_sales.pipelines', name: 'guard_workspace_closure', type: 31,
      enabled: 'O', function: 'crm_sales.guard_workspace_business_write()' },
    { relation: 'crm_sales.pipeline_stages', name: 'guard_workspace_closure', type: 31,
      enabled: 'O', function: 'crm_sales.guard_workspace_business_write()' },
    { relation: 'crm_sales.workspace_closure_fences', name: 'workspace_closure_fence_immutable',
      type: 27, enabled: 'O', function: 'crm_sales.workspace_closure_fence_immutable()' }
  ],
  functions: {
    guard: 'eb74f68e07345c00fea4d3d5fdd4fe1f973dbf7d591ca8417c1d2a66093a56cc',
    assertOpen: '60d8c3a0c7962e2d5387d46f2d65296d8aad10ce5e9b8434b1e8f1991c1fb78b',
    fence: 'f51abfcd8a5620d5f339100aabc0d8b70c4d0da961b5926b9314311c2738af23'
  },
  assertOpenExecute: { runtime: true, backup: false, publicGrant: false }
};
function verifySecurity(observed) {
  assert.deepEqual(observed, expectedSecurity,
    'CRM Sales closure fence or runtime/backup privileges changed');
}
function security(password) {
  const tables = query(password, `SELECT COALESCE(json_agg(json_build_object(
    'relation',c.oid::regclass::text,
    'runtime',(SELECT COALESCE(json_agg(name ORDER BY name),'[]'::json) FROM
      unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege(name)
      WHERE has_table_privilege('aerocrm_crm_sales_runtime',c.oid,name)),
    'backup',(SELECT COALESCE(json_agg(name ORDER BY name),'[]'::json) FROM
      unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege(name)
      WHERE has_table_privilege('aerocrm_crm_sales_backup',c.oid,name)),
    'columnGrants',(SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL),
    'unexpectedGrants',(SELECT count(*) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE a.grantee NOT IN (c.relowner,
        (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_runtime'),
        (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_backup'))),
    'grantOptions',(SELECT count(*) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE a.grantee IN ((SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_runtime'),
        (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_backup')) AND a.is_grantable)
    ) ORDER BY CASE c.oid
      WHEN 'crm_sales.pipelines'::regclass THEN 1
      WHEN 'crm_sales.pipeline_stages'::regclass THEN 2
      WHEN 'crm_sales.workspace_closure_fences'::regclass THEN 3 END),'[]'::json)::text
    FROM pg_class c WHERE c.oid IN ('crm_sales.pipelines'::regclass,
      'crm_sales.pipeline_stages'::regclass,'crm_sales.workspace_closure_fences'::regclass);`);
  const triggers = query(password, `SELECT COALESCE(json_agg(json_build_object(
    'relation',tgrelid::regclass::text,'name',tgname,'type',tgtype::int,
    'enabled',tgenabled,'function',tgfoid::regprocedure::text)
    ORDER BY CASE tgrelid
      WHEN 'crm_sales.pipelines'::regclass THEN 1
      WHEN 'crm_sales.pipeline_stages'::regclass THEN 2
      WHEN 'crm_sales.workspace_closure_fences'::regclass THEN 3 END,tgname),'[]'::json)::text
    FROM pg_trigger WHERE (tgrelid IN ('crm_sales.pipeline_stages'::regclass,
      'crm_sales.pipelines'::regclass) AND tgname='guard_workspace_closure')
      OR (tgrelid='crm_sales.workspace_closure_fences'::regclass
        AND tgname='workspace_closure_fence_immutable');`);
  const functions = query(password, `SELECT json_build_object(
    'guard',pg_get_functiondef('crm_sales.guard_workspace_business_write()'::regprocedure),
    'assertOpen',pg_get_functiondef('crm_sales.assert_workspace_open(uuid)'::regprocedure),
    'fence',pg_get_functiondef('crm_sales.workspace_closure_fence_immutable()'::regprocedure))::text;`);
  const assertOpenExecute = query(password, `SELECT json_build_object(
    'runtime',has_function_privilege('aerocrm_crm_sales_runtime',
      'crm_sales.assert_workspace_open(uuid)','EXECUTE'),
    'backup',has_function_privilege('aerocrm_crm_sales_backup',
      'crm_sales.assert_workspace_open(uuid)','EXECUTE'),
    'publicGrant',EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(p.proacl) a
      WHERE p.oid='crm_sales.assert_workspace_open(uuid)'::regprocedure AND a.grantee=0))::text;`);
  return { tables, triggers,
    functions: Object.fromEntries(Object.entries(functions).map(([name, definition]) =>
      [name, sha256(definition)])), assertOpenExecute };
}
function imageInventory() {
  const imageId = run('CRM Sales image revision', 'docker', ['image', 'inspect', '--format',
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image]);
  assert.equal(imageId, sha, 'CRM Sales image revision mismatch');
  const inventory = JSON.parse(run('CRM Sales image migration inventory', 'docker', [
    'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
    `const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma';
     const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
     console.log(JSON.stringify({migrations:fs.readdirSync(root+'/migrations',{withFileTypes:true})
       .filter(x=>x.isDirectory()).map(x=>[x.name,hash(fs.readFileSync(root+'/migrations/'+x.name+'/migration.sql'))])
       .sort((a,b)=>a[0].localeCompare(b[0])),aclSha256:hash(fs.readFileSync(root+'/database-access.json'))}));`
  ]));
  assert.deepEqual(inventory.migrations, [...migrations].sort((a, b) => a[0].localeCompare(b[0])),
    'CRM Sales image migration inventory mismatch');
  assert.equal(inventory.aclSha256, aclSha256, 'CRM Sales ACL manifest changed unexpectedly');
}

if (process.argv.length === 3 && process.argv[2] === '--policy-self-test') {
  const valid = migrations.map(([migration_name, checksum]) => ({ migration_name, checksum,
    finished: true, rolled_back: false }));
  verifyHistory(valid.slice(0, -1), migrations.length - 1);
  verifyHistory(valid, migrations.length);
  assert.throws(() => verifyHistory(valid.slice(1), migrations.length - 1), /order mismatch/);
  assert.throws(() => verifyHistory([{ ...valid[0], checksum: '0'.repeat(64) }, ...valid.slice(1)],
    migrations.length), /checksum mismatch/);
  const installed = { columns: expectedColumns, constraints: [expectedConstraint] };
  verifySchema({ columns: [], constraints: [] }, false);
  verifySchema(installed, true);
  assert.throws(() => verifySchema({ ...installed, columns: installed.columns.slice(1) }, true), /columns/);
  assert.throws(() => verifySchema({ ...installed, columns: [{ ...expectedColumns[0], default: '1' },
    expectedColumns[1]] }, true), /columns/);
  assert.throws(() => verifySchema({ ...installed, constraints: [] }, true), /constraint/);
  assert.throws(() => verifySchema({ ...installed, constraints: [{ ...expectedConstraint,
    definition: expectedConstraint.definition.replace('2160', '2161') }] }, true), /constraint/);
  verifySecurity(expectedSecurity);
  assert.throws(() => verifySecurity({ ...expectedSecurity,
    triggers: expectedSecurity.triggers.slice(1) }), /closure fence/);
  assert.throws(() => verifySecurity({ ...expectedSecurity, triggers: expectedSecurity.triggers.map(
    (trigger, index) => index === 1 ? { ...trigger, enabled: 'D' } : trigger) }), /closure fence/);
  assert.throws(() => verifySecurity({ ...expectedSecurity, functions: {
    ...expectedSecurity.functions, assertOpen: '0'.repeat(64) } }), /closure fence/);
  assert.throws(() => verifySecurity({ ...expectedSecurity, tables: expectedSecurity.tables.map(
    (table, index) => index === 1 ? { ...table, backup: ['SELECT', 'UPDATE'] } : table) }),
  /runtime\/backup/);
  assert.throws(() => verifySecurity({ ...expectedSecurity, tables: expectedSecurity.tables.map(
    (table, index) => index === 1 ? { ...table, runtime: [...table.runtime, 'TRUNCATE'] } : table) }),
  /runtime\/backup/);
  assert.throws(() => verifySecurity({ ...expectedSecurity,
    assertOpenExecute: { ...expectedSecurity.assertOpenExecute, publicGrant: true } }),
  /runtime\/backup/);
  console.log('CRM Sales stage next-action migration policy fixtures verified');
  process.exit(0);
}

assert.equal(process.platform, 'linux', 'CRM Sales migration must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
assert.equal(process.argv.length, 4, 'Expected exact SHA and private env hash');
assert(inspectReadOnly || /^[a-f0-9]{40}$/.test(sha), 'Exact target SHA required');
assert(/^[a-f0-9]{64}$/.test(expectedEnvHash), 'Private migration env hash required');
assert(migrations.every(([, checksum]) => /^[a-f0-9]{64}$/.test(checksum)));
const envStat = fs.lstatSync(envFile);
assert(envStat.isFile() && !envStat.isSymbolicLink() && fs.realpathSync(envFile) === envFile &&
  (envStat.mode & 0o777) === 0o600, 'Expected private regular crm-sales.env with mode 0600');
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

if (inspectReadOnly) {
  const observed = history(password);
  assert([migrations.length - 1, migrations.length].includes(observed.length),
    'Unexpected CRM Sales migration history length');
  verifyHistory(observed, observed.length);
  verifySchema(schema(password), observed.length === migrations.length);
  verifySecurity(security(password));
  console.log('CRM Sales stage next-action read-only inventory verified');
  process.exit(0);
}

imageInventory();
const before = history(password);
assert([migrations.length - 1, migrations.length].includes(before.length),
  'Unexpected CRM Sales migration history length');
verifyHistory(before, before.length);
verifySchema(schema(password), before.length === migrations.length);
verifySecurity(security(password));
run('CRM Sales stage next-action Prisma migration', 'docker', [
  'run', '--rm', '--network', 'host', '--env', 'NODE_ENV', '--env', 'CRM_SALES_DATABASE_URL',
  '--entrypoint', 'node', image, 'node_modules/prisma/build/index.js', 'migrate', 'deploy',
  '--schema', 'prisma/schema.prisma'
], { env: { ...process.env, ...values } });
verifyHistory(history(password), migrations.length);
verifySchema(schema(password), true);
verifySecurity(security(password));
console.log('CRM Sales stage next-action migration and constraints verified');
