import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertEmptyInventory, assertStopped, databaseChecks, legacyQueues,
  stoppedServices, inventorySql } from './crm-contract-cutover-preflight.mjs';
import { constraintsSql } from './crm-contract-cutover.mjs';

const emptyCounts = () => Object.fromEntries(Object.entries(databaseChecks)
  .flatMap(([schema, checks]) => checks.map(([table]) => [`${schema}.${table}`, 0])));
const emptyQueues = () => [...legacyQueues, 'aerocrm.crm-access.team.acceptance',
  'aerocrm.crm-access.team.acceptance.dead-letter'].map(name =>
  ({ name, messages_ready: 0, messages_unacknowledged: 0, consumers: 0 }));

test('accepts empty cutover state and preserves unrelated populated support DLQ', () => {
  const queues = emptyQueues();
  queues.push({ name: 'aerocrm.support.telegram-webhook.v1.dead-letter',
    messages_ready: 1, messages_unacknowledged: 0, consumers: 0 });
  assertEmptyInventory(emptyCounts(), queues);
  assertStopped(stoppedServices.map(Service => ({ Service, State: 'exited' })));
});

test('every nonzero or missing DB count aborts including source keys and receipts', () => {
  for (const key of Object.keys(emptyCounts())) {
    const counts = emptyCounts();
    counts[key] = 1;
    assert.throws(() => assertEmptyInventory(counts, emptyQueues()), /cutover blocker/);
    delete counts[key];
    assert.throws(() => assertEmptyInventory(counts, emptyQueues()), /Missing database count/);
  }
});

test('queued, in-flight and consumed messages cannot pass, even in dead letters', () => {
  for (const key of ['messages_ready', 'messages_unacknowledged', 'consumers']) {
    const queues = emptyQueues();
    queues.at(-1)[key] = 1;
    assert.throws(() => assertEmptyInventory(emptyCounts(), queues), /not quiescent/);
  }
  assert.throws(() => assertEmptyInventory(emptyCounts(), emptyQueues().slice(1)), /Missing or duplicate queue/);
  assert.throws(() => assertEmptyInventory(emptyCounts(), [...emptyQueues(), {
    name: 'aerocrm.notification.wincrm.unknown', messages_ready: 0,
    messages_unacknowledged: 0, consumers: 0
  }]), /Unmapped legacy queue/);
});

test('running, restarting, paused and missing writers all abort', () => {
  for (const State of ['running', 'restarting', 'paused']) {
    const containers = stoppedServices.map(Service => ({ Service, State: 'exited' }));
    containers[0].State = State;
    assert.throws(() => assertStopped(containers), /not stopped/);
  }
  assert.throws(() => assertStopped([]), /Missing expected container/);
});

test('rollback inventory includes canonical receipts without matching established entitlement events', () => {
  const sql = inventorySql('billing', true);
  assert(sql.startsWith('BEGIN READ ONLY;'));
  assert(sql.includes('(invitation|task-reminder|intake-sla|provider)'));
  assert(!sql.includes("LIKE '%crm%'"));
  assert(inventorySql('identity', true).includes("client IN ('wincrm', 'crm')"));
});

test('constraint rollback restores all four exact definitions and rejects incomplete snapshots', () => {
  const rows = [
    ['control_actions', 'control_actions_identity_check'],
    ['delivery_failures', 'delivery_failures_classification_check'],
    ['delivery_receipts', 'delivery_receipts_identity_check'],
    ['outbox_events', 'notification_outbox_events_identity_check']
  ].map(([table, name]) => ({ table, name, definition: "CHECK ((consumer <> 'fixture'))" }));
  const sql = constraintsSql(rows);
  assert.equal((sql.match(/ADD CONSTRAINT/g) || []).length, 4);
  assert(sql.includes('IN ACCESS EXCLUSIVE MODE'));
  assert(!/DELETE FROM|UPDATE /.test(sql));
  assert.throws(() => constraintsSql(rows.slice(1)), /Incomplete constraint snapshot/);
});

test('topology renderer provisions the canonical contract with exact scoped grants', () => {
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const workspace = path.resolve(scripts, '../..');
  const fixture = fs.mkdtempSync(path.join(tmpdir(), 'aerocrm-topology-test-'));
  try {
    const fixtureScripts = path.join(fixture, 'aeroCRM_infra/scripts');
    fs.mkdirSync(fixtureScripts, { recursive: true });
    for (const name of ['render-env.mjs', 'render-rabbitmq-definitions.mjs'])
      fs.copyFileSync(path.join(scripts, name), path.join(fixtureScripts, name));
    fs.mkdirSync(path.join(fixture, 'aeroCRM_monorepo/aeroCRM_services'), { recursive: true });
    fs.symlinkSync(path.join(workspace, 'aeroCRM_monorepo/aeroCRM_services/apps'),
      path.join(fixture, 'aeroCRM_monorepo/aeroCRM_services/apps'), 'dir');
    const renderer = fs.readFileSync(path.join(scripts, 'render-env.mjs'), 'utf8');
    const section = renderer.match(/const roles = \[([\s\S]*?)\n\];/)[1];
    const roles = [...section.matchAll(/\['([^']+)',\s*'([^']+)',\s*\d+(?:,\s*'([^']+)')?\]/g)];
    const names = roles.filter(([, , role]) => !['api', 'scheduler'].includes(role))
      .map(([, service, role, explicit]) => explicit || `${service}-${role}`);
    const password = name => `${name}-synthetic-test-credential-only`.padEnd(64, 'x');
    const deploy = path.join(fixture, '.deploy');
    fs.mkdirSync(deploy, { mode: 0o700 });
    fs.writeFileSync(path.join(deploy, 'runtime-secrets.env'), names.map(name =>
      `${name.replaceAll('-', '_').toUpperCase()}_RABBITMQ_PASSWORD=${password(name)}`).join('\n') +
      `\nRABBITMQ_MONITOR_PASSWORD=${password('monitor')}\n`, { mode: 0o600 });
    const kinds = [...renderer.match(/NOTIFICATION_DELIVERY_KINDS: \[([\s\S]*?)\]\.join/)[1]
      .matchAll(/'([^']+)'/g)].map(match => match[1]);
    fs.mkdirSync(path.join(deploy, 'env/backend'), { recursive: true });
    fs.writeFileSync(path.join(deploy, 'env/backend/notification-delivery-worker.env'),
      `RABBITMQ_URL=amqp://aerocrm_notification_delivery_worker:${password('notification-delivery-worker')}@127.0.0.1:5672/aerocrm\n` +
      `RABBITMQ_ASSERT_TOPOLOGY=false\nNOTIFICATION_DELIVERY_KINDS=${kinds.join(',')}\n`, { mode: 0o600 });
    execFileSync(process.execPath, [path.join(fixtureScripts, 'render-rabbitmq-definitions.mjs')], { stdio: 'pipe' });
    const topology = JSON.parse(fs.readFileSync(path.join(deploy, 'rabbitmq-definitions.json'), 'utf8'));
    assert.equal(topology.queues.length, 177);
    assert.equal(topology.bindings.length, 242);
    assert.equal(topology.exchanges.length, 14);
    assert(!JSON.stringify(topology).includes('wincrm'));
    for (const name of legacyQueues) assert(topology.queues.some(queue => queue.name === name.replace('wincrm', 'crm')));
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
