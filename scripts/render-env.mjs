#!/usr/bin/env node
// Renders private runtime files from the approved questionnaire and newly generated
// service credentials. Never imports .env.example or old WinWidget production env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const input = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
const generated = parseEnv(fs.readFileSync(path.join(root, '.deploy/runtime-secrets.env'), 'utf8'));
const required = (source, key) => {
  if (!source[key]?.trim()) throw new Error(`Missing private input: ${key}`);
  return source[key];
};
const q = key => required(input, key);
const g = key => required(generated, key);
const selected = (source, keys) => Object.fromEntries(keys.map(key => [key, required(source, key)]));
const providers = keys => selected(input, keys);
const tokens = keys => selected(generated, keys);
const prefixed = prefix => providers(Object.keys(input).filter(key => key.startsWith(prefix) && input[key]));
const smtp = { ...providers(['SMTP_SERVER', 'SMTP_LOGIN', 'SMTP_PASSWORD', 'SMTP_PORT', 'SMTP_SECURE']),
  SMTP_FROM: `"${q('CRM_MAIL_FROM_NAME')}" <${q('CRM_MAIL_FROM_ADDRESS')}>` };
if (/["\r\n]/.test(q('CRM_MAIL_FROM_NAME')) || !/^[^<>\s]+@aerocrm\.space$/.test(q('CRM_MAIL_FROM_ADDRESS'))) {
  throw new Error('Invalid aeroCRM sender configuration');
}
const shared = { NODE_ENV: 'production', MODE: 'production', TRUST_PROXY: 'loopback',
  CORS_ALLOWED_ORIGINS: q('CORS_ALLOWED_ORIGINS') };
const bases = { IDENTITY: 4900, BILLING: 4800, PLATFORM: 5000, SUPPORT: 5100, OPERATIONS: 5200,
  CAMPAIGNS: 4500, REPORTING: 4600, CRM_ACCESS: 5300, CRM_INTAKE: 5310,
  CRM_CUSTOMERS: 5320, CRM_SALES: 5330, NOTIFICATION_DELIVERY: 4401 };
const base = name => ({ [`${name}_INTERNAL_BASE_URL`]: `http://127.0.0.1:${bases[name]}` });
const identityClient = name => ({ ...base('IDENTITY'), ...tokens([`IDENTITY_${name}_TOKEN`]) });
const dbUrl = (name, role, pool = 1) => {
  const schema = name.replaceAll('-', '_');
  return `postgresql://aerocrm_${schema}_${role}:${g(`${schema.toUpperCase()}_${role.toUpperCase()}_PASSWORD`)}@127.0.0.1:5432/aerocrm_${schema}?schema=${schema}&connection_limit=${pool}&pool_timeout=10&connect_timeout=10`;
};
const broker = runtime => {
  const name = runtime.replaceAll('-', '_');
  return `amqp://aerocrm_${name}:${g(`${name.toUpperCase()}_RABBITMQ_PASSWORD`)}@127.0.0.1:5672/aerocrm`;
};
const output = new Map();
function write(relative, values) {
  const lines = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, raw]) => {
    const value = String(raw);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error(`Invalid env field: ${key}`);
    if (value.includes("'")) throw new Error(`Single quote needs explicit handling: ${key}`);
    return `${key}='${value}'`;
  });
  const content = lines.join('\n') + '\n';
  const parsed = parseEnv(content);
  for (const [key, value] of Object.entries(values)) {
    if (parsed[key] !== String(value)) throw new Error(`Env roundtrip failed: ${key}`);
  }
  output.set(relative, content);
}

