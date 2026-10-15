#!/usr/bin/env node
// Reviewed additive CRM Sales migration, called under the canonical backend release lock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { validateManifest, uniformManifest } from './backend-release-state.mjs';

const migrations = [
  ['20260920000000_init_aerocrm', 'e9cf8e4a39ea31ea0663edea98e8fe97ebb50ee68be9bc1e8b3f8d8d3a6c2c9a'],
  ['20260923010000_sales_commerce', '04b371cfb2664da21cd6ffc3f62de88f2a7bf3b64f3bfec2b8ab6f7aaf84f433'],
  ['20260923030000_workspace_closure', 'bb118b4953dbb143cd79e8c6b1c453958c88a38ac709bc57e1c33235c29e7d4a'],
  ['20261001000000_crm_file_imports', 'd2c22df0df205a6b877db8cbc63cd79ad282597503f2cef7ae296a1bc668cd3a'],
  ['20261004000000_planner_customization', '36c56d3211d194b511b433222568ed3b9ae0d6f46b0bf45b41afe65b3f9289ad'],
  ['20261005000000_interaction_results', '1d1c8a5544ed021ca18f74c240530f715d6e5086c9c889fb8977ff8a0037fd75'],
  ['20261007030000_meeting3_workflows', 'cff0bc656ed9067d4301c9810f54ecdb14190469a78456e1234cb1c048b26062'],
  ['20261013000000_reminder_delivery_foreign_keys', '196d9b7073b3d64cfcc64e619f7c864a2385aedf5086067245ed5ef3c3819aa8'],
  ['20261014010000_stage_next_action_templates', '4b46859b917757ddbfb4e14cfe17cbbfbf8a5e11a8dc5de083c743a7d02a138b'],
  ['20261014020000_stage_duration_control', 'ad14c772257dfd9f9100d0d76cd01664604cfcb2d3d5cb6a8249aaade192d541'],
  ['20261015020000_activity_text_templates', 'f366fd6ba9a34d7b7838267a711b5ec80d386d3a6241fc557784be7987c9e1b1']
];
const aclSha256 = 'bc087e393bdd34d0aa0a1c3441665fb01b04700b2960c3bd21129cf1ecfab25e';
const envFile = '/opt/aerocrm/env/migrations/crm-sales.env';
const tables = ['activity_text_template_settings', 'activity_text_template_commands'];
const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const functionHashes = {
  'assert_workspace_open(uuid)': '60d8c3a0c7962e2d5387d46f2d65296d8aad10ce5e9b8434b1e8f1991c1fb78b',
  'guard_workspace_business_write()': 'eb74f68e07345c00fea4d3d5fdd4fe1f973dbf7d591ca8417c1d2a66093a56cc',
  'notify_live_change()': '9952f527d457305a42c98446d3b91baa5277a0981218fd35f5c291afa135a890',
  'reject_reminder_command_mutation()': '5075247498b6e3bcf48ad6a8c85e3c500b531edd832d630f60121c684873e4dd',
  'track_deal_stage_entry()': '93ce0f3e1f7070b2bf60a6d5bbc85bce88111b5de0b1b8b168a62e6af1fb000e',
  'workspace_closure_fence_immutable()': 'f51abfcd8a5620d5f339100aabc0d8b70c4d0da961b5926b9314311c2738af23'
};
const legacyTriggerCount = 60;
const legacyTriggerSha256 = '643e87af7a20c656e509bb15d1f77cdc97e05ed73887357e75f5bee0522dfac0';
function run(label, binary, args, options = {}) {
  try { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'],
    timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...options }).trim(); }
  catch { throw new Error(`${label} failed; private command output suppressed`); }
}
function verifyHistory(rows) {
  assert([migrations.length - 1, migrations.length].includes(rows.length), 'Unexpected CRM Sales migration history length');
  rows.forEach((row, index) => {
    assert.deepEqual(Object.keys(row).sort(), ['checksum','finished','name','rolledBack']);
    assert.equal(row.name, migrations[index][0], 'CRM Sales migration order mismatch');
    assert.equal(row.checksum, migrations[index][1], `CRM Sales migration checksum differs: ${row.name}`);
    assert(row.finished === true && row.rolledBack === false, `CRM Sales migration incomplete: ${row.name}`);
  });
}
function expectedSchema(installed) {
  return installed ? {
    settings: ['created_at:timestamp(3) without time zone:NO:CURRENT_TIMESTAMP::', 'templates:jsonb:NO:::',
      'updated_at:timestamp(3) without time zone:NO:::', 'version:integer:NO:::', 'workspace_id:uuid:NO:::'],
    commands: ['actor_subject:character varying(256):NO:::', 'command_id:uuid:NO:::',
      'created_at:timestamp(3) without time zone:NO:CURRENT_TIMESTAMP::', 'request_hash:character(64):NO:::',
      'result:jsonb:NO:::', 'workspace_id:uuid:NO:::'],
    relations: [
      'activity_text_template_commands:aerocrm_crm_sales_migration:r:p:false:false',
      'activity_text_template_settings:aerocrm_crm_sales_migration:r:p:false:false'
    ],
    triggers: [
      'activity_text_template_commands:activity_text_template_commands_append_only:27:O:crm_sales.reject_reminder_command_mutation()::',
      'activity_text_template_commands:activity_text_template_commands_no_truncate:34:O:crm_sales.reject_reminder_command_mutation()::',
      'activity_text_template_commands:guard_workspace_closure:7:O:crm_sales.guard_workspace_business_write()::',
      'activity_text_template_settings:activity_text_template_settings_live_change:21:O:crm_sales.notify_live_change():776f726b73706163655f696400:',
      'activity_text_template_settings:guard_workspace_closure:31:O:crm_sales.guard_workspace_business_write()::'
    ],
    indexes: [
      'activity_text_template_commands_pkey:true:true:true:true:CREATE UNIQUE INDEX activity_text_template_commands_pkey ON crm_sales.activity_text_template_commands USING btree (command_id)',
      'activity_text_template_commands_workspace_idx:false:false:true:true:CREATE INDEX activity_text_template_commands_workspace_idx ON crm_sales.activity_text_template_commands USING btree (workspace_id, created_at)',
      'activity_text_template_settings_pkey:true:true:true:true:CREATE UNIQUE INDEX activity_text_template_settings_pkey ON crm_sales.activity_text_template_settings USING btree (workspace_id)'
    ],
    checks: [
      'activity_text_template_commands_actor_subject_not_null:n:true:NOT NULL actor_subject',
      'activity_text_template_commands_command_id_not_null:n:true:NOT NULL command_id',
      'activity_text_template_commands_created_at_not_null:n:true:NOT NULL created_at',
      'activity_text_template_commands_pkey:p:true:PRIMARY KEY (command_id)',
      'activity_text_template_commands_request_hash_not_null:n:true:NOT NULL request_hash',
      'activity_text_template_commands_result_not_null:n:true:NOT NULL result',
      'activity_text_template_commands_workspace_id_not_null:n:true:NOT NULL workspace_id',
      'activity_text_template_settings_created_at_not_null:n:true:NOT NULL created_at',
      'activity_text_template_settings_pkey:p:true:PRIMARY KEY (workspace_id)',
      "activity_text_template_settings_templates_check:c:true:CHECK ((jsonb_typeof(templates) = 'array'::text))",
      'activity_text_template_settings_templates_not_null:n:true:NOT NULL templates',
      'activity_text_template_settings_updated_at_not_null:n:true:NOT NULL updated_at',
      'activity_text_template_settings_version_check:c:true:CHECK ((version > 0))',
      'activity_text_template_settings_version_not_null:n:true:NOT NULL version',
      'activity_text_template_settings_workspace_id_not_null:n:true:NOT NULL workspace_id'
    ]
  } : { settings: [], commands: [], relations: [], triggers: [], indexes: [], checks: [] };
}
function verifySchema(value, installed) {
  assert.deepEqual(value, expectedSchema(installed), 'CRM Sales activity template schema differs');
}
function verifyAcl(value, installed) {
  const expected = installed ? {
    activity_text_template_commands: { runtime: ['INSERT','SELECT'], backup: ['SELECT'],
      unexpected: 0, grantOptions: 0, columns: 0 },
    activity_text_template_settings: { runtime: ['INSERT','SELECT','UPDATE'], backup: ['SELECT'],
      unexpected: 0, grantOptions: 0, columns: 0 }
  } : {};
  assert.deepEqual(value, expected, 'CRM Sales activity template ACL differs');
}
function verifyRecoverableAcl(value) {
  assert.deepEqual(Object.keys(value).sort(), tables.slice().sort(), 'CRM Sales activity template ACL tables differ');
  for (const table of tables) {
    const actual = value[table];
    const allowed = table.endsWith('settings') ? ['INSERT','SELECT','UPDATE'] : ['INSERT','SELECT'];
    assert.deepEqual(Object.keys(actual).sort(), ['backup','columns','grantOptions','runtime','unexpected']);
    assert(actual.runtime.every(privilege => allowed.includes(privilege)) &&
      actual.backup.every(privilege => privilege === 'SELECT') &&
      actual.unexpected === 0 && actual.grantOptions === 0 && actual.columns === 0,
    'CRM Sales activity template ACL has unreviewed grants');
  }
}
function verifySecurity(value) {
  assert.deepEqual(value.schema,{owner:'aerocrm_crm_sales_migration',runtimeUsage:true,
    runtimeCreate:false,backupUsage:true,backupCreate:false,publicUsage:false,publicCreate:false,
    unexpectedGrants:0,grantOptions:0},
  'CRM Sales schema owner/usage differs');
  assert.deepEqual(value.roles,[
    'aerocrm_crm_sales_backup', 'aerocrm_crm_sales_migration', 'aerocrm_crm_sales_runtime'
  ].map(name=>({name,superuser:false,createDb:false,createRole:false,replication:false,
    bypassRls:false,inherit:false,memberships:0})), 'CRM Sales role privileges differ');
  assert.deepEqual(Object.keys(value.functions).sort(),Object.keys(functionHashes).sort(),
    'CRM Sales protected function inventory differs');
  for (const [name,expectedHash] of Object.entries(functionHashes)) {
    const item=value.functions[name];
    assert.equal(sha256(item.body),expectedHash,`CRM Sales protected function definition differs: ${name}`);
    assert.deepEqual({...item,body:undefined},{name,owner:'aerocrm_crm_sales_migration',
      definer:false,volatile:'v',parallel:'u',
      config:name==='reject_reminder_command_mutation()'?null:
        name==='notify_live_change()'?['search_path=pg_catalog']:['search_path=pg_catalog, crm_sales'],
      runtime:name==='assert_workspace_open(uuid)',backup:false,publicGrant:false,
      unexpectedGrants:0,grantOptions:0,body:undefined},
    `CRM Sales protected function security differs: ${name}`);
  }
  assert.equal(value.legacyTriggers.length,legacyTriggerCount,'CRM Sales previous trigger count differs');
  assert.equal(sha256(JSON.stringify(value.legacyTriggers)),legacyTriggerSha256,
    'CRM Sales previous trigger definitions differ');
}
if (process.argv.length === 3 && process.argv[2] === '--policy-self-test') {
  const history = migrations.map(([name,checksum]) => ({ name, checksum, finished:true, rolledBack:false }));
  verifyHistory(history.slice(0,-1)); verifyHistory(history);
  assert.throws(() => verifyHistory(history.slice(1)), /order mismatch/);
  assert.throws(() => verifyHistory(history.map((row,index) => index === 10 ? {...row,checksum:'0'.repeat(64)} : row)), /checksum differs/);
  verifySchema({settings:[],commands:[],relations:[],triggers:[],indexes:[],checks:[]},false);
  const installed = expectedSchema(true);
  verifySchema(installed,true);
  for (const changed of [
    {...installed,commands:installed.commands.map((value,index)=>index===0?value.replace('256','255'):value)},
    {...installed,indexes:installed.indexes.slice(1)},
    {...installed,triggers:installed.triggers.map((value,index)=>index===3?value.replace('776f','786f'):value)},
    {...installed,checks:installed.checks.filter(value=>!value.includes('templates_check'))},
    {...installed,relations:installed.relations.map(value=>value.replace('migration','runtime'))}
  ]) assert.throws(()=>verifySchema(changed,true),/schema differs/);
  verifyAcl({},false);
  assert.throws(() => verifyAcl({activity_text_template_settings:{runtime:['SELECT']}},true),/ACL differs/);
  console.log('CRM Sales activity text template migration policy fixtures verified');
  process.exit(0);
}

