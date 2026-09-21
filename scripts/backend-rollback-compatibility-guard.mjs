#!/usr/bin/env node
// Target host only. Database inspection requires writers to be stopped first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const [candidateSha, mode] = process.argv.slice(2);
const writersStopped = mode === '--writers-stopped';
const billingEnvFile = '/opt/aerocrm/env/migrations/billing.env';
const crmAccessEnvFile = '/opt/aerocrm/env/migrations/crm-access.env';

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
function imageCapabilities(image, migrations) {
  return JSON.parse(run(`${image} compatibility inspection`, 'docker', [
    'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
    `const fs=require('node:fs'),root='/app/prisma/migrations';
     console.log(JSON.stringify(${JSON.stringify(migrations)}.map(name=>fs.existsSync(root+'/'+name+'/migration.sql'))));`
  ]));
}
function readDatabaseUrl(file, key, identity) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    fs.realpathSync(file) === file, `Expected private regular env file with mode 0600: ${file}`);
  let values;
  try { values = parseEnv(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`Invalid private migration env: ${file}`); }
  assert.deepEqual(Object.keys(values).sort(), [key, 'NODE_ENV'].sort(),
    `Unexpected migration env fields: ${file}`);
  assert.equal(values.NODE_ENV, 'production', `Production migration env required: ${file}`);
  let url;
  try { url = new URL(values[key]); }
  catch { throw new Error(`Invalid migration database URL: ${file}`); }
  assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' &&
    (!url.port || url.port === '5432') && url.pathname === `/${identity.database}` &&
    decodeURIComponent(url.username) === identity.role && !!url.password && !url.hash &&
    Object.entries({ schema: identity.schema, connection_limit: '1', pool_timeout: '10',
      connect_timeout: '10' }).every(([name, value]) =>
      url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === value) &&
    [...url.searchParams.keys()].length === 4,
  `Migration URL has an unexpected database identity: ${file}`);
  return { password: decodeURIComponent(url.password), ...identity };
}
function inspectDatabase(identity, query) {
  return JSON.parse(run(`${identity.database} compatibility inspection`, 'docker', [
    'run', '--rm', '--network', 'host', '--env', 'PGPASSWORD', '--entrypoint', 'psql',
    'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
    '-p', '5432', '-U', identity.role, '-d', identity.database, '-c', query
  ], { env: { ...process.env, PGPASSWORD: identity.password } }));
}

assert.equal(process.platform, 'linux', 'Backend compatibility guard must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
assert([3, 4].includes(process.argv.length) && (!mode || writersStopped),
  'Expected candidate exact SHA and optional --writers-stopped');
assert(/^[a-f0-9]{40}$/.test(candidateSha), 'Candidate exact SHA required');

const crmCapabilities = imageCapabilities(`aerocrm/crm-access:${candidateSha}`, [
  '20260921020000_add_crm_custom_member_role',
  '20260921020100_crm_custom_roles',
  '20260921030100_crm_admin_seat_capacity'
]);
const billingCapabilities = imageCapabilities(`aerocrm/billing:${candidateSha}`, [
  '20260921030000_crm_admin_seat_adjustments'
]);
assert(crmCapabilities.length === 3 && billingCapabilities.length === 1 &&
  [...crmCapabilities, ...billingCapabilities].every(value => typeof value === 'boolean'),
  'Candidate image compatibility inventory is invalid');
const customRolesCompatible = crmCapabilities[0] && crmCapabilities[1];
const adminSeatsCompatible = crmCapabilities[2] && billingCapabilities[0];
if (customRolesCompatible && adminSeatsCompatible) {
  console.log('Candidate backend images support custom roles and administrative seat adjustments');
  process.exit(0);
}
if (!writersStopped) {
  console.error('Candidate backend images require a stopped-writer data compatibility check');
  process.exit(2);
}

const crmAccess = readDatabaseUrl(crmAccessEnvFile, 'CRM_ACCESS_DATABASE_URL', {
  database: 'aerocrm_crm_access', role: 'aerocrm_crm_access_migration', schema: 'crm_access'
});
const crmState = inspectDatabase(crmAccess, `SELECT json_build_object(
  'customData', EXISTS (SELECT 1 FROM crm_access.crm_custom_roles)
    OR EXISTS (SELECT 1 FROM crm_access.crm_workspace_members WHERE role::text='CUSTOM')
    OR EXISTS (SELECT 1 FROM crm_access.crm_invitation_intents WHERE role::text='CUSTOM'),
  'activeAdminOperation', EXISTS (
    SELECT 1 FROM crm_access.crm_billing_operations operation
    LEFT JOIN crm_access.crm_billing_capacity capacity
      ON capacity.workspace_id=operation.workspace_id
    WHERE operation.command_type='ADMIN_SET_AEROCRM_SEATS'
      AND (operation.release_fence=false OR capacity.pending_operation_id=operation.command_id)))::text;`);
if (!customRolesCompatible)
  assert.equal(crmState.customData, false,
    'Candidate CRM Access image cannot read persisted custom-role data');
if (!adminSeatsCompatible)
  assert.equal(crmState.activeAdminOperation, false,
    'Administrative seat operation must finish before switching images');

if (!billingCapabilities[0]) {
  const billing = readDatabaseUrl(billingEnvFile, 'BILLING_DATABASE_URL', {
    database: 'aerocrm_billing', role: 'aerocrm_billing_migration', schema: 'billing'
  });
  const billingState = inspectDatabase(billing, `SELECT json_build_object(
    'paidPeriodAdjustment', EXISTS (
      SELECT 1 FROM billing.crm_admin_seat_adjustments WHERE target='PAID_PERIOD'))::text;`);
  assert.equal(billingState.paidPeriodAdjustment, false,
    'Candidate Billing image cannot protect an administratively adjusted paid period');
}
console.log('Persisted CRM data is compatible with the candidate backend images');
