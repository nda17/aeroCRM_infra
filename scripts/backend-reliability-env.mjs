// Scoped reliability release environment. Never writes live files or logs values.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { environmentHash } from './backend-chat-env.mjs';

const backupFile = 'operations-worker.env';
const mailFiles = ['crm-customers-api.env', 'crm-customers-mail-sync.env', 'crm-customers-mail-send.env'];
const accessFiles = ['crm-access-api.env', 'crm-access-telegram-worker.env'];
const files = [backupFile, ...mailFiles, ...accessFiles];
const fields = {
  [backupFile]: ['CRM_BACKUP_S3_ACCESS_KEY_ID', 'CRM_BACKUP_S3_SECRET_ACCESS_KEY'],
  ...Object.fromEntries(mailFiles.map(name => [name, [
    'CRM_MAIL_CREDENTIAL_KEYRING', 'CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID',
    'CRM_MAIL_HMAC_KEYRING', 'CRM_MAIL_HMAC_ACTIVE_KEY_ID', 'CRM_MAIL_KEY_ROTATION_ENABLED'
  ]])),
  ...Object.fromEntries(accessFiles.map(name => [name, ['CRM_ACCESS_RETENTION_ENABLED']]))
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (ok, message) => { if (!ok) throw new Error(message); };
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
const keyId = value => /^[A-Za-z0-9_-]{1,80}$/.test(value);
const keyBytes = value => /^[A-Za-z0-9+/]{43}=$/.test(value) &&
  Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value;

function keyring(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`Invalid ${label} keyring`); }
  check(value.length <= 8192 && parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    Object.keys(parsed).length >= 2 && Object.keys(parsed).length <= 10 &&
    Object.entries(parsed).every(([id, bytes]) => keyId(id) && keyBytes(bytes)) &&
    JSON.stringify(parsed) === value, `Invalid ${label} keyring`);
  return parsed;
}

// Shared by the operator's full renderer; an absent keyring keeps legacy Mail readable.
// Once any active key is configured, all read keys and the unchanged legacy pair are required.
export function reliabilityRoleEnvironmentFields(input, service, role) {
  if (service === 'crm-access') {
    if (!['api', 'telegram-worker'].includes(role)) return {};
    const value = input.CRM_ACCESS_RETENTION_ENABLED ?? 'false';
    check(['true', 'false'].includes(value), 'Invalid CRM_ACCESS_RETENTION_ENABLED');
    return { CRM_ACCESS_RETENTION_ENABLED: value };
  }
  if (service !== 'crm-customers') return {};
  check(['api', 'mail-sync', 'mail-send'].includes(role), 'Invalid CRM Customers role');
  const legacyId = input.CRM_MAIL_CREDENTIAL_KEY_ID;
  const legacyKey = input.CRM_MAIL_CREDENTIAL_KEY;
  const enabled = input.CRM_MAIL_ENABLED === 'true';
  const rotation = input.CRM_MAIL_KEY_ROTATION_ENABLED ?? 'false';
  check(['true', 'false'].includes(rotation), 'Invalid CRM_MAIL_KEY_ROTATION_ENABLED');
  const names = ['CRM_MAIL_CREDENTIAL_KEYRING', 'CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID',
    'CRM_MAIL_HMAC_KEYRING', 'CRM_MAIL_HMAC_ACTIVE_KEY_ID'];
  const hasNew = names.some(name => input[name] !== undefined);
  const needsLegacy = enabled || rotation === 'true' || hasNew || legacyId !== undefined || legacyKey !== undefined;
  if (needsLegacy) check(keyId(legacyId) && keyBytes(legacyKey), 'Mail legacy key is incomplete');
  const result = { CRM_MAIL_KEY_ROTATION_ENABLED: rotation };
  if (needsLegacy) Object.assign(result, { CRM_MAIL_CREDENTIAL_KEY_ID: legacyId,
    CRM_MAIL_CREDENTIAL_KEY: legacyKey });
  if (!hasNew) {
    check(rotation === 'false', 'Mail rotation requires complete keyrings');
    return result;
  }
  check(names.every(name => typeof input[name] === 'string' && input[name]),
    'Mail keyrings and active IDs must be complete');
  const aes = keyring(input.CRM_MAIL_CREDENTIAL_KEYRING, 'AES');
  const hmac = keyring(input.CRM_MAIL_HMAC_KEYRING, 'HMAC');
  check(aes[legacyId] === legacyKey && hmac[legacyId] === legacyKey,
    'Mail keyrings must preserve the legacy key');
  const aesId = input.CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID;
  const hmacId = input.CRM_MAIL_HMAC_ACTIVE_KEY_ID;
  check(keyId(aesId) && !!aes[aesId] && keyId(hmacId) && !!hmac[hmacId],
    'Mail active IDs must exist in keyrings');
  check(Object.entries(aes).every(([id, bytes]) => id === legacyId ||
    Object.entries(hmac).every(([hmacKeyId, hmacBytes]) => hmacKeyId === legacyId || bytes !== hmacBytes)),
    'New Mail AES and HMAC material must be independent');
  if (rotation === 'true') check(enabled && aesId !== legacyId && hmacId !== legacyId && aesId !== hmacId,
    'Mail rotation requires distinct new active IDs and enabled Mail');
  return { ...result, ...Object.fromEntries(names.map(name => [name, input[name]])) };
}

