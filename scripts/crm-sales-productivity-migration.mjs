#!/usr/bin/env node
// Reviewed two-service additive migration. Called under backend release.lock before image switch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { validateManifest, uniformManifest } from './backend-release-state.mjs';

const inventory = JSON.parse(fs.readFileSync(new URL('./crm-sales-productivity-reviewed-inventory.json', import.meta.url), 'utf8'));
const services = ['crm-sales', 'crm-customers'];
const migration = {
  'crm-sales': '20261016011000_sales_productivity_timeline_details',
  'crm-customers': '20261016010000_mail_templates'
};
const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const literal = value => `'${value.replaceAll("'", "''")}'`;
const ident = value => { assert(/^[a-z_][a-z0-9_]*$/.test(value)); return `"${value}"`; };
function execute(label, binary, args, options = {}) {
  try { return execFileSync(binary, args, { encoding:'utf8', stdio:['pipe','pipe','pipe'], timeout:180_000,
    maxBuffer:8 * 1024 * 1024, ...options }).trim(); }
  catch (error) { throw new Error(`${label} failed${error.code === 'E2BIG' ? ' (E2BIG)' : ''}; private command output suppressed`); }
}
function reviewed(service) {
  const entry = inventory.owners[service];
  assert(entry && Object.keys(entry.migrations).at(-1) === migration[service], 'Reviewed productivity migration missing');
  assert(Object.values(entry.migrations).every(value => /^[a-f0-9]{64}$/.test(value)));
  assert(/^[a-f0-9]{64}$/.test(entry.aclSha256));
  const expectedTables = service === 'crm-sales'
    ? { loss_reason_settings:['SELECT','INSERT','UPDATE'], loss_reason_commands:['SELECT','INSERT'], bulk_assignment_commands:['SELECT','INSERT'] }
    : { mail_template_settings:['SELECT','INSERT','UPDATE'], mail_template_commands:['SELECT','INSERT'] };
  assert.deepEqual(entry.newTables, expectedTables);
  assert.deepEqual(entry.newRoutines, service === 'crm-sales' ? [] : ['reject_mail_template_command_mutation']);
  assert(Array.isArray(entry.newTriggers) && entry.newTriggers.length >= 5);
  assert(Array.isArray(entry.newColumns) && entry.newColumns.length >= 10);
  if (service === 'crm-sales') assert.deepEqual(entry.dealColumns,[
    'deals:lost_at:timestamp(3) without time zone:false',
    'deals:loss_reason_id:uuid:false',
    'deals:loss_reason_title:character varying(200):false'
  ]);
  if (service === 'crm-sales') assert(/^[a-f0-9]{64}$/.test(entry.timelineDetailsCheckSha256));
  assert(Object.values(entry.newTables).every(value => Array.isArray(value)));
  return entry;
}
function privateIdentity(service) {
  const schema = service.replace('-', '_');
  const owner = `aerocrm_${schema}_migration`;
  const file = `/opt/aerocrm/env/migrations/${service}.env`;
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && fs.realpathSync(file) === file,
    `Expected private regular migration env: ${service}`);
  const bytes = fs.readFileSync(file);
  let values;
  try { values = parseEnv(bytes.toString('utf8')); }
  catch { throw new Error(`Invalid private ${service} migration env`); }
  const key = `${schema.toUpperCase()}_DATABASE_URL`;
  assert.deepEqual(Object.keys(values).sort(), [key,'NODE_ENV'].sort());
  assert.equal(values.NODE_ENV, 'production');
  const url = new URL(values[key]);
  assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' &&
    (!url.port || url.port === '5432') && url.pathname === `/aerocrm_${schema}` &&
    decodeURIComponent(url.username) === owner && !!url.password && !url.hash &&
    [...url.searchParams.keys()].length === 4 &&
    Object.entries({schema,connection_limit:'1',pool_timeout:'10',connect_timeout:'10'}).every(([name,value]) =>
      url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === value),
    `Unexpected ${service} migration database identity`);
  return { service, schema, owner, key, values, bytes, password:decodeURIComponent(url.password),
    database:`aerocrm_${schema}`, runtime:`aerocrm_${schema}_runtime`, backup:`aerocrm_${schema}_backup` };
}
function psql(identity, statement, json = true, readOnly = false) {
  const env = {...process.env,PGPASSWORD:identity.password};
  if (readOnly) env.PGOPTIONS = '-c default_transaction_read_only=on';
  const output = execute(`${identity.service} database inspection`, 'docker', ['run','--rm','-i','--network','host',
    '--env','PGPASSWORD',...(readOnly ? ['--env','PGOPTIONS'] : []),'--entrypoint','psql','postgres:18','-X','-qAt','-v','ON_ERROR_STOP=1',
    '-h','127.0.0.1','-p','5432','-U',identity.owner,'-d',identity.database],
    {env,input:statement});
  return json ? JSON.parse(output) : output;
}
function rows(identity, readOnly = false) {
  return psql(identity, `BEGIN READ ONLY; SELECT coalesce(json_agg(row_to_json(r) ORDER BY r.name),'[]'::json)::text FROM
    (SELECT migration_name AS name,checksum,finished_at IS NOT NULL AS finished,
      rolled_back_at IS NOT NULL AS "rolledBack" FROM ${ident(identity.schema)}._prisma_migrations) r; ROLLBACK;`,true,readOnly);
}
function verifyRows(service, observed, allowPrevious = true) {
  const expected = Object.entries(reviewed(service).migrations);
  const earlier = service === 'crm-sales' ? [expected.length-1,expected.length-2] : [expected.length-1];
  assert([expected.length, ...(allowPrevious ? earlier : [])].includes(observed.length),
    `Unexpected ${service} migration history`);
  assert.deepEqual(observed.map(row => row.name), expected.slice(0,observed.length).map(([name]) => name));
  observed.forEach((row,index) => {
    assert.equal(row.checksum, expected[index][1], `${service} migration checksum mismatch: ${row.name}`);
    assert(row.finished === true && row.rolledBack === false, `${service} migration incomplete: ${row.name}`);
  });
}
function imageInventory(identity, sha, manifest) {
  const image = `aerocrm/${identity.service}:${sha}`;
  assert.equal(execute(`${identity.service} image ID`, 'docker', ['image','inspect','--format','{{.Id}}',image]),
    manifest.services[identity.service].imageId);
  assert.equal(execute(`${identity.service} revision`, 'docker', ['image','inspect','--format',
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
  assert.deepEqual(observed.migrations,expected.migrations,`${identity.service} image migration inventory mismatch`);
  assert.equal(observed.aclSha256,expected.aclSha256,`${identity.service} image ACL inventory mismatch`);
  assert(observed.acl.version === 1 && observed.acl.service === identity.service);
  assert.deepEqual(Object.fromEntries(Object.entries(expected.newTables).map(([name]) => [name,observed.acl.tables[name]])),expected.newTables);
  assert(expected.newRoutines.every(name => observed.acl.routines.includes(name)));
  return observed.acl;
}
function aclSql(identity, acl) {
  const {schema,owner,runtime,backup} = identity;
  const names = Object.keys(acl.tables).sort();
  const routines = [...acl.routines].sort();
  assert.deepEqual(acl.sequences,{});
  assert(!acl.columnPrivileges || Object.keys(acl.columnPrivileges).length === 0);
  const sql = ['BEGIN;',"SET LOCAL lock_timeout='5s';","SET LOCAL statement_timeout='30s';",
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`];
  for (const [table, allowed] of Object.entries(acl.tables)) {
    assert(allowed.every(value => privileges.includes(value)));
    if (allowed.length) sql.push(`GRANT ${allowed.join(', ')} ON TABLE ${ident(schema)}.${ident(table)} TO ${ident(runtime)};`);
    sql.push(`GRANT SELECT ON TABLE ${ident(schema)}.${ident(table)} TO ${ident(backup)};`);
  }
  for (const signature of acl.routineExecute || []) {
    assert(/^[a-z_]+\((?:uuid|integer|text)(?:,(?:uuid|integer|text))*\)$/.test(signature));
    sql.push(`GRANT EXECUTE ON FUNCTION ${ident(schema)}.${signature} TO ${ident(runtime)};`);
  }
  sql.push(`DO $policy$ BEGIN
    IF current_database()<>${literal(identity.database)} OR current_user<>${literal(owner)}
      OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=${literal(schema)})<>${literal(owner)}
      THEN RAISE EXCEPTION 'CRM productivity database owner differs'; END IF;
    IF (SELECT array_agg(c.relname::text ORDER BY c.relname::text) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p','v','m','f')) IS DISTINCT FROM ARRAY[${names.map(literal).join(',')}]::text[]
      THEN RAISE EXCEPTION 'CRM productivity table inventory differs'; END IF;
    IF (SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname::text),'{}'::text[]) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=${literal(schema)} AND c.relkind='S')<>'{}'::text[]
      OR (SELECT coalesce(array_agg(t.typname::text ORDER BY t.typname::text),'{}'::text[]) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname=${literal(schema)} AND t.typtype='e') IS DISTINCT FROM ARRAY[${acl.types.map(literal).sort().join(',')}]::text[]
      THEN RAISE EXCEPTION 'CRM productivity sequence/type inventory differs'; END IF;
    IF (SELECT array_agg(DISTINCT p.proname::text ORDER BY p.proname::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=${literal(schema)}) IS DISTINCT FROM ARRAY[${routines.map(literal).join(',')}]::text[]
      OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)})<>${routines.length}
      THEN RAISE EXCEPTION 'CRM productivity routine inventory differs'; END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND pg_get_userbyid(c.relowner)<>${literal(owner)})
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)} AND pg_get_userbyid(p.proowner)<>${literal(owner)})
      THEN RAISE EXCEPTION 'CRM productivity object owner differs'; END IF;`);
  sql.push(`IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN (${[runtime,backup,owner].map(literal).join(',')})
      AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
        OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)))
      THEN RAISE EXCEPTION 'CRM productivity role must be unprivileged'; END IF;`);
  for (const [table, allowed] of Object.entries(acl.tables)) {
    for (const privilege of privileges) sql.push(`IF has_table_privilege(${literal(runtime)},${literal(`${schema}.${table}`)},${literal(privilege)}) IS DISTINCT FROM ${allowed.includes(privilege)}
      OR has_table_privilege(${literal(backup)},${literal(`${schema}.${table}`)},${literal(privilege)}) IS DISTINCT FROM ${privilege === 'SELECT'}
      THEN RAISE EXCEPTION 'CRM productivity table ACL differs: ${table}/${privilege}'; END IF;`);
    sql.push(`IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=${literal(`${schema}.${table}`)}::regclass AND a.grantee=0)
      THEN RAISE EXCEPTION 'CRM productivity PUBLIC table grant: ${table}'; END IF;`);
  }
  sql.push(`IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=${literal(schema)} AND has_function_privilege(${literal(runtime)},p.oid,'EXECUTE') IS DISTINCT FROM
      ((p.proname||'('||replace(oidvectortypes(p.proargtypes),', ', ',')||')')=ANY(ARRAY[${(acl.routineExecute||[]).map(literal).join(',')}]::text[])))
      THEN RAISE EXCEPTION 'CRM productivity function runtime ACL differs'; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE n.nspname=${literal(schema)} AND (a.grantee=0 OR a.grantee=(SELECT oid FROM pg_roles WHERE rolname=${literal(backup)})))
      THEN RAISE EXCEPTION 'CRM productivity PUBLIC/backup function grant'; END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(att.attacl) a WHERE n.nspname=${literal(schema)} AND att.attnum>0
      AND a.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=${literal(runtime)}),(SELECT oid FROM pg_roles WHERE rolname=${literal(backup)})))
      THEN RAISE EXCEPTION 'CRM productivity unreviewed column grant'; END IF;
    IF (SELECT array_agg(c.relname||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull
      ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)}
      AND c.relname IN (${Object.keys(reviewed(identity.service).newTables).map(literal).join(',')})
      AND a.attnum>0 AND NOT a.attisdropped) IS DISTINCT FROM ARRAY[
        ${reviewed(identity.service).newColumns.map(literal).join(',')} ]::text[]
      THEN RAISE EXCEPTION 'CRM productivity column inventory differs'; END IF;
    IF (SELECT array_agg(c.relname||':'||t.tgname||':'||p.proname ORDER BY c.relname,t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=${literal(schema)} AND c.relname IN (${Object.keys(reviewed(identity.service).newTables).map(literal).join(',')})
        AND NOT t.tgisinternal AND t.tgenabled='O') IS DISTINCT FROM ARRAY[
          ${reviewed(identity.service).newTriggers.map(literal).join(',')} ]::text[]
      THEN RAISE EXCEPTION 'CRM productivity closure/immutability guards differ'; END IF;
    ${identity.service === 'crm-sales' ? `IF (SELECT array_agg('deals:'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=${literal(`${schema}.deals`)}::regclass
        AND a.attname IN ('lost_at','loss_reason_id','loss_reason_title') AND a.attnum>0 AND NOT a.attisdropped)
        IS DISTINCT FROM ARRAY[${reviewed(identity.service).dealColumns.map(literal).join(',')}]::text[]
      OR NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=${literal(`${schema}.deals`)}::regclass
        AND c.conname='deals_loss_reason_snapshot_check' AND c.contype='c' AND c.convalidated)
      OR NOT EXISTS (SELECT 1 FROM pg_class i JOIN pg_index x ON x.indexrelid=i.oid
        WHERE i.relnamespace=${literal(schema)}::regnamespace AND i.relname='deals_loss_report_idx'
          AND x.indrelid=${literal(`${schema}.deals`)}::regclass AND x.indisvalid)
      OR NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=${literal(`${schema}.deal_timeline`)}::regclass
        AND c.conname='deal_timeline_details_check' AND c.contype='c' AND c.convalidated
        AND encode(sha256(convert_to(pg_get_constraintdef(c.oid),'UTF8')),'hex')=${literal(reviewed(identity.service).timelineDetailsCheckSha256)})
      THEN RAISE EXCEPTION 'CRM productivity loss lifecycle schema differs'; END IF;` : ''}
    END $policy$;`,'COMMIT;');
  return sql.join('\n');
}
function migrate(identity, sha, acl) {
  verifyRows(identity.service,rows(identity));
  const image = `aerocrm/${identity.service}:${sha}`;
  execute(`${identity.service} Prisma productivity migration`,'docker',[
    'run','--rm','--network','host','--env','NODE_ENV','--env',identity.key,
    '--entrypoint','node',image,'node_modules/prisma/build/index.js','migrate','deploy',
    '--schema','prisma/schema.prisma'], {env:{...process.env,...identity.values}});
  verifyRows(identity.service,rows(identity),false);
  psql(identity,aclSql(identity,acl),false);
}
function recoverySnapshot(identity, newTables) {
  const {schema,owner,runtime,backup}=identity;
  const quoted = newTables.map(literal).join(',');
  return psql(identity, `BEGIN READ ONLY;
    SET LOCAL statement_timeout='15s';
    SELECT json_build_object(
      'database',current_database(),'role',current_user,
      'schemaOwner',(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=${literal(schema)}),
      'relations',(SELECT coalesce(json_agg(json_build_object('name',c.relname,'owner',pg_get_userbyid(c.relowner)) ORDER BY c.relname),'[]'::json)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p','v','m','f')),
      'sequences',(SELECT coalesce(json_agg(c.relname ORDER BY c.relname),'[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND c.relkind='S'),
      'types',(SELECT coalesce(json_agg(t.typname ORDER BY t.typname),'[]'::json) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=${literal(schema)} AND t.typtype='e'),
      'routines',(SELECT coalesce(json_agg(json_build_object('name',p.proname,'signature',p.proname||'('||replace(oidvectortypes(p.proargtypes),', ', ',')||')','owner',pg_get_userbyid(p.proowner)) ORDER BY p.proname),'[]'::json)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)}),
      'roles',(SELECT coalesce(json_agg(json_build_object('name',r.rolname,'super',r.rolsuper,'createDb',r.rolcreatedb,'createRole',r.rolcreaterole,'replication',r.rolreplication,'bypassRls',r.rolbypassrls,'inherit',r.rolinherit,'memberOf',(SELECT count(*) FROM pg_auth_members m WHERE m.member=r.oid)) ORDER BY r.rolname),'[]'::json)
        FROM pg_roles r WHERE r.rolname IN (${[owner,runtime,backup].map(literal).join(',')})),
      'tableGrants',(SELECT coalesce(json_agg(json_build_object('table',c.relname,'grantee',coalesce(grantee.rolname,'PUBLIC'),'privilege',a.privilege_type::text) ORDER BY c.relname,grantee.rolname,a.privilege_type::text),'[]'::json)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a LEFT JOIN pg_roles grantee ON grantee.oid=a.grantee
        WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p','v','m','f')),
      'routineGrants',(SELECT coalesce(json_agg(json_build_object('signature',p.proname||'('||replace(oidvectortypes(p.proargtypes),', ', ',')||')','grantee',coalesce(grantee.rolname,'PUBLIC'),'privilege',a.privilege_type::text) ORDER BY p.proname,grantee.rolname),'[]'::json)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles grantee ON grantee.oid=a.grantee WHERE n.nspname=${literal(schema)}),
      'columnGrants',(SELECT count(*) FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(att.attacl) a
        WHERE n.nspname=${literal(schema)} AND att.attnum>0 AND a.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=${literal(runtime)}),(SELECT oid FROM pg_roles WHERE rolname=${literal(backup)}))),
      'newColumns',(SELECT coalesce(json_agg(c.relname||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull ORDER BY c.relname,a.attnum),'[]'::json)
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND c.relname IN (${quoted}) AND a.attnum>0 AND NOT a.attisdropped),
      'newTriggers',(SELECT coalesce(json_agg(c.relname||':'||t.tgname||':'||p.proname ORDER BY c.relname,t.tgname),'[]'::json)
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=${literal(schema)} AND c.relname IN (${quoted}) AND NOT t.tgisinternal AND t.tgenabled='O'),
      'newConstraints',(SELECT coalesce(json_agg(json_build_object('name',c.conname,'validated',c.convalidated) ORDER BY c.conname),'[]'::json)
        FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=${literal(schema)} AND r.relname IN (${quoted})),
      'newIndexes',(SELECT coalesce(json_agg(json_build_object('name',i.relname,'valid',x.indisvalid,'ready',x.indisready) ORDER BY i.relname),'[]'::json)
        FROM pg_index x JOIN pg_class r ON r.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=${literal(schema)} AND r.relname IN (${quoted})),
      'dealColumns',${identity.service === 'crm-sales' ? `(SELECT coalesce(json_agg('deals:'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull ORDER BY a.attnum),'[]'::json)
        FROM pg_attribute a WHERE a.attrelid='crm_sales.deals'::regclass AND a.attname IN ('lost_at','loss_reason_id','loss_reason_title') AND a.attnum>0 AND NOT a.attisdropped)` : `'[]'::json`},
      'salesGuards',${identity.service === 'crm-sales' ? `(SELECT json_build_object('snapshot',EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='crm_sales.deals'::regclass AND c.conname='deals_loss_reason_snapshot_check' AND c.contype='c' AND c.convalidated),
        'reportIndex',EXISTS(SELECT 1 FROM pg_class i JOIN pg_index x ON x.indexrelid=i.oid WHERE i.relnamespace='crm_sales'::regnamespace AND i.relname='deals_loss_report_idx' AND x.indrelid='crm_sales.deals'::regclass AND x.indisvalid),
        'timelineHash',(SELECT encode(sha256(convert_to(pg_get_constraintdef(c.oid),'UTF8')),'hex') FROM pg_constraint c WHERE c.conrelid='crm_sales.deal_timeline'::regclass AND c.conname='deal_timeline_details_check' AND c.contype='c' AND c.convalidated)))` : `'{}'::json`}
    ); ROLLBACK;`,true,true);
}
function verifyRecoverySnapshot(identity, acl, snapshot, salesPartial) {
  const {service,schema,owner,runtime,backup,database}=identity;
  const newTables=Object.keys(reviewed(service).newTables);
  const expectedTables=Object.keys(acl.tables).filter(name => salesPartial || !newTables.includes(name)).sort();
  assert.equal(snapshot.database,database); assert.equal(snapshot.role,owner); assert.equal(snapshot.schemaOwner,owner);
  assert.deepEqual(snapshot.relations.map(row => row.name),expectedTables);
  assert(snapshot.relations.every(row => row.owner===owner));
  assert.deepEqual(snapshot.sequences,[]); assert.deepEqual(snapshot.types,[...acl.types].sort());
  const expectedRoutines=acl.routines.filter(name => salesPartial || !reviewed(service).newRoutines.includes(name)).sort();
  assert.deepEqual(snapshot.routines.map(row => row.name),expectedRoutines);
  assert(snapshot.routines.every(row => row.owner===owner));
  assert.deepEqual(snapshot.roles.map(row => row.name),[backup,owner,runtime].sort());
  assert(snapshot.roles.every(row => !row.super && !row.createDb && !row.createRole && !row.replication && !row.bypassRls && !row.inherit && row.memberOf===0));
  assert.equal(snapshot.columnGrants,0);
  const grants=new Map();
  for (const row of snapshot.tableGrants) {
    assert(expectedTables.includes(row.table) && [owner,runtime,backup].includes(row.grantee));
    const key=`${row.table}:${row.grantee}`;
    grants.set(key,[...(grants.get(key)||[]),row.privilege]);
  }
  for (const table of expectedTables) {
    const expectedRuntime=newTables.includes(table) ? [] : acl.tables[table];
    const expectedBackup=newTables.includes(table) ? [] : ['SELECT'];
    assert.deepEqual((grants.get(`${table}:${runtime}`)||[]).sort(),[...expectedRuntime].sort());
    assert.deepEqual((grants.get(`${table}:${backup}`)||[]).sort(),expectedBackup);
  }
  const routineGrants=new Map();
  for (const row of snapshot.routineGrants) {
    assert([owner,runtime].includes(row.grantee));
    const key=`${row.signature}:${row.grantee}`;
    routineGrants.set(key,[...(routineGrants.get(key)||[]),row.privilege]);
  }
  for (const row of snapshot.routines) assert.deepEqual((routineGrants.get(`${row.signature}:${runtime}`)||[]).sort(),
    (acl.routineExecute||[]).includes(row.signature) ? ['EXECUTE'] : []);
  if (salesPartial) {
    assert.deepEqual(snapshot.newColumns,reviewed(service).newColumns);
    assert.deepEqual(snapshot.newTriggers,reviewed(service).newTriggers);
    assert.deepEqual(snapshot.dealColumns,reviewed(service).dealColumns);
    assert.equal(snapshot.salesGuards.snapshot,true); assert.equal(snapshot.salesGuards.reportIndex,true);
    assert.equal(snapshot.salesGuards.timelineHash,reviewed(service).timelineDetailsCheckSha256);
    const constraints = new Set(['loss_reason_settings_pkey','loss_reason_settings_version_check',
      'loss_reason_settings_reasons_check','loss_reason_commands_pkey','bulk_assignment_commands_pkey']);
    for (const entry of reviewed(service).newColumns) {
      const [table,column,,notNull] = entry.split(':');
      if (notNull === 'true') constraints.add(`${table}_${column}_not_null`);
    }
    assert.deepEqual(snapshot.newConstraints.map(row => row.name).sort(),[...constraints].sort());
    assert(snapshot.newConstraints.every(row => row.validated));
    const indexes=['loss_reason_settings_pkey','loss_reason_commands_pkey','loss_reason_commands_workspace_idx',
      'bulk_assignment_commands_pkey','bulk_assignment_commands_workspace_idx'];
    assert.deepEqual(snapshot.newIndexes.map(row => row.name).sort(),indexes.sort());
    assert(snapshot.newIndexes.every(row => row.valid && row.ready));
    const count=psql(identity,`BEGIN READ ONLY; SELECT json_build_object('settings',(SELECT count(*) FROM crm_sales.loss_reason_settings),
      'reasonsReceipts',(SELECT count(*) FROM crm_sales.loss_reason_commands),
      'bulkReceipts',(SELECT count(*) FROM crm_sales.bulk_assignment_commands))::text; ROLLBACK;`,true,true);
    assert.deepEqual(count,{settings:0,reasonsReceipts:0,bulkReceipts:0});
  } else {
    assert.deepEqual(snapshot.newColumns,[]); assert.deepEqual(snapshot.newTriggers,[]);
    assert.deepEqual(snapshot.newConstraints,[]); assert.deepEqual(snapshot.newIndexes,[]);
  }
}
if (process.argv.length === 3 && process.argv[2] === '--policy-self-test') {
  assert.equal(inventory.schemaVersion,1);
  assert.deepEqual(Object.keys(inventory.owners).sort(),[...services].sort());
  for (const service of services) {
    const entry = reviewed(service);
    const expected = Object.entries(entry.migrations);
    const row = ([name,checksum]) => ({name,checksum,finished:true,rolledBack:false});
    if (service === 'crm-sales') verifyRows(service,expected.slice(0,-2).map(row));
    verifyRows(service,expected.slice(0,-1).map(row));
    verifyRows(service,expected.map(row),false);
    assert.throws(() => verifyRows(service,[...expected.slice(0,-1).map(row),{...row(expected.at(-1)),checksum:'0'.repeat(64)}]),/checksum mismatch/);
    const identity = {service,schema:service.replace('-','_'),owner:`aerocrm_${service.replace('-','_')}_migration`,
      runtime:`aerocrm_${service.replace('-','_')}_runtime`,backup:`aerocrm_${service.replace('-','_')}_backup`,database:`aerocrm_${service.replace('-','_')}`};
    const acl = {tables:entry.newTables,sequences:{},types:[],routines:entry.newRoutines,routineExecute:[]};
    const sql = aclSql(identity,acl);
    assert(sql.includes('GRANT SELECT, INSERT, UPDATE ON TABLE'));
    assert(sql.includes(entry.newTriggers[0]));
  }
  console.log('CRM productivity migration policy fixtures verified');
  process.exit(0);
}
if (process.argv[2] === '--test-acl-sql') {
  assert.equal(process.argv.length,5,'Expected service and local ACL fixture');
  const service=process.argv[3];
  assert(services.includes(service),'Unknown ACL fixture service');
  const schema=service.replace('-','_');
  const acl=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
  assert.equal(acl.service,service);
  assert.deepEqual(Object.fromEntries(Object.entries(reviewed(service).newTables).map(([name]) => [name,acl.tables[name]])),
    reviewed(service).newTables,'ACL fixture differs from reviewed tables');
  const sql=Buffer.from(aclSql({service,schema,owner:`aerocrm_${schema}_migration`,
    runtime:`aerocrm_${schema}_runtime`,backup:`aerocrm_${schema}_backup`,database:`aerocrm_${schema}`},acl));
  for (let offset=0; offset<sql.length;) offset+=fs.writeSync(1,sql,offset,sql.length-offset);
  process.exit(0);
}
assert.equal(process.platform,'linux','CRM productivity migrations must run on Linux target');
assert.equal(fs.realpathSync('.'),'/opt/aerocrm','Run from /opt/aerocrm');
const recoveryPreflight = process.argv[2] === '--read-only-partial-recovery-preflight';
const [sha,envHash] = process.argv.slice(recoveryPreflight ? 3 : 2);
assert.equal(process.argv.length,recoveryPreflight ? 5 : 4);
assert(/^[a-f0-9]{40}$/.test(sha) && /^[a-f0-9]{64}$/.test(envHash),'Exact SHA and private env aggregate required');
const manifest = validateManifest(JSON.parse(fs.readFileSync(process.env.BACKEND_MANIFEST_PATH,'utf8')));
assert.equal(manifest.releaseSha,sha);
assert(uniformManifest(manifest),'CRM productivity migration requires full exact-SHA manifest');
const identities = services.map(privateIdentity);
const lines = [...identities].sort((a,b) => a.service.localeCompare(b.service))
  .map(identity => `${sha256(identity.bytes)}  ./${identity.service}.env\n`).join('');
assert.equal(sha256(lines),envHash,'CRM productivity private env aggregate hash mismatch');
// Inspect both immutable images and live histories before any DDL. A rerun may find
// Sales complete and Customers pending after a previous partial attempt.
const acls = identities.map(identity => imageInventory(identity,sha,manifest));
identities.forEach(identity => verifyRows(identity.service,rows(identity,recoveryPreflight)));
if (recoveryPreflight) {
  assert.equal(process.env.PGOPTIONS,undefined,'Recovery preflight controls read-only PostgreSQL options');
  for (const [index,identity] of identities.entries()) {
    const observed=rows(identity,true);
    const complete=identity.service==='crm-sales';
    assert.equal(observed.length,complete ? 13 : 9,'Partial CRM productivity migration state differs');
    const snapshot=recoverySnapshot(identity,Object.keys(reviewed(identity.service).newTables));
    verifyRecoverySnapshot(identity,acls[index],snapshot,complete);
  }
  console.log(JSON.stringify({readOnly:true,partialSalesProductivity:'verified',sourceSha:sha,
    salesMigrationCount:13,customersMigrationCount:9}));
  process.exit(0);
}
for (const [index,identity] of identities.entries()) {
  migrate(identity,sha,acls[index]);
  console.log(`CRM productivity migration and ACL verified: ${identity.service}`);
}
