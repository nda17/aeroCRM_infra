import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  runtimeStorageEnvironmentCandidate,
  runtimeStorageKeys,
  stageRuntimeStorageEnvironment,
  privateStorageUser,
  storageFields,
  storageOwners,
  storageReferenceHash,
  validateFrozenAvatarReferences,
  validateRuntimeStorageBundle,
} from './backend-runtime-storage-env.mjs';

let root;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tuple = {
  ENDPOINT: 'https://storage.example.test', REGION: 'ru-1', BUCKET: 'content-files', FORCE_PATH_STYLE: 'true',
};
const bundle = () => Object.fromEntries(runtimeStorageKeys.map(key => {
  const owner = Object.keys(storageOwners).find(name => key.startsWith(`${name}_S3_`));
  const field = key.slice(`${owner}_S3_`.length);
  if (key === 'CRM_CHAT_ATTACHMENTS_ENABLED') return [key, 'true'];
  if (field in tuple) return [key, tuple[field]];
  return [key, `${owner.toLowerCase()}-new-${field.toLowerCase()}`];
}));
const bundleBytes = () => Buffer.from(`${JSON.stringify(bundle())}\n`);
const writePrivate = (file, bytes) => fs.writeFileSync(file, bytes, { mode: 0o600 });
const setup = () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-runtime-storage-env-test-'));
  const sourceDirectory = path.join(root, 'source');
  fs.mkdirSync(sourceDirectory, { mode: 0o700 });
  const values = bundle();
  const originals = new Map();
  const names = [...new Set(Object.values(storageOwners).flat())];
  for (const name of names) {
    const owner = Object.entries(storageOwners).find(([, files]) => files.includes(name))[0];
    const lines = [`KEEP_${owner}=raw # preserve`, `CRM_BACKUP_S3_ACCESS_KEY_ID=backup-principal`];
    if (owner === 'CRM_MAIL') {
      lines.push(...storageFields.map(field => `CRM_MAIL_S3_${field}='${field === 'ACCESS_KEY_ID' ? 'old-mail-principal' : field === 'SECRET_ACCESS_KEY' ? 'old-mail-secret' : tuple[field]}'`));
    } else if (owner === 'CRM_CHAT') {
      lines.push(...runtimeStorageKeys.filter(key => key.startsWith('CRM_CHAT_')).map(key => `${key}='old-chat-value'`));
    } else if (owner === 'IDENTITY_AVATAR') {
      lines.push(...storageFields.map(field => `${owner}_S3_${field}='${field === 'ACCESS_KEY_ID' ? 'old-avatar-principal' : field === 'SECRET_ACCESS_KEY' ? 'old-avatar-secret' : tuple[field]}'`));
      lines.push(`${owner}_S3_PUBLIC_BASE_URL='https://api.aerocrm.space/api/v1/users/avatar-files'`);
    } else {
      lines.push(...storageFields.map(field => `${owner}_S3_${field}='old-${owner.toLowerCase()}-${field.toLowerCase()}'`));
    }
    const bytes = Buffer.from(`${lines.join('\r\n')}\r\n`);
    originals.set(name, bytes);
    writePrivate(path.join(sourceDirectory, name), bytes);
  }
  const unrelated = Buffer.from("# keep separate service\r\nBILLING_S3_ACCESS_KEY_ID=untouched-principal\r\nFEATURE_FLAG=0\r\n");
  originals.set('billing-api.env', unrelated);
  writePrivate(path.join(sourceDirectory, 'billing-api.env'), unrelated);
  const bundleFile = path.join(root, 'bundle.json');
  writePrivate(bundleFile, bundleBytes());
  return { sourceDirectory: fs.realpathSync(sourceDirectory), bundleFile, bundleHash: digest(bundleBytes()), originals, values };
};

