import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { telegramBusinessKeys, validateTelegramBusinessBundle,
  telegramBusinessEnvironmentCandidate, stageTelegramBusinessEnvironment }
  from './backend-telegram-business-env.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function bundle(enabled = 'false') {
  return Buffer.from(`${JSON.stringify({
    TELEGRAM_BUSINESS_ENABLED: enabled,
    TELEGRAM_BUSINESS_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyzABCDE12345',
    TELEGRAM_BUSINESS_BOT_USERNAME: 'aerocrm_tech_bot',
    TELEGRAM_BUSINESS_WEBHOOK_SECRET: 'synthetic-webhook-secret-value-123456',
    TELEGRAM_BUSINESS_WEBHOOK_URL: 'https://telegram.aerocrm.space/api/v1/telegram-bot/business-webhook',
    TELEGRAM_BUSINESS_API_BASE_URL: 'https://telegram.aerocrm.space/telegram-api',
    TELEGRAM_BUSINESS_API_PROXY_IP: '185.184.122.62'
  })}\n`);
}
function privateFile(file, bytes) {
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-telegram-env-test-')));
  const sourceDirectory = path.join(root, 'source');
  fs.mkdirSync(sourceDirectory, { mode: 0o700 });
  fs.chmodSync(sourceDirectory, 0o700);
  const existingRoutes = [
    { id: 'identity-info-webhook', pathPrefix: '/api/v1/identity-telegram/webhook', upstreamUrl: 'http://127.0.0.1:4900', authPolicy: 'telegram-webhook', timeoutMs: 15000 },
    { id: 'support-webhook', pathPrefix: '/api/v1/support/telegram/webhook', upstreamUrl: 'http://127.0.0.1:5100', authPolicy: 'telegram-webhook', timeoutMs: 15000 }
  ];
  const source = {
    'api-gateway.env': `GATEWAY_ROUTES_JSON='${JSON.stringify(existingRoutes)}'\nGATEWAY_UNRELATED_SETTING='retained'\n`,
    'crm-access-api.env': "CRM_ACCESS_PROCESS_ROLE='api'\nCRM_ACCESS_PORT='5300'\n",
    'crm-access-worker.env': "CRM_ACCESS_PROCESS_ROLE='worker'\nCRM_ACCESS_PORT='5301'\nRABBITMQ_CONNECTION_NAME='aerocrm-crm-access-worker'\n",
    'crm-access-outbox-publisher.env': "CRM_ACCESS_PROCESS_ROLE='outbox-publisher'\nCRM_ACCESS_PORT='5302'\n"
  };
  for (const [name, text] of Object.entries(source)) privateFile(path.join(sourceDirectory, name), Buffer.from(text));
  const bundleFile = path.join(root, 'bundle.json');
  const bytes = bundle();
  privateFile(bundleFile, bytes);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sourceDirectory, source, existingRoutes, bundleFile, bytes };
}
const sourceText = (candidate, name) => candidate.get(name).toString('utf8');

test('seven-field bundle accepts only canonical JSON with the reviewed disabled gate', () => {
  const bytes = bundle();
  const values = validateTelegramBusinessBundle(bytes, hash(bytes));
  assert.deepEqual(Object.keys(values), telegramBusinessKeys);
  for (const invalid of [
    Buffer.from(bytes.toString().trim()),
    Buffer.from(bytes.toString().replace('TELEGRAM_BUSINESS_ENABLED', 'UNKNOWN_FIELD')),
    Buffer.from(`${bytes.toString().trim().slice(0, -1)},"EXTRA":"x"}\n`),
    bundle('yes')
  ]) assert.throws(() => validateTelegramBusinessBundle(invalid, hash(invalid)));
  assert.equal(validateTelegramBusinessBundle(bundle('true'), hash(bundle('true'))).TELEGRAM_BUSINESS_ENABLED, 'true');
  assert.throws(() => validateTelegramBusinessBundle(bytes, '0'.repeat(64)), /hash mismatch/);
});

