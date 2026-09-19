#!/usr/bin/env node
// Render the new aeroCRM vhost: node scripts/render-rabbitmq-definitions.mjs
// Expected inventory: 19 runtime principals + monitor, 14 exchanges,
// 177 queues and 242 bindings. The private mode-0600 output is
// ../.deploy/rabbitmq-definitions.json for rabbitmqctl import_definitions.
// Runtime roles never receive the broker administrator credential.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'aeroCRM_monorepo/aeroCRM_services/apps');
const secretsPath = path.join(root, '.deploy/runtime-secrets.env');
const outputPath = path.join(root, '.deploy/rabbitmq-definitions.json');
const vhost = 'aerocrm';

function privateInput(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('Private broker input must be a regular mode-0600 file');
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Invalid private broker input; values suppressed');
  }
}

function runtimeNames() {
  const renderer = fs.readFileSync(path.join(root, 'aeroCRM_infra/scripts/render-env.mjs'), 'utf8');
  const section = renderer.match(/const roles = \[([\s\S]*?)\n\];/);
  if (!section) throw new Error('Cannot read the runtime role contract');
  const roles = [...section[1].matchAll(/\['([^']+)',\s*'([^']+)',\s*\d+(?:,\s*'([^']+)')?\]/g)];
  if (roles.length !== 29) throw new Error('Runtime role contract changed');
  const names = roles.filter(([, , role]) => !['api', 'scheduler'].includes(role))
    .map(([, service, role, explicit]) => explicit || `${service}-${role}`);
  if (names.length !== 19 || new Set(names).size !== names.length)
    throw new Error('Broker principal contract changed');
  return names;
}

const secrets = privateInput(secretsPath);
const runtimes = runtimeNames();
const password = key => {
  const value = secrets[key];
  if (typeof value !== 'string' || value.length < 32 || /[\r\n\0]/.test(value))
    throw new Error(`Missing or weak private broker input: ${key}`);
  return value;
};
const credential = name => password(`${name.replaceAll('-', '_').toUpperCase()}_RABBITMQ_PASSWORD`);
const values = [...runtimes.map(credential), password('RABBITMQ_MONITOR_PASSWORD')];
if (new Set(values).size !== values.length || values.includes(secrets.RABBITMQ_DEFAULT_PASS))
  throw new Error('Broker credentials are not distinct');
// Rendered role env is optional on a fresh host, but if present it must agree
// with the questionnaire-derived principal/password and disabled topology mode.
for (const runtime of runtimes) {
  const roleFile = path.join(root, `.deploy/env/backend/${runtime}.env`);
  if (!fs.existsSync(roleFile)) continue;
  const role = privateInput(roleFile);
  const raw = role.RABBITMQ_URL || role.CRM_INTAKE_RABBITMQ_URL || role.CRM_INTAKE_SLA_RABBITMQ_URL;
  if (!raw) throw new Error(`Missing role broker URL: ${runtime}`);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Invalid role broker URL: ${runtime}`); }
  if (url.protocol !== 'amqp:' || url.hostname !== '127.0.0.1' || url.port !== '5672' ||
      url.pathname !== '/aerocrm' || url.username !== `aerocrm_${runtime.replaceAll('-', '_')}` ||
      decodeURIComponent(url.password) !== credential(runtime) || url.search || url.hash)
    throw new Error(`Role broker principal mismatch: ${runtime}`);
  const assertKey = runtime.startsWith('crm-intake-sla-') ? 'CRM_INTAKE_SLA_RABBITMQ_ASSERT_TOPOLOGY'
    : runtime.startsWith('crm-intake-') ? 'CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY' : 'RABBITMQ_ASSERT_TOPOLOGY';
  if (role[assertKey] !== 'false') throw new Error(`Role topology assertion enabled: ${runtime}`);
}
function passwordHash(value) {
  const salt = randomBytes(4);
  return Buffer.concat([salt, createHash('sha256').update(salt).update(value, 'utf8').digest()]).toString('base64');
}
const users = runtimes.map(runtime => ({
  name: `aerocrm_${runtime.replaceAll('-', '_')}`,
  password_hash: passwordHash(credential(runtime)),
  hashing_algorithm: 'rabbit_password_hashing_sha256',
  tags: []
}));
users.push({ name: 'aerocrm_monitor', password_hash: passwordHash(password('RABBITMQ_MONITOR_PASSWORD')),
  hashing_algorithm: 'rabbit_password_hashing_sha256', tags: ['monitoring'] });

const exchanges = new Map();
const queues = new Map();
const bindings = new Map();
function exchange(name, type) {
  const current = exchanges.get(name);
  if (current && current.type !== type) throw new Error(`Exchange type conflict: ${name}`);
  exchanges.set(name, { name, vhost, type, durable: true, auto_delete: false, internal: false, arguments: {} });
}
function queue(name, args = {}) {
  const item = { name, vhost, durable: true, auto_delete: false, arguments: args };
  const current = queues.get(name);
  if (current && JSON.stringify(current) !== JSON.stringify(item)) throw new Error(`Queue argument conflict: ${name}`);
  queues.set(name, item);
}
function bind(name, sourceExchange, key) {
  const item = { source: sourceExchange, vhost, destination: name, destination_type: 'queue',
    routing_key: key, arguments: {} };
  const id = `${name}\0${sourceExchange}\0${key}`;
  bindings.set(id, item);
}
const events = 'aerocrm.events';
const retry = 'aerocrm.retry';
const dead = 'aerocrm.dead-letter';
const manual = 'aerocrm.manual-retry';
for (const [name, type] of [[events, 'topic'], [retry, 'direct'], [dead, 'topic'], [manual, 'direct']]) exchange(name, type);

// Notification Delivery: every configured kind has an independent main/retry/DLQ route.
const notifications = [
  ['support-team-email', 'aerocrm.notification.support.team.email', 'notification.support.team.email.requested.v1'],
  ['support-team-telegram', 'aerocrm.notification.support.team.telegram', 'notification.support.team.telegram.requested.v1'],
  ['support-client-email', 'aerocrm.notification.support.client.email', 'notification.support.client.email.requested.v1'],
  ['wincrm-intake-sla-email', 'aerocrm.notification.wincrm.intake-sla.email', 'notification.wincrm.intake-sla.email.requested.v1'],
  ['wincrm-intake-sla-telegram', 'aerocrm.notification.wincrm.intake-sla.telegram', 'notification.wincrm.intake-sla.telegram.requested.v1'],
  ['campaign-email', 'aerocrm.notification.campaign.email.v2', 'notification.campaign.email.requested.v2'],
  ['campaign-telegram', 'aerocrm.notification.campaign.telegram.v2', 'notification.campaign.telegram.requested.v2'],
  ['daily-summary-delivery-telegram', 'aerocrm.notification.daily-summary.telegram', 'notification.daily-summary.telegram.requested.v1'],
  ['operations-backup-report-telegram', 'aerocrm.notification.operations.backup-report.telegram', 'notification.operations.backup-report.telegram.requested.v1'],
  ['subscription-expiry-email', 'aerocrm.notification.subscription-expiry.email', 'notification.subscription-expiry.email.requested.v1'],
  ['subscription-expiry-telegram', 'aerocrm.notification.subscription-expiry.telegram', 'notification.subscription-expiry.telegram.requested.v1'],
  ['wincrm-invitation-email', 'aerocrm.notification.wincrm.invitation.email', 'notification.wincrm.invitation.email.requested.v1'],
  ['wincrm-task-reminder-email', 'aerocrm.notification.wincrm.task-reminder.email', 'notification.wincrm.task-reminder.email.requested.v1'],
  ['wincrm-task-reminder-telegram', 'aerocrm.notification.wincrm.task-reminder.telegram', 'notification.wincrm.task-reminder.telegram.requested.v1']
];
const notificationSource = fs.readFileSync(path.join(source, 'notification-delivery/src/messaging/messaging.constants.ts'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'aeroCRM_infra/scripts/render-env.mjs'), 'utf8');
const defaultKinds = new Set(['campaign-email', 'campaign-telegram', 'daily-summary-delivery-telegram',
  'operations-backup-report-telegram', 'subscription-expiry-email', 'subscription-expiry-telegram']);
for (const [kind, name, route] of notifications) {
  if (!notificationSource.includes(`'${kind}'`) || !notificationSource.includes(`'${name}'`) ||
      !notificationSource.includes(`'${route}'`) || (!defaultKinds.has(kind) && !rendererSource.includes(`'${kind}'`)))
    throw new Error(`Notification contract drift: ${kind}`);
  queue(name);
  bind(name, events, route);
  bind(name, events, `manual.${kind}`);
  bind(name, manual, kind);
  queue(`${name}.dead-letter`);
  bind(`${name}.dead-letter`, dead, `${kind}.dead-letter`);
  bind(`${name}.dead-letter`, events, `${kind}.dead-letter`);
  for (const [i, delay] of [30_000, 300_000, 1_800_000].entries()) {
    const target = `${name}.retry-v2.${i + 1}`;
    queue(target, { 'x-message-ttl': delay, 'x-dead-letter-exchange': manual, 'x-dead-letter-routing-key': kind });
    bind(target, retry, `${kind}.retry.${i + 1}`);
  }
}

// Identity destination suppression, with its established legacy manual routes.
const identityQueue = 'aerocrm.notification.telegram-destination-unavailable';
const identityKind = 'telegram-destination-unavailable';
queue(identityQueue);
bind(identityQueue, events, 'notification.telegram.destination-unavailable.v1');
bind(identityQueue, events, `manual.${identityKind}`);
bind(identityQueue, manual, identityKind);
queue(`${identityQueue}.dead-letter`);
for (const x of [dead, events]) bind(`${identityQueue}.dead-letter`, x, `${identityKind}.dead-letter`);
for (const [i, delay] of [30_000, 300_000, 1_800_000].entries()) {
  const target = `${identityQueue}.retry-v2.${i + 1}`;
  queue(target, { 'x-message-ttl': delay, 'x-dead-letter-exchange': manual, 'x-dead-letter-routing-key': identityKind });
  bind(target, retry, `${identityKind}.retry.${i + 1}`);
}

// Support webhook and notification-outcome consumers have separate receipts and retries.
for (const [name, route, consumer, version] of [
  ['aerocrm.support.telegram-webhook.v1', 'support.telegram.webhook-admitted.v1', 'support-telegram-webhook', 'v2'],
  ['aerocrm.support.notification-outcomes.v1', 'support.notification.delivery.outcome.v1', 'support-notification-outcome', 'v1']
]) {
  queue(name); bind(name, events, route); bind(name, manual, consumer);
  queue(`${name}.dead-letter`); bind(`${name}.dead-letter`, dead, `${consumer}.dead-letter`);
  for (const [i, delay] of [30_000, 300_000, 1_800_000].entries()) {
    const target = `${name}.retry-${version}.${i + 1}`;
    queue(target, { 'x-message-ttl': delay, 'x-dead-letter-exchange': manual, 'x-dead-letter-routing-key': consumer });
    bind(target, retry, `${consumer}.retry.${i + 1}`);
  }
}

// Billing's classic queues use a service-owned direct retry and DLX.
const billingRetry = 'aerocrm.billing.retry';
const billingDead = 'aerocrm.billing.dead-letter';
exchange(billingRetry, 'direct'); exchange(billingDead, 'direct');
for (const [kind, name, route] of [
  ['identity', 'aerocrm.billing.identity.v1', 'billing.identity.changed.v1'],
  ['offer', 'aerocrm.billing.offer.v2', 'billing.offer.changed.v2'],
  ['notification-routing', 'aerocrm.billing.notification-routing.v1', 'billing.notification-routing.changed.v1'],
  ['lifecycle-repair', 'aerocrm.billing.lifecycle-repair.v1', 'billing.lifecycle-repair.requested.v1']
]) {
  queue(name, { 'x-queue-type': 'classic' });
  bind(name, events, route); bind(name, billingRetry, route);
  queue(`${name}.dead-letter`, { 'x-queue-type': 'classic' });
  bind(`${name}.dead-letter`, billingDead, `${kind}.dead-letter`);
  for (const [i, delay] of [60_000, 300_000, 1_800_000].entries()) {
    const target = `${name}.retry.${i + 1}`;
    queue(target, { 'x-queue-type': 'classic', 'x-message-ttl': delay,
      'x-dead-letter-exchange': billingRetry, 'x-dead-letter-routing-key': route });
    bind(target, billingRetry, `${kind}.retry.${i + 1}`);
  }
}
const providerExchange = 'aerocrm.billing.wincrm-provider.dead-letter';
const providerQueue = 'aerocrm.billing.wincrm-provider.v1';
const providerRoute = 'billing.wincrm.provider-operation.requested.v1';
exchange(providerExchange, 'direct'); queue(providerQueue); bind(providerQueue, events, providerRoute);
queue(`${providerQueue}.dead-letter`); bind(`${providerQueue}.dead-letter`, providerExchange, providerRoute);

// Campaigns and Reporting use per-consumer retry queues.
const campaignsRetry = 'aerocrm.campaigns.retry';
exchange(campaignsRetry, 'direct');
for (const [kind, name, route] of [
  ['snapshot', 'aerocrm.campaigns.snapshot', 'campaign.snapshot.requested.v1'],
  ['outcome', 'aerocrm.campaigns.delivery-outcome.v2', 'notification.delivery.outcome.v2']
]) {
  queue(name); bind(name, events, route);
  queue(`${name}.dead-letter`); bind(`${name}.dead-letter`, dead, `campaigns.${kind}.dead-letter`);
  for (const [i, delay] of [30_000, 300_000, 1_800_000].entries()) {
    const target = `${name}.retry.${i + 1}`;
    queue(target, { 'x-message-ttl': delay, 'x-dead-letter-exchange': events, 'x-dead-letter-routing-key': route });
    bind(target, campaignsRetry, `${kind}.retry.${i + 1}`);
  }
}
const reportingRetry = 'aerocrm.reporting.retry';
const reportingManual = 'aerocrm.reporting.manual-retry';
exchange(reportingRetry, 'direct'); exchange(reportingManual, 'direct');
for (const [kind, name, route] of [
  ['identityUser', 'aerocrm.reporting.identity-user', 'identity.user.changed.v1'],
  ['crmOrder', 'aerocrm.reporting.crm-order', 'billing.crm-order.succeeded.v1'],
  ['crmEntitlement', 'aerocrm.reporting.crm-entitlement', 'billing.crm-entitlement.changed.v1'],
  ['reportingSettings', 'aerocrm.reporting.settings', 'operations.notification-routing.changed.v1'],
  ['deliveryOutcome', 'aerocrm.reporting.delivery-outcome', 'reporting.notification.delivery.outcome.v1']
]) {
  queue(name); bind(name, events, route); bind(name, reportingManual, `manual.${kind}`);
  queue(`${name}.dead-letter`); bind(`${name}.dead-letter`, dead, `reporting.${kind}.dead-letter`);
  for (const [i, delay] of [30_000, 300_000, 1_800_000].entries()) {
    const target = `${name}.retry.${i + 1}`;
    queue(target, { 'x-message-ttl': delay, 'x-dead-letter-exchange': events, 'x-dead-letter-routing-key': route });
    bind(target, reportingRetry, `${kind}.retry.${i + 1}`);
  }
}

// CRM Access retries are durable PostgreSQL Outbox records; no TTL queue is used.
for (const [kind, route] of [
  ['provision', 'crm.access.invitation-provision.v1'],
  ['acceptance', 'identity.wincrm.invitation-accepted.v1'],
  ['admission', 'crm.access.admission-wake.v1']
]) {
  const name = `aerocrm.crm-access.team.${kind}`;
  const manualRoute = `crm-access.team.${kind}`;
  queue(name); bind(name, events, route); bind(name, manual, manualRoute);
  queue(`${name}.dead-letter`); bind(`${name}.dead-letter`, dead, `${manualRoute}.dead-letter`);
}

// Intake owns two independent direct exchanges; retry delay is publisher-side.
for (const [exchangeName, deadExchange, name, route] of [
  ['aerocrm.crm-intake.events', 'aerocrm.crm-intake.dead-letter', 'aerocrm.crm-intake.acceptance.v1', 'crm.intake.acceptance.requested.v1'],
  ['aerocrm.crm-intake.sla.events', 'aerocrm.crm-intake.sla.dead-letter', 'aerocrm.crm-intake.sla.v1', 'crm.intake.sla.evaluate.v1']
]) {
  exchange(exchangeName, 'direct'); exchange(deadExchange, 'direct');
  queue(name); bind(name, exchangeName, route);
  queue(`${name}.dead-letter`); bind(`${name}.dead-letter`, deadExchange, route);
}
queue('aerocrm.crm.sales.reminders'); bind('aerocrm.crm.sales.reminders', events, 'crm.sales.reminder.tick.v1');

// Operations consumes six independent audit streams plus scheduled and restore jobs.
for (const [owner, route] of [
  ['campaigns', 'admin.audit.event.v1'], ['reporting', 'admin.audit.reporting.v1'],
  ['billing', 'admin.audit.billing.v1'], ['identity', 'admin.audit.identity.v1'],
  ['platform', 'admin.audit.platform.v1'], ['support', 'admin.audit.support.v1']
]) {
  const name = `aerocrm.operations.admin.audit.${owner}.v1`;
  const retryRoute = `operations.admin.audit.${owner}.retry.v1`;
  queue(name); bind(name, events, route); bind(name, manual, `operations.admin.audit.${owner}.manual.v1`);
  queue(`${name}.retry-v1`, { 'x-dead-letter-exchange': events, 'x-dead-letter-routing-key': route });
  bind(`${name}.retry-v1`, retry, retryRoute);
  queue(`${name}.dead-letter`, { 'x-message-ttl': 7 * 24 * 60 * 60 * 1_000 });
  bind(`${name}.dead-letter`, dead, `operations.admin.audit.${owner}.dead-letter.v1`);
}
for (const [name, route] of [
  ['aerocrm.operations.scheduled-jobs.v1', 'operations.scheduled-job.requested.v1'],
  ['aerocrm.operations.database-restore.v1', 'operations.database-restore.requested.v1']
]) {
  queue(name); bind(name, events, route);
  queue(`${name}.retry-v1`, { 'x-dead-letter-exchange': events, 'x-dead-letter-routing-key': route });
  bind(`${name}.retry-v1`, retry, `${route}.retry.v1`);
  queue(`${name}.dead-letter`); bind(`${name}.dead-letter`, dead, `${route}.dead-letter`);
}

function sourceIncludes(relative, literals) {
  const body = fs.readFileSync(path.join(source, relative), 'utf8');
  for (const literal of literals)
    if (!body.includes(`'${literal}'`)) throw new Error(`Broker contract drift in ${relative}: ${literal}`);
}
sourceIncludes('identity/src/messaging/messaging.constants.ts', [identityQueue,
  'notification.telegram.destination-unavailable.v1', events, retry, dead, manual]);
sourceIncludes('support/src/messaging/support-messaging.constants.ts', [
  'aerocrm.support.telegram-webhook.v1', 'support.telegram.webhook-admitted.v1']);
sourceIncludes('support/src/web/support-notifications.service.ts', [
  'aerocrm.support.notification-outcomes.v1', 'support.notification.delivery.outcome.v1']);
sourceIncludes('billing/src/messaging/billing-messaging.constants.ts', [billingRetry, billingDead,
  'aerocrm.billing.identity.v1', 'aerocrm.billing.offer.v2',
  'aerocrm.billing.notification-routing.v1', 'aerocrm.billing.lifecycle-repair.v1']);
sourceIncludes('billing/src/provider/wincrm-provider.config.ts', [providerExchange, providerQueue, providerRoute]);
sourceIncludes('campaigns/src/messaging/campaigns-messaging.constants.ts', [campaignsRetry,
  'aerocrm.campaigns.snapshot', 'aerocrm.campaigns.delivery-outcome.v2']);
sourceIncludes('reporting/src/messaging/reporting-messaging.constants.ts', [reportingRetry, reportingManual,
  'aerocrm.reporting.identity-user', 'aerocrm.reporting.crm-order',
  'aerocrm.reporting.crm-entitlement', 'aerocrm.reporting.settings', 'aerocrm.reporting.delivery-outcome']);
sourceIncludes('crm-access/src/team/team.util.ts', [
  'crm.access.invitation-provision.v1', 'identity.wincrm.invitation-accepted.v1', 'crm.access.admission-wake.v1']);
if (!fs.readFileSync(path.join(source, 'crm-access/src/team/team-messaging.contract.ts'), 'utf8')
  .includes('`aerocrm.crm-access.team.${consumer}`')) throw new Error('CRM Access queue contract drift');
sourceIncludes('crm-intake/src/acceptance/acceptance.messaging.ts', [
  'aerocrm.crm-intake.events', 'aerocrm.crm-intake.dead-letter', 'aerocrm.crm-intake.acceptance.v1']);
sourceIncludes('crm-intake/src/sla/sla.messaging.ts', [
  'aerocrm.crm-intake.sla.events', 'aerocrm.crm-intake.sla.dead-letter', 'aerocrm.crm-intake.sla.v1']);
sourceIncludes('crm-sales/src/reminders/reminder-delivery.contract.ts', [
  'aerocrm.crm.sales.reminders', 'crm.sales.reminder.tick.v1']);
sourceIncludes('operations/src/messaging/operations-messaging.constants.ts', [
  'aerocrm.operations.scheduled-jobs.v1', 'aerocrm.operations.database-restore.v1',
  'operations.notification-routing.changed.v1']);

function regex(names) {
  if (!names.length) return '^$';
  const root = { terminal: false, children: new Map() };
  for (const name of new Set(names)) {
    let node = root;
    for (const char of name) {
      if (!node.children.has(char)) node.children.set(char, { terminal: false, children: new Map() });
      node = node.children.get(char);
    }
    node.terminal = true;
  }
  const escape = char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const emit = node => {
    const branches = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([char, child]) => `${escape(char)}${emit(child)}`);
    if (!branches.length) return '';
    const choice = branches.length === 1 ? branches[0] : `(?:${branches.join('|')})`;
    return node.terminal ? `(?:${choice})?` : choice;
  };
  return `^${emit(root)}$`;
}
const mainQueues = prefix => [...queues.keys()].filter(name => name.startsWith(prefix) && !name.includes('.retry') && !name.endsWith('.dead-letter'));
const permissionsByRuntime = {
  'notification-delivery-worker': { read: mainQueues('aerocrm.notification.').filter(name => name !== identityQueue), write: [events, retry, dead] },
  'campaigns-service': { read: mainQueues('aerocrm.campaigns.'), write: [events, campaignsRetry, dead] },
  'reporting-service': { read: mainQueues('aerocrm.reporting.'), write: [events, reportingRetry, reportingManual, dead] },
  'billing-worker': { read: mainQueues('aerocrm.billing.'), write: [] },
  'billing-outbox-publisher': { read: [], write: [events, billingRetry, billingDead, providerExchange] },
  'identity-worker': { read: [identityQueue], write: [] },
  'identity-outbox-publisher': { read: [], write: [events, retry, dead, manual] },
  'platform-outbox-publisher': { read: [], write: [events] },
  'support-worker': { read: ['aerocrm.support.notification-outcomes.v1', 'aerocrm.support.telegram-webhook.v1'], write: [] },
  'support-outbox-publisher': { read: [], write: [events, retry, dead, manual] },
  'operations-worker': { read: [...queues.keys()].filter(name =>
    name.startsWith('aerocrm.operations.admin.audit.') || name.startsWith('aerocrm.operations.scheduled-jobs.v1')),
    write: [retry, dead], check: [events, retry, dead, manual] },
  'operations-outbox-publisher': { read: [], write: [events, manual] },
  'crm-access-worker': { read: mainQueues('aerocrm.crm-access.team.'), write: [] },
  'crm-access-outbox-publisher': { read: [], write: [events, dead, manual] },
  'crm-intake-worker': { read: ['aerocrm.crm-intake.acceptance.v1'], write: [] },
  'crm-intake-publisher': { read: [], write: ['aerocrm.crm-intake.events', 'aerocrm.crm-intake.dead-letter'] },
  'crm-intake-sla-worker': { read: ['aerocrm.crm-intake.sla.v1'], write: [] },
  'crm-intake-sla-publisher': { read: [], write: ['aerocrm.crm-intake.sla.events', 'aerocrm.crm-intake.sla.dead-letter', events] },
  'crm-sales-reminders': { read: ['aerocrm.crm.sales.reminders'], write: [events] }
};
assert.deepEqual(Object.keys(permissionsByRuntime).sort(), runtimes.toSorted());
// Factored audit owner and suffix groups avoid RabbitMQ's regexp size limit;
// the inventory check below proves this still grants only the exact resources.
const operationsReadPattern =
  '^aerocrm\\.(?:operations\\.(?:admin\\.audit\\.(?:campaigns|reporting|billing|identity|platform|support)\\.v1(?:\\.retry-v1|\\.dead-letter)?|scheduled-jobs\\.v1(?:\\.retry-v1|\\.dead-letter)?)|events|retry|dead-letter|manual-retry)$';
const notificationReadPattern =
  '^aerocrm\\.notification\\.((support\\.team|wincrm\\.(intake-sla|task-reminder)|subscription-expiry)\\.(email|telegram)|support\\.client\\.email|wincrm\\.invitation\\.email|campaign\\.(email|telegram)\\.v2|(daily-summary|operations\\.backup-report)\\.telegram)$';
const permissions = runtimes.map(runtime => {
  const grants = permissionsByRuntime[runtime];
  for (const name of grants.read) assert(queues.has(name), `Unknown read queue: ${name}`);
  for (const name of grants.write) assert(exchanges.has(name), `Unknown write exchange: ${name}`);
  return { user: `aerocrm_${runtime.replaceAll('-', '_')}`, vhost, configure: '^$',
    write: regex(grants.write), read: runtime === 'operations-worker' ? operationsReadPattern
      : runtime === 'notification-delivery-worker' ? notificationReadPattern
        : regex([...grants.read, ...(grants.check || [])]) };
});
permissions.push({ user: 'aerocrm_monitor', vhost, configure: '^$', write: '^$', read: '^aerocrm\\.' });
const inventory = [...queues.keys(), ...exchanges.keys()];
for (const [i, runtime] of runtimes.entries()) {
  const grants = permissionsByRuntime[runtime];
  const expectedRead = new Set([...grants.read, ...(grants.check || [])]);
  const expectedWrite = new Set(grants.write);
  for (const [mode, expected] of [['read', expectedRead], ['write', expectedWrite]]) {
    const expression = permissions[i][mode];
    if (Buffer.byteLength(expression, 'utf8') > 256)
      throw new Error(`Broker ${mode} permission pattern too long: ${runtime}`);
    const pattern = new RegExp(expression);
    for (const name of inventory)
      if (pattern.test(name) !== expected.has(name))
        throw new Error(`Broker ${mode} permission mismatch: ${runtime}`);
    for (const denied of ['aerocrm.widgets.any', 'aerocrm.operations.database-restore.v1',
      'aerocrm.operations.admin.audit.unexpected.v1', 'aerocrm.operations.admin.audit.billing.v2',
      'aerocrm.notification.unknown', 'aerocrm.notification.support.team.sms',
      'aerocrm.notification.subscription-expiry.telegram.v2'])
      if (!expected.has(denied) && pattern.test(denied))
        throw new Error(`Broker ${mode} permission overmatch: ${runtime}`);
  }
}
for (const permission of permissions)
  for (const mode of ['configure', 'write', 'read']) {
    if (Buffer.byteLength(permission[mode], 'utf8') > 256)
      throw new Error(`Broker ${mode} permission pattern too long: ${permission.user}`);
    new RegExp(permission[mode]);
  }

// Exact topology checks catch copy/paste omissions before any private file is emitted.
for (const item of bindings.values()) {
  assert(queues.has(item.destination), `Binding without queue: ${item.destination}`);
  assert(exchanges.has(item.source), `Binding without exchange: ${item.source}`);
}
for (const item of queues.values()) {
  const dlx = item.arguments['x-dead-letter-exchange'];
  if (dlx) assert(exchanges.has(dlx), `Queue without DLX: ${item.name}`);
}
if (users.length !== 20 || exchanges.size !== 14 || queues.size !== 177 || bindings.size !== 242 ||
    permissions.length !== 20) throw new Error('Broker topology inventory changed');
const definitions = { vhosts: [{ name: vhost }], users, permissions, topic_permissions: [],
  exchanges: [...exchanges.values()].sort((a, b) => a.name.localeCompare(b.name)),
  queues: [...queues.values()].sort((a, b) => a.name.localeCompare(b.name)),
  bindings: [...bindings.values()].sort((a, b) =>
    `${a.destination}\0${a.source}\0${a.routing_key}`.localeCompare(`${b.destination}\0${b.source}\0${b.routing_key}`)),
  policies: [], parameters: [], global_parameters: [] };
fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
const outputDir = fs.lstatSync(path.dirname(outputPath));
if (!outputDir.isDirectory() || outputDir.isSymbolicLink() || (outputDir.mode & 0o077) !== 0)
  throw new Error('Broker definitions directory must be private');
if (fs.existsSync(outputPath) && fs.lstatSync(outputPath).isSymbolicLink())
  throw new Error('Refusing broker definitions symlink');
const temporary = `${outputPath}.tmp-${process.pid}`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(definitions, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, outputPath);
  fs.chmodSync(outputPath, 0o600);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
console.log(`Rendered private RabbitMQ definitions: ${users.length} users, ${exchanges.size} exchanges, ` +
  `${queues.size} queues, ${bindings.size} bindings, ${permissions.length} scoped permissions; values withheld`);
