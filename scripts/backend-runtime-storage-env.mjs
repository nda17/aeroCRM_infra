// Reviewed runtime storage delta; never changes live files or performs network calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { environmentHash } from './backend-chat-env.mjs';

// Capabilityless containers must read private bind mounts as their host owner.
export function privateStorageUser(uid = process.getuid?.(), gid = process.getgid?.()) {
  assert(Number.isSafeInteger(uid) && uid >= 0 && Number.isSafeInteger(gid) && gid >= 0,
    'Private storage container requires a valid host UID and GID');
  return `${uid}:${gid}`;
}

export const storageFields = ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'FORCE_PATH_STYLE'];
export const storageOwners = {
  CRM_MAIL: ['crm-customers-api.env', 'crm-customers-mail-sync.env', 'crm-customers-mail-send.env'],
  SUPPORT: ['support-api.env'], IDENTITY_AVATAR: ['identity-api.env'], CRM_CHAT: ['crm-access-api.env']
};
export const runtimeStorageKeys = [...Object.keys(storageOwners).flatMap(owner => storageFields.map(field => `${owner}_S3_${field}`)), 'CRM_CHAT_ATTACHMENTS_ENABLED'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
export function validateFrozenAvatarReferences({ paths, mediaEmpty }) {
  check(mediaEmpty === true && Array.isArray(paths) && paths.length === 2,
    'Frozen Avatar history differs from the reviewed external-only profile');
  for (const value of paths) {
    check(typeof value === 'string', 'Invalid frozen Avatar reference');
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid frozen Avatar reference'); }
    check(url.protocol === 'https:' && url.hostname === 'avatars.yandex.net' && !url.port && !url.username && !url.password,
      'Frozen Avatar reference requires a separate reviewed storage plan');
  }
  return { externalAvatars: paths.length, mediaEmpty: true };
}
export function storageReferenceHash(rows) {
  const normalized = rows.map(row => {
    check(Array.isArray(row) && row.length === 7, 'Invalid storage reference tuple');
    const [owner, kind, key, state, sha256, size, expires] = row;
    check(['mail', 'support'].includes(owner) && ['attachment', 'mime'].includes(kind) && typeof state === 'string',
      'Invalid storage reference identity');
    check((key === null || typeof key === 'string') && (sha256 === null || typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)),
      'Invalid storage reference key or hash');
    check(kind === 'mime' ? size === null && expires === null : Number.isSafeInteger(size) && size >= 0,
      'Invalid storage reference size');
    check(expires === null || typeof expires === 'string' && expires.endsWith('Z') && Number.isFinite(Date.parse(expires)),
      'Storage reference expiration must be UTC');
    return [owner, kind, key, state, sha256, size, expires == null ? null : new Date(expires).toISOString()];
  }).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return digest(JSON.stringify({ schemaVersion: 1, rows: normalized }) + '\n');
}
export function privateBytes(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    (!process.getuid || stat.uid === process.getuid()), 'Private storage file metadata mismatch');
  return fs.readFileSync(file);
}
export function validateRuntimeStorageBundle(bytes, expectedHash) {
  check(/^[a-f0-9]{64}$/.test(expectedHash) && digest(bytes) === expectedHash, 'Private storage bundle hash mismatch');
  let values;
  try { values = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid private storage bundle'); }
  check(values && !Array.isArray(values) && Object.keys(values).length === runtimeStorageKeys.length &&
    runtimeStorageKeys.every(key => typeof values[key] === 'string' && values[key]), 'Storage bundle requires exactly 25 reviewed values');
  check(bytes.equals(Buffer.from(JSON.stringify(Object.fromEntries(runtimeStorageKeys.map(key => [key, values[key]]))) + '\n')),
    'Private storage bundle must be canonical');
  check(Object.values(values).every(value => !/[\r\n\0']/.test(value)), 'Invalid storage configuration text');
  const ids = [];
  for (const owner of Object.keys(storageOwners)) {
    let endpoint;
    try { endpoint = new URL(values[`${owner}_S3_ENDPOINT`]); } catch { throw new Error('Invalid storage provider endpoint'); }
    check(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
      'Invalid storage provider endpoint');
    check(values[`${owner}_S3_BUCKET`] === 'content-files', 'Runtime storage requires content-files');
    check(['true', 'false'].includes(values[`${owner}_S3_FORCE_PATH_STYLE`]), 'Explicit storage path style is required');
    for (const field of ['ENDPOINT', 'REGION', 'FORCE_PATH_STYLE'])
      check(values[`${owner}_S3_${field}`] === values[`CRM_MAIL_S3_${field}`], 'Runtime storage provider tuple must be uniform');
    ids.push(values[`${owner}_S3_ACCESS_KEY_ID`]);
  }
  check(new Set(ids).size === 4, 'Runtime storage requires four independent principals');
  check(values.CRM_CHAT_ATTACHMENTS_ENABLED === 'true', 'Reviewed Chat storage must be enabled');
  return values;
}
export function runtimeStorageEnvironmentCandidate({ bundleFile, bundleHash, sourceDirectory }) {
  const stat = fs.lstatSync(sourceDirectory);
  check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(sourceDirectory) === sourceDirectory, 'Unsafe source env directory');
  const source = new Map(fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.env')).sort()
    .map(name => [name, privateBytes(path.join(sourceDirectory, name))]));
  const values = validateRuntimeStorageBundle(privateBytes(bundleFile), bundleHash);
  const trusted = storageOwners.CRM_MAIL.map(name => {
    check(source.has(name), 'Trusted Mail role environment required');
    return parseEnv(source.get(name).toString('utf8'));
  });
  for (const field of storageFields)
    check(trusted.every(env => env[`CRM_MAIL_S3_${field}`] && env[`CRM_MAIL_S3_${field}`] === trusted[0][`CRM_MAIL_S3_${field}`]),
      'Existing Mail S3 fields must be uniform across three roles');
  for (const field of ['ENDPOINT', 'REGION', 'FORCE_PATH_STYLE'])
    check(values[`CRM_MAIL_S3_${field}`] === trusted[0][`CRM_MAIL_S3_${field}`], 'Storage must preserve the trusted provider tuple');
  check(source.has('identity-api.env'), 'Reviewed Identity storage environment required');
  const identity = parseEnv(source.get('identity-api.env').toString('utf8'));
  check(identity.IDENTITY_AVATAR_S3_BUCKET === 'content-files' &&
    ['ENDPOINT', 'REGION', 'FORCE_PATH_STYLE'].every(field => identity[`IDENTITY_AVATAR_S3_${field}`] === values[`IDENTITY_AVATAR_S3_${field}`]),
    'Existing Avatar storage must already use the reviewed content-files provider');
  let avatarPublicUrl;
  try { avatarPublicUrl = new URL(identity.IDENTITY_AVATAR_S3_PUBLIC_BASE_URL); }
  catch { throw new Error('Existing Avatar public URL must preserve the reviewed API proxy'); }
  check(avatarPublicUrl.protocol === 'https:' && !avatarPublicUrl.username && !avatarPublicUrl.password &&
    !avatarPublicUrl.search && !avatarPublicUrl.hash &&
    avatarPublicUrl.toString().replace(/\/$/, '') === 'https://api.aerocrm.space/api/v1/users/avatar-files',
    'Existing Avatar public URL must preserve the reviewed API proxy');
  const oldIds = [...source.values()].flatMap(bytes => {
    const env = parseEnv(bytes.toString('utf8'));
    return [...Object.keys(storageOwners), 'CRM_BACKUP'].map(owner => env[`${owner}_S3_ACCESS_KEY_ID`]).filter(Boolean);
  });
  check(Object.keys(storageOwners).every(owner => !oldIds.includes(values[`${owner}_S3_ACCESS_KEY_ID`])),
    'Storage principals must be newly provisioned and independent from source and backup');
  const candidate = new Map(source);
  for (const [owner, names] of Object.entries(storageOwners)) for (const name of names) {
    check(source.has(name), 'Every reviewed storage role environment is required');
    const keys = storageFields.map(field => `${owner}_S3_${field}`);
    if (owner === 'CRM_CHAT') keys.push('CRM_CHAT_ATTACHMENTS_ENABLED');
    const bytes = source.get(name), original = bytes.toString('utf8');
    check(Buffer.from(original).equals(bytes), 'Storage role environment must be UTF-8');
    const seen = new Set();
    const patched = (original.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(line => {
      const match = /^(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=/.exec(line);
      if (!match || !keys.includes(match[1])) return line;
      check(!seen.has(match[1]), 'Duplicate reviewed storage environment field');
      seen.add(match[1]);
      return `${match[1]}='${values[match[1]]}'${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`;
    }).join('');
    check(owner === 'CRM_CHAT' ? seen.size === 0 || seen.size === keys.length : seen.size === keys.length,
      'Incomplete storage role environment is forbidden');
    candidate.set(name, Buffer.from(seen.size ? patched : `${original}${original && !original.endsWith('\n') ? '\n' : ''}${keys.map(key => `${key}='${values[key]}'\n`).join('')}`));
  }
  return { source, candidate };
}
export function stageRuntimeStorageEnvironment(options) {
  const { candidate } = runtimeStorageEnvironmentCandidate(options);
  fs.mkdirSync(options.candidateDirectory, { mode: 0o700 });
  try {
    for (const [name, bytes] of candidate) fs.writeFileSync(path.join(options.candidateDirectory, name), bytes, { mode: 0o600, flag: 'wx' });
  } catch (error) { fs.rmSync(options.candidateDirectory, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [mode, file, hash, sourceDirectory] = process.argv.slice(2);
    if (mode === '--preview') {
      assert.equal(process.argv.length, 6);
      const { source, candidate } = runtimeStorageEnvironmentCandidate({ bundleFile: file, bundleHash: hash, sourceDirectory });
      console.log(JSON.stringify({ beforeHash: environmentHash(source), afterHash: environmentHash(candidate), bundleHash: hash }));
    } else {
      assert.equal(mode, '--stage'); assert.equal(process.argv.length, 5);
      const secret = process.env.CRM_RUNTIME_STORAGE_ENV_BUNDLE ?? '';
      const bytes = Buffer.from(secret.endsWith('\n') ? secret : `${secret}\n`);
      validateRuntimeStorageBundle(bytes, hash);
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ bundleHash: hash }));
    }
  } catch { console.error('Private runtime storage validation failed; values withheld'); process.exitCode = 1; }
}
