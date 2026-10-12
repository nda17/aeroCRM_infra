#!/usr/bin/env node
// CI-only Telegram provider activation. The token never enters output or durable files.
import assert from 'node:assert/strict';
import https from 'node:https';
import { validateTelegramBusinessBundle } from './backend-telegram-business-env.mjs';

const secret = process.env.CRM_ACCESS_TELEGRAM_BUSINESS_ENV_BUNDLE ?? '';
const bytes = Buffer.from(secret.endsWith('\n') ? secret : `${secret}\n`);
const values = validateTelegramBusinessBundle(bytes, process.env.TELEGRAM_ENV_BUNDLE_HASH ?? '');
assert.equal(values.TELEGRAM_BUSINESS_ENABLED, 'true', 'Webhook activation requires the enabled backend bundle');
const host = 'telegram.aerocrm.space';
const webhookPath = '/api/v1/telegram-bot/business-webhook';
const token = values.TELEGRAM_BUSINESS_BOT_TOKEN;
const basePath = `/telegram-api/bot${token}/`;
const allowedUpdates = ['message', 'callback_query', 'business_connection', 'business_message',
  'edited_business_message', 'deleted_business_messages'];

function request(path, body, expectedStatus = 200) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({ hostname: host, port: 443, family: 4, path, method: data ? 'POST' : 'GET',
      servername: host, rejectUnauthorized: true, timeout: 15000,
      lookup: (_hostname, _options, callback) => callback(null, values.TELEGRAM_BUSINESS_API_PROXY_IP, 4),
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) { req.destroy(); reject(new Error('Provider response too large')); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== expectedStatus) {
          reject(new Error(`Provider HTTP status ${response.statusCode}`)); return;
        }
        if (expectedStatus === 401) { resolve(null); return; }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.ok !== true || !parsed.result) throw new Error('Provider returned unsuccessful result');
          resolve(parsed.result);
        } catch { reject(new Error('Invalid provider response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Provider timeout')));
    req.on('error', () => reject(new Error('Provider connection or TLS validation failed')));
    if (data) req.write(data);
    req.end();
  });
}

try {
  await request(webhookPath, {}, 401);
  const bot = await request(`${basePath}getMe`);
  assert.equal(bot.username, values.TELEGRAM_BUSINESS_BOT_USERNAME, 'Unexpected bot username');
  assert.equal(bot.can_connect_to_business, true, 'Bot cannot connect to Telegram Business');
  const before = await request(`${basePath}getWebhookInfo`);
  assert(before.url === '' || before.url === values.TELEGRAM_BUSINESS_WEBHOOK_URL,
    'Bot has another webhook; automatic takeover forbidden');
  await request(`${basePath}setWebhook`, { url: values.TELEGRAM_BUSINESS_WEBHOOK_URL,
    secret_token: values.TELEGRAM_BUSINESS_WEBHOOK_SECRET,
    allowed_updates: allowedUpdates, drop_pending_updates: false });
  const after = await request(`${basePath}getWebhookInfo`);
  assert.equal(after.url, values.TELEGRAM_BUSINESS_WEBHOOK_URL, 'Webhook URL differs after activation');
  assert(allowedUpdates.every(update => after.allowed_updates?.includes(update)),
    'Provider allowed update list differs');
  console.log(JSON.stringify({ configured: true, botId: bot.id, username: bot.username,
    webhookUrl: after.url, allowedUpdates, pendingUpdateCount: after.pending_update_count ?? null,
    lastErrorDate: after.last_error_date ?? null }));
} catch (error) {
  console.error(`Telegram Business webhook activation failed: ${error.message}`);
  process.exitCode = 1;
}
