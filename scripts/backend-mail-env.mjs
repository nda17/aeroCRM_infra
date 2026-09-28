// Scoped private candidate configuration for the canonical backend transaction.
// This module never installs live env files or starts containers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const mailEnvFiles = ['crm-customers-api.env', 'crm-customers-mail-sync.env', 'crm-customers-mail-send.env'];
const mailKeys = ['CRM_MAIL_ENABLED', 'CRM_MAIL_SYNC_ENABLED', 'CRM_MAIL_SEND_ENABLED',
  'CRM_MAIL_CREDENTIAL_KEY_ID', 'CRM_MAIL_CREDENTIAL_KEY', 'CRM_MAIL_S3_ENDPOINT',
  'CRM_MAIL_S3_REGION', 'CRM_MAIL_S3_BUCKET', 'CRM_MAIL_S3_ACCESS_KEY_ID',
  'CRM_MAIL_S3_SECRET_ACCESS_KEY', 'CRM_MAIL_S3_FORCE_PATH_STYLE'];
const keyFields = ['CRM_MAIL_CREDENTIAL_KEY_ID', 'CRM_MAIL_CREDENTIAL_KEY'];
const gates = ['CRM_MAIL_ENABLED', 'CRM_MAIL_SYNC_ENABLED', 'CRM_MAIL_SEND_ENABLED'];
const s3Fields = ['CRM_MAIL_S3_ENDPOINT', 'CRM_MAIL_S3_REGION', 'CRM_MAIL_S3_BUCKET',
  'CRM_MAIL_S3_ACCESS_KEY_ID', 'CRM_MAIL_S3_SECRET_ACCESS_KEY'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };

