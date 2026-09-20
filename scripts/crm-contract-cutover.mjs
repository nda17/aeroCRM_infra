#!/usr/bin/env node
// Target host only. Usage from /opt/aerocrm:
// node scripts/crm-contract-cutover.mjs SHA /private/staged-env /private/definitions.json
// Resume the same reviewed artifacts after a guarded rollback: append --resume.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { assertEmptyInventory, assertStopped, databaseChecks, inventorySql,
  legacyQueues, parseContainers, stoppedServices } from './crm-contract-cutover-preflight.mjs';

const script = fileURLToPath(import.meta.url);
const directory = 'releases/crm-contract-cutover';
const marker = 'releases/crm-contract-cutover.pending';
const migration = '20260920010000_crm_runtime_contracts';
const constraintNames = ['control_actions_identity_check', 'delivery_failures_classification_check',
  'delivery_receipts_identity_check', 'notification_outbox_events_identity_check'];
const apps = ['api-gateway', 'notification-delivery', 'campaigns', 'reporting', 'billing',
  'identity', 'platform', 'support', 'operations', 'crm-access', 'crm-intake', 'crm-customers', 'crm-sales'];
const ports = [4401, 4500, 4600, 4800, 4801, 4802, 4803, 4900, 4901, 4902, 5000, 5001,
  5100, 5101, 5102, 5200, 5201, 5202, 5300, 5301, 5302, 5310, 5311, 5312, 5317, 5318, 5320, 5330, 5331];

function run(label, executable, args, options = {}) {
  try {
    return execFileSync(executable, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...options });
  } catch { throw new Error(`${label} failed; private command output suppressed`); }
}
function privateFile(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    `Expected a private regular file: ${path.basename(file)}`);
  return fs.readFileSync(file, 'utf8');
}
function save(file, data) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function envFiles(dir) {
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected an environment directory');
  return fs.readdirSync(dir).filter(name => name.endsWith('.env')).sort();
}
function copyEnv(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of envFiles(from)) save(path.join(to, name), privateFile(path.join(from, name)));
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function environmentHash(dir) {
  return hash(envFiles(dir).map(name => `${name}\0${hash(privateFile(path.join(dir, name)))}`).join('\n'));
}
export function constraintsSql(rows) {
  assert.equal(rows.length, constraintNames.length, 'Incomplete constraint snapshot');
  assert.deepEqual(rows.map(row => row.name).sort(), [...constraintNames].sort());
  const tables = new Set(['control_actions', 'delivery_failures', 'delivery_receipts', 'outbox_events']);
  for (const row of rows) {
    assert(tables.has(row.table) && typeof row.definition === 'string' && row.definition.startsWith('CHECK ('),
      'Invalid constraint snapshot');
  }
  return `BEGIN; SET LOCAL lock_timeout = '10s';\nLOCK TABLE ${[...tables]
    .map(table => `notification_delivery."${table}"`).join(', ')} IN ACCESS EXCLUSIVE MODE;\n` +
    rows.map(row => `ALTER TABLE notification_delivery."${row.table}" DROP CONSTRAINT "${row.name}";\n` +
      `ALTER TABLE notification_delivery."${row.table}" ADD CONSTRAINT "${row.name}" ${row.definition};`).join('\n') +
    '\nCOMMIT;\n';
}

