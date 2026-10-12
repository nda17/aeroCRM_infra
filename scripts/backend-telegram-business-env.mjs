#!/usr/bin/env node
// Scoped Telegram Business configuration for the canonical backend transaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const telegramBusinessKeys = ['TELEGRAM_BUSINESS_ENABLED', 'TELEGRAM_BUSINESS_BOT_TOKEN',
  'TELEGRAM_BUSINESS_BOT_USERNAME', 'TELEGRAM_BUSINESS_WEBHOOK_SECRET', 'TELEGRAM_BUSINESS_WEBHOOK_URL',
  'TELEGRAM_BUSINESS_API_BASE_URL', 'TELEGRAM_BUSINESS_API_PROXY_IP'];
const owners = ['crm-access-api.env', 'crm-access-telegram-worker.env'];
const webhookUrl = 'https://telegram.aerocrm.space/api/v1/telegram-bot/business-webhook';
const gatewayRoute = Object.freeze({ id: 'telegram-business-webhook',
  pathPrefix: '/api/v1/telegram-bot/business-webhook', upstreamUrl: 'http://127.0.0.1:5300',
  authPolicy: 'telegram-webhook', timeoutMs: 15000 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };

export function validateTelegramBusinessBundle(bytes, expectedHash) {
  check(/^[a-f0-9]{64}$/.test(expectedHash) && digest(bytes) === expectedHash,
    'Private Telegram Business bundle hash mismatch');
  let values;
  try { values = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid Telegram Business bundle'); }
  check(values && typeof values === 'object' && !Array.isArray(values) &&
    Object.keys(values).length === telegramBusinessKeys.length &&
    telegramBusinessKeys.every(key => typeof values[key] === 'string'),
  'Telegram Business bundle must contain exactly seven reviewed fields');
  check(bytes.equals(Buffer.from(JSON.stringify(Object.fromEntries(telegramBusinessKeys.map(key =>
    [key, values[key]]))) + '\n')), 'Telegram Business bundle must be canonical JSON');
  check(values.TELEGRAM_BUSINESS_ENABLED === 'true' || values.TELEGRAM_BUSINESS_ENABLED === 'false',
    'Invalid Telegram Business gate');
  check(/^\d+:[A-Za-z0-9_-]{30,}$/.test(values.TELEGRAM_BUSINESS_BOT_TOKEN),
    'Invalid Telegram Business token shape');
  check(values.TELEGRAM_BUSINESS_BOT_USERNAME === 'aerocrm_tech_bot',
    'Unexpected Telegram Business bot username');
  check(/^[A-Za-z0-9_-]{32,256}$/.test(values.TELEGRAM_BUSINESS_WEBHOOK_SECRET) &&
    !/(?:placeholder|changeme|replace[_-]?me|example|your[_-]?secret|test[_-]?secret)/i.test(values.TELEGRAM_BUSINESS_WEBHOOK_SECRET) &&
    !/^([A-Za-z0-9_-])\1+$/.test(values.TELEGRAM_BUSINESS_WEBHOOK_SECRET),
    'Invalid Telegram Business webhook secret shape');
  check(values.TELEGRAM_BUSINESS_WEBHOOK_URL === webhookUrl,
    'Unexpected Telegram Business webhook URL');
  check(values.TELEGRAM_BUSINESS_API_BASE_URL === 'https://telegram.aerocrm.space/telegram-api' &&
    values.TELEGRAM_BUSINESS_API_PROXY_IP === '185.184.122.62',
    'Unexpected Telegram Business verified relay');
  return values;
}

function privateBytes(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    (!process.getuid || stat.uid === process.getuid()), 'Private Telegram Business file metadata mismatch');
  return fs.readFileSync(file);
}

export function telegramBusinessEnvironmentCandidate({ bundleFile, bundleHash, sourceDirectory }) {
  const stat = fs.lstatSync(sourceDirectory);
  check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(sourceDirectory) === sourceDirectory,
    'Unsafe source env directory');
  const source = new Map(fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.env')).sort()
    .map(name => [name, privateBytes(path.join(sourceDirectory, name))]));
  check(source.has('crm-access-api.env') && source.has('crm-access-worker.env') &&
    source.has('crm-access-outbox-publisher.env') && source.has('api-gateway.env'),
    'CRM Access roles are required');
  const values = validateTelegramBusinessBundle(privateBytes(bundleFile), bundleHash);
  const candidate = new Map(source);
  let previousApi = null;
  for (const name of owners) {
    const present = source.has(name);
    const sourceName = present ? name : 'crm-access-worker.env';
    const original = source.get(sourceName).toString('utf8');
    check(Buffer.from(original).equals(source.get(sourceName)), 'CRM Access environment must be UTF-8');
    const previous = parseEnv(original);
    const existing = present ? telegramBusinessKeys.filter(key => Object.hasOwn(previous, key)) : [];
    check(existing.length === 0 || existing.length === telegramBusinessKeys.length,
      'Partial existing Telegram Business environment is forbidden');
    if (existing.length) {
      check(previous.TELEGRAM_BUSINESS_BOT_TOKEN === values.TELEGRAM_BUSINESS_BOT_TOKEN &&
        previous.TELEGRAM_BUSINESS_WEBHOOK_SECRET === values.TELEGRAM_BUSINESS_WEBHOOK_SECRET,
      'Telegram Business credential rotation requires a separate reviewed process');
    } else check(values.TELEGRAM_BUSINESS_ENABLED === 'false',
      'Provision Telegram Business credentials with the gate disabled first');
    if (name === 'crm-access-telegram-worker.env' && present)
      check(telegramBusinessKeys.every(key => previous[key] === previousApi[key]),
        'Previous Telegram Business configuration must be uniform');
    if (name === 'crm-access-api.env') previousApi = previous;
    if (name === 'crm-access-telegram-worker.env') {
      check((present && previous.CRM_ACCESS_PROCESS_ROLE === 'telegram-worker' &&
        previous.CRM_ACCESS_PORT === '5303') ||
        (!present && previous.CRM_ACCESS_PROCESS_ROLE === 'worker' && previous.CRM_ACCESS_PORT === '5301'),
      'Unexpected Telegram Business worker baseline');
    }
    const seen = new Set();
    const patched = (original.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(line => {
      const match = /^(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=/.exec(line);
      if (!match || !match[1].startsWith('TELEGRAM_BUSINESS_')) return line;
      const key = match[1];
      check(telegramBusinessKeys.includes(key) && !seen.has(key),
        'Unknown or duplicate Telegram Business field');
      seen.add(key);
      return `${key}='${values[key]}'${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`;
    }).join('');
    check(seen.size === existing.length, 'Telegram Business environment parsing differs');
    let replacement = existing.length ? patched :
      `${original}${original && !original.endsWith('\n') ? '\n' : ''}${telegramBusinessKeys.map(key =>
        `${key}='${values[key]}'\n`).join('')}`;
    if (name === 'crm-access-telegram-worker.env' && !present) replacement = replacement
      .replace(/^CRM_ACCESS_PROCESS_ROLE='worker'$/m, "CRM_ACCESS_PROCESS_ROLE='telegram-worker'")
      .replace(/^CRM_ACCESS_PORT='5301'$/m, "CRM_ACCESS_PORT='5303'")
      .replace(/^RABBITMQ_CONNECTION_NAME='aerocrm-crm-access-worker'$/m,
        "RABBITMQ_CONNECTION_NAME='aerocrm-crm-access-telegram-worker'");
    candidate.set(name, Buffer.from(replacement));
  }
  const gatewaySource = source.get('api-gateway.env').toString('utf8');
  check(Buffer.from(gatewaySource).equals(source.get('api-gateway.env')),
    'Gateway environment must be UTF-8');
  const gatewayValues = parseEnv(gatewaySource);
  let routes;
  try { routes = JSON.parse(gatewayValues.GATEWAY_ROUTES_JSON); }
  catch { throw new Error('Invalid reviewed Gateway route inventory'); }
  check(Array.isArray(routes) && routes.every(route => route && typeof route === 'object'),
    'Invalid Gateway routes');
  const existingRoute = routes.filter(route => route.id === gatewayRoute.id ||
    route.pathPrefix === gatewayRoute.pathPrefix);
  check(existingRoute.length === 0 || (existingRoute.length === 1 &&
    JSON.stringify(existingRoute[0]) === JSON.stringify(gatewayRoute)),
  'Unexpected existing Telegram Business Gateway route');
  if (!existingRoute.length) {
    const index = routes.findIndex(route => route.id === 'identity-info-webhook');
    check(index >= 0 && routes.some(route => route.id === 'support-webhook'),
      'Existing Telegram webhook routes differ');
    routes.splice(index, 0, gatewayRoute);
  }
  const originalLine = `GATEWAY_ROUTES_JSON='${gatewayValues.GATEWAY_ROUTES_JSON}'`;
  check(gatewaySource.split(originalLine).length === 2, 'Gateway route source must be canonical');
  candidate.set('api-gateway.env', Buffer.from(gatewaySource.replace(originalLine,
    `GATEWAY_ROUTES_JSON='${JSON.stringify(routes)}'`)));
  for (const [name, bytes] of source) if (![...owners, 'api-gateway.env'].includes(name)) check(candidate.get(name).equals(bytes),
    `Unrelated environment changed: ${name}`);
  for (const name of ['crm-access-worker.env', 'crm-access-outbox-publisher.env'])
    check(!telegramBusinessKeys.some(key => Object.hasOwn(parseEnv(source.get(name).toString('utf8')), key)),
      `Telegram Business credentials must not reach ${name}`);
  return { source, candidate };
}

export function stageTelegramBusinessEnvironment(options) {
  const { candidate } = telegramBusinessEnvironmentCandidate(options);
  fs.mkdirSync(options.candidateDirectory, { mode: 0o700 });
  try {
    for (const [name, bytes] of candidate)
      fs.writeFileSync(path.join(options.candidateDirectory, name), bytes, { mode: 0o600, flag: 'wx' });
    return options.candidateDirectory;
  } catch (error) { fs.rmSync(options.candidateDirectory, { recursive: true, force: true }); throw error; }
}

export function environmentHash(files) {
  return digest([...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, bytes]) =>
    `${digest(bytes)}  ./${name}\n`).join(''));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [mode, file, hash, sourceDirectory] = process.argv.slice(2);
    if (mode === '--preview') {
      assert.equal(process.argv.length, 6);
      const { source, candidate } = telegramBusinessEnvironmentCandidate({
        bundleFile: file, bundleHash: hash, sourceDirectory });
      console.log(JSON.stringify({ beforeHash: environmentHash(source), afterHash: environmentHash(candidate),
        bundleHash: hash, valuesWithheld: true }));
      process.exit(0);
    }
    assert.equal(mode, '--stage'); assert.equal(process.argv.length, 5);
    const secret = process.env.CRM_ACCESS_TELEGRAM_BUSINESS_ENV_BUNDLE ?? '';
    const bytes = Buffer.from(secret.endsWith('\n') ? secret : `${secret}\n`);
    validateTelegramBusinessBundle(bytes, hash);
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ bundleHash: hash, valuesWithheld: true }));
  } catch { console.error('Private Telegram Business configuration validation failed; values withheld'); process.exitCode = 1; }
}
