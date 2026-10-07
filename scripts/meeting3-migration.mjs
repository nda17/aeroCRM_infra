#!/usr/bin/env node
// Reviewed three-owner meeting 3 migration. Called under backend release.lock before image switch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { validateManifest, uniformManifest } from './backend-release-state.mjs';

const inventory = JSON.parse(fs.readFileSync(new URL('./meeting3-reviewed-inventory.json', import.meta.url)));
const services = ['crm-access', 'crm-intake', 'crm-sales'];
const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const sequencePrivileges = ['SELECT', 'USAGE', 'UPDATE'];
const resolvedAccessBaseline = Object.freeze({
  migration_name: '20260920000000_init_aerocrm',
  checksum: '2a7fdd85882cc55b6893d2024f920788c1ea03e1d8497ad218770558ebce0793',
  started_at_utc: '2026-09-19T22:05:46.748634Z',
  finished_at_utc: null,
  rolled_back_at_utc: '2026-09-19T22:07:20.080831Z',
  applied_steps_count: 0
});
const sha256 = value => createHash('sha256').update(value).digest('hex');
const literal = value => `'${value.replaceAll("'", "''")}'`;
const ident = value => { assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)); return `"${value}"`; };

function execute(label, binary, args, options = {}) {
  try {
    return execFileSync(binary, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options }).trim();
  } catch {
    throw new Error(`${label} failed; private command output suppressed`);
  }
}
function reviewed(service) {
  const entry = inventory.owners[service];
  assert(entry && Object.keys(entry.migrations).at(-1) === entry.migration);
  assert(Object.values(entry.migrations).every(value => /^[a-f0-9]{64}$/.test(value)));
  assert(/^[a-f0-9]{64}$/.test(entry.aclSha256));
  return entry;
}
function privateIdentity(service) {
  const schema = service.replace('-', '_');
  const owner = `aerocrm_${schema}_migration`;
  const file = `/opt/aerocrm/env/migrations/${service}.env`;
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    fs.realpathSync(file) === file && (!process.getuid || stat.uid === process.getuid()), `Expected private migration env: ${service}`);
  const bytes = fs.readFileSync(file);
  let values;
  try { values = parseEnv(bytes.toString('utf8')); }
  catch { throw new Error(`Invalid private migration env: ${service}`); }
  const key = `${schema.toUpperCase()}_DATABASE_URL`;
  assert.deepEqual(Object.keys(values).sort(), [key, 'NODE_ENV'].sort());
  assert.equal(values.NODE_ENV, 'production');
  const url = new URL(values[key]);
  assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' &&
    (!url.port || url.port === '5432') && url.pathname === `/aerocrm_${schema}` &&
    decodeURIComponent(url.username) === owner && !!url.password && !url.hash &&
    [...url.searchParams.keys()].length === 4 &&
    Object.entries({schema,connection_limit:'1',pool_timeout:'10',connect_timeout:'10'}).every(([name,value]) =>
      url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === value),
    `Unexpected ${service} migration database identity`);
  return {service,schema,owner,key,values,bytes,password:decodeURIComponent(url.password),
    database:`aerocrm_${schema}`,runtime:`aerocrm_${schema}_runtime`,backup:`aerocrm_${schema}_backup`};
}
function psql(identity, statement, json = true) {
  const output = execute(`${identity.service} database inspection`, 'docker', [
    'run','--rm','--network','host','--env','PGPASSWORD','--entrypoint','psql','postgres:18',
    '-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','5432','-U',identity.owner,
    '-d',identity.database,'-c',statement], {env:{...process.env,PGPASSWORD:identity.password}});
  return json ? JSON.parse(output) : output;
}
function verifyDatabaseIdentity(identity) {
  const state = psql(identity, `SELECT json_build_object(
    'database', current_database()=${literal(identity.database)},
    'principal', current_user=${literal(identity.owner)},
    'schemaOwner', (SELECT pg_get_userbyid(nspowner)=${literal(identity.owner)} FROM pg_namespace WHERE nspname=${literal(identity.schema)}),
    'roles', (SELECT count(*)=3 AND bool_and(NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)) FROM pg_roles r
      WHERE r.rolname IN (${[identity.owner,identity.runtime,identity.backup].map(literal).join(',')}))
  )::text;`);
  assert(Object.values(state).every(value => value === true), `${identity.service} database identity differs`);
}
function migrationRows(identity) {
  return psql(identity, `SELECT coalesce(json_agg(row_to_json(r) ORDER BY r.migration_name,r.started_at_utc),'[]'::json)::text FROM
    (SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,
      rolled_back_at IS NOT NULL AS rolled_back,
      to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at_utc,
      to_char(finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at_utc,
      to_char(rolled_back_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS rolled_back_at_utc,
      applied_steps_count FROM ${ident(identity.schema)}._prisma_migrations) r;`);
}
function verifyRows(service, rows, complete = false) {
  const resolved = rows.filter(row => service === 'crm-access' &&
    Object.entries(resolvedAccessBaseline).every(([key,value]) => row[key] === value));
  assert(resolved.length <= 1, 'Unexpected duplicate resolved CRM Access baseline attempt');
  const active = rows.filter(row => !resolved.includes(row));
  const expected = Object.entries(reviewed(service).migrations);
  assert([expected.length - 1, expected.length].includes(active.length) &&
    (!complete || active.length === expected.length), `Unexpected ${service} migration history`);
  active.forEach((row,index) => {
    assert.equal(row.migration_name, expected[index][0], `${service} migration ordering differs`);
    assert.equal(row.checksum, expected[index][1], `${service} migration checksum mismatch`);
    assert(row.finished === true && row.rolled_back === false,
      `${service} migration incomplete or rolled back`);
  });
}
function imageInventory(identity, sha, manifest) {
  const image = `aerocrm/${identity.service}:${sha}`;
  assert.equal(execute(`${identity.service} image ID`, 'docker', ['image','inspect','--format','{{.Id}}',image]),
    manifest.services[identity.service].imageId);
  assert.equal(execute(`${identity.service} image revision`, 'docker', ['image','inspect','--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',image]), sha);
  const observed = JSON.parse(execute(`${identity.service} image inventory`, 'docker', [
    'run','--rm','--network','none','--entrypoint','node',image,'-e',
    `const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma',hash=b=>crypto.createHash('sha256').update(b).digest('hex');
     console.log(JSON.stringify({migrations:Object.fromEntries(fs.readdirSync(root+'/migrations',{withFileTypes:true})
       .filter(x=>x.isDirectory()).map(x=>[x.name,hash(fs.readFileSync(root+'/migrations/'+x.name+'/migration.sql'))])),
       aclSha256:hash(fs.readFileSync(root+'/database-access.json')),
       acl:JSON.parse(fs.readFileSync(root+'/database-access.json','utf8'))}));`
  ]));
  const expected = reviewed(identity.service);
  assert.deepEqual(observed.migrations,expected.migrations,`${identity.service} image migrations differ`);
  assert.equal(observed.aclSha256,expected.aclSha256,`${identity.service} image ACL differs`);
  const acl = observed.acl;
  assert(acl.version === 1 && acl.service === identity.service);
  assert.deepEqual(Object.keys(acl.tables).sort(),expected.tables);
  assert.deepEqual(acl.sequences,expected.sequences);
  assert.deepEqual(acl.types.slice().sort(),expected.types);
  assert.deepEqual(acl.routines.slice().sort(),expected.routines);
  assert.deepEqual((acl.routineExecute||[]).slice().sort(),expected.routineExecute);
  assert(!acl.columnPrivileges || Object.keys(acl.columnPrivileges).length === 0);
  return acl;
}
function aclSql(identity, acl, verifyOnly = false) {
  const {schema,owner,runtime,backup} = identity;
  const statements = ['BEGIN;',"SET LOCAL lock_timeout='5s';","SET LOCAL statement_timeout='30s';",
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`];
  for (const [table, allowed] of Object.entries(acl.tables)) {
    assert(allowed.every(value => privileges.includes(value)));
    if (allowed.length) statements.push(`GRANT ${allowed.join(', ')} ON TABLE ${ident(schema)}.${ident(table)} TO ${ident(runtime)};`);
    statements.push(`GRANT SELECT ON TABLE ${ident(schema)}.${ident(table)} TO ${ident(backup)};`);
  }
  for (const [sequence, allowed] of Object.entries(acl.sequences)) {
    assert(allowed.every(value => sequencePrivileges.includes(value)));
    if (allowed.length) statements.push(`GRANT ${allowed.join(', ')} ON SEQUENCE ${ident(schema)}.${ident(sequence)} TO ${ident(runtime)};`);
    statements.push(`GRANT SELECT ON SEQUENCE ${ident(schema)}.${ident(sequence)} TO ${ident(backup)};`);
  }
  for (const type of acl.types) {
    statements.push(`REVOKE ALL ON TYPE ${ident(schema)}.${ident(type)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`);
    statements.push(`GRANT USAGE ON TYPE ${ident(schema)}.${ident(type)} TO ${ident(runtime)}, ${ident(backup)};`);
  }
  for (const signature of acl.routineExecute || []) {
    assert(/^[a-z_]+\((?:uuid|text\[\])?\)$/.test(signature));
    statements.push(`GRANT EXECUTE ON FUNCTION ${ident(schema)}.${signature} TO ${ident(runtime)};`);
  }
  const names = Object.keys(acl.tables).sort();
  const sequences = Object.keys(acl.sequences).sort();
  const verifyStart = statements.length;
  statements.push(`DO $verify$ BEGIN
    IF current_database()<>${literal(identity.database)} OR current_user<>${literal(owner)}
      OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=${literal(schema)})<>${literal(owner)}
      THEN RAISE EXCEPTION 'Meeting 3 database owner differs'; END IF;
    IF (SELECT array_agg(c.relname::text ORDER BY c.relname::text) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p','v','m','f')) IS DISTINCT FROM ARRAY[${names.map(literal).join(',')}]::text[]
      THEN RAISE EXCEPTION 'Meeting 3 table inventory differs'; END IF;
    IF (SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname::text),'{}'::text[]) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=${literal(schema)} AND c.relkind='S') IS DISTINCT FROM ARRAY[${sequences.map(literal).join(',')}]::text[]
      THEN RAISE EXCEPTION 'Meeting 3 sequence inventory differs'; END IF;
    IF (SELECT coalesce(array_agg(t.typname::text ORDER BY t.typname::text),'{}'::text[]) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname=${literal(schema)} AND t.typtype='e') IS DISTINCT FROM ARRAY[${acl.types.slice().sort().map(literal).join(',')}]::text[]
      THEN RAISE EXCEPTION 'Meeting 3 enum inventory differs'; END IF;
    IF (SELECT array_agg(DISTINCT p.proname::text ORDER BY p.proname::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=${literal(schema)}) IS DISTINCT FROM ARRAY[${acl.routines.slice().sort().map(literal).join(',')}]::text[]
      THEN RAISE EXCEPTION 'Meeting 3 routine inventory differs'; END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=${literal(schema)})<>${acl.routines.length}
      THEN RAISE EXCEPTION 'Meeting 3 overloaded routine inventory differs'; END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND pg_get_userbyid(c.relowner)<>${literal(owner)})
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)} AND pg_get_userbyid(p.proowner)<>${literal(owner)})
      OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=${literal(schema)}
        AND t.typtype='e' AND pg_get_userbyid(t.typowner)<>${literal(owner)})
      THEN RAISE EXCEPTION 'Meeting 3 object owner differs'; END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(c.relacl) a WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p','v','m','f','S')
      AND a.grantee=0)
      THEN RAISE EXCEPTION 'Meeting 3 PUBLIC table/sequence grant'; END IF;
    IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace,
      LATERAL aclexplode(t.typacl) a WHERE n.nspname=${literal(schema)} AND t.typtype='e' AND a.grantee=0)
      THEN RAISE EXCEPTION 'Meeting 3 PUBLIC type grant'; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN (${[runtime,backup,owner].map(literal).join(',')})
      AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)))
      THEN RAISE EXCEPTION 'Meeting 3 role must be unprivileged'; END IF;`);
  for (const [table, allowed] of Object.entries(acl.tables)) {
    for (const privilege of privileges) statements.push(`IF has_table_privilege(${literal(runtime)},${literal(`${schema}.${table}`)},${literal(privilege)}) IS DISTINCT FROM ${allowed.includes(privilege)}
      OR has_table_privilege(${literal(backup)},${literal(`${schema}.${table}`)},${literal(privilege)}) IS DISTINCT FROM ${privilege === 'SELECT'}
      THEN RAISE EXCEPTION 'Meeting 3 table ACL differs: ${table}/${privilege}'; END IF;`);
  }
  for (const [sequence, allowed] of Object.entries(acl.sequences)) {
    for (const privilege of sequencePrivileges) statements.push(`IF has_sequence_privilege(${literal(runtime)},${literal(`${schema}.${sequence}`)},${literal(privilege)}) IS DISTINCT FROM ${allowed.includes(privilege)}
      OR has_sequence_privilege(${literal(backup)},${literal(`${schema}.${sequence}`)},${literal(privilege)}) IS DISTINCT FROM ${privilege === 'SELECT'}
      THEN RAISE EXCEPTION 'Meeting 3 sequence ACL differs: ${sequence}/${privilege}'; END IF;`);
  }
  for (const type of acl.types) statements.push(`IF NOT has_type_privilege(${literal(runtime)},${literal(`${ident(schema)}.${ident(type)}`)},'USAGE')
      OR NOT has_type_privilege(${literal(backup)},${literal(`${ident(schema)}.${ident(type)}`)},'USAGE')
      THEN RAISE EXCEPTION 'Meeting 3 type ACL differs: ${type}'; END IF;`);
  statements.push(`IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=${literal(schema)} AND has_function_privilege(${literal(runtime)},p.oid,'EXECUTE') IS DISTINCT FROM
      ((p.proname||'('||oidvectortypes(p.proargtypes)||')')=ANY(ARRAY[${(acl.routineExecute||[]).map(literal).join(',')}]::text[])))
      THEN RAISE EXCEPTION 'Meeting 3 routine ACL differs'; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE n.nspname=${literal(schema)} AND (a.grantee=0 OR a.grantee=(SELECT oid FROM pg_roles WHERE rolname=${literal(backup)})))
      THEN RAISE EXCEPTION 'Meeting 3 PUBLIC/backup routine grant'; END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(att.attacl) a WHERE n.nspname=${literal(schema)} AND att.attnum>0
      AND a.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=${literal(runtime)}),(SELECT oid FROM pg_roles WHERE rolname=${literal(backup)})))
      THEN RAISE EXCEPTION 'Meeting 3 unreviewed column grant'; END IF;
    END $verify$;`,'COMMIT;');
  return (verifyOnly ? statements.slice(verifyStart,-1) : statements).join('\n');
}
function postflight(identity) {
  const table = identity.service === 'crm-access' ? 'crm_chat_attachments' : identity.service === 'crm-intake' ? 'mail_intake_sources' : 'deal_timeline';
  const schema = identity.schema;
  const entry = inventory.owners[identity.service];
  const relation = `t.relname=${literal(table)} AND n.nspname=${literal(schema)}`;
  const definitions = `(SELECT regexp_replace(pg_get_constraintdef(c.oid), '[\\s"]', '', 'g') FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE ${relation} AND c.convalidated AND c.conname=`;
  const fkeys = identity.service === 'crm-access' ? [
    ['crm_chat_attachments_conversation_id_workspace_id_fkey', 'FOREIGNKEY(conversation_id,workspace_id)REFERENCEScrm_access.crm_chat_conversations(id,workspace_id)ONDELETERESTRICT'],
    ['crm_chat_attachments_message_id_conversation_id_workspace__fkey', 'FOREIGNKEY(message_id,conversation_id,workspace_id)REFERENCEScrm_access.crm_chat_messages(id,conversation_id,workspace_id)ONDELETERESTRICT']
  ] : identity.service === 'crm-intake' ? [
    ['mail_intake_sources_entry_binding_fkey', 'FOREIGNKEY(workspace_id,entry_id)REFERENCEScrm_intake.inbox_entries(workspace_id,id)ONUPDATERESTRICTONDELETERESTRICT']
  ] : [];
  const foreignKeys = fkeys.map(([name, definition]) => `${definitions}${literal(name)})=${literal(definition)}`).join(' AND ') || 'true';
  const triggerSql = identity.service === 'crm-access' ?
    "(t.tgname='chat_attachment_guard' AND p.proname='guard_chat_attachment' AND t.tgtype=27) OR (t.tgname='workspace_closure_business_guard' AND p.proname='guard_workspace_business' AND t.tgtype=31)" :
    "(t.tgname='mail_intake_source_immutable' AND p.proname='mail_intake_source_immutable' AND t.tgtype=27) OR (t.tgname='guard_workspace_closure' AND p.proname='guard_workspace_business_write' AND t.tgtype=7)";
  const state = psql(identity, `SELECT json_build_object(
    'foreignKeys', COALESCE((${foreignKeys}),false),
    'guards', ${identity.service === 'crm-sales' ? 'true' : `(SELECT count(*)=2 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid AND p.pronamespace=n.oid WHERE n.nspname=${literal(schema)} AND c.relname=${literal(table)} AND NOT t.tgisinternal AND t.tgenabled='O' AND (${triggerSql}))`},
    'immutable', ${entry.immutableRoutine ? `(SELECT count(*)=1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)} AND p.proname=${literal(entry.immutableRoutine.name)} AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND md5(p.prosrc)=${literal(entry.immutableRoutine.bodyMd5)})` : 'true'},
    'checks', ${identity.service === 'crm-access' ? `(SELECT count(*)=6 AND bool_and(c.convalidated) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE ${relation} AND c.contype='c')` : identity.service === 'crm-intake' ? `(SELECT count(*)=2 AND bool_and(c.convalidated) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE ${relation} AND c.contype='c' AND c.conname IN ('mail_intake_sources_source_hash_check','mail_intake_sources_actor_check'))` : `(SELECT count(*)=2 AND bool_and(c.convalidated) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE ${relation} AND c.contype='c' AND c.conname IN ('deal_timeline_kind_check','deal_timeline_details_check') AND pg_get_constraintdef(c.oid) LIKE '%ASSIGNEE_CHANGED%')`},
    'fence', (SELECT count(*)=1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)} AND p.proname='assert_workspace_open' AND p.pronargs=1 AND p.proargtypes='2950'::oidvector)
  )::text;`);
  assert(Object.values(state).every(value => value === true), `${identity.service} meeting 3 constraints or guards differ`);
}

function migrate(identity, sha, acl) {
  const image = `aerocrm/${identity.service}:${sha}`;
  execute(`${identity.service} Prisma Meeting 3 migration`, 'docker', [
    'run','--rm','--network','host','--env','NODE_ENV','--env',identity.key,
    '--entrypoint','node',image,'node_modules/prisma/build/index.js','migrate','deploy',
    '--schema','prisma/schema.prisma'], {env:{...process.env,...identity.values}});
  verifyRows(identity.service,migrationRows(identity),true);
  psql(identity,aclSql(identity,acl),false);
  postflight(identity);
}
if (process.argv.length === 3 && process.argv[2] === '--policy-self-test') {
  assert.equal(inventory.schemaVersion,1);
  assert.deepEqual(Object.keys(inventory.owners).sort(),services);
  for (const service of services) {
    const entry = reviewed(service);
    const expected = Object.entries(entry.migrations);
    const row = ([migration_name,checksum]) => ({migration_name,checksum,finished:true,rolled_back:false});
    verifyRows(service,expected.slice(0,-1).map(row));
    verifyRows(service,expected.map(row),true);
    assert.throws(() => verifyRows(service,[...expected.slice(0,-1).map(row),{...row(expected.at(-1)),checksum:'0'.repeat(64)}]),/checksum mismatch/);
    const identity = {service,schema:service.replace('-','_'),owner:`aerocrm_${service.replace('-','_')}_migration`,
      runtime:`aerocrm_${service.replace('-','_')}_runtime`,backup:`aerocrm_${service.replace('-','_')}_backup`,database:`aerocrm_${service.replace('-','_')}`};
    const acl = {tables:Object.fromEntries(entry.tables.map(name => [name,['SELECT']])),sequences:entry.sequences,
      types:entry.types,routines:entry.routines,routineExecute:entry.routineExecute};
    const sql = aclSql(identity,acl);
    assert(sql.includes('crm_admissions_position_seq') === (service === 'crm-access'));
    assert(sql.includes('is_valid_custom_role_permissions(text[])') === (service === 'crm-access'));
    const readOnly = aclSql(identity,acl,true);
    assert(readOnly.startsWith('DO $verify$ BEGIN'));
    assert(readOnly.includes('Meeting 3 table ACL differs'));
    assert(readOnly.includes('Meeting 3 routine ACL differs'));
    if (entry.types.length) assert(readOnly.includes(`'"${identity.schema}"."${entry.types[0]}"'`));
    assert(readOnly.endsWith('END $verify$;'));
    assert(!/^(?:BEGIN|COMMIT|GRANT|REVOKE|SET LOCAL)\b/m.test(readOnly));
  }
  const access = Object.entries(reviewed('crm-access').migrations).map(([migration_name,checksum]) =>
    ({migration_name,checksum,finished:true,rolled_back:false}));
  verifyRows('crm-access',[{...resolvedAccessBaseline,finished:false,rolled_back:true},...access],true);
  console.log('Meeting 3 migration policy fixtures verified');
  process.exit(0);
}
assert.equal(process.platform,'linux','Meeting 3 migrations must run on Linux target');
assert.equal(fs.realpathSync('.'),'/opt/aerocrm','Run from /opt/aerocrm');
const readOnlyMode = ['--read-only-preflight','--read-only-postflight'].includes(process.argv[2]) ? process.argv[2] : null;
const [sha,envHash] = process.argv.slice(readOnlyMode ? 3 : 2);
assert.equal(process.argv.length,readOnlyMode ? 5 : 4);
assert(/^[a-f0-9]{40}$/.test(sha) && /^[a-f0-9]{64}$/.test(envHash));
const manifest = validateManifest(JSON.parse(fs.readFileSync(process.env.BACKEND_MANIFEST_PATH,'utf8')));
assert.equal(manifest.releaseSha,sha);
assert(uniformManifest(manifest),'Meeting 3 migration requires full exact-SHA backend manifest');
const identities = services.map(privateIdentity);
const lines = identities.map(identity => `${sha256(identity.bytes)}  ./${identity.service}.env\n`).join('');
assert.equal(sha256(lines),envHash,'Meeting 3 private env aggregate hash mismatch');
// Every owner is checked before the first DDL; a rerun may find one applied and the other pending.
const acls = identities.map(identity => imageInventory(identity,sha,manifest));
identities.forEach(verifyDatabaseIdentity);
identities.forEach(identity => verifyRows(identity.service,migrationRows(identity)));
if (readOnlyMode) {
  if (readOnlyMode === '--read-only-postflight') for (const identity of identities) {
    verifyRows(identity.service,migrationRows(identity),true);
    psql(identity,aclSql(identity,acls[services.indexOf(identity.service)],true),false);
    postflight(identity);
  }
  console.log(`Meeting 3 ${readOnlyMode.slice(12)} verified: ${services.join(', ')}`);
  process.exit(0);
}
for (const [index,identity] of identities.entries()) {
  migrate(identity,sha,acls[index]);
  console.log(`Meeting 3 migration and ACL verified: ${identity.service}`);
}
