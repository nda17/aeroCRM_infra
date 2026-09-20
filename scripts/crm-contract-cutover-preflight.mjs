#!/usr/bin/env node
// Read-only gate. Run from /opt/aerocrm while holding release.lock, after stopping
// --list-services. Never purges queues, changes records, or reads private env files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const stoppedServices = [
  'api-gateway', 'notification-delivery-worker',
  'identity-api', 'identity-worker', 'identity-outbox-publisher',
  'billing-api', 'billing-scheduler', 'billing-worker', 'billing-outbox-publisher',
  'crm-access-api', 'crm-access-worker', 'crm-access-outbox-publisher',
  'crm-intake-api', 'crm-intake-worker', 'crm-intake-publisher',
  'crm-intake-sla-worker', 'crm-intake-sla-publisher',
  'crm-sales-api', 'crm-sales-reminders'
];

const legacy = (...columns) => `concat_ws(' ', ${columns.join(', ')}) LIKE '%wincrm%'`;
const payloadContract = ["payload->>'eventType'", "payload#>>'{reference,type}'"];
export const databaseChecks = {
  identity: [
    ['outbox_events', legacy('event_type', 'routing_key', 'deduplication_key', ...payloadContract)],
    ['internal_command_receipts', "client = 'wincrm'"],
    ['workspace_invitations', 'TRUE']
  ],
  billing: [
    ['outbox_events', legacy('event_type', 'routing_key', 'exchange', 'aggregate_type', 'deduplication_key', ...payloadContract)],
    ['crm_provider_deliveries', legacy('consumer')],
    ['integration_delivery_receipts', legacy('integration')],
    ['integration_delivery_failures', legacy('integration', 'routing_key', ...payloadContract)],
    ['crm_provider_operations', 'TRUE']
  ],
  crm_access: [
    ['crm_team_outbox', legacy('event_type', 'routing_key', 'deduplication_key', ...payloadContract)],
    ['crm_team_deliveries', legacy('consumer', ...payloadContract)]
  ],
  crm_intake: [
    ['sla_outbox', legacy('deduplication_key', ...payloadContract)],
    // Tilda sources have kind API too; an empty filtered TILDA query is insufficient.
    ['intake_sources', 'TRUE'],
    ['inbound_receipts', 'TRUE']
  ],
  crm_sales: [
    ['reminder_outbox', legacy('event_type', ...payloadContract)]
    // Completed reminder_jobs are business history, not old delivery contracts.
  ],
  notification_delivery: [
    ['delivery_receipts', legacy('consumer')],
    ['delivery_failures', legacy('consumer', 'routing_key', ...payloadContract)],
    ['control_actions', legacy('kind')],
    ['outbox_events', legacy('event_type', 'routing_key', 'deduplication_key', "payload->>'sourceKind'", ...payloadContract)]
  ]
};

export const legacyQueues = [
  ...['intake-sla.email', 'intake-sla.telegram', 'invitation.email',
    'task-reminder.email', 'task-reminder.telegram'].flatMap(name =>
    ['', '.dead-letter', '.retry-v2.1', '.retry-v2.2', '.retry-v2.3']
      .map(suffix => `aerocrm.notification.wincrm.${name}${suffix}`)),
  'aerocrm.billing.wincrm-provider.v1',
  'aerocrm.billing.wincrm-provider.v1.dead-letter'
];
const acceptanceQueues = [
  'aerocrm.crm-access.team.acceptance',
  'aerocrm.crm-access.team.acceptance.dead-letter'
];

export function assertStopped(containers) {
  for (const service of stoppedServices) {
    const found = containers.filter(item => item.Service === service);
    assert(found.length > 0, `Missing expected container: ${service}`);
    assert(found.every(item => item.State === 'exited' || item.State === 'created'),
      `Writer is not stopped: ${service}`);
  }
}