assert.equal(process.platform, 'linux', 'CRM Sales migration must run on Linux host');
assert.equal(fs.realpathSync('.'), '/opt/aerocrm', 'Run from /opt/aerocrm');
const inspectReadOnly = process.argv[2] === '--inspect-read-only';
const [sha,envHash] = process.argv.slice(inspectReadOnly ? 3 : 2);
assert.equal(process.argv.length, inspectReadOnly ? 5 : 4);
assert(/^[a-f0-9]{40}$/.test(sha) && /^[a-f0-9]{64}$/.test(envHash), 'Exact SHA and env hash required');
const manifest = validateManifest(JSON.parse(fs.readFileSync(process.env.BACKEND_MANIFEST_PATH, 'utf8')));
assert.equal(manifest.releaseSha,sha);
assert(uniformManifest(manifest), 'Activity template migration requires full exact-SHA manifest');
const stat = fs.lstatSync(envFile);
assert(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(envFile) === envFile &&
  (stat.mode & 0o777) === 0o600, 'Private CRM Sales migration env metadata differs');
const bytes = fs.readFileSync(envFile);
assert.equal(sha256(bytes),envHash, 'CRM Sales migration env hash differs');
const values = parseEnv(bytes.toString('utf8'));
assert.deepEqual(Object.keys(values).sort(),['CRM_SALES_DATABASE_URL','NODE_ENV']);
assert.equal(values.NODE_ENV,'production');
const url = new URL(values.CRM_SALES_DATABASE_URL);
assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && (!url.port || url.port === '5432') &&
  url.pathname === '/aerocrm_crm_sales' && decodeURIComponent(url.username) === 'aerocrm_crm_sales_migration' &&
  !!url.password && !url.hash && [...url.searchParams.keys()].length === 4 &&
  Object.entries({schema:'crm_sales',connection_limit:'1',pool_timeout:'10',connect_timeout:'10'})
    .every(([key,value]) => url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value),
  'Unexpected CRM Sales migration database identity');
