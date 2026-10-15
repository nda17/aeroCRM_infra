#!/usr/bin/env node
// Three additive owners, under the canonical stopped-writer release transaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { validateManifest, uniformManifest } from './backend-release-state.mjs';
import { aclSql } from './crm-reliability-migration.mjs';
import { riskControlsServices, riskControlsImageCapable } from './risk-controls-capabilities.mjs';

export const riskControlsInventory = JSON.parse(fs.readFileSync(new URL('./risk-controls-reviewed-inventory.json', import.meta.url)));
export const migrationServices = ['billing', 'campaigns', 'identity'];
let diagnostic = { stage: 'preflight', service: 'none' };
const step = (stage, service = 'none') => { diagnostic = { stage, service }; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const schemaFingerprint = value => hash(JSON.stringify(value));
function checkedSchema(value) { assert(migrationServices.includes(value)); return value; }
export function schemaQuery(service) {
  const schema = checkedSchema(service);
  // Full catalog without data/ACL, ordered independently of object OIDs. PG18 only.
  return `SET search_path=pg_catalog; SELECT json_build_object(
    'columns',(SELECT coalesce(json_agg(json_build_object('relation',c.relname,'name',a.attname,
      'type',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),
      'identity',a.attidentity,'generated',a.attgenerated) ORDER BY c.relname,a.attnum),'[]'::json)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname='${schema}' AND c.relkind IN ('r','p') AND c.relname<>'_prisma_migrations' AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT coalesce(json_agg(json_build_object('relation',c.relname,'name',x.conname,
      'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY c.relname,x.conname),'[]'::json)
      FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='${schema}' AND c.relname<>'_prisma_migrations'),
    'indexes',(SELECT coalesce(json_agg(json_build_object('relation',c.relname,'name',i.relname,
      'valid',x.indisvalid,'ready',x.indisready,'definition',pg_get_indexdef(x.indexrelid)) ORDER BY c.relname,i.relname),'[]'::json)
      FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class i ON i.oid=x.indexrelid
      WHERE n.nspname='${schema}' AND c.relname<>'_prisma_migrations'),
    'enums',(SELECT coalesce(json_agg(json_build_object('type',t.typname,'label',e.enumlabel) ORDER BY t.typname,e.enumsortorder),'[]'::json)
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='${schema}'),
    'triggers',(SELECT coalesce(json_agg(json_build_object('relation',c.relname,'name',t.tgname,
      'type',t.tgtype::int,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname),'[]'::json)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND NOT t.tgisinternal),
    'routines',(SELECT coalesce(json_agg(json_build_object('name',p.oid::regprocedure::text,
      'owner',p.proowner::regrole::text,'securityDefiner',p.prosecdef,'config',p.proconfig,'definition',pg_get_functiondef(p.oid))
      ORDER BY p.oid::regprocedure::text),'[]'::json) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='${schema}')
  )::text;`;
}
function execute(label, binary, args, options = {}) {
  try { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options }).trim(); }
  catch { throw new Error(`${label} failed; private output suppressed`); }
}
function identity(service) {
  const file = `/opt/aerocrm/env/migrations/${service}.env`, stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file && (stat.mode & 0o777) === 0o600);
  const bytes = fs.readFileSync(file), values = parseEnv(bytes.toString('utf8'));
  const key = service.toUpperCase() + '_DATABASE_URL';
  assert.deepEqual(Object.keys(values).sort(), [key, 'NODE_ENV'].sort());
  const url = new URL(values[key]), owner = `aerocrm_${service}_migration`;
  assert.equal(values.NODE_ENV, 'production');
  assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && (!url.port || url.port === '5432') &&
    url.pathname === `/aerocrm_${service}` && decodeURIComponent(url.username) === owner && url.password && !url.hash &&
    [...url.searchParams].length === 4 && Object.entries({ schema: service, connection_limit: '1', pool_timeout: '10', connect_timeout: '10' })
      .every(([name, value]) => url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === value),
  'Risk controls migration URL identity differs');
  return { service, schema: service, owner, runtime: `aerocrm_${service}_runtime`, backup: `aerocrm_${service}_backup`,
    database: `aerocrm_${service}`, bytes, key, values, password: decodeURIComponent(url.password) };
}
function query(owner, statement, readOnly = true, json = true) {
  const result = execute(`${owner.service} migration inspection`, 'docker', ['run', '--rm', '--network', 'host',
    '--env', 'PGPASSWORD', '--env', 'PGOPTIONS', '--entrypoint', 'psql', 'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', '5432', '-U', owner.owner, '-d', owner.database, '-c', statement],
  { env: { ...process.env, PGPASSWORD: owner.password,
    PGOPTIONS: `-c search_path=pg_catalog -c statement_timeout=30000 -c lock_timeout=5000${readOnly ? ' -c default_transaction_read_only=on' : ''}` } });
  return json ? JSON.parse(result) : result;
}
export function verifyHistory(service, rows, completed = false) {
  const expected = Object.entries(riskControlsInventory.owners[service].migrations);
  assert([expected.length - 1, expected.length].includes(rows.length) && (!completed || rows.length === expected.length),
    `${service} risk controls migration history length differs`);
  rows.forEach((row, index) => {
    assert.deepEqual(row, { migration_name: expected[index][0], checksum: expected[index][1], finished: true, rolled_back: false },
      `${service} risk controls migration history checksum/attempt differs`);
  });
  return rows.length === expected.length;
}
function history(owner) {
  return query(owner, `SELECT coalesce(json_agg(row_to_json(m) ORDER BY migration_name),'[]'::json)::text FROM
    (SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back
     FROM ${owner.schema}._prisma_migrations) m;`);
}
export function verifySchema(service, value, completed) {
  const expected = riskControlsInventory.owners[service][completed ? 'schemaAfterSha256' : 'schemaBeforeSha256'];
  assert(/^[a-f0-9]{64}$/.test(expected), 'Reviewed PG18 risk controls schema fingerprint not frozen');
  assert.equal(schemaFingerprint(value), expected, `${service} risk controls catalog fingerprint differs`);
}
function extraAclChecks(owner) {
  const result = query(owner, `SELECT json_build_object(
    'schemaRuntimeUsage',has_schema_privilege('${owner.runtime}','${owner.schema}','USAGE'),
    'schemaBackupUsage',has_schema_privilege('${owner.backup}','${owner.schema}','USAGE'),
    'schemaRuntimeCreate',has_schema_privilege('${owner.runtime}','${owner.schema}','CREATE'),
    'schemaBackupCreate',has_schema_privilege('${owner.backup}','${owner.schema}','CREATE'),
    'unexpected',(SELECT count(*) FROM (
      SELECT a.grantee,a.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
        LATERAL aclexplode(c.relacl) a WHERE n.nspname='${owner.schema}'
      UNION ALL SELECT a.grantee,a.is_grantable FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
        LATERAL aclexplode(p.proacl) a WHERE n.nspname='${owner.schema}'
      UNION ALL SELECT a.grantee,a.is_grantable FROM pg_namespace n,
        LATERAL aclexplode(n.nspacl) a WHERE n.nspname='${owner.schema}'
      UNION ALL SELECT a.grantee,a.is_grantable FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace,LATERAL aclexplode(att.attacl) a WHERE n.nspname='${owner.schema}'
      UNION ALL SELECT a.grantee,a.is_grantable FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace,
        LATERAL aclexplode(t.typacl) a WHERE n.nspname='${owner.schema}' AND t.typtype='e') x
      WHERE grantee NOT IN ((SELECT oid FROM pg_roles WHERE rolname='${owner.owner}'),
        (SELECT oid FROM pg_roles WHERE rolname='${owner.runtime}'),(SELECT oid FROM pg_roles WHERE rolname='${owner.backup}'))
      OR (is_grantable AND grantee<>(SELECT oid FROM pg_roles WHERE rolname='${owner.owner}'))))::text;`);
  assert.deepEqual(result, { schemaRuntimeUsage: true, schemaBackupUsage: true, schemaRuntimeCreate: false, schemaBackupCreate: false, unexpected: 0 },
    'Unreviewed risk controls schema privilege/principal/grant option');
}
export function pendingGrantAcl(entry) {
  return { ...entry.acl, tables: Object.fromEntries(Object.entries(entry.acl.tables)
    .map(([name, privileges]) => [name, Object.hasOwn(entry.beforeAcl.tables, name) ? privileges : []])) };
}
function verifyAcl(owner, completed) {
  const entry = riskControlsInventory.owners[owner.service];
  if (!completed) query(owner, aclSql(owner, entry.beforeAcl, true), true, false);
  else {
    try { query(owner, aclSql(owner, entry.acl, true), true, false); }
    catch {
      // Only the exact additive post-DDL/no-new-grants state is resumable.
      // No privilege repair is allowed for arbitrary drift in existing objects.
      query(owner, aclSql(owner, pendingGrantAcl(entry), true,
        { backupTables: Object.keys(entry.beforeAcl.tables) }), true, false);
    }
  }
  extraAclChecks(owner);
}
function main() {
  const inspectOnly = process.argv[2] === '--inspect-read-only';
  const readOnly = inspectOnly || process.argv[2] === '--preflight';
  const args = process.argv.slice(readOnly ? 3 : 2);
  assert(args.length === 2 && /^[a-f0-9]{40}$/.test(args[0]) && /^[a-f0-9]{64}$/.test(args[1]));
  assert(process.platform === 'linux' && fs.realpathSync('.') === '/opt/aerocrm');
  const [sha, envHash] = args;
  const owners = migrationServices.map(identity);
  assert.equal(hash(owners.map(x => `${hash(x.bytes)}  ./${x.service}.env\n`).join('')), envHash,
    'Risk controls migration env aggregate hash differs');
  let manifest;
  if (!inspectOnly) {
    manifest = validateManifest(JSON.parse(fs.readFileSync(process.env.BACKEND_MANIFEST_PATH, 'utf8')));
    assert.equal(manifest.releaseSha, sha); assert(uniformManifest(manifest));
    for (const service of riskControlsServices) {
      step('image-capability', service);
      const image = `aerocrm/${service}:${sha}`;
      assert.equal(execute(`${service} immutable image`, 'docker', ['image', 'inspect', '--format', '{{.Id}}', image]), manifest.services[service].imageId);
      assert(riskControlsImageCapable(service, image, sha, riskControlsInventory.owners[service] || riskControlsInventory.capabilityInventories[service], execute),
        `Risk controls semantic image capability differs: ${service}`);
    }
  }
  // All histories, exact catalogs and existing ACL are inspected before the first DDL.
  for (const owner of owners) {
    step('history-catalog-acl', owner.service);
    const completed = verifyHistory(owner.service, history(owner));
    verifySchema(owner.service, query(owner, schemaQuery(owner.service)), completed);
    verifyAcl(owner, completed);
  }
  if (readOnly) { console.log('Risk controls read-only history/catalog/ACL verified'); return; }
  for (const owner of owners) {
    step('prisma-migrate', owner.service);
    execute(`${owner.service} risk controls Prisma migration`, 'docker', ['run', '--rm', '--network', 'host',
      '--env', 'NODE_ENV', '--env', owner.key, '--env', 'PGOPTIONS', '--entrypoint', 'node', `aerocrm/${owner.service}:${sha}`,
      'node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    { env: { ...process.env, ...owner.values, PGOPTIONS: '-c lock_timeout=5000 -c statement_timeout=60000' } });
    step('post-ddl-catalog-acl', owner.service);
    verifyHistory(owner.service, history(owner), true);
    verifySchema(owner.service, query(owner, schemaQuery(owner.service)), true);
    verifyAcl(owner, true);
    query(owner, aclSql(owner, riskControlsInventory.owners[owner.service].acl), false, false);
    query(owner, aclSql(owner, riskControlsInventory.owners[owner.service].acl, true), true, false);
    extraAclChecks(owner);
  }
  console.log('Risk controls three-owner migration/catalog/ACL verified');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch { console.error(`RISK_CONTROLS_FAILURE stage=${diagnostic.stage} service=${diagnostic.service}; private details withheld`); process.exitCode = 1; }
}
