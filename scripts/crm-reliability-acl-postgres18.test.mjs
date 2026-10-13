import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { aclSql } from './crm-reliability-migration.mjs';

const inventory = JSON.parse(readFileSync(new URL('./crm-reliability-reviewed-inventory.json', import.meta.url)));
const services = ['crm-access', 'crm-customers'];
const token = randomBytes(6).toString('hex');
const container = `crm-acl-pg18-${token}`;
let port;

const ident = value => {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/);
  return `"${value}"`;
};

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000, ...options }).trim();
}

function psql(database, sql, expectedSuccess = true, expectedError = null) {
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database], { input: sql, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024 });
  if (expectedSuccess) assert.equal(result.status, 0,
    `PG18 rejected generated ACL SQL (${database}): ${result.stderr.trim()}`);
  else {
    assert.notEqual(result.status, 0, `PG18 unexpectedly accepted ACL SQL (${database})`);
    if (expectedError) assert(result.stderr.includes(expectedError), `PG18 failed for an unexpected reason (${database})`);
  }
}

function aclFor(service) {
  const entry = inventory.owners[service];
  const bytes = readFileSync(new URL(`./fixtures/${service}.database-access.json`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.aclSha256,
    `${service} ACL fixture differs from reviewed inventory`);
  const acl = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(acl).sort(),
    ['routineExecute', 'routines', 'sequences', 'service', 'tables', 'types', 'version'].sort());
  assert.equal(acl.version, 1);
  assert.equal(acl.service, service);
  assert.deepEqual(Object.keys(acl.tables).sort(), entry.tables);
  assert.deepEqual(acl.sequences, entry.sequences);
  assert.deepEqual(acl.types.slice().sort(), entry.types);
  assert.deepEqual(acl.routines.slice().sort(), entry.routines);
  assert.deepEqual(acl.routineExecute.slice().sort(), entry.routineExecute.slice().sort());
  return acl;
}

function fixtureObjectsSql(service, acl) {
  const schema = service.replaceAll('-', '_');
  const owner = `aerocrm_${schema}_migration`;
  const runtime = `aerocrm_${schema}_runtime`;
  const backup = `aerocrm_${schema}_backup`;
  const database = `aerocrm_${schema}_acl_test`;
  const statements = [
    `CREATE ROLE ${ident(owner)} NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    `CREATE ROLE ${ident(runtime)} NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    `CREATE ROLE ${ident(backup)} NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    `CREATE DATABASE ${ident(database)} OWNER ${ident(owner)};`
  ];
  psql('postgres', statements.join('\n'));
  const objects = [`SET ROLE ${ident(owner)};`, `CREATE SCHEMA ${ident(schema)} AUTHORIZATION ${ident(owner)};`];
  for (const table of Object.keys(acl.tables))
    objects.push(`CREATE TABLE ${ident(schema)}.${ident(table)} (id integer);`);
  for (const sequence of Object.keys(acl.sequences))
    objects.push(`CREATE SEQUENCE ${ident(schema)}.${ident(sequence)};`);
  for (const type of acl.types)
    objects.push(`CREATE TYPE ${ident(schema)}.${ident(type)} AS ENUM ('fixture');`);
  const executeTypes = new Map(acl.routineExecute.map(signature => {
    const open = signature.indexOf('(');
    return [signature.slice(0, open), signature.slice(open + 1, -1)];
  }));
  for (const routine of acl.routines) {
    const args = executeTypes.get(routine) ?? '';
    objects.push(`CREATE FUNCTION ${ident(schema)}.${ident(routine)}(${args}) RETURNS integer LANGUAGE SQL AS 'SELECT 1';`);
  }
  psql(database, objects.join('\n'));
  return { schema, owner, runtime, backup, database };
}

before(async () => {
  const password = randomBytes(24).toString('base64url');
  docker(['run', '--detach', '--rm', '--name', container, '--env', `POSTGRES_PASSWORD=${password}`,
    '--publish', '127.0.0.1::5432', 'postgres:18']);
  const mapping = docker(['port', container, '5432/tcp']);
  port = Number(mapping.match(/:(\d+)$/)?.[1]);
  assert(Number.isInteger(port) && port > 0, 'PG18 container did not expose an ephemeral localhost port');
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'],
      { encoding: 'utf8', timeout: 2_000 });
    if (result.status === 0) {
      const connection = spawnSync('docker', ['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
        '-U', 'postgres', '-d', 'postgres', '-Atc', 'SELECT 1'],
      { encoding: 'utf8', timeout: 2_000 });
      if (connection.status === 0 && connection.stdout.trim() === '1') { ready = true; break; }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(ready, 'Disposable PostgreSQL 18 fixture did not become ready');
}, { timeout: 90_000 });

after(() => {
  try { docker(['rm', '--force', container]); } catch {}
});

for (const service of services) {
test(`${service} generated ACL SQL applies, verifies, and rejects unreviewed ACL state on PostgreSQL 18`, () => {
    const acl = aclFor(service);
    const identity = fixtureObjectsSql(service, acl);
    psql(identity.database, `SET ROLE ${ident(identity.owner)};\n${aclSql(identity, acl)}`);
    psql(identity.database, `SET ROLE ${ident(identity.owner)};\n${aclSql(identity, acl, true)}`);
    const table = Object.entries(acl.tables).find(([, allowed]) => allowed.includes('SELECT'))[0];
    psql(identity.database, `SET ROLE ${ident(identity.owner)}; REVOKE SELECT ON TABLE ${ident(identity.schema)}.${ident(table)} FROM ${ident(identity.runtime)};`);
    psql(identity.database, `SET ROLE ${ident(identity.owner)};\n${aclSql(identity, acl, true)}`, false,
      'CRM reliability table ACL differs');
    psql(identity.database, `SET ROLE ${ident(identity.owner)}; GRANT SELECT ON TABLE ${ident(identity.schema)}.${ident(table)} TO ${ident(identity.runtime)};`);
    psql(identity.database, `SET ROLE ${ident(identity.owner)}; CREATE TYPE ${ident(identity.schema)}.unreviewed_enum AS ENUM ('unexpected');`);
    psql(identity.database, `SET ROLE ${ident(identity.owner)};\n${aclSql(identity, acl, true)}`, false,
      'CRM reliability enum inventory differs');
  });
}