export function assertEmptyInventory(counts, queues) {
  for (const [schema, checks] of Object.entries(databaseChecks)) {
    for (const [table] of checks) {
      const name = `${schema}.${table}`;
      assert(Object.hasOwn(counts, name), `Missing database count: ${name}`);
      assert.equal(counts[name], 0, `Legacy cutover blocker: ${name}`);
    }
  }
  for (const name of [...legacyQueues, ...acceptanceQueues]) {
    const found = queues.filter(item => item.name === name);
    assert.equal(found.length, 1, `Missing or duplicate queue: ${name}`);
    for (const key of ['messages_ready', 'messages_unacknowledged', 'consumers'])
      assert.equal(found[0][key], 0, `Queue is not quiescent: ${name} (${key})`);
  }
  const expected = new Set(legacyQueues);
  for (const queue of queues)
    assert(!queue.name.includes('wincrm') || expected.has(queue.name),
      `Unmapped legacy queue: ${queue.name}`);
}

export function parseContainers(raw) {
  const value = raw.trim();
  if (!value) return [];
  return value.startsWith('[') ? JSON.parse(value) : value.split('\n').map(line => JSON.parse(line));
}

export function inventorySql(schema, includeCanonical = false) {
  assert(Object.hasOwn(databaseChecks, schema), 'Unknown inventory schema');
  const selects = databaseChecks[schema].map(([table, predicate]) => {
    let condition = predicate;
    if (includeCanonical) {
      // Match only renamed contracts. Existing crm-entitlement, crm-order and
      // unrelated delivery history are not blockers or rewritten during rollback.
      condition = predicate.replace(/LIKE '%wincrm%'/g,
        "~ 'wincrm|(^|[ .:_-])crm[.:-](invitation|task-reminder|intake-sla|provider)'")
        .replace("client = 'wincrm'", "client IN ('wincrm', 'crm')");
    }
    return `SELECT '${schema}.${table}' AS name, count(*)::int AS rows FROM "${schema}"."${table}" WHERE ${condition}`;
  });
  return `BEGIN READ ONLY; SET LOCAL statement_timeout = '10s';\n` +
    `SELECT json_agg(q) FROM (${selects.join('\nUNION ALL\n')}) q;\nCOMMIT;\n`;
}

export function main(args = process.argv.slice(2)) {
  assert(args.length <= 1, 'Use --require-stopped, --inventory or --list-services');
  const mode = args[0] || '--require-stopped';
  assert(['--require-stopped', '--inventory', '--list-services'].includes(mode), 'Unknown preflight option');
  if (mode === '--list-services') {
    console.log(stoppedServices.join('\n'));
    return;
  }
  const sha = (process.env.IMAGE_SHA || fs.readFileSync('releases/backend.sha', 'utf8')).trim();
  assert(/^[a-f0-9]{40}$/.test(sha), 'Exact backend IMAGE_SHA or releases/backend.sha is required');
  const compose = (args, input) => {
    try {
      return execFileSync('docker', ['compose', '-f', 'compose/backend.yml', ...args], {
        env: { ...process.env, IMAGE_SHA: sha }, encoding: 'utf8', input,
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000, maxBuffer: 4 * 1024 * 1024
      });
    } catch {
      throw new Error('Read-only Docker inventory failed; command output suppressed');
    }
  };
  const containers = () => parseContainers(compose(['ps', '--all', '--format', 'json']));
  if (mode === '--require-stopped') assertStopped(containers());
  const counts = {};
  for (const [schema, checks] of Object.entries(databaseChecks)) {
    const result = compose(['exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-U', 'aerocrm_cluster_admin', '-d', `aerocrm_${schema}`], inventorySql(schema));
    const rows = JSON.parse(result.trim());
    for (const row of rows) counts[row.name] = row.rows;
  }
  const queues = JSON.parse(compose(['exec', '-T', 'rabbitmq', 'rabbitmqctl', 'list_queues',
    '-p', 'aerocrm', 'name', 'messages_ready', 'messages_unacknowledged', 'consumers', '--formatter=json']));
  const affectedQueues = queues.filter(queue => legacyQueues.includes(queue.name) || acceptanceQueues.includes(queue.name));
  console.log(JSON.stringify({ mode, counts, queues: affectedQueues }, null, 2));
  if (mode === '--inventory') {
    console.log('Inventory only; this is not cutover approval. Stop writers and rerun --require-stopped.');
    return;
  }
  assertEmptyInventory(counts, queues);
  assertStopped(containers());
  console.log('PASS: stopped writers, empty legacy ledgers, sources and queues. Keep release.lock held and writers stopped.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`CRM contract cutover aborted: ${error.message}`);
    process.exitCode = 1;
  }
}
