const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const test = require('node:test');
const { validateManifest, normalizeHeaders, runCopy } = require('./runtime-storage-copy.cjs');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureHeaders = index => ({
  ContentType: ['application/pdf', 'image/png', 'message/rfc822', 'text/plain', 'application/octet-stream', 'application/zip', 'application/pdf'][index],
  ContentDisposition: `attachment; filename=\"object-${index}.bin\"`,
  ...(index % 2 ? { CacheControl: 'private, max-age=0' } : {}),
  ...(index === 0 ? { ContentEncoding: 'gzip' } : {}),
  ...(index === 1 ? { ContentLanguage: 'ru-RU' } : {}),
  ...(index === 2 ? { Expires: '2026-10-08T00:00:00.000Z' } : {}),
  Metadata: { source: index < 6 ? 'crm-mail' : 'support-chat-files', index: String(index) },
});
function manifestFixture() {
  const objects = Array.from({ length: 7 }, (_, index) => {
    const owner = index === 6 ? 'support' : 'mail';
    const bytes = Buffer.from(`private synthetic object ${index}`);
    const headers = fixtureHeaders(index);
    const sourceBucket = owner === 'mail' ? 'backup-services' : 'support-chat-files';
    const key = owner === 'mail' ? `mail/fixture/${index}.bin` : `support/attachments/fixture-${index}.bin`;
    return { owner, sourceBucket, key, targetKey: key, size: owner === 'support' ? 209482 : bytes.length,
      sha256: owner === 'support' ? digest(Buffer.alloc(209482, 0x53)) : digest(bytes),
      etag: `\"fixture-${index}\"`, versionId: null, headers, _bytes: owner === 'support' ? Buffer.alloc(209482, 0x53) : bytes };
  });
  return { schemaVersion: 1, targetBucket: 'content-files',
    provider: { endpoint: 'https://s3.twcstorage.ru', region: 'ru-1', forcePathStyle: true },
    referencesHash: 'a'.repeat(64), objects };
}

class Command { constructor(input) { this.input = input; } }
class ListObjectsV2Command extends Command {}
class HeadObjectCommand extends Command {}
class GetObjectCommand extends Command {}
class PutObjectCommand extends Command {}
class GetObjectAclCommand extends Command {}
class DeleteObjectCommand extends Command {}
class GetBucketVersioningCommand extends Command {}
class ListObjectVersionsCommand extends Command {}
class ListMultipartUploadsCommand extends Command {}
const sdk = { ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand, GetObjectAclCommand,
  DeleteObjectCommand, GetBucketVersioningCommand, ListObjectVersionsCommand, ListMultipartUploadsCommand };
