#!/usr/bin/env node
// Target host only. Run under release.lock before switching backend images.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const [sha, expectedEnvHash] = process.argv.slice(2);
const image = `aerocrm/billing:${sha}`;
const envFile = '/opt/aerocrm/env/migrations/billing.env';
const baseline = '20260920000000_init_aerocrm';
const migration = '20260921010000_defer_crm_capacity_bindings';
const checksums = {
  [baseline]: 'b6a6babe34607ec210b864289d5f17b285c4924234e3570a9acf190253d85266',
  [migration]: '9318239e1b2e2926102f643faacd852782bb64901028f9950eb586fc2d498307'
};
const constraints = [
  ['crm_orders', 'crm_orders_capacity_command_id_workspace_id_owner_subject_fkey'],
  ['crm_commerce_accounts', 'crm_commerce_accounts_capacity_owner_fkey']
];

function run(label, executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      ...options
    }).trim();
  } catch {
    throw new Error(`${label} failed; private command output suppressed`);
  }
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function inspectDatabase(password, query) {
  return JSON.parse(run('Billing database inspection', 'docker', [
    'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD',
    '--entrypoint', 'psql', 'postgres:18', '-X', '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '5432',
    '-U', 'aerocrm_billing_migration', '-d', 'aerocrm_billing', '-c', query
  ], { env: { ...process.env, PGPASSWORD: password } }));
}
function migrationRows(password) {
  return inspectDatabase(password, `SELECT COALESCE(json_agg(row_to_json(m) ORDER BY m.migration_name), '[]'::json)::text
    FROM (SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
      rolled_back_at IS NOT NULL AS rolled_back FROM billing._prisma_migrations) m;`);
}
function constraintRows(password) {
  return inspectDatabase(password, `SELECT COALESCE(json_agg(row_to_json(fk) ORDER BY fk.name), '[]'::json)::text
    FROM (SELECT c.conname AS name, t.relname AS table_name,
      c.condeferrable AS deferrable, c.condeferred AS initially_deferred
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'billing' AND c.contype = 'f' AND c.conname IN
      ('crm_orders_capacity_command_id_workspace_id_owner_subject_fkey',
       'crm_commerce_accounts_capacity_owner_fkey')) fk;`);
}
function verifyMigrations(rows, applied) {
  const expected = applied ? [baseline, migration] : [baseline];
  assert.deepEqual(rows.map(row => row.migration_name).sort(), expected.sort(),
    'Unexpected Billing migration history');
  for (const row of rows) {
    assert.equal(row.checksum, checksums[row.migration_name],
      `Billing migration checksum mismatch: ${row.migration_name}`);
    assert(row.finished === true && row.rolled_back === false,
      `Incomplete Billing migration: ${row.migration_name}`);
  }
}
function verifyConstraints(rows, deferred) {
  assert.equal(rows.length, constraints.length, 'Incomplete Billing capacity FK inventory');
  assert.deepEqual(rows.map(row => [row.table_name, row.name]).sort(),
    constraints.slice().sort(), 'Unexpected Billing capacity FK inventory');
  for (const row of rows) {
    assert.equal(row.deferrable, deferred, `Unexpected FK deferrability: ${row.name}`);
    assert.equal(row.initially_deferred, deferred, `Unexpected FK initial mode: ${row.name}`);
  }
}

assert.equal(process.platform, 'linux', 'Billing migration must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
assert.equal(process.argv.length, 4, 'Expected exact SHA and private env hash');
assert(/^[a-f0-9]{40}$/.test(sha), 'Exact target SHA required');
assert(/^[a-f0-9]{64}$/.test(expectedEnvHash), 'Private env hash required');
const envStat = fs.lstatSync(envFile);
assert(envStat.isFile() && !envStat.isSymbolicLink() &&
  (envStat.mode & 0o777) === 0o600 && fs.realpathSync(envFile) === envFile,
  'Expected private regular billing.env with mode 0600');
const envBytes = fs.readFileSync(envFile);
assert.equal(sha256(envBytes), expectedEnvHash, 'Billing migration env hash mismatch');
let values;
try { values = parseEnv(envBytes.toString('utf8')); }
catch { throw new Error('Invalid private Billing migration env'); }
assert.deepEqual(Object.keys(values).sort(), ['BILLING_DATABASE_URL', 'NODE_ENV'],
  'Unexpected Billing migration env fields');
assert.equal(values.NODE_ENV, 'production', 'Billing migration requires production mode');
let url;
try { url = new URL(values.BILLING_DATABASE_URL); }
catch { throw new Error('Invalid Billing migration database URL'); }
assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' &&
  (!url.port || url.port === '5432') && url.pathname === '/aerocrm_billing' &&
  decodeURIComponent(url.username) === 'aerocrm_billing_migration' &&
  !!url.password && !url.hash &&
  Object.entries({ schema: 'billing', connection_limit: '1', pool_timeout: '10',
    connect_timeout: '10' }).every(([key, value]) =>
    url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value) &&
  [...url.searchParams.keys()].length === 4,
  'Billing migration URL must name the loopback Billing database, migration role and schema');
const password = decodeURIComponent(url.password);

const revision = run('Billing image revision inspection', 'docker', ['image', 'inspect',
  '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image]);
assert.equal(revision, sha, 'Billing image revision mismatch');
const imageMigrations = JSON.parse(run('Billing image migration inspection', 'docker', [
  'run', '--rm', '--entrypoint', 'node', image, '-e',
  `const fs=require('node:fs'); const crypto=require('node:crypto');
   const root='/app/prisma/migrations';
   console.log(JSON.stringify(fs.readdirSync(root,{withFileTypes:true})
    .filter(entry=>entry.isDirectory()).map(entry=>({name:entry.name,
      checksum:crypto.createHash('sha256').update(fs.readFileSync(root+'/'+entry.name+'/migration.sql')).digest('hex')
    })).sort((a,b)=>a.name.localeCompare(b.name))));`
]));
assert.deepEqual(imageMigrations,
  Object.entries(checksums).map(([name, checksum]) => ({ name, checksum }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  'Billing image migration files differ from reviewed baseline and additive migration');

const before = migrationRows(password);
const alreadyApplied = before.some(row => row.migration_name === migration);
verifyMigrations(before, alreadyApplied);
verifyConstraints(constraintRows(password), alreadyApplied);
run('Billing Prisma migration', 'docker', [
  'run', '--rm', '--network', 'host', '--env', 'NODE_ENV',
  '--env', 'BILLING_DATABASE_URL', '--entrypoint', 'node', image,
  'node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'
], { env: { ...process.env, ...values } });
verifyMigrations(migrationRows(password), true);
verifyConstraints(constraintRows(password), true);
console.log('Billing capacity FK migration verified');