async function cutover(args) {
  const [sha, envDirectory, definitionsFile, option] = args;
  assert(args.length === 3 || (args.length === 4 && option === '--resume'), 'Invalid cutover arguments');
  assert(/^[a-f0-9]{40}$/.test(sha), 'Exact target SHA required');
  assert(process.platform === 'linux' && fs.realpathSync('.') === '/opt/aerocrm', 'Run on the target host from /opt/aerocrm');
  if (process.env.AEROCRM_CUTOVER_LOCKED !== '1') {
    const result = spawnSync('flock', ['-n', 'release.lock', process.execPath, script, ...args],
      { stdio: 'inherit', env: { ...process.env, AEROCRM_CUTOVER_LOCKED: '1' } });
    process.exitCode = result.status ?? 1;
    return;
  }
  const compose = (values, selectedSha = sha, input) => run('Docker Compose', 'docker',
    ['compose', '-f', 'compose/backend.yml', ...values], { env: { ...process.env, IMAGE_SHA: selectedSha }, input });
  const sql = (schema, input) => compose(['exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v',
    'ON_ERROR_STOP=1', '-U', 'aerocrm_cluster_admin', '-d', `aerocrm_${schema}`], sha, input).trim();
  const containers = () => parseContainers(compose(['ps', '--all', '--format', 'json']));
  const previous = fs.readFileSync('releases/backend.sha', 'utf8').trim();
  assert(/^[a-f0-9]{40}$/.test(previous), 'Previous release SHA missing');
  for (const app of apps) for (const revision of [sha, previous]) {
    const value = run('Image revision check', 'docker', ['image', 'inspect', '--format',
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}', `aerocrm/${app}:${revision}`]).trim();
    assert.equal(value, revision, `Image revision mismatch: ${app}`);
  }
  const staged = path.resolve(envDirectory);
  assert.notEqual(staged, path.resolve('env'), 'Stage new env separately before stopping writers');
  assert.deepEqual(envFiles(`${staged}/backend`), envFiles('env/backend'), 'Backend env inventory changed');
  for (const name of ['postgres.env', 'rabbitmq.env'])
    assert.equal(hash(privateFile(`${staged}/backend/${name}`)), hash(privateFile(`env/backend/${name}`)),
      'Infrastructure credentials must remain unchanged during the contract cutover');
  const migrationEnvs = Object.fromEntries(['identity', 'notification-delivery'].map(service => {
    let values;
    try { values = parseEnv(privateFile(`${staged}/migrations/${service}.env`)); }
    catch { throw new Error(`Invalid private migration env: ${service}`); }
    const databaseKey = `${service.replaceAll('-', '_').toUpperCase()}_DATABASE_URL`;
    assert.deepEqual(Object.keys(values).sort(), [databaseKey, 'NODE_ENV'].sort(),
      `Unexpected migration env fields: ${service}`);
    assert(values[databaseKey]?.startsWith('postgresql://') && values.NODE_ENV === 'production',
      `Invalid migration env values: ${service}`);
    return [service, values];
  }));
  const definitions = privateFile(definitionsFile);
  const parsed = JSON.parse(definitions);
  assert.equal(parsed.queues.length, 177, 'Unexpected target queue inventory');
  assert.equal(parsed.exchanges.length, 14, 'Unexpected target exchange inventory');
  assert(parsed.queues.every(queue => queue.vhost === 'aerocrm' && !queue.name.includes('wincrm')),
    'Target topology contains legacy or foreign queues');
  const newKinds = parseEnv(privateFile(`${staged}/backend/notification-delivery-worker.env`)).NOTIFICATION_DELIVERY_KINDS;
  assert(newKinds?.includes('crm-invitation-email') && !newKinds.includes('wincrm'), 'Target delivery kinds not canonical');
  let state;
  if (option === '--resume') {
    assert(fs.existsSync(marker), 'No pending cutover to resume');
    state = JSON.parse(privateFile(`${directory}/state.json`));
    assert(state.status === 'rolled-back', 'Inspect stopped failure before resuming; only a completed guarded rollback can resume');
    assert.equal(state.sha, sha, 'Resume SHA must match the reviewed cutover');
    assert.equal(state.definitionsHash, hash(definitions), 'Resume definitions changed');
    assert.equal(state.environmentHash, environmentHash(`${staged}/backend`), 'Resume env changed');
  } else {
    assert(!fs.existsSync(marker) && !fs.existsSync(directory), 'Existing cutover state; inspect it and use --resume if rolled back');
    assert(parseEnv(privateFile('env/backend/notification-delivery-worker.env')).NOTIFICATION_DELIVERY_KINDS?.includes('wincrm'),
      'Prior runtime env must be captured before replacing legacy kinds');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    copyEnv('env/backend', `${directory}/previous-env`);
    state = { sha, previous, definitionsHash: hash(definitions), environmentHash: environmentHash(`${staged}/backend`),
      status: 'prepared', mutationsStarted: false };
  }
  const record = status => {
    state.status = status;
    save(`${directory}/state.json`, `${JSON.stringify(state, null, 2)}\n`);
    save(marker, `${sha}\n${status}\n`);
    console.log(`CRM cutover: ${status}`);
  };
  const brokerEnv = parseEnv(privateFile('env/backend/rabbitmq.env'));
  const authorization = `Basic ${Buffer.from(`${brokerEnv.RABBITMQ_DEFAULT_USER}:${brokerEnv.RABBITMQ_DEFAULT_PASS}`).toString('base64')}`;
  assert(brokerEnv.RABBITMQ_DEFAULT_USER && brokerEnv.RABBITMQ_DEFAULT_PASS, 'Broker administrator credential missing');
  const broker = async (route, method = 'GET', body) => {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:15672/api/${route}`, { method,
        headers: { authorization, 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(30_000) });
    } catch { throw new Error('Loopback broker administration unavailable'); }
    assert(response.ok, `Broker ${method} failed with HTTP ${response.status}`);
    const raw = await response.text();
    return raw ? JSON.parse(raw) : null;
  };
  // Management statistics lag behind consumer shutdown; use the broker's live
  // queue counters for every zero gate, then conditional HTTP deletion.
  const queues = () => JSON.parse(compose(['exec', '-T', 'rabbitmq', 'rabbitmqctl',
    'list_queues', '-p', 'aerocrm', 'name', 'messages_ready', 'messages_unacknowledged',
    'consumers', '--formatter=json']));
  const counts = (both = false) => Object.fromEntries(Object.keys(databaseChecks)
    .flatMap(schema => JSON.parse(sql(schema, inventorySql(schema, both))).map(row => [row.name, row.rows])));
  const zero = (both = false, inventory) => {
    assertStopped(containers());
    const values = counts(both);
    for (const [name, count] of Object.entries(values)) assert.equal(count, 0, `Cutover ledger is not empty: ${name}`);
    if (!both) assertEmptyInventory(values, inventory);
    else for (const queue of inventory) {
      if (![...legacyQueues, ...legacyQueues.map(name => name.replace('wincrm', 'crm')),
        'aerocrm.crm-access.team.acceptance', 'aerocrm.crm-access.team.acceptance.dead-letter'].includes(queue.name)) continue;
      for (const key of ['messages_ready', 'messages_unacknowledged', 'consumers'])
        assert.equal(queue[key], 0, `Rollback queue is not quiescent: ${queue.name}`);
    }
    assertStopped(containers());
  };
  const runtimeServices = compose(['config', '--services']).trim().split('\n')
    .filter(name => !['postgres', 'rabbitmq', 'api-gateway', 'operations-restore-worker'].includes(name));
  const waitReady = async selectedPorts => {
    const pending = new Set(selectedPorts);
    const deadline = Date.now() + 120_000;
    while (pending.size && Date.now() < deadline) {
      await Promise.all([...pending].map(async port => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(2000) });
          if (response.ok) pending.delete(port);
        } catch { /* Retry bounded loopback readiness. */ }
      }));
      if (pending.size) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.equal(pending.size, 0, `Readiness failed on ports: ${[...pending].join(', ')}`);
  };
  const retire = async namespace => {
    const names = legacyQueues.map(name => name.replace('wincrm', namespace));
    const inventory = await queues();
    for (const queue of inventory.filter(queue => names.includes(queue.name))) {
      for (const key of ['messages_ready', 'messages_unacknowledged', 'consumers'])
        assert.equal(queue[key], 0, `Refusing nonempty queue retirement: ${queue.name}`);
      await broker(`queues/aerocrm/${encodeURIComponent(queue.name)}?if-empty=true&if-unused=true`, 'DELETE');
    }
    const bindingsRoute = 'bindings/aerocrm/e/aerocrm.events/q/aerocrm.crm-access.team.acceptance';
    for (const binding of await broker(bindingsRoute)) if (binding.routing_key === `identity.${namespace}.invitation-accepted.v1`)
      await broker(`${bindingsRoute}/${encodeURIComponent(binding.properties_key)}`, 'DELETE');
    const name = `aerocrm.billing.${namespace}-provider.dead-letter`;
    const exchanges = await broker('exchanges/aerocrm');
    if (exchanges.some(exchange => exchange.name === name))
      await broker(`exchanges/aerocrm/${encodeURIComponent(name)}?if-unused=true`, 'DELETE');
  };
  const migrationRun = (service, label, command) => {
    const values = migrationEnvs[service];
    return run(label, 'docker', ['run', '--rm', '--network', 'host',
      ...Object.keys(values).flatMap(name => ['--env', name]), '--entrypoint', 'node', `aerocrm/${service}:${sha}`,
      'node_modules/prisma/build/index.js', 'migrate', ...command, '--schema', 'prisma/schema.prisma'],
    { env: { ...process.env, ...values } });
  };
  const migrate = service => migrationRun(service, `${service} migration`, ['deploy']);
  record('prepared');
  try {
    compose(['stop', '--timeout', '40', ...stoppedServices], previous);
    zero(false, await queues());
    if (!fs.existsSync(`${directory}/previous-constraints.sql`)) {
      const rows = JSON.parse(sql('notification_delivery', `SELECT json_agg(q) FROM (
        SELECT c.conname AS name, t.relname AS "table", pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'notification_delivery'
        AND c.conname IN (${constraintNames.map(name => `'${name}'`).join(',')}) ORDER BY c.conname) q;`));
      save(`${directory}/previous-constraints.sql`, constraintsSql(rows));
      save(`${directory}/previous-topology.json`, JSON.stringify(await broker('definitions')));
      save(`${directory}/forward-constraints.sql`, run('Target migration extraction', 'docker', ['run', '--rm',
        '--entrypoint', 'cat', `aerocrm/notification-delivery:${sha}`, `/app/prisma/migrations/${migration}/migration.sql`]));
    }
    state.mutationsStarted = true;
    record('migrating');
    migrate('identity');
    const failed = sql('notification_delivery', `SELECT count(*) FROM notification_delivery._prisma_migrations
      WHERE migration_name = '${migration}' AND finished_at IS NULL AND rolled_back_at IS NULL;`);
    if (failed === '1') migrationRun('notification-delivery', 'Resolve atomic failed constraint migration',
      ['resolve', '--rolled-back', migration]);
    migrate('notification-delivery');
    // A previous guarded rollback preserves migration history. Explicitly reapply
    // the reviewed constraints on resume even if Prisma already records success.
    if (option === '--resume') sql('notification_delivery', privateFile(`${directory}/forward-constraints.sql`));
    await broker('definitions', 'POST', definitions);
    copyEnv(`${staged}/backend`, 'env/backend');
    record('starting');
    compose(['up', '-d', '--no-deps', ...runtimeServices]);
    await waitReady(ports);
    await retire('wincrm');
    const activeQueues = await queues();
    assert.equal(activeQueues.length, 177, 'Unexpected post-cutover queue inventory');
    assert(activeQueues.every(queue => !queue.name.includes('wincrm')), 'Legacy queue remains after cutover');
    compose(['up', '-d', '--no-deps', 'api-gateway']);
    await waitReady([4100]);
    save('releases/backend.sha', `${sha}\n`);
    record('completed');
    fs.unlinkSync(marker);
  } catch (error) {
    console.error(`CRM cutover failed: ${error.message}`);
    try {
      compose(['stop', '--timeout', '40', ...stoppedServices]);
      if (state.mutationsStarted) {
        zero(true, await queues());
        sql('notification_delivery', privateFile(`${directory}/previous-constraints.sql`));
        await broker('definitions', 'POST', privateFile(`${directory}/previous-topology.json`));
        await retire('crm');
      }
      copyEnv(`${directory}/previous-env`, 'env/backend');
      compose(['up', '-d', '--no-deps', ...runtimeServices], state.previous);
      await waitReady(ports);
      compose(['up', '-d', '--no-deps', 'api-gateway'], state.previous);
      await waitReady([4100]);
      record('rolled-back');
      console.error('Consistent prior runtime restored. Pending marker blocks ordinary release; fix and resume this exact cutover.');
    } catch (rollbackError) {
      // No data restore or purge: preserve new receipts and queue deliveries.
      compose(['stop', '--timeout', '40', ...stoppedServices]);
      record('stopped-needs-review');
      console.error(`Automatic rollback stopped: ${rollbackError.message}. Writers remain stopped; no records or messages were discarded.`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  cutover(process.argv.slice(2)).catch(error => {
    console.error(`CRM cutover refused: ${error.message}`);
    process.exitCode = 1;
  });
}