const missing = () => Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
function clientsFor(manifest, { existingTargets = false } = {}) {
  const requests = [];
  const source = { objects: new Map(manifest.objects.map(item => [`${item.sourceBucket}/${item.key}`, item])),
    versioningStatus: undefined, uploads: [], extraVersions: [], deleteMarkers: [],
    async send(command) {
      const { Bucket, Key, Prefix, MaxKeys } = command.input; requests.push({ client: 'source', command, ...command.input });
      if (command instanceof GetBucketVersioningCommand) return { ...(this.versioningStatus ? { Status: this.versioningStatus } : {}) };
      if (command instanceof ListObjectVersionsCommand) {
        const prefix = Prefix || '';
        const Versions = [...this.objects.values()].filter(item => item.sourceBucket === Bucket && item.key.startsWith(prefix))
          .map(item => ({ Key: item.key, VersionId: 'null' })).concat(this.extraVersions.filter(item => item.Bucket === Bucket && item.Key.startsWith(prefix)).map(item => ({ Key: item.Key, VersionId: item.VersionId })));
        const DeleteMarkers = this.deleteMarkers.filter(item => item.Bucket === Bucket && item.Key.startsWith(prefix));
        return { Versions, DeleteMarkers, IsTruncated: false };
      }
      if (command instanceof ListMultipartUploadsCommand) return { Uploads: this.uploads.filter(item => item.Bucket === Bucket && (!Prefix || item.Key.startsWith(Prefix))), IsTruncated: false };
      if (command instanceof ListObjectsV2Command) {
        const prefix = Prefix || '';
        const Contents = [...this.objects.values()].filter(item => item.sourceBucket === Bucket && item.key.startsWith(prefix))
          .map(item => ({ Key: item.key, Size: item.size, ETag: item.etag }));
        return { Contents: Contents.slice(0, MaxKeys), IsTruncated: Contents.length > MaxKeys };
      }
      if (command instanceof HeadObjectCommand) {
        const item = this.objects.get(`${Bucket}/${Key}`);
        if (!item && Bucket === 'content-files') {
          const target = Object.values(destinations).map(client => client.objects.get(Key)).find(Boolean);
          if (target) return { ContentLength: target.bytes.length, ETag: target.etag, ...target.headers };
        }
        if (!item) throw missing();
        return { ContentLength: item.size, ETag: item.etag, ...item.headers, VersionId: null };
      }
      if (command instanceof GetObjectCommand) {
        const item = this.objects.get(`${Bucket}/${Key}`);
        if (!item) throw missing();
        return { ContentLength: item.size, Body: Readable.from([item._bytes]) };
      }
      if (command instanceof GetObjectAclCommand) return { Owner: { ID: 'owner-id' }, Grants: [{ Grantee: { ID: 'owner-id' }, Permission: 'FULL_CONTROL' }] };
      if (command instanceof DeleteObjectCommand) { this.objects.delete(`${Bucket}/${Key}`); return {}; }
      throw new Error(`unsupported source command ${command.constructor.name}`);
    } };
  const destinations = Object.fromEntries(['mail', 'support'].map(owner => [owner, {
    owner, objects: new Map(),
    async send(command) {
      const { Bucket, Key } = command.input; requests.push({ client: owner, command, ...command.input });
      const item = manifest.objects.find(row => row.owner === owner && row.targetKey === Key);
      if (!item) throw missing();
      if (command instanceof HeadObjectCommand) {
        const stored = this.objects.get(Key);
        if (!stored) throw missing();
        return { ContentLength: stored.bytes.length, ETag: stored.etag, ...stored.headers };
      }
      if (command instanceof GetObjectCommand) {
        const stored = this.objects.get(Key);
        if (!stored) throw missing();
        return { ContentLength: stored.bytes.length, Body: Readable.from([stored.bytes]) };
      }
      if (command instanceof PutObjectCommand) {
        assert.equal(command.input.IfNoneMatch, '*', 'destination writes must be conditional create only');
        if (this.objects.has(Key)) throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
        this.objects.set(Key, { bytes: Buffer.from(command.input.Body), headers: normalizeHeaders(command.input), etag: `\"target-${item.key}\"` });
        return {};
      }
      throw new Error(`unsupported destination command ${command.constructor.name}`);
    } }])) ;
  if (existingTargets) for (const item of manifest.objects) destinations[item.owner].objects.set(item.targetKey,
    { bytes: Buffer.from(item._bytes), headers: normalizeHeaders(item.headers), etag: `\"existing-${item.key}\"` });
  return { source, destinations, requests };
}
function reviewedManifest() {
  const full = manifestFixture();
  const clean = { ...full, objects: full.objects.map(({ _bytes, ...item }) => item) };
  const bytes = Buffer.from(JSON.stringify(clean));
  return { manifest: validateManifest(bytes, digest(bytes)), full };
}

test('copies all seven manifest objects with complete headers, private ACL, SHA verification, and unchanged sources', async () => {
  const { manifest, full } = reviewedManifest();
  const { source, destinations, requests } = clientsFor(full);
  const result = await runCopy({ manifest, source, destinations, sdk });
  assert.equal(result.ok, true);
  assert.equal(result.objects, 7);
  assert.equal([...destinations.mail.objects.keys()].length, 6);
  assert.equal([...destinations.support.objects.keys()].length, 1);
  assert.equal(requests.filter(row => row.command instanceof PutObjectCommand).length, 7);
  assert.equal(requests.filter(row => row.command instanceof DeleteObjectCommand).length, 0);
  for (const item of full.objects) assert.ok(source.objects.has(`${item.sourceBucket}/${item.key}`));
  const support = full.objects.find(item => item.owner === 'support');
  assert.deepEqual(normalizeHeaders(destinations.support.objects.get(support.targetKey).headers), normalizeHeaders(support.headers));
});

