#!/usr/bin/env node
// Reviewed additive CRM Sales migration; invoked under the canonical backend release lock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const [sha, expectedEnvHash] = process.argv.slice(2);
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
  ['20261013000000_reminder_delivery_foreign_keys', '196d9b7073b3d64cfcc64e619f7c864a2385aedf5086067245ed5ef3c3819aa8']
];
const aclSha256 = 'e43d8f2afcbb3b36039a1ce5cb310e99a1830ed0fcd5c4a1be0a6259112fc0b3';
const expectedConstraints = [
  { name: 'reminder_deliveries_rule_workspace_fkey', source: ['rule_id', 'workspace_id'], target: 'crm_sales.reminder_rules', references: ['id', 'workspace_id'] },
  { name: 'reminder_deliveries_task_workspace_fkey', source: ['task_id', 'workspace_id'], target: 'crm_sales.tasks', references: ['id', 'workspace_id'] }
];

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
function orphanCounts(password) {
  return query(password, `SELECT json_build_object(
    'task', (SELECT count(*) FROM crm_sales.reminder_deliveries d
      LEFT JOIN crm_sales.tasks t ON t.id=d.task_id AND t.workspace_id=d.workspace_id WHERE t.id IS NULL),
    'rule', (SELECT count(*) FROM crm_sales.reminder_deliveries d
      LEFT JOIN crm_sales.reminder_rules r ON r.id=d.rule_id AND r.workspace_id=d.workspace_id WHERE r.id IS NULL))::text;`);
}
function verifyConstraints(rows, present) {
  assert.equal(rows.length, present ? 2 : 0, 'Unexpected CRM Sales reminder FK inventory');
  if (!present) return;
  assert.deepEqual(rows, expectedConstraints.map(constraint => ({ ...constraint,
    kind: 'f', validated: true, onUpdate: 'r', onDelete: 'r', relation: 'crm_sales.reminder_deliveries' })));
}
function constraints(password) {
  return query(password, `SELECT COALESCE(json_agg(row_to_json(f) ORDER BY f.name), '[]'::json)::text FROM (
    SELECT c.conname AS name, c.contype AS kind, c.convalidated AS validated,
      c.confupdtype AS "onUpdate", c.confdeltype AS "onDelete",
      c.conrelid::regclass::text AS relation, c.confrelid::regclass::text AS target,
      (SELECT json_agg(a.attname ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS source,
      (SELECT json_agg(a.attname ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum) AS "references"
    FROM pg_constraint c WHERE c.conrelid='crm_sales.reminder_deliveries'::regclass
      AND c.conname IN ('reminder_deliveries_task_workspace_fkey', 'reminder_deliveries_rule_workspace_fkey')
  ) f;`);
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
  verifyConstraints([], false);
  verifyConstraints(expectedConstraints.map(constraint => ({ ...constraint,
    kind: 'f', validated: true, onUpdate: 'r', onDelete: 'r', relation: 'crm_sales.reminder_deliveries' })), true);
  assert.throws(() => verifyConstraints([{ ...expectedConstraints[0] }], true), /inventory/);
  console.log('CRM Sales reminder FK migration policy fixtures verified');
  process.exit(0);
}

assert.equal(process.platform, 'linux', 'CRM Sales migration must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
assert.equal(process.argv.length, 4, 'Expected exact SHA and private env hash');
assert(/^[a-f0-9]{40}$/.test(sha), 'Exact target SHA required');
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

imageInventory();
const before = history(password);
assert([migrations.length - 1, migrations.length].includes(before.length),
  'Unexpected CRM Sales migration history length');
verifyHistory(before, before.length);
verifyConstraints(constraints(password), before.length === migrations.length);
const orphans = orphanCounts(password);
assert.deepEqual(Object.keys(orphans).sort(), ['rule', 'task']);
assert(String(orphans.task) === '0' && String(orphans.rule) === '0',
  `CRM Sales reminder FK preflight found orphan rows: task=${orphans.task} rule=${orphans.rule}`);
run('CRM Sales reminder FK Prisma migration', 'docker', [
  'run', '--rm', '--network', 'host', '--env', 'NODE_ENV', '--env', 'CRM_SALES_DATABASE_URL',
  '--entrypoint', 'node', image, 'node_modules/prisma/build/index.js', 'migrate', 'deploy',
  '--schema', 'prisma/schema.prisma'
], { env: { ...process.env, ...values } });
verifyHistory(history(password), migrations.length);
verifyConstraints(constraints(password), true);
console.log('CRM Sales reminder FK migration, orphan preflight and constraints verified');