test.afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test('storage reference fingerprint sorts input rows, normalizes UTC dates, and preserves duplicate rows', () => {
  const rows = [
    ['mail', 'attachment', 'mail/validated/a', 'VALIDATED', 'a'.repeat(64), 12, '2026-10-08T00:00:00Z'],
    ['mail', 'mime', 'mail/intent/mime', 'ACCEPTED', 'b'.repeat(64), null, null],
    ['support', 'attachment', 'support/attachments/a', 'ATTACHED', 'c'.repeat(64), 24, null],
    ['mail', 'attachment', null, 'UNAVAILABLE', null, 0, null],
  ];
  const canonicalizedDate = rows.map(row => row[2] === 'mail/validated/a'
    ? [...row.slice(0, 6), '2026-10-08T00:00:00.000Z']
    : row);
  assert.equal(storageReferenceHash(rows), storageReferenceHash([...canonicalizedDate].reverse()));
  assert.notEqual(storageReferenceHash(rows), storageReferenceHash([...rows, rows[0]]));
  assert.notEqual(storageReferenceHash(rows), storageReferenceHash(rows.map(row => row[2] === 'mail/validated/a'
    ? [...row.slice(0, 3), 'QUARANTINED', ...row.slice(4)]
    : row)));
  assert.throws(() => storageReferenceHash([['mail', 'mime', 'mail/mime', 'ACCEPTED', 'a'.repeat(64), 1, null]]));
  assert.throws(() => storageReferenceHash([['support', 'attachment', 'key', 'ATTACHED', 'z'.repeat(64), 1, null]]));
  assert.throws(() => storageReferenceHash([['mail', 'attachment', 'key', 'VALIDATED', null, -1, null]]));
  assert.throws(() => storageReferenceHash([['mail', 'attachment', 'key', 'VALIDATED', null, 1, '2026-10-08 00:00:00']]));
});

test('private storage container identity follows the host file owner and rejects invalid IDs', () => {
  assert.equal(privateStorageUser(1000, 1000), '1000:1000');
  assert.equal(privateStorageUser(0, 0), '0:0');
  for (const [uid, gid] of [[-1, 1000], [1000, -1], [1.5, 1000], [1000, Number.MAX_SAFE_INTEGER + 1], [null, 1000]]) {
    assert.throws(() => privateStorageUser(uid, gid), /valid host UID and GID/);
  }
});

test('accepts the exact canonical 25-key bundle and rejects wrong hash, key set, bucket, or reused principals', () => {
  const bytes = bundleBytes();
  assert.deepEqual(validateRuntimeStorageBundle(bytes, digest(bytes)), bundle());
  assert.throws(() => validateRuntimeStorageBundle(bytes, '0'.repeat(64)), /hash mismatch/);

  const wrongBucket = { ...bundle(), SUPPORT_S3_BUCKET: 'backup-services' };
  const wrongBucketBytes = Buffer.from(`${JSON.stringify(wrongBucket)}\n`);
  assert.throws(() => validateRuntimeStorageBundle(wrongBucketBytes, digest(wrongBucketBytes)), /content-files/);

  const duplicate = Buffer.from(bytes.toString().replace('"CRM_CHAT_ATTACHMENTS_ENABLED":"true"', '"CRM_CHAT_ATTACHMENTS_ENABLED":"true","CRM_CHAT_ATTACHMENTS_ENABLED":"true"'));
  assert.throws(() => validateRuntimeStorageBundle(duplicate, digest(duplicate)), /canonical/);

  const reused = { ...bundle(), SUPPORT_S3_ACCESS_KEY_ID: bundle().CRM_MAIL_S3_ACCESS_KEY_ID };
  const reusedBytes = Buffer.from(`${JSON.stringify(reused)}\n`);
  assert.throws(() => validateRuntimeStorageBundle(reusedBytes, digest(reusedBytes)), /four independent/);
});

test('keeps the frozen Avatar history on its exact external host and outside S3 media', () => {
  const refs = ['https://avatars.yandex.net/get-zen_doc/123/abc?size=small',
    'https://avatars.yandex.net/get-users/456/photo?x=1#profile'];
  assert.deepEqual(validateFrozenAvatarReferences({ paths: refs, mediaEmpty: true }), { externalAvatars: 2, mediaEmpty: true });
  for (const paths of [refs.slice(0, 1), [...refs, refs[0]],
    ['https://content-files.s3.example.test/avatar.png', refs[1]],
    ['https://proxy.example.test/avatar.png', refs[1]],
    ['http://avatars.yandex.net/avatar.png', refs[1]],
    ['https://user@avatars.yandex.net/avatar.png', refs[1]]]) {
    assert.throws(() => validateFrozenAvatarReferences({ paths, mediaEmpty: true }));
  }
  assert.throws(() => validateFrozenAvatarReferences({ paths: refs, mediaEmpty: false }));
});