test('rejects reviewed source inventory drift before writing any target object', async () => {
  const { manifest, full } = reviewedManifest();
  const { source, destinations } = clientsFor(full);
  source.objects.set('backup-services/mail/unreviewed.bin', { sourceBucket: 'backup-services', key: 'mail/unreviewed.bin', size: 1, etag: '\"extra\"' });
  await assert.rejects(runCopy({ manifest, source, destinations, sdk }));
  assert.equal(destinations.mail.objects.size + destinations.support.objects.size, 0);
});

test('stops before copying when a reviewed source bucket becomes versioned or has multipart writers', async () => {
  const { manifest, full } = reviewedManifest();
  for (const mutate of [
    source => { source.versioningStatus = 'Enabled'; },
    source => { source.uploads.push({ Bucket: 'backup-services', Key: 'mail/in-flight.bin' }); },
    source => { source.extraVersions.push({ Bucket: 'backup-services', Key: 'mail/fixture/0.bin', VersionId: 'version-2' }); },
  ]) {
    const { source, destinations } = clientsFor(full);
    mutate(source);
    await assert.rejects(runCopy({ manifest, source, destinations, sdk }));
    assert.equal(destinations.mail.objects.size + destinations.support.objects.size, 0);
  }
});

test('requires the complete whole-bucket Support inventory before copying', async () => {
  const { manifest, full } = reviewedManifest();
  const { source, destinations } = clientsFor(full);
  source.objects.set('support-chat-files/unreviewed/outside-prefix.bin', {
    sourceBucket: 'support-chat-files', key: 'unreviewed/outside-prefix.bin', size: 1, etag: '\"extra-support\"',
  });
  await assert.rejects(runCopy({ manifest, source, destinations, sdk }));
  assert.equal(destinations.mail.objects.size + destinations.support.objects.size, 0);
});

test('verifies only the reviewed Support boundary without writes or deletes', async () => {
  const { manifest, full } = reviewedManifest();
  const { source, destinations, requests } = clientsFor(full, { existingTargets: true });
  const result = await runCopy({ manifest, source, destinations, sdk, mode: 'verify-support-boundary' });
  assert.deepEqual(result, { ok: true, mode: 'verify-support-boundary', objects: 1,
    manifestSha256: digest(Buffer.from(JSON.stringify(manifest))) });
  assert.equal(requests.filter(row => row.command instanceof PutObjectCommand || row.command instanceof DeleteObjectCommand).length, 0);
  assert.equal(requests.filter(row => row.client === 'mail').length, 0);
  for (const row of requests.filter(row => row.command instanceof ListObjectVersionsCommand ||
    row.command instanceof ListMultipartUploadsCommand || row.command instanceof ListObjectsV2Command)) {
    assert.equal(row.Bucket, 'support-chat-files');
    assert.equal(row.Prefix, undefined, 'Support boundary proof must cover the whole source bucket');
  }
  const support = full.objects.find(item => item.owner === 'support');
  assert.ok(source.objects.has(`${support.sourceBucket}/${support.key}`), 'Support source remains unchanged');
  assert.equal(destinations.support.objects.size, 1);
  assert.equal(destinations.mail.objects.size, 6, 'Mail targets are outside this proof and remain untouched');
});

test('Support boundary proof rejects a newly appeared whole-bucket object without mutation', async () => {
  const { manifest, full } = reviewedManifest();
  const { source, destinations, requests } = clientsFor(full, { existingTargets: true });
  source.objects.set('support-chat-files/other-owner/new.bin', {
    sourceBucket: 'support-chat-files', key: 'other-owner/new.bin', size: 3, etag: '\"unreviewed\"',
  });
  await assert.rejects(runCopy({ manifest, source, destinations, sdk, mode: 'verify-support-boundary' }));
  assert.equal(requests.filter(row => row.command instanceof PutObjectCommand || row.command instanceof DeleteObjectCommand).length, 0);
  assert.equal(destinations.support.objects.size, 1);
  assert.equal(source.objects.has('support-chat-files/other-owner/new.bin'), true);
});

