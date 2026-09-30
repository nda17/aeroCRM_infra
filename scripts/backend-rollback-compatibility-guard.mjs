#!/usr/bin/env node
// Target host only. Database inspection requires writers to be stopped first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseEnv } from 'node:util';

const [candidateSha, ...modes] = process.argv.slice(2);
const manifestMode = modes.includes('--manifest');
const candidateManifest = manifestMode ? JSON.parse(fs.readFileSync(candidateSha, 'utf8')) : null;
function candidateImage(service) {
  const entry = candidateManifest?.services[service];
  if (entry) {
    assert.equal(run(`${service} immutable image`, 'docker', ['image', 'inspect', '--format', '{{.Id}}', `aerocrm/${service}:${entry.sourceSha}`]), entry.imageId);
    return `aerocrm/${service}:${entry.sourceSha}`;
  }
  return `aerocrm/${service}:${candidateSha}`;
}
const writersStopped = modes.includes('--writers-stopped');
const closureEnabled = modes.includes('--closure-enabled');
const billingEnvFile = '/opt/aerocrm/env/migrations/billing.env';
const crmAccessEnvFile = '/opt/aerocrm/env/migrations/crm-access.env';
const crmSalesEnvFile = '/opt/aerocrm/env/migrations/crm-sales.env';
const commerceMigration = '20260923010000_sales_commerce';
const closureMigration = '20260923030000_workspace_closure';
const closureOwners = ['crm-access', 'identity', 'billing', 'crm-customers', 'crm-sales', 'crm-intake', 'notification-delivery'];
const closureInventory = JSON.parse(fs.readFileSync(new URL('./workspace-closure-reviewed-inventory.json', import.meta.url)));
const mailInventory = JSON.parse(fs.readFileSync(new URL('./crm-corporate-mail-reviewed-inventory.json', import.meta.url)));
const importInventory = JSON.parse(fs.readFileSync(new URL('./crm-file-imports-reviewed-inventory.json', import.meta.url)));
const importMigration = '20261001000000_crm_file_imports';
const mailMigration = '20260928000000_corporate_mail';
const mailWorkspaceMigration = '20260929000000_mail_workspace';
const commerceChecksum = '04b371cfb2664da21cd6ffc3f62de88f2a7bf3b64f3bfec2b8ab6f7aaf84f433';
const commerceBusinessDataTables = [
  'commerce_catalog_items', 'commerce_deal_lines', 'commerce_commands',
  'commerce_events', 'commerce_quotes', 'commerce_payments'
];

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
function imageCapabilities(image, migrations, expectedChecksums = {}, execute = run) {
  return JSON.parse(execute(`${image} compatibility inspection`, 'docker', [
    'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
    `const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma/migrations';
     const expected=${JSON.stringify(expectedChecksums)};
     console.log(JSON.stringify(${JSON.stringify(migrations)}.map(name=>{
       const file=root+'/'+name+'/migration.sql';
       return fs.existsSync(file) && (!expected[name] ||
         crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')===expected[name]);
     })));`
  ]));
}
function closureImageReviewed(service, sha, execute = run) {
  const expected = closureInventory.owners[service];
  const accepted = service === 'crm-customers'
    ? [expected, mailInventory.legacyClosureCustomers, mailInventory.previousMailCustomers, mailInventory.previousNotificationsCustomers, mailInventory.previousWorkspaceCustomers, importInventory.owners['crm-customers']]
    : service === 'crm-sales' ? [expected, importInventory.owners['crm-sales']] : [expected];
  const image = `aerocrm/${service}:${sha}`;
  const revision = execute(`${service} closure image revision`, 'docker', ['image', 'inspect',
    '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', image]);
  if (revision !== sha) return false;
  const result = JSON.parse(execute(`${service} closure inventory`, 'docker', [
    'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
    `const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma';
     const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
     const inventories=${JSON.stringify(accepted.map(entry => entry.migrations))};
     const names=fs.readdirSync(root+'/migrations',{withFileTypes:true})
       .filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
     const inventoryIndex=inventories.findIndex(expected=>names.length===Object.keys(expected).length && names.every(name=>
       expected[name]===hash(fs.readFileSync(root+'/migrations/'+name+'/migration.sql'))));
     console.log(JSON.stringify({migrations:inventoryIndex>=0,inventoryIndex,aclSha:hash(fs.readFileSync(root+'/database-access.json'))}));`
  ]));
  const inventoryIndex = result.inventoryIndex ?? (accepted.length === 1 ? 0 : -1);
  return result.migrations === true && Number.isInteger(inventoryIndex) && result.aclSha === accepted[inventoryIndex]?.aclSha256;
}
function commerceBusinessDataQuery() {
  return `SELECT json_build_object('businessWrites', ${commerceBusinessDataTables
    .map(table => `EXISTS (SELECT 1 FROM crm_sales.${table})`).join(' OR ')})::text;`;
}
function assertNoCommerceBusinessWrites(state) {
  assert.equal(state.businessWrites, false,
    'Candidate CRM Sales image cannot read persisted commerce data');
}
function mailBusinessDataQuery() {
  return `SELECT json_build_object('mailData', ${Object.keys(mailInventory.mailTables)
    .map(table => `EXISTS (SELECT 1 FROM crm_customers.${table})`).join(' OR ')})::text;`;
}
function assertNoMailData(state) {
  assert.equal(state.mailData, false,
    'Old Customers image cannot protect persisted mail data/jobs/admitted sends; disable admission via CI/CD and retain compatible outcome workers');
}
function mailWorkspaceDataQuery() {
  return `SELECT json_build_object('mailWorkspaceData',
    EXISTS (SELECT 1 FROM crm_customers.mail_send_intents WHERE contact_id IS NULL OR scope_message_id IS NOT NULL OR html IS NOT NULL)
    OR EXISTS (SELECT 1 FROM crm_customers.mail_attachments WHERE message_id IS NULL AND upload_actor IS NOT NULL AND contact_id IS NULL))::text;`;
}
function assertNoMailWorkspaceData(state) {
  assert.equal(state.mailWorkspaceData, false,
    'Old Customers image cannot protect persisted standalone mail; retain a compatible image and fix forward');
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

if (process.argv.length === 3 && process.argv[2] === '--policy-self-test') {
  let probe;
  const capabilities = imageCapabilities('aerocrm/crm-sales:fixture', [commerceMigration],
    { [commerceMigration]: commerceChecksum }, (_label, executable, args) => {
      probe = { executable, args };
      return '[true]';
    });
  assert.deepEqual(capabilities, [true]);
  assert.equal(probe.executable, 'docker');
  assert(probe.args.includes('none') && probe.args.at(-1).includes(commerceChecksum));
  const query = commerceBusinessDataQuery();
  for (const table of commerceBusinessDataTables) assert(query.includes(`crm_sales.${table}`));
  assert(!query.includes('commerce_import_previews'));
  let calls = 0;
  assert(closureImageReviewed('identity', 'a'.repeat(40), (_label, executable, args) => {
    calls++;
    assert.equal(executable, 'docker');
    if (calls === 1) return 'a'.repeat(40);
    assert(args.includes('none'));
    assert(args.at(-1).includes(closureInventory.owners.identity.aclSha256) === false);
    assert(args.at(-1).includes(closureInventory.owners.identity.migrations[closureMigration]));
    return JSON.stringify({ migrations: true, aclSha: closureInventory.owners.identity.aclSha256 });
  }));
  assert.equal(calls, 2);
  assert.equal(closureImageReviewed('identity', 'a'.repeat(40), (_label, _executable, args) =>
    args[0] === 'image' ? 'a'.repeat(40) : JSON.stringify({ migrations: false,
      aclSha: closureInventory.owners.identity.aclSha256 })), false);
  assertNoCommerceBusinessWrites({ businessWrites: false });
  assert.throws(() => assertNoCommerceBusinessWrites({ businessWrites: true }),
    /cannot read persisted commerce data/);
  const mailQuery = mailBusinessDataQuery();
  for (const table of Object.keys(mailInventory.mailTables)) assert(mailQuery.includes(`crm_customers.${table}`));
  assert.equal(Object.keys(mailInventory.mailTables).length, 14);
  assertNoMailData({ mailData: false });
  assert.throws(() => assertNoMailData({ mailData: true }), /cannot protect persisted mail data/);
  const workspaceQuery = mailWorkspaceDataQuery();
  assert(workspaceQuery.includes('contact_id IS NULL'));
  assert(workspaceQuery.includes('scope_message_id IS NOT NULL'));
  assert(workspaceQuery.includes('upload_actor IS NOT NULL'));
  assertNoMailWorkspaceData({ mailWorkspaceData: false });
  assert.throws(() => assertNoMailWorkspaceData({ mailWorkspaceData: true }), /cannot protect persisted standalone mail/);
  assert.throws(() => assertNoMailWorkspaceData({}), /cannot protect persisted standalone mail/);
  const customers = closureInventory.owners['crm-customers'];
  const legacy = mailInventory.legacyClosureCustomers;
  const previous = mailInventory.previousMailCustomers;
  const previousNotifications = mailInventory.previousNotificationsCustomers;
  const previousWorkspace = mailInventory.previousWorkspaceCustomers;
  const reviewedPairs = [customers, legacy, previous, previousNotifications, previousWorkspace, importInventory.owners['crm-customers']];
  const reviewCustomers = (pair, crossAcl = false) => {
    let calls = 0;
    const result = closureImageReviewed('crm-customers', 'b'.repeat(40), (_label, executable, args) => {
      calls++;
      assert.equal(executable, 'docker');
      if (calls === 1) return 'b'.repeat(40);
      const script = args.at(-1);
      for (const reviewed of reviewedPairs)
        for (const checksum of Object.values(reviewed.migrations)) assert(script.includes(checksum));
      const inventoryIndex = reviewedPairs.indexOf(pair);
      const crossed = reviewedPairs.find(reviewed => reviewed.aclSha256 !== pair.aclSha256);
      return JSON.stringify({ migrations: true, inventoryIndex,
        aclSha: crossAcl ? crossed.aclSha256 : pair.aclSha256 });
    });
    assert.equal(calls, 2);
    return result;
  };
  assert.equal(reviewCustomers(customers), true);
  assert.equal(reviewCustomers(legacy), true);
  assert.equal(reviewCustomers(previous), true);
  assert.equal(reviewCustomers(previousNotifications), true);
  assert.equal(reviewCustomers(previousWorkspace), true);
  assert.equal(reviewCustomers(importInventory.owners['crm-customers']), true);
  assert.equal(reviewCustomers(customers, true), false);
  assert.equal(reviewCustomers(legacy, true), false);
  assert.equal(reviewCustomers(previous, true), false);
  assert.equal(reviewCustomers(previousNotifications, true), false);
  assert.equal(reviewCustomers(previousWorkspace, true), false);
  assert.equal(reviewCustomers(importInventory.owners['crm-customers'], true), false);
  console.log('Backend rollback policy fixtures verified');
  process.exit(0);
}

assert.equal(process.platform, 'linux', 'Backend compatibility guard must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
assert(modes.length <= 3 && new Set(modes).size === modes.length &&
  modes.every(mode => ['--writers-stopped', '--closure-enabled', '--manifest'].includes(mode)),
  'Expected candidate exact SHA and optional compatibility modes');
assert(manifestMode || /^[a-f0-9]{40}$/.test(candidateSha), 'Candidate exact SHA required');
if (manifestMode) {
  const { validateManifest } = await import('./backend-release-state.mjs');
  validateManifest(candidateManifest);
}

if (closureEnabled) {
  for (const service of closureOwners)
    assert(closureImageReviewed(service, candidateManifest?.services[service].sourceSha ?? candidateSha),
      `Candidate ${service} image does not match reviewed workspace closure migrations and ACL`);
}

const closureCapabilities = closureOwners.map(service => imageCapabilities(
  candidateImage(service), [closureMigration],
  { [closureMigration]: closureInventory.owners[service].migrations[closureMigration] }
)[0]);
assert(closureCapabilities.every(value => typeof value === 'boolean'), 'Candidate closure inventory is invalid');
if (!closureCapabilities.every(Boolean)) {
  if (!writersStopped) {
    console.error('Candidate backend images require a stopped-writer closure compatibility check');
    process.exit(2);
  }
  for (const service of closureOwners) {
    const schema = service.replaceAll('-', '_');
    const identity = readDatabaseUrl(`/opt/aerocrm/env/migrations/${service}.env`,
      `${schema.toUpperCase()}_DATABASE_URL`, {
        database: `aerocrm_${schema}`, role: `aerocrm_${schema}_migration`, schema
      });
    const exists = inspectDatabase(identity, `SELECT json_build_object(
      'fences', to_regclass('${schema}.workspace_closure_fences') IS NOT NULL,
      'operations', ${service === 'crm-access' ? "to_regclass('crm_access.crm_workspace_closures') IS NOT NULL" : 'false'})::text;`);
    if (!exists.fences) {
      assert(!exists.operations, 'Closure operation table exists without its fence');
      continue;
    }
    const state = inspectDatabase(identity, `SELECT json_build_object(
      'fenceExists', EXISTS (SELECT 1 FROM ${schema}.workspace_closure_fences WHERE fenced_at IS NOT NULL),
      'operationExists', ${service === 'crm-access' && exists.operations
        ? 'EXISTS (SELECT 1 FROM crm_access.crm_workspace_closures)' : 'false'})::text;`);
    assert(!state.fenceExists && !state.operationExists,
      `Candidate backend images cannot protect persisted workspace closure: ${service}`);
  }
}

const crmCapabilities = imageCapabilities(candidateImage('crm-access'), [
  '20260921020000_add_crm_custom_member_role',
  '20260921020100_crm_custom_roles',
  '20260921030100_crm_admin_seat_capacity'
]);
const billingCapabilities = imageCapabilities(candidateImage('billing'), [
  '20260921030000_crm_admin_seat_adjustments'
]);
const salesCapabilities = imageCapabilities(candidateImage('crm-sales'), [commerceMigration], {
  [commerceMigration]: commerceChecksum
});
const mailCapabilities = imageCapabilities(candidateImage('crm-customers'), [mailMigration], {
  [mailMigration]: mailInventory.migrations[mailMigration]
});
const mailWorkspaceCapabilities = imageCapabilities(candidateImage('crm-customers'), [mailWorkspaceMigration], {
  [mailWorkspaceMigration]: mailInventory.migrations[mailWorkspaceMigration]
});
const importCapabilities = Object.fromEntries(['crm-customers','crm-sales'].map(service => [service,
  imageCapabilities(candidateImage(service), [importMigration], {
    [importMigration]: importInventory.owners[service].migrations[importMigration]
  })[0]]));
assert(Object.values(importCapabilities).every(value => typeof value === 'boolean'),
  'Invalid CRM file import image compatibility inventory');
assert(mailWorkspaceCapabilities.length === 1 && typeof mailWorkspaceCapabilities[0] === 'boolean');
assert(crmCapabilities.length === 3 && billingCapabilities.length === 1 &&
  salesCapabilities.length === 1 && mailCapabilities.length === 1 &&
  [...crmCapabilities, ...billingCapabilities, ...salesCapabilities].every(value => typeof value === 'boolean'),
  'Candidate image compatibility inventory is invalid');
assert(typeof mailCapabilities[0] === 'boolean', 'Invalid mail image compatibility inventory');
const customRolesCompatible = crmCapabilities[0] && crmCapabilities[1];
const adminSeatsCompatible = crmCapabilities[2] && billingCapabilities[0];
if (customRolesCompatible && adminSeatsCompatible && salesCapabilities[0] && mailCapabilities[0] &&
    mailWorkspaceCapabilities[0] && Object.values(importCapabilities).every(Boolean)) {
  console.log('Candidate backend images support persisted CRM contracts');
  process.exit(0);
}
if (!writersStopped) {
  console.error('Candidate backend images require a stopped-writer data compatibility check');
  process.exit(2);
}

for (const service of ['crm-customers','crm-sales']) if (!importCapabilities[service]) {
  const schema = service.replace('-', '_');
  const identity = readDatabaseUrl(`/opt/aerocrm/env/migrations/${service}.env`,
    `${schema.toUpperCase()}_DATABASE_URL`, {
      database:`aerocrm_${schema}`,role:`aerocrm_${schema}_migration`,schema
    });
  const applied = inspectDatabase(identity, `SELECT EXISTS (SELECT 1 FROM ${schema}._prisma_migrations
    WHERE migration_name='${importMigration}' AND checksum='${importInventory.owners[service].migrations[importMigration]}'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL)::text;`);
  if (applied) {
    const data = inspectDatabase(identity, `SELECT json_build_object('persistedImport',
      EXISTS (SELECT 1 FROM ${schema}.import_previews) OR EXISTS (SELECT 1 FROM ${schema}.import_bindings))::text;`);
    assert.equal(data.persistedImport, false,
      `Candidate ${service} image cannot protect persisted CRM file import previews and bindings`);
  }
}

if (!mailWorkspaceCapabilities[0]) {
  const customers = readDatabaseUrl('/opt/aerocrm/env/migrations/crm-customers.env', 'CRM_CUSTOMERS_DATABASE_URL', {
    database: 'aerocrm_crm_customers', role: 'aerocrm_crm_customers_migration', schema: 'crm_customers'
  });
  const applied = inspectDatabase(customers, `SELECT EXISTS (SELECT 1 FROM crm_customers._prisma_migrations
    WHERE migration_name='${mailWorkspaceMigration}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)::text;`);
  if (applied) assertNoMailWorkspaceData(inspectDatabase(customers, mailWorkspaceDataQuery()));
}

if (!mailCapabilities[0]) {
  const customers = readDatabaseUrl('/opt/aerocrm/env/migrations/crm-customers.env', 'CRM_CUSTOMERS_DATABASE_URL', {
    database: 'aerocrm_crm_customers', role: 'aerocrm_crm_customers_migration', schema: 'crm_customers'
  });
  const applied = inspectDatabase(customers, `SELECT EXISTS (SELECT 1 FROM crm_customers._prisma_migrations
    WHERE migration_name='${mailMigration}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)::text;`);
  if (applied) assertNoMailData(inspectDatabase(customers, mailBusinessDataQuery()));
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
if (!salesCapabilities[0]) {
  const crmSales = readDatabaseUrl(crmSalesEnvFile, 'CRM_SALES_DATABASE_URL', {
    database: 'aerocrm_crm_sales', role: 'aerocrm_crm_sales_migration', schema: 'crm_sales'
  });
  const commerceApplied = inspectDatabase(crmSales, `SELECT EXISTS (
    SELECT 1 FROM crm_sales._prisma_migrations
    WHERE migration_name='${commerceMigration}' AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL)::text;`);
  if (commerceApplied) {
    const salesState = inspectDatabase(crmSales, commerceBusinessDataQuery());
    assertNoCommerceBusinessWrites(salesState);
  }
}
console.log('Persisted CRM data is compatible with the candidate backend images');