test('candidate installs Telegram fields only in API and a dedicated 5303 worker, preserving common worker and publisher', t => {
  const f = fixture(t);
  const { candidate } = telegramBusinessEnvironmentCandidate({ bundleFile: f.bundleFile,
    bundleHash: hash(f.bytes), sourceDirectory: f.sourceDirectory });
  const api = sourceText(candidate, 'crm-access-api.env');
  const worker = sourceText(candidate, 'crm-access-telegram-worker.env');
  assert(telegramBusinessKeys.every(key => api.includes(`${key}='`)));
  assert.match(api, /^TELEGRAM_BUSINESS_ENABLED='false'$/m);
  assert.match(worker, /^CRM_ACCESS_PROCESS_ROLE='telegram-worker'$/m);
  assert.match(worker, /^CRM_ACCESS_PORT='5303'$/m);
  assert.match(worker, /^RABBITMQ_CONNECTION_NAME='aerocrm-crm-access-telegram-worker'$/m);
  assert(telegramBusinessKeys.every(key => worker.includes(`${key}='`)));
  const gateway = sourceText(candidate, 'api-gateway.env');
  const gatewayRoutes = JSON.parse(/^GATEWAY_ROUTES_JSON='([^']+)'$/m.exec(gateway)[1]);
  assert.equal(gatewayRoutes.length, 3);
  assert.deepEqual(gatewayRoutes[0], {
    id: 'telegram-business-webhook',
    pathPrefix: '/api/v1/telegram-bot/business-webhook',
    upstreamUrl: 'http://127.0.0.1:5300',
    authPolicy: 'telegram-webhook',
    timeoutMs: 15000
  });
  assert.deepEqual(gatewayRoutes.slice(1), f.existingRoutes);
  assert.match(gateway, /^GATEWAY_UNRELATED_SETTING='retained'$/m);
  for (const name of ['crm-access-worker.env', 'crm-access-outbox-publisher.env']) {
    assert.equal(sourceText(candidate, name), f.source[name]);
    assert(!telegramBusinessKeys.some(key => sourceText(candidate, name).includes(`${key}=`)));
  }
});

test('existing exact bundle can be enabled idempotently while credential rotation and partial config fail closed', t => {
  const f = fixture(t);
  const first = telegramBusinessEnvironmentCandidate({ bundleFile: f.bundleFile,
    bundleHash: hash(f.bytes), sourceDirectory: f.sourceDirectory }).candidate;
  const enabledBytes = bundle('true');
  const enabledBundleFile = path.join(f.root, 'enabled.json');
  privateFile(enabledBundleFile, enabledBytes);
  const settings = JSON.parse(enabledBytes.toString());
  const sourceToEnabled = name => {
    const original = sourceText(first, name).replace(/^TELEGRAM_BUSINESS_[A-Z0-9_]+=.*\n/gm, '');
    return `${original}${telegramBusinessKeys.map(key => `${key}='${settings[key]}'\n`).join('')}`;
  };
  const enabledSource = path.join(f.root, 'enabled-source');
  fs.mkdirSync(enabledSource, { mode: 0o700 });
  for (const name of Object.keys(f.source)) {
    const text = name === 'crm-access-api.env' ? sourceToEnabled(name)
      : name === 'api-gateway.env' ? sourceText(first, name) : f.source[name];
    privateFile(path.join(enabledSource, name), Buffer.from(text));
  }
  privateFile(path.join(enabledSource, 'crm-access-telegram-worker.env'),
    Buffer.from(sourceToEnabled('crm-access-telegram-worker.env')));
  const rerun = telegramBusinessEnvironmentCandidate({ bundleFile: enabledBundleFile,
    bundleHash: hash(enabledBytes), sourceDirectory: enabledSource }).candidate;
  assert.match(sourceText(rerun, 'crm-access-api.env'), /^TELEGRAM_BUSINESS_ENABLED='true'$/m);
  assert.match(sourceText(rerun, 'crm-access-telegram-worker.env'), /^TELEGRAM_BUSINESS_ENABLED='true'$/m);

  const rotate = Buffer.from(enabledBytes.toString().replace('123456:abcdefghijklmnopqrstuvwxyzABCDE12345', '654321:abcdefghijklmnopqrstuvwxyzABCDE12345'));
  const rotateFile = path.join(f.root, 'rotate.json');
  privateFile(rotateFile, rotate);
  assert.throws(() => telegramBusinessEnvironmentCandidate({ bundleFile: rotateFile,
    bundleHash: hash(rotate), sourceDirectory: enabledSource }), /credential rotation/);

  const partialSource = path.join(f.root, 'partial-source');
  fs.cpSync(enabledSource, partialSource, { recursive: true });
  const apiFile = path.join(partialSource, 'crm-access-api.env');
  fs.writeFileSync(apiFile, fs.readFileSync(apiFile, 'utf8').replace(/TELEGRAM_BUSINESS_API_PROXY_IP=.*\n/, ''), { mode: 0o600 });
  assert.throws(() => telegramBusinessEnvironmentCandidate({ bundleFile: enabledBundleFile,
    bundleHash: hash(enabledBytes), sourceDirectory: partialSource }), /Partial existing/);
});

test('staging writes the exact candidate with private directory and file permissions', t => {
  const f = fixture(t);
  const destination = path.join(f.root, 'candidate');
  stageTelegramBusinessEnvironment({ bundleFile: f.bundleFile, bundleHash: hash(f.bytes),
    sourceDirectory: f.sourceDirectory, candidateDirectory: destination });
  assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(destination, 'crm-access-telegram-worker.env')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'crm-access-worker.env')),
    fs.readFileSync(path.join(f.sourceDirectory, 'crm-access-worker.env')));
});
