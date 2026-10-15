import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(root, 'crm-sales-productivity-migration.mjs');
const inventory = JSON.parse(readFileSync(path.join(root, 'crm-sales-productivity-reviewed-inventory.json'), 'utf8'));
const services = ['crm-sales', 'crm-customers'];
const appRoot = process.env.AEROCRM_MONOREPO_PATH;
const token = randomBytes(6).toString('hex');
const container = `crm-productivity-acl-pg18-${token}`;
const postgresPassword = randomBytes(24).toString('base64url');
let containerReady = false;

const ident = value => {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/);
  return `"${value}"`;
};
const literal = value => `'${value.replaceAll("'", "''")}'`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, ...options }).trim();
}

function psql(database, role, password, sql, expectedSuccess = true) {
  const result = spawnSync('docker', ['run', '--rm', '-i', '--network', `container:${container}`,
    '--env', 'PGPASSWORD', '--entrypoint', 'psql', 'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', '5432', '-U', role, '-d', database], {
    input: sql,
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: password },
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (expectedSuccess) assert.equal(result.status, 0,
    `PostgreSQL 18 rejected generated productivity ACL SQL (${database}): ${result.stderr.trim()}`);
  return result;
}

function startDatabase() {
  docker(['run', '--detach', '--rm', '--name', container, '--network', 'bridge', '--env', `POSTGRES_PASSWORD=${postgresPassword}`, 'postgres:18']);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync('docker', ['exec', '-e', `PGPASSWORD=${postgresPassword}`, container,
      'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { encoding: 'utf8', timeout: 2_000 });
    if (result.status === 0) {
      const connection = spawnSync('docker', ['exec', '-e', `PGPASSWORD=${postgresPassword}`, container,
        'psql', '-h', '127.0.0.1', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-Atc', 'SELECT 1'],
      { encoding: 'utf8', timeout: 2_000 });
      if (connection.status === 0 && connection.stdout.trim() === '1') {
        ready = true;
        containerReady = true;
        break;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  assert(ready, 'Disposable PostgreSQL 18 fixture did not become ready');
}

function runAdmin(sql, database = 'postgres') {
  const result = spawnSync('docker', ['exec', '-i', '-e', `PGPASSWORD=${postgresPassword}`, container,
    'psql', '-h', '127.0.0.1', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
    input: sql, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(result.status, 0, `PostgreSQL 18 fixture setup failed: ${result.stderr.trim()}`);
}

function servicePaths(service) {
  assert(appRoot, 'Set AEROCRM_MONOREPO_PATH to the exact-SHA aeroCRM_monorepo checkout');
  const schema = service.replaceAll('-', '_');
  const app = path.join(appRoot, 'aeroCRM_services', 'apps', service);
  return {
    schema,
    app,
    migrations: path.join(app, 'prisma', 'migrations'),
    aclPath: path.join(app, 'prisma', 'database-access.json')
  };
}

function prepareIdentity(service, acl) {
  const schema = service.replaceAll('-', '_');
  const owner = `aerocrm_${schema}_migration`;
  const runtime = `aerocrm_${schema}_runtime`;
  const backup = `aerocrm_${schema}_backup`;
  const database = `aerocrm_${schema}`;
  const password = randomBytes(24).toString('base64url');
  runAdmin(`CREATE ROLE ${ident(owner)} LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)};
    CREATE ROLE ${ident(runtime)} NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${ident(backup)} NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE DATABASE ${ident(database)} OWNER ${ident(owner)};`);
  psql(database, owner, password, `CREATE SCHEMA ${ident(schema)} AUTHORIZATION ${ident(owner)};
    REVOKE ALL ON SCHEMA ${ident(schema)} FROM PUBLIC;
    GRANT USAGE ON SCHEMA ${ident(schema)} TO ${ident(runtime)}, ${ident(backup)};
    CREATE SCHEMA foreign_service_guard AUTHORIZATION ${ident(owner)};
    CREATE TABLE foreign_service_guard.sentinel (id integer PRIMARY KEY);
    REVOKE ALL ON SCHEMA foreign_service_guard FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`);
  return { service, schema, owner, runtime, backup, database, password, acl };
}

function migrationsFor(service, paths) {
  const expected = Object.entries(inventory.owners[service].migrations);
  const directories = readdirSync(paths.migrations, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  assert.deepEqual(directories, expected.map(([name]) => name), `${service} Prisma migration set differs from the reviewed inventory`);
  return expected.map(([name, checksum]) => {
    const sql = readFileSync(path.join(paths.migrations, name, 'migration.sql'));
    assert.equal(sha256(sql), checksum, `${service} migration checksum differs: ${name}`);
    return sql.toString('utf8');
  });
}

function generatedAclSql(service, aclPath) {
  const result = spawnSync(process.execPath, [hook, '--test-acl-sql', service, aclPath], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(result.status, 0, `Productivity hook failed to generate ${service} ACL SQL: ${result.stderr.trim()}`);
  return result.stdout;
}

before(() => startDatabase(), { timeout: 90_000 });
after(() => {
  if (containerReady) {
    try { docker(['rm', '--force', container]); } catch {}
  }
});

test('productivity hook sends SQL to psql on stdin with docker -i', () => {
  const source = readFileSync(hook, 'utf8');
  assert.match(source, /function psql\(identity, statement[\s\S]*?\['run','--rm','-i','--network','host'[\s\S]*?\{env,input:statement\}/,
    'psql must receive the statement on stdin through docker -i');
  assert.doesNotMatch(source, /identity\.database,'-c',statement/,
    'Large ACL statements must not be passed as one docker argv');
});

test('Linux rejects the historical >128 KiB single argument before psql starts', { skip: process.platform !== 'linux' }, () => {
  const oversizedComment = `--${'x'.repeat(140 * 1024)}`;
  const result = spawnSync('docker', ['run', '--rm', '-i', '--network', `container:${container}`,
    '--entrypoint', 'psql', 'postgres:18', '-X', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres',
    '-d', 'postgres', '-c', oversizedComment], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error?.code, 'E2BIG', 'Linux must reject the historical single-argument transport before psql starts');
});

for (const service of services) {
  test(`${service} exact migration ACL applies and verifies on PostgreSQL 18 over stdin`, { timeout: 180_000 }, () => {
    const paths = servicePaths(service);
    const aclBytes = readFileSync(paths.aclPath);
    assert.equal(sha256(aclBytes), inventory.owners[service].aclSha256, `${service} ACL does not match reviewed hash`);
    const acl = JSON.parse(aclBytes.toString('utf8'));
    const identity = prepareIdentity(service, acl);
    const migrations = migrationsFor(service, paths);
    for (const migration of migrations) psql(identity.database, identity.owner, identity.password, migration);
    psql(identity.database, identity.owner, identity.password,
      `CREATE TABLE ${ident(identity.schema)}._prisma_migrations (id text);`);

    const sql = generatedAclSql(service, paths.aclPath);
    if (service === 'crm-sales') assert(Buffer.byteLength(sql) > 128 * 1024, 'Sales ACL fixture must exercise the Linux per-argument limit');
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;$/);
    assert.equal(psql(identity.database, identity.owner, identity.password, sql).status, 0);
    assert.equal(psql(identity.database, identity.owner, identity.password, sql).status, 0,
      'Reapplying the exact ACL SQL must be safe');

    const newTable = service === 'crm-sales' ? 'loss_reason_settings' : 'mail_template_settings';
    const hasRuntimeExecute = service === 'crm-customers'
      ? `has_function_privilege(${literal(identity.runtime)},'${identity.schema}.reject_mail_template_command_mutation()','EXECUTE')`
      : `'not-applicable'`;
    const expectedCustomerRoutines = service === 'crm-customers'
      ? `has_function_privilege(${literal(identity.runtime)},'${identity.schema}.assert_workspace_open(uuid)','EXECUTE')
        AND has_function_privilege(${literal(identity.runtime)},'${identity.schema}.rewrap_mail_credential(uuid,integer,text,text,text)','EXECUTE')`
      : 'true';
    const state = psql(identity.database, identity.owner, identity.password,
      `SELECT json_build_object('runtimeSchema',has_schema_privilege(${literal(identity.runtime)},${literal(identity.schema)},'USAGE'),
      'runtimeTableSelect',has_table_privilege(${literal(identity.runtime)},${literal(`${identity.schema}.${newTable}`)},'SELECT'),
      'backupTableSelect',has_table_privilege(${literal(identity.backup)},${literal(`${identity.schema}.${newTable}`)},'SELECT'),
      'expectedRoutineExecute',${expectedCustomerRoutines},
      'runtimeUnexpectedRoutineExecute',${hasRuntimeExecute})::text;`);
    const parsed = JSON.parse(state.stdout.trim());
    assert.equal(parsed.runtimeSchema, true);
    assert.equal(parsed.runtimeTableSelect, true);
    assert.equal(parsed.backupTableSelect, true);
    if (service === 'crm-customers') assert.equal(parsed.runtimeUnexpectedRoutineExecute, false,
      'Customers runtime must not receive EXECUTE for the protected mutation trigger function');
    if (service === 'crm-customers') assert.equal(parsed.expectedRoutineExecute, true,
      'Customers runtime must retain its two reviewed function EXECUTE grants');
  });
}