const password = decodeURIComponent(url.password);
function query(sql) { return JSON.parse(run('CRM Sales inventory', 'docker', ['run','--rm','--network','host',
  '--env','PGPASSWORD','--env','PGOPTIONS','--entrypoint','psql','postgres:18','-X','-qAt','-v','ON_ERROR_STOP=1',
  '-h','127.0.0.1','-p','5432','-U','aerocrm_crm_sales_migration','-d','aerocrm_crm_sales','-c',sql],
  {env:{...process.env,PGPASSWORD:password,
    PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=3000'}})); }
function executeSql(sql) { run('CRM Sales ACL installation','docker',['run','--rm','--network','host',
  '--env','PGPASSWORD','--env','PGOPTIONS','--entrypoint','psql','postgres:18','-X','-qAt','-v','ON_ERROR_STOP=1',
  '-h','127.0.0.1','-p','5432','-U','aerocrm_crm_sales_migration','-d','aerocrm_crm_sales','-c',sql],
  {env:{...process.env,PGPASSWORD:password,PGOPTIONS:''}}); }
function history() { return query(`SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.name),'[]'::json)::text
  FROM (SELECT migration_name AS name,checksum,finished_at IS NOT NULL AS finished,
    rolled_back_at IS NOT NULL AS "rolledBack" FROM crm_sales._prisma_migrations) r;`); }
function schema() { return query(`SELECT json_build_object(
  'settings',(SELECT COALESCE(json_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||
    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END||':'||COALESCE(pg_get_expr(d.adbin,d.adrelid),'')||':'||
    a.attgenerated::text||':'||a.attidentity::text ORDER BY a.attname),'[]'::json)
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass('crm_sales.activity_text_template_settings') AND a.attnum>0 AND NOT a.attisdropped),
  'commands',(SELECT COALESCE(json_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||
    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END||':'||COALESCE(pg_get_expr(d.adbin,d.adrelid),'')||':'||
    a.attgenerated::text||':'||a.attidentity::text ORDER BY a.attname),'[]'::json)
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass('crm_sales.activity_text_template_commands') AND a.attnum>0 AND NOT a.attisdropped),
  'relations',(SELECT COALESCE(json_agg(c.relname||':'||pg_get_userbyid(c.relowner)||':'||c.relkind::text||':'||
    c.relpersistence::text||':'||c.relrowsecurity||':'||c.relforcerowsecurity ORDER BY c.relname),'[]'::json)
    FROM pg_class c WHERE c.oid IN (to_regclass('crm_sales.activity_text_template_settings'),
      to_regclass('crm_sales.activity_text_template_commands'))),
  'triggers',(SELECT COALESCE(json_agg(c.relname||':'||t.tgname||':'||t.tgtype::int||':'||t.tgenabled::text||':'||
    t.tgfoid::regprocedure::text||':'||encode(t.tgargs,'hex')||':'||COALESCE(pg_get_expr(t.tgqual,t.tgrelid),'')
    ORDER BY c.relname,t.tgname),'[]'::json)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.oid IN
    (to_regclass('crm_sales.activity_text_template_settings'),to_regclass('crm_sales.activity_text_template_commands'))
    AND NOT t.tgisinternal),
  'indexes',(SELECT COALESCE(json_agg(i.relname||':'||x.indisunique||':'||x.indisprimary||':'||
    x.indisvalid||':'||x.indisready||':'||pg_get_indexdef(i.oid) ORDER BY i.relname),'[]'::json) FROM pg_class i
    JOIN pg_index x ON x.indexrelid=i.oid WHERE x.indrelid IN
    (to_regclass('crm_sales.activity_text_template_settings'),to_regclass('crm_sales.activity_text_template_commands'))),
  'checks',(SELECT COALESCE(json_agg(conname||':'||contype::text||':'||convalidated||':'||pg_get_constraintdef(oid) ORDER BY conname),'[]'::json) FROM pg_constraint
    WHERE conrelid IN (to_regclass('crm_sales.activity_text_template_settings'),to_regclass('crm_sales.activity_text_template_commands'))
    ))::text;`); }
function acl() { return query(`SELECT COALESCE(json_object_agg(c.relname,json_build_object(
  'runtime',(SELECT COALESCE(json_agg(p ORDER BY p),'[]'::json) FROM unnest(ARRAY[${privileges.map(p=>`'${p}'`).join(',')}]) p
    WHERE has_table_privilege('aerocrm_crm_sales_runtime',c.oid,p)),
  'backup',(SELECT COALESCE(json_agg(p ORDER BY p),'[]'::json) FROM unnest(ARRAY[${privileges.map(p=>`'${p}'`).join(',')}]) p
    WHERE has_table_privilege('aerocrm_crm_sales_backup',c.oid,p)),
  'unexpected',(SELECT count(*) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee NOT IN (c.relowner,(SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_runtime'),
      (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_backup'))),
  'grantOptions',(SELECT count(*) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND a.is_grantable),
  'columns',(SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL))), '{}'::json)::text
  FROM pg_class c WHERE c.oid IN (to_regclass('crm_sales.activity_text_template_settings'),
    to_regclass('crm_sales.activity_text_template_commands'));`); }
function fullAcl() { return query(`SELECT COALESCE(json_agg(json_build_object(
  'table',c.relname,
  'runtime',(SELECT COALESCE(json_agg(p ORDER BY p),'[]'::json) FROM unnest(ARRAY[${privileges.map(p=>`'${p}'`).join(',')}]) p
    WHERE has_table_privilege('aerocrm_crm_sales_runtime',c.oid,p)),
  'backup',(SELECT COALESCE(json_agg(p ORDER BY p),'[]'::json) FROM unnest(ARRAY[${privileges.map(p=>`'${p}'`).join(',')}]) p
    WHERE has_table_privilege('aerocrm_crm_sales_backup',c.oid,p)),
  'unexpected',(SELECT count(*) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee NOT IN (c.relowner,(SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_runtime'),
      (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_backup'))),
  'grantOptions',(SELECT count(*) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND a.is_grantable),
  'columns',(SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL))
  ORDER BY c.relname),'[]'::json)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='crm_sales' AND c.relkind IN ('r','p');`); }
function security() {
  const schema = query(`SELECT json_build_object(
    'owner',(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='crm_sales'),
    'runtimeUsage',has_schema_privilege('aerocrm_crm_sales_runtime','crm_sales','USAGE'),
    'runtimeCreate',has_schema_privilege('aerocrm_crm_sales_runtime','crm_sales','CREATE'),
    'backupUsage',has_schema_privilege('aerocrm_crm_sales_backup','crm_sales','USAGE'),
    'backupCreate',has_schema_privilege('aerocrm_crm_sales_backup','crm_sales','CREATE'),
    'publicUsage',EXISTS(SELECT 1 FROM pg_namespace n,
      LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='crm_sales' AND a.grantee=0 AND a.privilege_type='USAGE'),
    'publicCreate',EXISTS(SELECT 1 FROM pg_namespace n,
      LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='crm_sales' AND a.grantee=0 AND a.privilege_type='CREATE'),
    'unexpectedGrants',(SELECT count(*) FROM pg_namespace n,
      LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='crm_sales' AND a.grantee NOT IN (n.nspowner,
        (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_runtime'),
        (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_backup'))),
    'grantOptions',(SELECT count(*) FROM pg_namespace n,
      LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='crm_sales' AND a.grantee<>n.nspowner AND a.is_grantable))::text;`);
  const roles = query(`SELECT COALESCE(json_agg(json_build_object('name',rolname,
    'superuser',rolsuper,'createDb',rolcreatedb,'createRole',rolcreaterole,
    'replication',rolreplication,'bypassRls',rolbypassrls,'inherit',rolinherit,
    'memberships',(SELECT count(*) FROM pg_auth_members m WHERE m.member=r.oid)) ORDER BY rolname),'[]'::json)::text
    FROM pg_roles r WHERE rolname IN ('aerocrm_crm_sales_migration','aerocrm_crm_sales_runtime','aerocrm_crm_sales_backup');`);
  const signatures = Object.keys(functionHashes).map(name=>`'crm_sales.${name}'::regprocedure`).join(',');
  const functions = query(`SELECT COALESCE(json_agg(json_build_object(
    'name',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
    'definer',p.prosecdef,'volatile',p.provolatile::text,'parallel',p.proparallel::text,
    'config',p.proconfig,'runtime',has_function_privilege('aerocrm_crm_sales_runtime',p.oid,'EXECUTE'),
    'backup',has_function_privilege('aerocrm_crm_sales_backup',p.oid,'EXECUTE'),
    'publicGrant',EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0),
    'unexpectedGrants',(SELECT count(*) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee NOT IN (p.proowner,(SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_runtime'),
        (SELECT oid FROM pg_roles WHERE rolname='aerocrm_crm_sales_backup'))),
    'grantOptions',(SELECT count(*) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND a.is_grantable),
    'body',pg_get_functiondef(p.oid)) ORDER BY p.oid::regprocedure::text),'[]'::json)::text
    FROM pg_proc p WHERE p.oid IN (${signatures});`);
  const legacyTriggers = query(`SELECT COALESCE(json_agg(json_build_object('table',cl.relname,
    'name',t.tgname,'type',t.tgtype::int,'enabled',t.tgenabled,
    'function',t.tgfoid::regprocedure::text,'args',encode(t.tgargs,'hex'),
    'qual',pg_get_expr(t.tgqual,t.tgrelid),'definition',pg_get_triggerdef(t.oid))
    ORDER BY cl.relname,t.tgname),'[]'::json)::text FROM pg_trigger t
    JOIN pg_class cl ON cl.oid=t.tgrelid JOIN pg_namespace n ON n.oid=cl.relnamespace
    WHERE n.nspname='crm_sales' AND NOT t.tgisinternal
      AND cl.relname NOT IN ('activity_text_template_settings','activity_text_template_commands');`);
  return {schema,roles,functions:Object.fromEntries(functions.map(item=>[
    item.name.replace(/^crm_sales\./,''),{...item,name:item.name.replace(/^crm_sales\./,'')}])),legacyTriggers};
}
function verifyFullAcl(rows, manifest, installed) {
  const expected = Object.entries(manifest.tables)
    .filter(([table]) => installed || !tables.includes(table))
    .map(([table,runtime]) => ({table,runtime:[...runtime].sort(),backup:['SELECT'],unexpected:0,grantOptions:0,columns:0}))
    .sort((a,b)=>a.table.localeCompare(b.table));
  assert.deepEqual(rows,expected,'CRM Sales full runtime/backup table ACL inventory differs');
}
const image = `aerocrm/crm-sales:${sha}`;
assert.equal(run('CRM Sales image ID','docker',['image','inspect','--format','{{.Id}}',image]),
  manifest.services['crm-sales'].imageId);
assert.equal(run('CRM Sales image revision','docker',['image','inspect','--format',
  '{{index .Config.Labels "org.opencontainers.image.revision"}}',image]),sha);
const inventory = JSON.parse(run('CRM Sales image inventory','docker',['run','--rm','--network','none',
  '--entrypoint','node',image,'-e',`const fs=require('node:fs'),crypto=require('node:crypto'),root='/app/prisma',
  hash=b=>crypto.createHash('sha256').update(b).digest('hex');console.log(JSON.stringify({
  migrations:fs.readdirSync(root+'/migrations',{withFileTypes:true}).filter(x=>x.isDirectory())
    .map(x=>[x.name,hash(fs.readFileSync(root+'/migrations/'+x.name+'/migration.sql'))]).sort((a,b)=>a[0].localeCompare(b[0])),
  aclSha256:hash(fs.readFileSync(root+'/database-access.json')),
  acl:JSON.parse(fs.readFileSync(root+'/database-access.json','utf8'))}));`]));
assert.deepEqual(inventory.migrations,migrations);
assert.equal(inventory.aclSha256,aclSha256);
assert.equal(inventory.acl.version,1);
assert.equal(inventory.acl.service,'crm-sales');
assert.deepEqual(Object.keys(inventory.acl.tables).filter(name=>tables.includes(name)).sort(),tables.slice().sort());
const before = history(); verifyHistory(before);
verifySchema(schema(),before.length === migrations.length);
verifyFullAcl(fullAcl().filter(row=>!tables.includes(row.table)),inventory.acl,false);
verifySecurity(security());
if (inspectReadOnly) {
  assert.equal(before.length,migrations.length,'Activity template migration is not complete');
  verifyAcl(acl(),true);
  verifyFullAcl(fullAcl(),inventory.acl,true);
  verifySecurity(security());
  console.log(JSON.stringify({activityTextTemplates:'verified',sourceSha:sha,migrationCount:migrations.length,
    schema:'crm_sales',acl:'reviewed'}));
  process.exit(0);
}
if (before.length === migrations.length) {
  // A retry after successful DDL but interrupted ACL installation completes the exact same grant plan.
  const observed = acl();
  verifyRecoverableAcl(observed);
  if (JSON.stringify(observed) === JSON.stringify({
    activity_text_template_commands:{runtime:['INSERT','SELECT'],backup:['SELECT'],unexpected:0,grantOptions:0,columns:0},
    activity_text_template_settings:{runtime:['INSERT','SELECT','UPDATE'],backup:['SELECT'],unexpected:0,grantOptions:0,columns:0}
  })) {
    console.log('CRM Sales activity text template migration already verified');
    process.exit(0);
  }
} else {
  verifyAcl(acl(),false);
  run('CRM Sales activity text template Prisma migration','docker',['run','--rm','--network','host',
    '--env','NODE_ENV','--env','CRM_SALES_DATABASE_URL','--entrypoint','node',image,
    'node_modules/prisma/build/index.js','migrate','deploy','--schema','prisma/schema.prisma'],
    {env:{...process.env,...values}});
  verifyHistory(history()); verifySchema(schema(),true);
}
executeSql(`BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
  GRANT SELECT, INSERT, UPDATE ON crm_sales.activity_text_template_settings TO aerocrm_crm_sales_runtime;
  GRANT SELECT, INSERT ON crm_sales.activity_text_template_commands TO aerocrm_crm_sales_runtime;
  GRANT SELECT ON crm_sales.activity_text_template_settings, crm_sales.activity_text_template_commands
    TO aerocrm_crm_sales_backup; COMMIT;`);
verifyAcl(acl(),true);
verifyFullAcl(fullAcl(),inventory.acl,true);
verifySecurity(security());
console.log('CRM Sales activity text template migration, schema and ACL verified');
