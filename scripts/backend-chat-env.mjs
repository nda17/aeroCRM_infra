// Private Chat-only delta for the canonical backend candidate transaction.
// Never modifies live environment files or runs storage probes itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const chatKeys = ['CRM_CHAT_ATTACHMENTS_ENABLED', 'CRM_CHAT_S3_ENDPOINT', 'CRM_CHAT_S3_REGION',
  'CRM_CHAT_S3_BUCKET', 'CRM_CHAT_S3_ACCESS_KEY_ID', 'CRM_CHAT_S3_SECRET_ACCESS_KEY', 'CRM_CHAT_S3_FORCE_PATH_STYLE'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
export function validateChatBundle(bytes, expectedHash) {
  check(/^[a-f0-9]{64}$/.test(expectedHash) && digest(bytes) === expectedHash, 'Private Chat bundle hash mismatch');
  let values;
  try { values = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid private Chat bundle'); }
  check(values && typeof values === 'object' && !Array.isArray(values) &&
    Object.keys(values).length === chatKeys.length && chatKeys.every(key => typeof values[key] === 'string' && values[key]),
    'Chat bundle must contain exactly seven complete reviewed keys');
  const canonical = JSON.stringify(Object.fromEntries(chatKeys.map(key => [key, values[key]]))) + '\n';
  check(bytes.equals(Buffer.from(canonical)), 'Private Chat bundle JSON must be canonical');
  check(Object.values(values).every(value => !/[\r\n\0']/.test(value)), 'Invalid Chat configuration text');
  check(values.CRM_CHAT_ATTACHMENTS_ENABLED === 'true' && ['true', 'false'].includes(values.CRM_CHAT_S3_FORCE_PATH_STYLE),
    'Chat installer requires explicit enabled storage booleans');
  let endpoint;
  try { endpoint = new URL(values.CRM_CHAT_S3_ENDPOINT); } catch { throw new Error('Invalid Chat storage endpoint'); }
  check(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    'Invalid Chat storage endpoint');
  check(values.CRM_CHAT_S3_BUCKET === 'backup-services', 'Chat storage must use the reviewed existing private bucket');
  return values;
}
function privateRegular(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    (!process.getuid || stat.uid === process.getuid()), 'Private Chat env metadata mismatch');
  return fs.readFileSync(file);
}
export function chatEnvironmentCandidate({ bundleFile, bundleHash, sourceDirectory }) {
  const stat = fs.lstatSync(sourceDirectory);
  check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(sourceDirectory) === sourceDirectory,
    'Unsafe source env directory');
  const source = new Map(fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.env')).sort()
    .map(name => [name, privateRegular(path.join(sourceDirectory, name))]));
  const values = validateChatBundle(privateRegular(bundleFile), bundleHash);
  check(source.has('crm-access-api.env'), 'Access API environment is required');
  for (const content of source.values()) {
    const existing = parseEnv(content.toString('utf8'));
    check(!['CRM_MAIL_S3_ACCESS_KEY_ID', 'CRM_BACKUP_S3_ACCESS_KEY_ID', 'SUPPORT_S3_ACCESS_KEY_ID', 'IDENTITY_AVATAR_S3_ACCESS_KEY_ID']
      .some(key => existing[key] === values.CRM_CHAT_S3_ACCESS_KEY_ID), 'Chat storage requires an independent access key');
  }
  const tupleFields = ['ENDPOINT', 'REGION', 'BUCKET', 'FORCE_PATH_STYLE'];
  const trusted = ['crm-customers-api.env', 'crm-customers-mail-sync.env', 'crm-customers-mail-send.env']
    .map(name => {
      check(source.has(name), 'Trusted Mail storage environment is required');
      return parseEnv(source.get(name).toString('utf8'));
    });
  check(tupleFields.every(field => trusted.every(env => env[`CRM_MAIL_S3_${field}`] &&
    env[`CRM_MAIL_S3_${field}`] === trusted[0][`CRM_MAIL_S3_${field}`]) &&
    values[`CRM_CHAT_S3_${field}`] === trusted[0][`CRM_MAIL_S3_${field}`]),
    'Chat storage must preserve the uniform trusted Mail provider and private bucket tuple');
  const original = source.get('crm-access-api.env').toString('utf8');
  check(Buffer.from(original).equals(source.get('crm-access-api.env')), 'Access environment must be UTF-8');
  const seen = new Set();
  const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const patched = lines.map(line => {
    const match = /^(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=/.exec(line);
    if (!match || !match[1].startsWith('CRM_CHAT_')) return line;
    const key = match[1];
    check(chatKeys.includes(key) && !seen.has(key), 'Unknown or duplicate Chat fields in Access environment');
    seen.add(key);
    return `${key}='${values[key]}'${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`;
  }).join('');
  check(seen.size === 0 || seen.size === chatKeys.length, 'Partial existing Chat environment is forbidden');
  const replacement = seen.size ? patched : `${original}${original && !original.endsWith('\n') ? '\n' : ''}${chatKeys.map(key => `${key}='${values[key]}'\n`).join('')}`;
  return { source, candidate: new Map([...source].map(([name, bytes]) =>
    [name, name === 'crm-access-api.env' ? Buffer.from(replacement) : bytes])) };
}
export function environmentHash(files) {
  return digest([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) =>
    `${digest(bytes)}  ./${name}\n`).join(''));
}
export function stageChatEnvironment(options) {
  const { candidate } = chatEnvironmentCandidate(options);
  fs.mkdirSync(options.candidateDirectory, { mode: 0o700 });
  try {
    for (const [name, bytes] of candidate)
      fs.writeFileSync(path.join(options.candidateDirectory, name), bytes, { mode: 0o600, flag: 'wx' });
    return options.candidateDirectory;
  } catch (error) { fs.rmSync(options.candidateDirectory, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [mode, file, hash, sourceDirectory] = process.argv.slice(2);
    if (mode === '--preview') {
      assert.equal(process.argv.length, 6);
      const { source, candidate } = chatEnvironmentCandidate({ bundleFile: file, bundleHash: hash, sourceDirectory });
      console.log(JSON.stringify({ beforeHash: environmentHash(source), afterHash: environmentHash(candidate), bundleHash: hash }));
    } else {
      assert.equal(mode, '--stage'); assert.equal(process.argv.length, 5);
      const secret = process.env.CRM_ACCESS_CHAT_ENV_BUNDLE ?? '';
      const bytes = Buffer.from(secret.endsWith('\n') ? secret : `${secret}\n`);
      validateChatBundle(bytes, hash);
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ bundleHash: hash }));
    }
  } catch { console.error('Private Chat configuration validation failed; values withheld'); process.exitCode = 1; }
}