test('patches only the six reviewed runtime files and preserves every unrelated byte', () => {
  const options = setup();
  const { source, candidate } = runtimeStorageEnvironmentCandidate(options);
  assert.equal(candidate.size, source.size);
  const touched = new Set(Object.values(storageOwners).flat());
  for (const [name, bytes] of source) {
    if (!touched.has(name)) assert.deepEqual(candidate.get(name), bytes);
    else {
      const text = candidate.get(name).toString('utf8');
      assert.ok(text.includes(`KEEP_${Object.entries(storageOwners).find(([, files]) => files.includes(name))[0]}=raw # preserve\r\n`));
      assert.ok(text.includes('CRM_BACKUP_S3_ACCESS_KEY_ID=backup-principal'));
      const owner = Object.entries(storageOwners).find(([, files]) => files.includes(name))[0];
      for (const field of storageFields) assert.ok(text.includes(`${owner}_S3_${field}='${options.values[`${owner}_S3_${field}`]}'`));
    }
  }
  assert.equal(touched.size, 6);
  assert.deepEqual(
    [...candidate].filter(([name]) => !touched.has(name)).map(([name]) => name),
    [...source].filter(([name]) => !touched.has(name)).map(([name]) => name),
  );
  for (const owner of Object.keys(storageOwners)) {
    const ids = new Set(storageOwners[owner].map(name => candidate.get(name).toString('utf8').match(new RegExp(`^${owner}_S3_ACCESS_KEY_ID='([^']+)'`, 'm'))?.[1]));
    assert.equal(ids.size, 1, `${owner} should use one stable principal across its runtime roles`);
  }
  const access = candidate.get('crm-access-api.env').toString('utf8');
  assert.ok(access.includes("CRM_CHAT_ATTACHMENTS_ENABLED='true'"));
});

test('rejects source principal reuse, a noncanonical bundle, and incomplete reviewed source roles', () => {
  const options = setup();
  const mail = path.join(options.sourceDirectory, 'crm-customers-api.env');
  fs.appendFileSync(mail, `SUPPORT_S3_ACCESS_KEY_ID=${options.values.SUPPORT_S3_ACCESS_KEY_ID}\n`);
  assert.throws(() => runtimeStorageEnvironmentCandidate(options), /independent/);

  const fresh = setup();
  fs.appendFileSync(path.join(fresh.sourceDirectory, 'support-api.env'), 'SUPPORT_S3_REGION=duplicate\n');
  assert.throws(() => runtimeStorageEnvironmentCandidate(fresh), /Duplicate reviewed storage environment field/);

  const missing = setup();
  fs.unlinkSync(path.join(missing.sourceDirectory, 'identity-api.env'));
  assert.throws(() => runtimeStorageEnvironmentCandidate(missing));

  const wrongAvatarBucket = setup();
  fs.appendFileSync(path.join(wrongAvatarBucket.sourceDirectory, 'identity-api.env'), 'IDENTITY_AVATAR_S3_BUCKET=old-bucket\n');
  assert.throws(() => runtimeStorageEnvironmentCandidate(wrongAvatarBucket), /content-files provider/);

  const wrongAvatarEndpoint = setup();
  fs.appendFileSync(path.join(wrongAvatarEndpoint.sourceDirectory, 'identity-api.env'), 'IDENTITY_AVATAR_S3_ENDPOINT=https://other.example.test\n');
  assert.throws(() => runtimeStorageEnvironmentCandidate(wrongAvatarEndpoint), /content-files provider/);

  const wrongPublicUrl = setup();
  fs.appendFileSync(path.join(wrongPublicUrl.sourceDirectory, 'identity-api.env'), 'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL=https://other.example.test/avatar\n');
  assert.throws(() => runtimeStorageEnvironmentCandidate(wrongPublicUrl), /public URL/);
});

test('stages a private candidate with exact bytes and refuses an existing destination', () => {
  const options = setup();
  const candidateDirectory = path.join(root, 'candidate');
  stageRuntimeStorageEnvironment({ ...options, candidateDirectory });
  assert.equal(fs.statSync(candidateDirectory).mode & 0o777, 0o700);
  const touched = new Set(Object.values(storageOwners).flat());
  for (const name of fs.readdirSync(options.sourceDirectory)) {
    const staged = fs.readFileSync(path.join(candidateDirectory, name));
    const expected = touched.has(name)
      ? runtimeStorageEnvironmentCandidate(options).candidate.get(name)
      : options.originals.get(name);
    assert.deepEqual(staged, expected);
    assert.equal(fs.statSync(path.join(candidateDirectory, name)).mode & 0o777, 0o600);
  }
  assert.throws(() => stageRuntimeStorageEnvironment({ ...options, candidateDirectory }));
});