test('verifies a correct existing target without overwrite and refuses to overwrite a corrupt collision', async () => {
  const { manifest, full } = reviewedManifest();
  const good = clientsFor(full, { existingTargets: true });
  await runCopy({ manifest, ...good, sdk });
  assert.equal(good.requests.filter(row => row.command instanceof PutObjectCommand).length, 0);

  const corrupt = clientsFor(full, { existingTargets: true });
  const collided = full.objects[0];
  corrupt.destinations[collided.owner].objects.get(collided.targetKey).bytes[0] ^= 0xff;
  await assert.rejects(runCopy({ manifest, ...corrupt, sdk }), /Destination SHA mismatch/);
  assert.equal(corrupt.requests.filter(row => row.command instanceof PutObjectCommand).length, 0);
  assert.equal(corrupt.destinations[collided.owner].objects.get(collided.targetKey).bytes[0], collided._bytes[0] ^ 0xff);
});

test('cleanup-mail deletes only the six verified Mail source objects and retains Support source', async () => {
  const { manifest, full } = reviewedManifest();
  const { source, destinations, requests } = clientsFor(full, { existingTargets: true });
  await runCopy({ manifest, source, destinations, sdk, mode: 'cleanup-mail' });
  assert.equal(requests.filter(row => row.command instanceof DeleteObjectCommand).length, 6);
  for (const item of full.objects) {
    assert.equal(source.objects.has(`${item.sourceBucket}/${item.key}`), item.owner === 'support');
  }
});

test('resumes Mail cleanup when an approved source object was deleted by an earlier partial attempt', async () => {
  const { manifest, full } = reviewedManifest();
  const { source, destinations, requests } = clientsFor(full, { existingTargets: true });
  const alreadyRemoved = full.objects.find(item => item.owner === 'mail');
  source.objects.delete(`${alreadyRemoved.sourceBucket}/${alreadyRemoved.key}`);
  await runCopy({ manifest, source, destinations, sdk, mode: 'cleanup-mail' });
  assert.equal(requests.filter(row => row.command instanceof DeleteObjectCommand).length, 5);
  assert.ok(source.objects.has('support-chat-files/support/attachments/fixture-6.bin'));
});

test('blocks Mail cleanup on versioning, delete markers, extra versions, or multipart uploads before source deletion', async () => {
  const { manifest, full } = reviewedManifest();
  const mutations = [
    source => { source.versioningStatus = 'Enabled'; },
    source => { source.deleteMarkers.push({ Bucket: 'backup-services', Key: 'mail/fixture/0.bin' }); },
    source => { source.extraVersions.push({ Bucket: 'backup-services', Key: 'mail/fixture/0.bin', VersionId: 'version-2' }); },
    source => { source.uploads.push({ Bucket: 'backup-services', Key: 'mail/in-flight.bin' }); },
  ];
  for (const mutate of mutations) {
    const { source, destinations, requests } = clientsFor(full, { existingTargets: true });
    mutate(source);
    await assert.rejects(runCopy({ manifest, source, destinations, sdk, mode: 'cleanup-mail' }));
    assert.equal(requests.filter(row => row.command instanceof DeleteObjectCommand).length, 0);
    assert.equal(source.objects.size, 7);
  }
});

test('rejects incomplete object inventory and unsafe target prefix during manifest validation', () => {
  const full = manifestFixture();
  const clean = { ...full, objects: full.objects.slice(0, 6).map(({ _bytes, ...item }) => item) };
  const bytes = Buffer.from(JSON.stringify(clean));
  assert.throws(() => validateManifest(bytes, digest(bytes)));
  const unsafe = manifestFixture();
  unsafe.objects[0].key = 'mail/../private.bin';
  unsafe.objects[0].targetKey = unsafe.objects[0].key;
  const unsafeBytes = Buffer.from(JSON.stringify({ ...unsafe, objects: unsafe.objects.map(({ _bytes, ...item }) => item) }));
  assert.throws(() => validateManifest(unsafeBytes, digest(unsafeBytes)));
});