const roles = [
  ['notification-delivery', 'worker', 4401, 'notification-delivery-worker'],
  ['campaigns', 'all', 4500, 'campaigns-service'], ['reporting', 'all', 4600, 'reporting-service'],
  ['billing', 'api', 4800], ['billing', 'scheduler', 4801], ['billing', 'worker', 4802], ['billing', 'outbox-publisher', 4803],
  ['identity', 'api', 4900], ['identity', 'worker', 4901], ['identity', 'outbox-publisher', 4902],
  ['platform', 'api', 5000], ['platform', 'outbox-publisher', 5001],
  ['support', 'api', 5100], ['support', 'worker', 5101], ['support', 'outbox-publisher', 5102],
  ['operations', 'api', 5200], ['operations', 'worker', 5201], ['operations', 'outbox-publisher', 5202],
  ['crm-access', 'api', 5300], ['crm-access', 'worker', 5301], ['crm-access', 'outbox-publisher', 5302],
  ['crm-intake', 'api', 5310], ['crm-intake', 'worker', 5311], ['crm-intake', 'publisher', 5312],
  ['crm-intake', 'sla-worker', 5317], ['crm-intake', 'sla-publisher', 5318],
  ['crm-customers', 'api', 5320], ['crm-sales', 'api', 5330], ['crm-sales', 'reminders', 5331],
];
const services = [...new Set(roles.map(([service]) => service))];
for (const [service, role, port, explicit] of roles) {
  const runtime = explicit || `${service}-${role}`;
  const prefix = service.replaceAll('-', '_').toUpperCase();
  const isPublisher = role.includes('publisher');
  const isApi = ['api', 'all'].includes(role);
  const env = { ...shared, [`${prefix}_DATABASE_URL`]: dbUrl(service, 'runtime', isApi ? 2 : 1),
    [`${prefix}_PROCESS_ROLE`]: role, [`${prefix}_LISTEN_HOST`]: '127.0.0.1',
    NODE_OPTIONS: `--max-old-space-size=${isApi ? 256 : isPublisher ? 128 : 256}` };
  const rolePorts = ['billing', 'platform', 'operations'].includes(service);
  const portKey = service === 'notification-delivery' || service === 'campaigns' ? `${prefix}_HEALTH_PORT`
    : service === 'crm-sales' && role === 'reminders' ? 'CRM_SALES_REMINDERS_PORT'
    : rolePorts ? `${prefix}_${role.replaceAll('-', '_').toUpperCase()}_PORT` : `${prefix}_PORT`;
  env[portKey] = String(port);
  if (!['api', 'scheduler'].includes(role)) {
    Object.assign(env, { RABBITMQ_URL: broker(runtime), RABBITMQ_CONNECTION_NAME: `aerocrm-${runtime}`,
      RABBITMQ_ASSERT_TOPOLOGY: 'false', RABBITMQ_MAX_MESSAGE_BYTES: '262144' });
  }
  if (service === 'identity' && isApi) Object.assign(env, smtp, base('BILLING'), tokens(['BILLING_IDENTITY_TOKEN']),
    tokens(Object.keys(generated).filter(key => /^IDENTITY_.*_TOKEN$/.test(key))),
    base('OPERATIONS'), tokens(['OPERATIONS_IDENTITY_TOKEN']), prefixed('JWT_ACCESS_'), prefixed('IDENTITY_AVATAR_S3_'),
    providers(['JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_CLOCK_TOLERANCE_SECONDS', 'AUTH_COOKIE_DOMAIN',
      'SMSAERO_EMAIL', 'SMSAERO_API_KEY', 'SMSAERO_SIGN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'YANDEX_CLIENT_ID', 'YANDEX_CLIENT_SECRET', 'VK_CLIENT_ID', 'VK_SERVICE_TOKEN',
      'TURNSTILE_ENABLED', 'TURNSTILE_SECRET_KEY', 'TELEGRAM_INFO_BOT_TOKEN', 'TELEGRAM_INFO_BOT_USERNAME',
      'TELEGRAM_INFO_BOT_WEBHOOK_SECRET', 'TELEGRAM_API_BASE_URL', 'TELEGRAM_WEBHOOK_HOST']),
    { TURNSTILE_EXPECTED_HOSTNAME: new URL(q('NEXT_PUBLIC_MAIN_APP_URL')).hostname,
      TURNSTILE_CLIENT_URL: new URL(q('NEXT_PUBLIC_MAIN_APP_URL')).origin,
      IDENTITY_LOGIN_OTP_ENABLED: 'true', CRM_INVITATION_EMAIL_ENABLED: 'true',
      ...Object.fromEntries(['google', 'yandex', 'vk'].map(provider => [`${provider.toUpperCase()}_CALLBACK_URL`,
        `${new URL(q('NEXT_PUBLIC_API_URL')).origin}/api/v1/auth/${provider}/redirect`])) });
  if (service === 'platform' && isApi) Object.assign(env, identityClient('PLATFORM'), tokens(['PLATFORM_OPERATIONS_TOKEN']));
  if (service === 'support') {
    env.SUPPORT_WEB_CHAT_ENABLED = q('SUPPORT_WEB_CHAT_ENABLED');
    if (!isPublisher) Object.assign(env, providers(['TELEGRAM_SUPPORT_BOT_TOKEN', 'TELEGRAM_API_BASE_URL', 'TELEGRAM_API_PROXY_IP']));
    if (isApi) Object.assign(env, identityClient('SUPPORT'), tokens(['SUPPORT_OPERATIONS_TOKEN', 'SUPPORT_NOTIFICATION_DELIVERY_TOKEN']),
      providers(['TELEGRAM_SUPPORT_BOT_USERNAME', 'TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET', 'SUPPORT_WEBHOOK_PUBLIC_URL']), prefixed('SUPPORT_S3_'),
      { SUPPORT_CRM_ACCESS_BASE_URL: 'http://127.0.0.1:5300', SUPPORT_CRM_ACCESS_TOKEN: g('CRM_ACCESS_SUPPORT_TOKEN') });
  }
  if (service === 'notification-delivery') Object.assign(env, smtp, identityClient('NOTIFICATION_DELIVERY'),
    providers(['TELEGRAM_INFO_BOT_TOKEN', 'TELEGRAM_SUPPORT_BOT_TOKEN', 'TELEGRAM_API_BASE_URL']),
    base('SUPPORT'), base('CRM_INTAKE'), base('CRM_SALES'),
    tokens(['SUPPORT_NOTIFICATION_DELIVERY_TOKEN', 'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN', 'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
      'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN', 'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN', 'NOTIFICATION_DELIVERY_OPERATIONS_TOKEN']),
    { NOTIFICATION_DELIVERY_KINDS: ['campaign-email', 'campaign-telegram', 'daily-summary-delivery-telegram', 'wincrm-invitation-email',
      'wincrm-task-reminder-email', 'wincrm-task-reminder-telegram', 'wincrm-intake-sla-email', 'wincrm-intake-sla-telegram',
      'support-team-email', 'support-team-telegram', 'support-client-email', 'subscription-expiry-telegram', 'operations-backup-report-telegram'].join(',') });
  if (service === 'campaigns') Object.assign(env, identityClient('CAMPAIGNS'), base('BILLING'), tokens(['BILLING_CAMPAIGNS_TOKEN', 'CAMPAIGNS_OPERATIONS_TOKEN']));
  if (service === 'reporting') Object.assign(env, identityClient('REPORTING'), base('OPERATIONS'), tokens(['REPORTING_INTERNAL_TOKEN', 'REPORTING_OPERATIONS_TOKEN']));
  if (service === 'billing' && !isPublisher) Object.assign(env, identityClient('BILLING'),
    tokens(['BILLING_IDENTITY_TOKEN', 'BILLING_CRM_ACCESS_TOKEN', 'BILLING_CRM_ACCESS_COMMERCE_TOKEN', 'BILLING_CAMPAIGNS_TOKEN', 'BILLING_OPERATIONS_TOKEN']),
    { BILLING_CRM_ACCESS_COMMERCE_BASE_URL: 'http://127.0.0.1:5300', CRM_FRONTEND_ORIGIN: new URL(q('NEXT_PUBLIC_APP_URL')).origin },
    providers(['PAYMENT_METHOD_ENCRYPTION_KEY', 'CRM_PAYMENT_LAUNCH_MODE', 'BILLING_CRM_PAYMENTS_ENABLED', 'BILLING_CRM_RECONCILIATION_ENABLED']),
    prefixed(q('CRM_PAYMENT_LAUNCH_MODE') === 'test' ? 'YOOKASSA_TEST_' : 'YOOKASSA_PRODUCTION_'));
  if (service === 'billing' && role === 'worker') Object.assign(env, {
    BILLING_CRM_PROVIDER_RABBITMQ_URL: env.RABBITMQ_URL, BILLING_CRM_PROVIDER_ASSERT_TOPOLOGY: 'false' });
  if (service === 'operations') {
    env.DATABASE_RESTORE_ENABLED = 'false';
    if (isApi) {
      Object.assign(env, identityClient('OPERATIONS'), tokens(['OPERATIONS_IDENTITY_TOKEN', 'REPORTING_INTERNAL_TOKEN']),
        { TELEGRAM_INFO_BOT_CONFIGURED: 'true', TELEGRAM_INFO_BOT_USERNAME: q('TELEGRAM_INFO_BOT_USERNAME'),
          RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:15672', RABBITMQ_VHOST: 'aerocrm',
          RABBITMQ_MONITOR_USER: 'aerocrm_monitor', RABBITMQ_MONITOR_PASSWORD: g('RABBITMQ_MONITOR_PASSWORD') });
      for (const owner of ['NOTIFICATION_DELIVERY', 'CAMPAIGNS', 'REPORTING', 'BILLING', 'PLATFORM', 'SUPPORT']) {
        Object.assign(env, base(owner), tokens([`${owner}_OPERATIONS_TOKEN`]));
      }
      env.NOTIFICATION_DELIVERY_INTERNAL_URL = 'http://127.0.0.1:4401';
    }
    if (role === 'worker') Object.assign(env, providers(['TELEGRAM_INFO_BOT_TOKEN', 'TELEGRAM_API_BASE_URL',
      'CRM_BACKUP_RETENTION_DAYS', 'CRM_BACKUP_BUCKET_CONSOLE_URL', 'DATABASE_BACKUP_PROVENANCE_KEY_ID']), prefixed('CRM_BACKUP_S3_'),
      { DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE: '/run/aerocrm-operations-secrets/database-backup-provenance-private-key.pem',
        ...Object.fromEntries(services.map(owner => [`${owner.replaceAll('-', '_').toUpperCase()}_BACKUP_URL`, dbUrl(owner, 'backup')])) });
  }
  if (service === 'crm-access') {
    env.CRM_ACCESS_BILLING_ENABLED = q('CRM_ACCESS_BILLING_ENABLED');
    // The Access module constructs its service clients in every process role.
    Object.assign(env, identityClient('CRM_ACCESS'), base('BILLING'), base('CRM_SALES'), tokens([
      'BILLING_CRM_ACCESS_TOKEN', 'BILLING_CRM_ACCESS_COMMERCE_TOKEN', 'CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
      'CRM_ACCESS_CRM_SALES_TOKEN', 'CRM_ACCESS_CRM_INTAKE_TOKEN', 'CRM_ACCESS_SUPPORT_TOKEN', 'CRM_SALES_CRM_ACCESS_TOKEN']));
    if (!isApi) env.CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY = 'false';
  }
  if (service === 'crm-intake') {
    env.CRM_INTAKE_SLA_ENABLED = 'true';
    if (!isPublisher) Object.assign(env, base('CRM_ACCESS'), base('CRM_CUSTOMERS'), base('CRM_SALES'), base('NOTIFICATION_DELIVERY'), tokens([
      'CRM_ACCESS_CRM_INTAKE_TOKEN', 'CRM_CUSTOMERS_CRM_INTAKE_TOKEN', 'CRM_SALES_CRM_INTAKE_TOKEN',
      'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN', 'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN']));
    if (!isApi) {
      const key = role.startsWith('sla-') ? 'CRM_INTAKE_SLA' : 'CRM_INTAKE';
      env[`${key}_RABBITMQ_URL`] = env.RABBITMQ_URL;
      env[`${key}_RABBITMQ_ASSERT_TOPOLOGY`] = 'false';
      delete env.RABBITMQ_URL;
    }
  }
  if (service === 'crm-customers') Object.assign(env, base('CRM_ACCESS'), tokens(['CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
    'CRM_CUSTOMERS_CRM_INTAKE_TOKEN', 'CRM_CUSTOMERS_CRM_SALES_TOKEN']), providers(['CRM_CUSTOMERS_DADATA_API_KEY']));
  if (service === 'crm-sales') Object.assign(env, base('CRM_ACCESS'), base('CRM_CUSTOMERS'), base('NOTIFICATION_DELIVERY'), tokens([
    'CRM_ACCESS_CRM_SALES_TOKEN', 'CRM_CUSTOMERS_CRM_SALES_TOKEN', 'CRM_SALES_CRM_ACCESS_TOKEN', 'CRM_SALES_CRM_INTAKE_TOKEN',
    'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN', 'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN']), { CRM_TASK_REMINDERS_ENABLED: 'true' });
  write(`backend/${runtime}.env`, env);
}
const routes = [
  {
    "id": "identity-auth",
    "pathPrefix": "/api/v1/auth",
    "upstreamUrl": "http://127.0.0.1:4900",
    "authPolicy": "optional",
    "timeoutMs": 60000
  },
  {
    "id": "identity-users",
    "pathPrefix": "/api/v1/users",
    "upstreamUrl": "http://127.0.0.1:4900",
    "authPolicy": "optional",
    "timeoutMs": 60000
  },
  {
    "id": "identity-invitations",
    "pathPrefix": "/api/v1/workspace-invitations",
    "upstreamUrl": "http://127.0.0.1:4900",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "identity-info-webhook",
    "pathPrefix": "/api/v1/telegram-bot/webhook",
    "upstreamUrl": "http://127.0.0.1:4900",
    "authPolicy": "optional",
    "timeoutMs": 60000
  },
  {
    "id": "identity-info-admin",
    "pathPrefix": "/api/v1/telegram-info/admin",
    "upstreamUrl": "http://127.0.0.1:4900",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "support-webhook",
    "pathPrefix": "/api/v1/telegram-bot/support-webhook",
    "upstreamUrl": "http://127.0.0.1:5100",
    "authPolicy": "optional",
    "timeoutMs": 10000
  },
  {
    "id": "support-admin",
    "pathPrefix": "/api/v1/support/admin",
    "upstreamUrl": "http://127.0.0.1:5100",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "support-web",
    "pathPrefix": "/api/v1/support",
    "upstreamUrl": "http://127.0.0.1:5100",
    "authPolicy": "required",
    "timeoutMs": 30000
  },
  {
    "id": "operations-events",
    "pathPrefix": "/api/v1/admin-event-log",
    "upstreamUrl": "http://127.0.0.1:5200",
    "authPolicy": "required",
    "timeoutMs": 30000
  },
  {
    "id": "operations-restores",
    "pathPrefix": "/api/v1/dev-tools/database-restores",
    "upstreamUrl": "http://127.0.0.1:5200",
    "authPolicy": "required",
    "timeoutMs": 600000
  },
  {
    "id": "operations-telegram",
    "pathPrefix": "/api/v1/telegram-bot/admin",
    "upstreamUrl": "http://127.0.0.1:5200",
    "authPolicy": "required",
    "timeoutMs": 600000
  },
  {
    "id": "operations-messaging",
    "pathPrefix": "/api/v1/messaging/admin",
    "upstreamUrl": "http://127.0.0.1:5200",
    "authPolicy": "required",
    "timeoutMs": 30000
  },
  {
    "id": "operations-alerts",
    "pathPrefix": "/api/v1/admin-alerts",
    "upstreamUrl": "http://127.0.0.1:5200",
    "authPolicy": "required",
    "timeoutMs": 30000
  },
  {
    "id": "operations-health-admin",
    "pathPrefix": "/api/v1/health/admin",
    "upstreamUrl": "http://127.0.0.1:5200",
    "authPolicy": "required",
    "timeoutMs": 30000
  },
  {
    "id": "operations-deployment",
    "pathPrefix": "/api/v1/health/deployment",
    "upstreamUrl": "http://127.0.0.1:5200",
    "authPolicy": "optional",
    "timeoutMs": 30000
  },
  {
    "id": "platform-settings",
    "pathPrefix": "/api/v1/site-settings",
    "upstreamUrl": "http://127.0.0.1:5000",
    "authPolicy": "optional",
    "timeoutMs": 60000
  },
  {
    "id": "platform-legal",
    "pathPrefix": "/api/v1/legal-pages",
    "upstreamUrl": "http://127.0.0.1:5000",
    "authPolicy": "optional",
    "timeoutMs": 60000
  },
  {
    "id": "platform-home",
    "pathPrefix": "/api/v1/home-page-content",
    "upstreamUrl": "http://127.0.0.1:5000",
    "authPolicy": "optional",
    "timeoutMs": 60000
  },
  {
    "id": "billing-crm-settings",
    "pathPrefix": "/api/v1/billing-settings/crm",
    "upstreamUrl": "http://127.0.0.1:4800",
    "authPolicy": "optional",
    "timeoutMs": 30000
  },
  {
    "id": "billing-crm-admin-settings",
    "pathPrefix": "/api/v1/billing-settings/admin/crm",
    "upstreamUrl": "http://127.0.0.1:4800",
    "authPolicy": "required",
    "timeoutMs": 30000
  },
  {
    "id": "billing-crm-admin-subscriptions",
    "pathPrefix": "/api/v1/subscriptions/admin/crm",
    "upstreamUrl": "http://127.0.0.1:4800",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "billing-crm-provider-operations",
    "pathPrefix": "/api/v1/payments/admin/crm-provider-operations",
    "upstreamUrl": "http://127.0.0.1:4800",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "billing-webhook",
    "pathPrefix": "/api/v1/payments/webhook",
    "upstreamUrl": "http://127.0.0.1:4800",
    "authPolicy": "optional",
    "timeoutMs": 30000
  },
  {
    "id": "campaigns",
    "pathPrefix": "/api/v1/admin/campaigns",
    "upstreamUrl": "http://127.0.0.1:4500",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "reporting",
    "pathPrefix": "/api/v1/admin/reporting",
    "upstreamUrl": "http://127.0.0.1:4600",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "crm-access",
    "pathPrefix": "/api/v1/crm/access",
    "upstreamUrl": "http://127.0.0.1:5300",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "crm-templates",
    "pathPrefix": "/api/v1/crm/templates",
    "upstreamUrl": "http://127.0.0.1:5330",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "crm-sales",
    "pathPrefix": "/api/v1/crm/sales",
    "upstreamUrl": "http://127.0.0.1:5330",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "crm-customers",
    "pathPrefix": "/api/v1/crm/customers",
    "upstreamUrl": "http://127.0.0.1:5320",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "crm-intake",
    "pathPrefix": "/api/v1/crm/intake",
    "upstreamUrl": "http://127.0.0.1:5310",
    "authPolicy": "required",
    "timeoutMs": 60000
  },
  {
    "id": "crm-intake-ingest",
    "pathPrefix": "/api/v1/crm/intake/ingest",
    "upstreamUrl": "http://127.0.0.1:5310",
    "authPolicy": "crm-source",
    "timeoutMs": 60000
  }
];
if (routes.some(route => !route.upstreamUrl.startsWith('http://127.0.0.1:') || /widgets/.test(route.pathPrefix))) throw new Error('Unsafe Gateway route');
write('backend/api-gateway.env', { ...shared, GATEWAY_PORT: '4100', GATEWAY_LISTEN_HOST: '127.0.0.1',
  GATEWAY_ROUTES_JSON: JSON.stringify(routes), JWT_JWKS_URL: 'http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json',
  JWT_ISSUER: q('JWT_ISSUER'), JWT_AUDIENCE: q('JWT_AUDIENCE'), JWT_CLOCK_TOLERANCE_SECONDS: '5', JWT_MAX_TOKEN_LIFETIME_SECONDS: '900' });
