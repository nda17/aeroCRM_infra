#!/usr/bin/env node
// Apply and verify explicit service-owned ACLs on the new, shared aeroCRM cluster.
// No credentials are embedded in the generated operator script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const services = ['platform', 'identity', 'support', 'billing', 'operations', 'campaigns', 'reporting',
  'notification-delivery', 'crm-access', 'crm-customers', 'crm-sales', 'crm-intake'];
const ident = value => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid SQL identifier');
  return '"' + value + '"';
};
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const shell = ['set -euo pipefail', 'cd /opt/aerocrm', 'export IMAGE_SHA=0000000000000000000000000000000000000000'];
for (const service of services) {
  const schema = service.replaceAll('-', '_');
  const owner = `aerocrm_${schema}_migration`;
  const runtime = `aerocrm_${schema}_runtime`;
  const backup = `aerocrm_${schema}_backup`;
  const database = `aerocrm_${schema}`;
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'aeroCRM_monorepo/aeroCRM_services/apps', service, 'prisma/database-access.json')));
  if (contract.version !== 1 || contract.service !== service) throw new Error(`Invalid ACL manifest: ${service}`);
  const tables = Object.keys(contract.tables);
  const sql = [`BEGIN;`, `SET LOCAL lock_timeout = '5s';`, `SET LOCAL statement_timeout = '30s';`,
    `CREATE TEMP TABLE expected_acl (contract jsonb) ON COMMIT DROP;`,
    `INSERT INTO expected_acl VALUES (${literal(JSON.stringify(contract))}::jsonb);`,
    `DO $guard$ DECLARE obj record; expected jsonb; BEGIN`,
    `SELECT contract INTO expected FROM expected_acl;`,
    `IF current_database() <> ${literal(database)} THEN RAISE EXCEPTION 'Unexpected database'; END IF;`,
    `IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=${literal(schema)}) IS DISTINCT FROM ${literal(owner)} THEN RAISE EXCEPTION 'Schema owner mismatch'; END IF;`,
    `IF (SELECT array_agg(c.relname::text ORDER BY c.relname::text) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p','v','m','f')) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(expected->'tables') k) THEN RAISE EXCEPTION 'Table inventory mismatch'; END IF;`,
    `IF (SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname::text),'{}'::text[]) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND c.relkind='S') IS DISTINCT FROM (SELECT coalesce(array_agg(k ORDER BY k COLLATE "C"),'{}'::text[]) FROM jsonb_object_keys(expected->'sequences') k) THEN RAISE EXCEPTION 'Sequence inventory mismatch'; END IF;`,
    `IF (SELECT coalesce(array_agg(t.typname::text ORDER BY t.typname::text),'{}'::text[]) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=${literal(schema)} AND t.typtype='e') IS DISTINCT FROM (SELECT coalesce(array_agg(k ORDER BY k COLLATE "C"),'{}'::text[]) FROM jsonb_array_elements_text(expected->'types') k) THEN RAISE EXCEPTION 'Enum inventory mismatch'; END IF;`,
    `IF (SELECT coalesce(array_agg(DISTINCT p.proname::text ORDER BY p.proname::text),'{}'::text[]) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)}) IS DISTINCT FROM (SELECT coalesce(array_agg(k ORDER BY k COLLATE "C"),'{}'::text[]) FROM jsonb_array_elements_text(expected->'routines') k) THEN RAISE EXCEPTION 'Function inventory mismatch'; END IF;`,
    `IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND pg_get_userbyid(c.relowner)<>${literal(owner)}) OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)} AND pg_get_userbyid(p.proowner)<>${literal(owner)}) THEN RAISE EXCEPTION 'Object owner mismatch'; END IF;`,
    `FOR obj IN SELECT * FROM pg_roles WHERE rolname IN (${[runtime, backup, owner, `aerocrm_${schema}_admin`].map(literal).join(',')}) LOOP`,
    `IF obj.rolsuper OR obj.rolcreatedb OR obj.rolcreaterole OR obj.rolreplication OR obj.rolbypassrls OR obj.rolinherit OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=obj.oid) THEN RAISE EXCEPTION 'Privileged service role'; END IF;`,
    `IF EXISTS (SELECT 1 FROM pg_database WHERE datname LIKE 'aerocrm\\_%' ESCAPE '\\' AND datname<>current_database() AND has_database_privilege(obj.oid,oid,'CONNECT')) THEN RAISE EXCEPTION 'Cross-service database access'; END IF;`,
    `END LOOP; END $guard$;`,
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`,
    `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ${ident(schema)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)};`,
    `DO $columns$ DECLARE obj record; privilege text; BEGIN`,
    `FOR obj IN SELECT c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped LOOP`,
    `FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP EXECUTE format('REVOKE %s (%I) ON TABLE %I.%I FROM PUBLIC, %I, %I',privilege,obj.attname,${literal(schema)},obj.relname,${literal(runtime)},${literal(backup)}); END LOOP;`,
    `END LOOP; END $columns$;`];
  for (const table of tables) {
    const permissions = contract.tables[table];
    if (permissions.some(p => !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(p))) throw new Error('Invalid table privilege');
    const target = `${ident(schema)}.${ident(table)}`;
    if (permissions.length) sql.push(`GRANT ${permissions.join(', ')} ON TABLE ${target} TO ${ident(runtime)};`);
    sql.push(`GRANT SELECT ON TABLE ${target} TO ${ident(backup)};`);
  }
  for (const [table, permissions] of Object.entries(contract.columnPrivileges || {})) {
    for (const [privilege, columns] of Object.entries(permissions)) {
      if (!tables.includes(table) || privilege !== 'UPDATE') throw new Error('Unsupported column grant');
      sql.push(`GRANT UPDATE (${columns.map(ident).join(', ')}) ON TABLE ${ident(schema)}.${ident(table)} TO ${ident(runtime)};`);
    }
  }
  for (const [sequence, permissions] of Object.entries(contract.sequences)) {
    if (permissions.some(p => !['SELECT', 'USAGE'].includes(p))) throw new Error('Invalid sequence privilege');
    const target = `${ident(schema)}.${ident(sequence)}`;
    if (permissions.length) sql.push(`GRANT ${permissions.join(', ')} ON SEQUENCE ${target} TO ${ident(runtime)};`);
    sql.push(`GRANT SELECT ON SEQUENCE ${target} TO ${ident(backup)};`);
  }
  for (const type of contract.types) sql.push(`REVOKE ALL ON TYPE ${ident(schema)}.${ident(type)} FROM PUBLIC, ${ident(runtime)}, ${ident(backup)}; GRANT USAGE ON TYPE ${ident(schema)}.${ident(type)} TO ${ident(runtime)}, ${ident(backup)};`);
  for (const signature of contract.routineExecute || []) {
    if (!/^[a-z_]+\((?:text(?:\[\])?)?\)$/.test(signature)) throw new Error('Unsupported routine signature');
    sql.push(`GRANT EXECUTE ON FUNCTION ${ident(schema)}.${signature} TO ${ident(runtime)};`);
  }
  sql.push(`DO $verify$ DECLARE obj record; expected jsonb; privilege text; permitted boolean; role_name text; BEGIN`,
    `SELECT contract INTO expected FROM expected_acl;`,
    `FOREACH role_name IN ARRAY ARRAY[${literal(runtime)},${literal(backup)}] LOOP`,
    `IF has_database_privilege(role_name,current_database(),'CREATE') OR has_database_privilege(role_name,current_database(),'TEMP') OR has_schema_privilege(role_name,${literal(schema)},'CREATE') THEN RAISE EXCEPTION 'Forbidden database/schema capability'; END IF;`,
    `FOR obj IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p') LOOP`,
    `FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP`,
    `permitted := CASE WHEN role_name=${literal(backup)} THEN privilege='SELECT' ELSE coalesce((expected->'tables'->obj.relname) ? privilege,false) END;`,
    `IF has_table_privilege(role_name,obj.oid,privilege) IS DISTINCT FROM permitted OR has_table_privilege(role_name,obj.oid,privilege||' WITH GRANT OPTION') THEN RAISE EXCEPTION 'Unexpected table privilege: %.% % %',${literal(schema)},obj.relname,role_name,privilege; END IF;`,
    `END LOOP; END LOOP;`,
    `FOR obj IN SELECT c.oid,c.relname,a.attnum,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped LOOP`,
    `FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP`,
    `permitted := CASE WHEN role_name=${literal(backup)} THEN privilege='SELECT' ELSE coalesce((expected->'tables'->obj.relname) ? privilege,false) OR coalesce((expected->'columnPrivileges'->obj.relname->privilege) ? obj.attname,false) END;`,
    `IF has_column_privilege(role_name,obj.oid,obj.attnum,privilege) IS DISTINCT FROM permitted OR has_column_privilege(role_name,obj.oid,obj.attnum,privilege||' WITH GRANT OPTION') THEN RAISE EXCEPTION 'Unexpected column privilege'; END IF;`,
    `END LOOP; END LOOP;`,
    `FOR obj IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND c.relkind='S' LOOP`,
    `FOREACH privilege IN ARRAY ARRAY['SELECT','USAGE','UPDATE'] LOOP`,
    `permitted := CASE WHEN role_name=${literal(backup)} THEN privilege='SELECT' ELSE coalesce((expected->'sequences'->obj.relname) ? privilege,false) END;`,
    `IF has_sequence_privilege(role_name,obj.oid,privilege) IS DISTINCT FROM permitted OR has_sequence_privilege(role_name,obj.oid,privilege||' WITH GRANT OPTION') THEN RAISE EXCEPTION 'Unexpected sequence privilege'; END IF;`,
    `END LOOP; END LOOP;`,
    `FOR obj IN SELECT p.oid,p.proname||'('||oidvectortypes(p.proargtypes)||')' AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${literal(schema)} LOOP`,
    `permitted := role_name=${literal(runtime)} AND coalesce((expected->'routineExecute') ? obj.signature,false);`,
    `IF has_function_privilege(role_name,obj.oid,'EXECUTE') IS DISTINCT FROM permitted OR has_function_privilege(role_name,obj.oid,'EXECUTE WITH GRANT OPTION') THEN RAISE EXCEPTION 'Unexpected function privilege: %',obj.signature; END IF;`,
    `END LOOP; END LOOP; END $verify$;`, `COMMIT;`,
    `SELECT 'Verified database ACL: ${service} (${tables.length} tables)';`);
  shell.push(`docker compose -f compose/backend.yml exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U aerocrm_cluster_admin -d ${database} <<'AEROCRM_ACL_SQL'`, sql.join('\n'), 'AEROCRM_ACL_SQL');
}
const destination = path.join(root, '.deploy/apply-database-access.sh');
fs.writeFileSync(destination, shell.join('\n') + '\n', { mode: 0o600 });
fs.chmodSync(destination, 0o600);
console.log(`Prepared explicit ACL apply/verification for ${services.length} new service databases`);
