#!/usr/bin/env node
// Target-only reviewed additive schema/ACL hook. Called under the canonical release lock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest, uniformManifest } from './backend-release-state.mjs';

const inventory = JSON.parse(fs.readFileSync(new URL('./crm-corporate-mail-reviewed-inventory.json', import.meta.url)));
const schema = 'crm_customers';
const runtime = 'aerocrm_crm_customers_runtime';
const backup = 'aerocrm_crm_customers_backup';
const owner = 'aerocrm_crm_customers_migration';
const migration = '20260929000000_mail_workspace';
const hash = value => createHash('sha256').update(value).digest('hex');
const literal = value => `'${value.replaceAll("'", "''")}'`;
const ident = value => { assert(/^[a-z_][a-z0-9_]*$/.test(value)); return `"${value}"`; };
function run(label, executable, args, options = {}) {
  try { return execFileSync(executable, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options }).trim(); }
  catch { throw new Error(`${label} failed; private output suppressed`); }
}
function psql(password, query, json = true) {
  const output = run('Corporate mail database policy', 'docker', ['run', '--rm', '--network', 'host',
    '--env', 'PGPASSWORD', '--entrypoint', 'psql', 'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', '5432', '-U', owner, '-d', 'aerocrm_crm_customers', '-c', query],
    { env: { ...process.env, PGPASSWORD: password } });
  return json ? JSON.parse(output) : output;
}
export function verifyRows(rows, allowPrevious) {
  const expected = Object.entries(inventory.migrations);
  assert.deepEqual(expected.map(([name]) => name), ['20260920000000_init_aerocrm',
    '20260923030000_workspace_closure', '20260928000000_corporate_mail',
    '20260928010000_mail_reply_guard_alias', '20260928020000_mail_notifications', migration]);
  assert((allowPrevious ? [2, 3, 4, 5, 6] : [6]).includes(rows.length),
    'Unexpected corporate mail migration history');
  assert.deepEqual(rows.map(row => row.name), expected.slice(0, rows.length).map(([name]) => name));
  rows.forEach((row, index) => {
    assert.equal(row.checksum, expected[index][1], `Corporate mail migration checksum differs: ${row.name}`);
    assert(row.finished && !row.rolledBack, `Incomplete corporate mail migration: ${row.name}`);
  });
}
export function aclSql(acl) {
  assert.equal(acl.version, 1); assert.equal(acl.service, 'crm-customers');
  assert.deepEqual(acl.sequences, {}); assert.deepEqual(acl.types, []);
  assert(!acl.columnPrivileges || Object.keys(acl.columnPrivileges).length === 0,
    'Corporate mail must not change reviewed existing column grants');
  const tables = Object.keys(acl.tables).sort();
  const routines = [...acl.routines].sort();
  const sql = ['BEGIN;', "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='30s';",
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`];
  for (const [table, permissions] of Object.entries(acl.tables)) {
    assert(permissions.every(p => ['SELECT', 'INSERT', 'UPDATE'].includes(p)), `Unexpected Customers table privilege: ${table}`);
    if (table.startsWith('mail_')) assert.deepEqual(permissions, inventory.mailTables[table], `Unreviewed mail ACL: ${table}`);
    if (permissions.length) sql.push(`GRANT ${permissions.join(', ')} ON TABLE ${ident(schema)}.${ident(table)} TO ${ident(runtime)};`);
    sql.push(`GRANT SELECT ON TABLE ${ident(schema)}.${ident(table)} TO ${ident(backup)};`);
  }
  assert.deepEqual(tables.filter(name => name.startsWith('mail_')), Object.keys(inventory.mailTables).sort());
  for (const signature of acl.routineExecute ?? []) {
    assert(/^[a-z_]+\((?:uuid)?\)$/.test(signature), 'Unsupported Customers routine signature');
    sql.push(`GRANT EXECUTE ON FUNCTION ${ident(schema)}.${signature} TO ${ident(runtime)};`);
  }
  sql.push(`DO $policy$ BEGIN
    IF current_database()<>'aerocrm_crm_customers' OR current_user<>${literal(owner)}
      OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=${literal(schema)})<>${literal(owner)}
      THEN RAISE EXCEPTION 'Mail database identity differs'; END IF;
    IF (SELECT array_agg(c.relname::text ORDER BY c.relname::text) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p','v','m','f')) IS DISTINCT FROM ARRAY[${tables.map(literal).join(',')}]::text[]
      THEN RAISE EXCEPTION 'Mail table inventory differs'; END IF;
    IF (SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname::text),'{}'::text[]) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=${literal(schema)} AND c.relkind='S')<>'{}'::text[]
      OR (SELECT coalesce(array_agg(t.typname::text ORDER BY t.typname::text),'{}'::text[]) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname=${literal(schema)} AND t.typtype='e')<>'{}'::text[] THEN RAISE EXCEPTION 'Mail sequence/type inventory differs'; END IF;
    IF (SELECT array_agg(DISTINCT p.proname::text ORDER BY p.proname::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=${literal(schema)}) IS DISTINCT FROM ARRAY[${routines.map(literal).join(',')}]::text[]
      OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=${literal(schema)})<>${routines.length}
      THEN RAISE EXCEPTION 'Mail routine inventory differs'; END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND pg_get_userbyid(c.relowner)<>${literal(owner)})
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)} AND pg_get_userbyid(p.proowner)<>${literal(owner)})
      THEN RAISE EXCEPTION 'Mail object owner differs'; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN (${[runtime,backup,owner].map(literal).join(',')})
      AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
        OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)))
      THEN RAISE EXCEPTION 'Mail role must be unprivileged'; END IF;`);
  for (const [table, permissions] of Object.entries(acl.tables)) {
    for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) {
      sql.push(`IF has_table_privilege(${literal(runtime)},${literal(`${schema}.${table}`)},${literal(privilege)}) IS DISTINCT FROM ${permissions.includes(privilege)}
        OR has_table_privilege(${literal(backup)},${literal(`${schema}.${table}`)},${literal(privilege)}) IS DISTINCT FROM ${privilege==='SELECT'}
        THEN RAISE EXCEPTION 'Mail runtime/backup ACL differs: ${table}/${privilege}'; END IF;`);
    }
    sql.push(`IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=${literal(`${schema}.${table}`)}::regclass AND a.grantee=0) THEN RAISE EXCEPTION 'Mail PUBLIC table grant'; END IF;`);
  }
  sql.push(`IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=${literal(schema)} AND has_function_privilege(${literal(runtime)},p.oid,'EXECUTE') IS DISTINCT FROM
      ((p.proname||'('||oidvectortypes(p.proargtypes)||')')=ANY(ARRAY[${(acl.routineExecute ?? []).map(literal).join(',')}]::text[])))
      THEN RAISE EXCEPTION 'Mail runtime routine ACL differs'; END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(att.attacl) a WHERE n.nspname=${literal(schema)} AND att.attnum>0
      AND a.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=${literal(runtime)}),(SELECT oid FROM pg_roles WHERE rolname=${literal(backup)})))
      THEN RAISE EXCEPTION 'Mail unreviewed column grant'; END IF;
    IF (SELECT array_agg(DISTINCT c.relname::text ORDER BY c.relname::text) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=${literal(schema)} AND c.relname LIKE 'mail_%' AND NOT t.tgisinternal AND t.tgenabled='O'
        AND p.proname='mail_write_guard') IS DISTINCT FROM ARRAY[${Object.keys(inventory.mailTables).sort().map(literal).join(',')}]::text[]
      THEN RAISE EXCEPTION 'Mail table fence inventory differs'; END IF;`);
  sql.push(`IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE n.nspname=${literal(schema)} AND (a.grantee=0 OR a.grantee=(SELECT oid FROM pg_roles WHERE rolname=${literal(backup)})))
      THEN RAISE EXCEPTION 'Mail PUBLIC/backup routine grant'; END IF;
    IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=${literal(schema)} AND c.relname LIKE 'mail_%'
        AND NOT t.tgisinternal AND t.tgenabled='O' AND p.proname='mail_write_guard')<>${inventory.mailTriggerCount}
      THEN RAISE EXCEPTION 'Mail fence triggers differ'; END IF;
    END $policy$;`, 'COMMIT;');
  return sql.join('\n');
}

async function main() {
assert.equal(process.platform, 'linux');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm');
const [sha, envHash] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert(/^[a-f0-9]{40}$/.test(sha) && /^[a-f0-9]{64}$/.test(envHash), 'Exact release SHA and private env hash required');
const manifest = validateManifest(JSON.parse(fs.readFileSync(process.env.BACKEND_MANIFEST_PATH, 'utf8')));
assert.equal(manifest.releaseSha, sha); assert(uniformManifest(manifest), 'Mail migration requires full exact-SHA manifest');
assert.equal(inventory.schemaVersion, 1);
assert.equal(Object.keys(inventory.migrations).at(-1), migration);
assert(Object.values(inventory.migrations).every(value => /^[a-f0-9]{64}$/.test(value)) && /^[a-f0-9]{64}$/.test(inventory.aclSha256), 'Mail checksums must be reviewed');
const envFile = '/opt/aerocrm/env/migrations/crm-customers.env';
const stat = fs.lstatSync(envFile);
assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && fs.realpathSync(envFile) === envFile);
const bytes = fs.readFileSync(envFile); assert.equal(hash(bytes), envHash, 'Customers migration env hash differs');
const values = parseEnv(bytes.toString('utf8'));
assert.deepEqual(Object.keys(values).sort(), ['CRM_CUSTOMERS_DATABASE_URL','NODE_ENV']); assert.equal(values.NODE_ENV,'production');
const url = new URL(values.CRM_CUSTOMERS_DATABASE_URL);
assert(url.protocol==='postgresql:' && url.hostname==='127.0.0.1' && (!url.port || url.port==='5432') && url.pathname==='/aerocrm_crm_customers'
  && decodeURIComponent(url.username)===owner && !!url.password && !url.hash && [...url.searchParams.keys()].length===4
  && Object.entries({schema,connection_limit:'1',pool_timeout:'10',connect_timeout:'10'}).every(([key,value])=>url.searchParams.getAll(key).length===1 && url.searchParams.get(key)===value), 'Unexpected Customers migration identity');
const password = decodeURIComponent(url.password);
const image = `aerocrm/crm-customers:${sha}`;
assert.equal(run('Customers immutable image','docker',['image','inspect','--format','{{.Id}}',image]),manifest.services['crm-customers'].imageId);
assert.equal(run('Customers revision','docker',['image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',image]),sha);
const observed = JSON.parse(run('Customers reviewed schema','docker',['run','--rm','--network','none','--entrypoint','node',image,'-e',
  `const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma',hash=b=>crypto.createHash('sha256').update(b).digest('hex');
   console.log(JSON.stringify({migrations:Object.fromEntries(fs.readdirSync(root+'/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>[x.name,hash(fs.readFileSync(root+'/migrations/'+x.name+'/migration.sql'))])),aclSha256:hash(fs.readFileSync(root+'/database-access.json')),acl:JSON.parse(fs.readFileSync(root+'/database-access.json','utf8'))}));`]));
assert.deepEqual(observed.migrations,inventory.migrations); assert.equal(observed.aclSha256,inventory.aclSha256);
const rows = () => psql(password, `SELECT coalesce(json_agg(row_to_json(r) ORDER BY r.name),'[]'::json)::text FROM
  (SELECT migration_name AS name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS "rolledBack" FROM crm_customers._prisma_migrations) r;`);
verifyRows(rows(),true);
run('Corporate mail additive migration','docker',['run','--rm','--network','host','--env','NODE_ENV','--env','CRM_CUSTOMERS_DATABASE_URL','--entrypoint','node',image,'node_modules/prisma/build/index.js','migrate','deploy','--schema','prisma/schema.prisma'],{env:{...process.env,...values}});
verifyRows(rows(),false);
psql(password,aclSql(observed.acl),false);
console.log('Corporate mail additive migration, runtime ACL and fence inventory verified');

}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