function privateFile(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    (!process.getuid || stat.uid === process.getuid()), 'Private reliability file metadata mismatch');
  return fs.readFileSync(file);
}

export function validateReliabilityBundle(bytes, expectedHash) {
  check(/^[a-f0-9]{64}$/.test(expectedHash) && hash(bytes) === expectedHash,
    'Private reliability bundle hash mismatch');
  let bundle;
  try { bundle = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid reliability bundle'); }
  check(exactKeys(bundle, ['schemaVersion', 'phase', 'files']) && bundle.schemaVersion === 1 &&
    ['prepare', 'activate'].includes(bundle.phase) && exactKeys(bundle.files, files),
  'Reliability bundle shape mismatch');
  for (const name of files) {
    check(exactKeys(bundle.files[name], fields[name]), 'Reliability bundle field inventory mismatch');
    check(fields[name].every(key => typeof bundle.files[name][key] === 'string' && bundle.files[name][key] &&
      !/[\r\n\0']/.test(bundle.files[name][key])), 'Invalid reliability bundle value');
  }
  check(bytes.equals(Buffer.from(JSON.stringify(bundle) + '\n')), 'Reliability bundle must be canonical JSON with final LF');
  const backup = bundle.files[backupFile];
  check(backup.CRM_BACKUP_S3_ACCESS_KEY_ID && backup.CRM_BACKUP_S3_SECRET_ACCESS_KEY,
    'Backup principal is incomplete');
  for (const name of mailFiles) {
    const mail = bundle.files[name];
    const aes = keyring(mail.CRM_MAIL_CREDENTIAL_KEYRING, 'AES');
    const hmac = keyring(mail.CRM_MAIL_HMAC_KEYRING, 'HMAC');
    check(keyId(mail.CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID) && aes[mail.CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID] &&
      keyId(mail.CRM_MAIL_HMAC_ACTIVE_KEY_ID) && hmac[mail.CRM_MAIL_HMAC_ACTIVE_KEY_ID] &&
      mail.CRM_MAIL_KEY_ROTATION_ENABLED === (bundle.phase === 'activate' ? 'true' : 'false'),
      'Mail keyring activation is invalid');
    check(JSON.stringify(mail) === JSON.stringify(bundle.files[mailFiles[0]]),
      'Mail keyring must be identical across all three roles');
  }
  for (const name of accessFiles)
    check(bundle.files[name].CRM_ACCESS_RETENTION_ENABLED === (bundle.phase === 'activate' ? 'true' : 'false'),
      'Access retention gate differs from release phase');
  return bundle;
}

function patchEnv(bytes, values) {
  const original = bytes.toString('utf8');
  check(Buffer.from(original).equals(bytes), 'Reliability source env must be UTF-8');
  const seen = new Set();
  let result = (original.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(line => {
    const match = /^(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=/.exec(line);
    if (!match || !Object.hasOwn(values, match[1])) return line;
    check(!seen.has(match[1]), 'Duplicate reliability env field');
    seen.add(match[1]);
    return `${match[1]}='${values[match[1]]}'${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`;
  }).join('');
  result += `${result && !result.endsWith('\n') ? '\n' : ''}${Object.keys(values).filter(key => !seen.has(key))
    .map(key => `${key}='${values[key]}'\n`).join('')}`;
  return Buffer.from(result);
}

export function reliabilityEnvironmentCandidate({ bundleFile, bundleHash, sourceDirectory }) {
  const stat = fs.lstatSync(sourceDirectory);
  check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(sourceDirectory) === sourceDirectory,
    'Unsafe reliability source directory');
  const source = new Map(fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.env')).sort()
    .map(name => [name, privateFile(path.join(sourceDirectory, name))]));
  const bundle = validateReliabilityBundle(privateFile(bundleFile), bundleHash);
  check(files.every(name => source.has(name)), 'Reliability release requires all reviewed role env files');
  const previous = Object.fromEntries(files.map(name => [name, parseEnv(source.get(name).toString('utf8'))]));
  const legacyId = previous[mailFiles[0]].CRM_MAIL_CREDENTIAL_KEY_ID;
  const legacyKey = previous[mailFiles[0]].CRM_MAIL_CREDENTIAL_KEY;
  check(keyId(legacyId) && keyBytes(legacyKey) && mailFiles.every(name =>
    previous[name].CRM_MAIL_CREDENTIAL_KEY_ID === legacyId && previous[name].CRM_MAIL_CREDENTIAL_KEY === legacyKey),
  'Existing Mail legacy keys must be uniform and preserved');
  check(previous[backupFile].CRM_BACKUP_S3_BUCKET === 'backup-services' &&
    previous[backupFile].CRM_BACKUP_S3_ENDPOINT?.startsWith('https://') &&
    previous[backupFile].CRM_BACKUP_S3_ACCESS_KEY_ID,
  'Reviewed private backup storage is required');
  const candidate = new Map(source);
  for (const name of files) candidate.set(name, patchEnv(source.get(name), bundle.files[name]));
  const next = Object.fromEntries(files.map(name => [name, parseEnv(candidate.get(name).toString('utf8'))]));
  check(next[backupFile].CRM_BACKUP_S3_ACCESS_KEY_ID !== previous[backupFile].CRM_BACKUP_S3_ACCESS_KEY_ID ||
    bundle.phase === 'activate', 'Prepare must rotate the backup principal');
  const otherIds = [...source.values()].flatMap(bytes => Object.entries(parseEnv(bytes.toString('utf8')))
    .filter(([key]) => key.endsWith('_S3_ACCESS_KEY_ID') && key !== 'CRM_BACKUP_S3_ACCESS_KEY_ID')
    .map(([, value]) => value));
  check(!otherIds.includes(next[backupFile].CRM_BACKUP_S3_ACCESS_KEY_ID),
    'Backup principal must be independent of runtime storage principals');
  for (const name of mailFiles) {
    if (bundle.phase === 'prepare')
      check((!previous[name].CRM_MAIL_KEY_ROTATION_ENABLED || previous[name].CRM_MAIL_KEY_ROTATION_ENABLED === 'false') &&
        (!previous[name].CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID || previous[name].CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID === legacyId) &&
        (!previous[name].CRM_MAIL_HMAC_ACTIVE_KEY_ID || previous[name].CRM_MAIL_HMAC_ACTIVE_KEY_ID === legacyId),
        'Prepare cannot deactivate an existing Mail key rotation');
    check(next[name].CRM_MAIL_CREDENTIAL_KEY_ID === legacyId && next[name].CRM_MAIL_CREDENTIAL_KEY === legacyKey,
      'Legacy mail key changed');
    const aes = keyring(next[name].CRM_MAIL_CREDENTIAL_KEYRING, 'AES');
    const hmac = keyring(next[name].CRM_MAIL_HMAC_KEYRING, 'HMAC');
    check(aes[legacyId] === legacyKey && hmac[legacyId] === legacyKey,
      'Legacy mail key must remain readable in both keyrings');
    check(Object.entries(aes).every(([id, bytes]) => id === legacyId ||
      Object.entries(hmac).every(([hmacId, hmacBytes]) => hmacId === legacyId || bytes !== hmacBytes)),
    'New Mail AES and HMAC key material must be independent');
    for (const [key, ring] of [['CRM_MAIL_CREDENTIAL_KEYRING', aes], ['CRM_MAIL_HMAC_KEYRING', hmac]]) {
      if (!previous[name][key]) continue;
      const old = keyring(previous[name][key], key);
      check(Object.entries(old).every(([id, value]) => ring[id] === value),
        'Mail transition cannot remove or replace a read key');
    }
    if (bundle.phase === 'prepare') {
      check(next[name].CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID === legacyId &&
        next[name].CRM_MAIL_HMAC_ACTIVE_KEY_ID === legacyId,
        'Prepare must retain legacy active Mail key IDs');
    } else {
      check(previous[name].CRM_MAIL_ENABLED === 'true' &&
        previous[name].CRM_MAIL_CREDENTIAL_KEYRING && previous[name].CRM_MAIL_HMAC_KEYRING &&
        previous[name].CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID === legacyId &&
        previous[name].CRM_MAIL_HMAC_ACTIVE_KEY_ID === legacyId &&
        previous[name].CRM_MAIL_KEY_ROTATION_ENABLED === 'false' &&
        next[name].CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID !== legacyId &&
        next[name].CRM_MAIL_HMAC_ACTIVE_KEY_ID !== legacyId &&
        next[name].CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID !== next[name].CRM_MAIL_HMAC_ACTIVE_KEY_ID,
        'Activate requires prepared keyrings and new active Mail IDs');
    }
  }
  if (bundle.phase === 'activate') {
    check(next[backupFile].CRM_BACKUP_S3_ACCESS_KEY_ID === previous[backupFile].CRM_BACKUP_S3_ACCESS_KEY_ID &&
      next[backupFile].CRM_BACKUP_S3_SECRET_ACCESS_KEY === previous[backupFile].CRM_BACKUP_S3_SECRET_ACCESS_KEY,
      'Activate must preserve the prepared backup principal');
    check(accessFiles.every(name => previous[name].CRM_ACCESS_RETENTION_ENABLED === 'false'),
      'Activate requires a disabled Access retention snapshot');
  } else {
    check(accessFiles.every(name => !previous[name].CRM_ACCESS_RETENTION_ENABLED ||
      previous[name].CRM_ACCESS_RETENTION_ENABLED === 'false'),
      'Prepare cannot deactivate existing Access retention');
  }
  return { source, candidate, phase: bundle.phase,
    beforeHash: environmentHash(source), afterHash: environmentHash(candidate) };
}

export function stageReliabilityEnvironment(options) {
  const { candidate } = reliabilityEnvironmentCandidate(options);
  fs.mkdirSync(options.candidateDirectory, { mode: 0o700 });
  try {
    for (const [name, bytes] of candidate)
      fs.writeFileSync(path.join(options.candidateDirectory, name), bytes, { mode: 0o600, flag: 'wx' });
  } catch (error) { fs.rmSync(options.candidateDirectory, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [mode, file, bundleHash, sourceDirectory] = process.argv.slice(2);
    if (mode === '--preview') {
      assert.equal(process.argv.length, 6);
      const { phase, beforeHash, afterHash } = reliabilityEnvironmentCandidate({ bundleFile: file,
        bundleHash, sourceDirectory });
      console.log(JSON.stringify({ phase, beforeHash, afterHash, bundleHash, valuesWithheld: true }));
    } else {
      assert.equal(mode, '--stage'); assert.equal(process.argv.length, 5);
      const secret = process.env.CRM_RELIABILITY_ENV_BUNDLE ?? '';
      const bytes = Buffer.from(secret.endsWith('\n') ? secret : `${secret}\n`);
      validateReliabilityBundle(bytes, bundleHash);
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      console.log('Private reliability bundle staged; values withheld');
    }
  } catch { console.error('Private reliability bundle validation failed; values withheld'); process.exitCode = 1; }
}