write('backend/operations-restore-worker.env', { ...shared, OPERATIONS_PROCESS_ROLE: 'restore-worker', DATABASE_RESTORE_ENABLED: 'false' });
write('backend/postgres.env', { POSTGRES_USER: 'aerocrm_cluster_admin', POSTGRES_PASSWORD: g('POSTGRES_PASSWORD'), POSTGRES_DB: 'postgres' });
write('backend/rabbitmq.env', { RABBITMQ_DEFAULT_USER: 'aerocrm_broker_admin', RABBITMQ_DEFAULT_PASS: g('RABBITMQ_DEFAULT_PASS'), RABBITMQ_DEFAULT_VHOST: 'aerocrm' });
for (const service of services) {
  const prefix = service.replaceAll('-', '_').toUpperCase();
  write(`migrations/${service}.env`, { NODE_ENV: 'production', [`${prefix}_DATABASE_URL`]: dbUrl(service, 'migration') });
}
write('bootstrap/identity-admin.env', providers(['CRM_INITIAL_ADMIN_EMAIL', 'CRM_INITIAL_ADMIN_PASSWORD', 'CRM_INITIAL_ADMIN_FULL_NAME']));
write('bootstrap/billing-policy.env', providers(['CRM_MONTHLY_PRICE_RUB', 'CRM_YEARLY_PRICE_RUB', 'CRM_YEARLY_DISCOUNT_PERCENT',
  'CRM_ADDITIONAL_SEAT_MONTHLY_PRICE_RUB', 'CRM_ADDITIONAL_SEAT_YEARLY_PRICE_RUB', 'CRM_TRIAL_DAYS', 'CRM_TRIAL_SEAT_LIMIT', 'CRM_INCLUDED_SEATS']));
for (const [relative, content] of output) {
  const target = path.join(root, '.deploy/env', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}
console.log(`Rendered ${output.size} private runtime/migration/bootstrap env files; mode 0600; values withheld`);