export function parseMailEnv(text) {
  check(typeof text === 'string' && text.length > 0 && text.endsWith('\n'), 'Mail env must be canonical text');
  const values = {};
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)='([^'\r\n\0]*)'$/.exec(line);
    check(match && !Object.hasOwn(values, match[1]), 'Mail env has invalid or duplicate fields');
    values[match[1]] = match[2];
  }
  const parsed = parseEnv(text);
  check(Object.keys(values).every(key => parsed[key] === values[key]), 'Mail env parse mismatch');
  return values;
}
function unchanged(actual, expected, message) {
  check(Object.keys(actual).length === Object.keys(expected).length &&
    Object.keys(expected).every(key => actual[key] === expected[key]), message);
}
function withoutMail(values) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !mailKeys.includes(key)));
}
function validateMailConfig(values) {
  check(gates.every(key => ['true', 'false'].includes(values[key])), 'Mail gates must be explicit booleans');
  check(values.CRM_MAIL_ENABLED === 'true' || gates.every(key => values[key] === 'false'),
    'Mail workers require the mail API gate');
  if (values.CRM_MAIL_CREDENTIAL_KEY || values.CRM_MAIL_CREDENTIAL_KEY_ID || values.CRM_MAIL_ENABLED === 'true') {
    const key = values.CRM_MAIL_CREDENTIAL_KEY ?? '';
    check(/^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32 &&
      Buffer.from(key, 'base64').toString('base64') === key &&
      /^[A-Za-z0-9_-]{1,80}$/.test(values.CRM_MAIL_CREDENTIAL_KEY_ID ?? ''), 'Invalid mail encryption key configuration');
  }
  const storage = s3Fields.map(key => values[key]);
  check(!storage.some(Boolean) || storage.every(Boolean), 'Mail storage configuration must be complete');
  check(values.CRM_MAIL_ENABLED !== 'true' || storage.every(Boolean), 'Enabled mail requires private attachment storage');
  check(!values.CRM_MAIL_S3_FORCE_PATH_STYLE || ['true', 'false'].includes(values.CRM_MAIL_S3_FORCE_PATH_STYLE),
    'Invalid mail storage boolean');
  if (values.CRM_MAIL_S3_ENDPOINT) {
    let endpoint;
    try { endpoint = new URL(values.CRM_MAIL_S3_ENDPOINT); } catch { throw new Error('Invalid mail storage endpoint'); }
    check(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
      'Invalid mail storage endpoint');
  }
}
function workerBaseline(api, role, port) {
  const expected = { ...withoutMail(api), CRM_CUSTOMERS_PROCESS_ROLE: role, CRM_CUSTOMERS_PORT: String(port) };
  delete expected.CRM_CUSTOMERS_DADATA_API_KEY;
  let database;
  try { database = new URL(expected.CRM_CUSTOMERS_DATABASE_URL); } catch { throw new Error('Invalid Customers database configuration'); }
  check(database.searchParams.get('connection_limit') === '2', 'Unexpected Customers API database pool');
  // Preserve the original URL encoding; only the reviewed pool size changes.
  expected.CRM_CUSTOMERS_DATABASE_URL = expected.CRM_CUSTOMERS_DATABASE_URL.replace(/([?&]connection_limit=)2(?=&|$)/,
    (_match, prefix) => `${prefix}1`);
  return expected;
}
export function validateMailBundle(bytes, expectedHash, previousFilesMap = null) {
  check(/^[a-f0-9]{64}$/.test(expectedHash) && digest(bytes) === expectedHash, 'Private mail bundle hash mismatch');
  let bundle;
  try { bundle = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid private mail bundle'); }
  check(bundle && typeof bundle === 'object' && !Array.isArray(bundle) &&
    Object.keys(bundle).length === mailEnvFiles.length && mailEnvFiles.every(name => typeof bundle[name] === 'string'),
    'Private mail bundle must contain exactly three reviewed files');
  const canonical = JSON.stringify(Object.fromEntries(mailEnvFiles.map(name => [name, bundle[name]]))) + '\n';
  check(bytes.equals(Buffer.from(canonical)), 'Private mail bundle JSON must be canonical');
  const values = new Map(mailEnvFiles.map(name => [name, parseMailEnv(bundle[name])]));
  check([...values.values()].every(env => Object.keys(env).every(key => !key.startsWith('CRM_MAIL_') || mailKeys.includes(key))),
    'Unreviewed mail configuration fields are forbidden');
  const api = values.get(mailEnvFiles[0]);
  check(api.CRM_CUSTOMERS_PROCESS_ROLE === 'api' && api.CRM_CUSTOMERS_PORT === '5320', 'Invalid Customers API role');
  validateMailConfig(api);
  for (const [index, role, port] of [[1, 'mail-sync', 5321], [2, 'mail-send', 5322]]) {
    const worker = values.get(mailEnvFiles[index]);
    unchanged(withoutMail(worker), workerBaseline(api, role, port), 'Unreviewed Customers worker configuration');
    unchanged(Object.fromEntries(mailKeys.filter(key => Object.hasOwn(worker, key)).map(key => [key, worker[key]])),
      Object.fromEntries(mailKeys.filter(key => Object.hasOwn(api, key)).map(key => [key, api[key]])),
      'Mail configuration must be uniform across all three roles');
  }
  if (previousFilesMap) {
    check(previousFilesMap.has(mailEnvFiles[0]), 'Previous Customers API env is required');
    if (api.CRM_MAIL_ENABLED === 'true') {
      const previousApi = parseMailEnv(previousFilesMap.get(mailEnvFiles[0]));
      // The rollback snapshot must already retain the key before any writes can
      // be admitted. Provision it in a disabled release, then enable unchanged.
      check(keyFields.every(key => previousApi[key] && previousApi[key] === api[key]),
        'Mail enable requires the same encryption key and id in the previous disabled snapshot');
    }
    for (const name of mailEnvFiles) {
      if (!previousFilesMap.has(name)) continue;
      const previous = parseMailEnv(previousFilesMap.get(name));
      unchanged(withoutMail(values.get(name)), withoutMail(previous), 'Unrelated Customers env changes are forbidden');
      for (const key of keyFields)
        check(!previous[key] || previous[key] === values.get(name)[key], 'Existing mail encryption key removal or rotation is forbidden');
    }
  }
  return new Map(mailEnvFiles.map(name => [name, bundle[name]]));
}
function privateRegular(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    (!process.getuid || stat.uid === process.getuid()), 'Private env metadata mismatch');
  return fs.readFileSync(file);
}
export function stageMailEnvironment({ bundleFile, bundleHash, sourceDirectory, candidateDirectory }) {
  const sourceStat = fs.lstatSync(sourceDirectory);
  check(sourceStat.isDirectory() && !sourceStat.isSymbolicLink() && fs.realpathSync(sourceDirectory) === sourceDirectory,
    'Unsafe source env directory');
  const source = new Map(fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.env'))
    .map(name => [name, privateRegular(path.join(sourceDirectory, name))]));
  const selected = new Map(mailEnvFiles.filter(name => source.has(name)).map(name => [name, source.get(name).toString('utf8')]));
  const replacement = validateMailBundle(privateRegular(bundleFile), bundleHash, selected);
  const mailAccessKey = parseMailEnv(replacement.get(mailEnvFiles[0])).CRM_MAIL_S3_ACCESS_KEY_ID;
  if (mailAccessKey) for (const content of source.values()) {
    const existing = parseEnv(content.toString('utf8'));
    check(!['CRM_BACKUP_S3_ACCESS_KEY_ID', 'SUPPORT_S3_ACCESS_KEY_ID', 'IDENTITY_AVATAR_S3_ACCESS_KEY_ID']
      .some(key => existing[key] === mailAccessKey), 'Mail storage requires an independent access key');
  }
  fs.mkdirSync(candidateDirectory, { mode: 0o700 });
  try {
    for (const [name, content] of new Map([...source, ...replacement]))
      fs.writeFileSync(path.join(candidateDirectory, name), content, { mode: 0o600, flag: 'wx' });
    return candidateDirectory;
  } catch (error) { fs.rmSync(candidateDirectory, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [mode, directory, destination] = process.argv.slice(2);
    if (mode === '--bundle') {
      assert.equal(process.argv.length, 5);
      const bundle = Buffer.from(JSON.stringify(Object.fromEntries(mailEnvFiles.map(name =>
        [name, privateRegular(path.join(directory, name)).toString('utf8')]))) + '\n');
      validateMailBundle(bundle, digest(bundle));
      fs.writeFileSync(destination, bundle, { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ bundleHash: digest(bundle), files: mailEnvFiles, valuesWithheld: true }));
    } else {
      assert.equal(mode, '--stage'); assert.equal(process.argv.length, 5);
      const secret = process.env.CRM_CUSTOMERS_MAIL_ENV_BUNDLE ?? '';
      // Secret transports may omit the file's final LF. The approved hash is
      // always over the canonical JSON file, including exactly that final LF.
      const bundle = Buffer.from(secret.endsWith('\n') ? secret : `${secret}\n`);
      validateMailBundle(bundle, destination);
      fs.writeFileSync(directory, bundle, { mode: 0o600, flag: 'wx' });
      console.log('Private Customers env bundle staged; values withheld');
    }
  } catch { console.error('Private Customers env bundle validation failed; output withheld'); process.exitCode = 1; }
}
