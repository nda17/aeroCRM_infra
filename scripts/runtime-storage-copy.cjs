// Manifest-bounded physical copy. No administrative credentials enter runtime services.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const headerNames = ['ContentType', 'ContentDisposition', 'ContentEncoding', 'ContentLanguage', 'CacheControl', 'Expires', 'Metadata'];
function normalizeHeaders(head) {
  return Object.fromEntries(headerNames.filter(name => head[name] != null).map(name => [name,
    name === 'Metadata' ? Object.fromEntries(Object.entries(head[name]).sort(([a], [b]) => a.localeCompare(b))) :
    name === 'Expires' ? new Date(head[name]).toISOString() : head[name]]));
}
function validateManifest(bytes, expectedHash) {
  assert.match(expectedHash, /^[a-f0-9]{64}$/); assert.equal(hash(bytes), expectedHash, 'Reviewed object manifest hash mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.targetBucket, 'content-files');
  assert.deepEqual(manifest.provider, { endpoint: 'https://s3.twcstorage.ru', region: 'ru-1', forcePathStyle: true });
  assert.match(manifest.referencesHash, /^[a-f0-9]{64}$/);
  assert.equal(manifest.objects.length, 7);
  const keys = new Set(); let support = 0, mail = 0, total = 0;
  for (const item of manifest.objects) {
    assert(item.owner === 'support' || item.owner === 'mail');
    assert.equal(item.sourceBucket, item.owner === 'support' ? 'support-chat-files' : 'backup-services');
    assert(typeof item.key === 'string' && item.key.startsWith(item.owner === 'support' ? 'support/attachments/' : 'mail/') &&
      !/[\r\n\0]/.test(item.key) && !item.key.split('/').some(part => part === '..' || part === '.' || !part));
    assert.equal(item.targetKey, item.key); assert(!keys.has(item.key)); keys.add(item.key);
    assert(Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 16 * 1024 * 1024);
    assert.match(item.sha256, /^[a-f0-9]{64}$/); assert(typeof item.etag === 'string' && /^"[^"\r\n]+"$/.test(item.etag));
    assert.equal(item.versionId, null, 'Versioned source requires a separately reviewed plan');
    assert.deepEqual(item.headers, normalizeHeaders(item.headers), 'Unreviewed object headers');
    assert(item.headers.ContentType && item.headers.Metadata && typeof item.headers.Metadata === 'object');
    if (item.owner === 'support') { support++; assert.equal(item.size, 209482); } else mail++;
    total += item.size;
  }
  assert.equal(support, 1); assert.equal(mail, 6); assert(total <= 32 * 1024 * 1024);
  return manifest;
}
async function bodyBytes(response, size) {
  const chunks = []; let count = 0;
  const timer = setTimeout(() => response.Body?.destroy?.(), 15000);
  try {
    for await (const chunk of response.Body) {
      count += chunk.length; assert(count <= size, 'Object size exceeds reviewed manifest'); chunks.push(chunk);
    }
    assert.equal(count, size); return Buffer.concat(chunks);
  } finally { clearTimeout(timer); response.Body?.destroy?.(); }
}
async function runCopy({ manifest, source, destinations, sdk, mode = 'copy' }) {
  assert(['copy', 'verify', 'cleanup-mail', 'verify-support-boundary'].includes(mode));
  const { ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand, GetObjectAclCommand, DeleteObjectCommand, GetBucketVersioningCommand, ListObjectVersionsCommand, ListMultipartUploadsCommand } = sdk;
  let requests = 0;
  const started = Date.now();
  const request = async (client, Command, input) => {
    assert(++requests <= 100 && Date.now() - started < 300000, 'Bounded object transfer limit exceeded');
    return client.send(new Command(input), { abortSignal: AbortSignal.timeout(15000) });
  };
  if (['copy', 'verify-support-boundary'].includes(mode)) for (const owner of mode === 'copy' ? ['support', 'mail'] : ['support']) {
    const items = manifest.objects.filter(item => item.owner === owner);
    const versioning = await request(source, GetBucketVersioningCommand, { Bucket: items[0].sourceBucket });
    assert(!versioning.Status, 'Source bucket versioning changed since review');
    const prefix = owner === 'support' ? undefined : 'mail/';
    const versions = await request(source, ListObjectVersionsCommand, { Bucket: items[0].sourceBucket, Prefix: prefix, MaxKeys: items.length + 1 });
    assert(!versions.IsTruncated && !versions.DeleteMarkers?.length && (versions.Versions || []).every(version => version.VersionId === 'null'),
      'Unexpected source versions or delete markers');
    assert.deepEqual((versions.Versions || []).map(version => version.Key).sort(), items.map(item => item.key).sort());
    const multipart = await request(source, ListMultipartUploadsCommand, { Bucket: items[0].sourceBucket, Prefix: prefix, MaxUploads: 1 });
    assert(!multipart.IsTruncated && !multipart.Uploads?.length, 'Source has unfinished multipart writers');
    const listed = await request(source, ListObjectsV2Command, { Bucket: items[0].sourceBucket,
      Prefix: prefix, MaxKeys: items.length + 1 });
    assert(!listed.IsTruncated);
    assert.deepEqual((listed.Contents || []).map(item => item.Key).sort(), items.map(item => item.key).sort(), 'Source inventory changed after review');
    for (const item of items) {
      const record = listed.Contents.find(record => record.Key === item.key);
      assert.equal(record.Size, item.size); assert.equal(record.ETag, item.etag);
    }
  }
  const verifyDestination = async item => {
    const client = destinations[item.owner];
    const head = await request(client, HeadObjectCommand, { Bucket: manifest.targetBucket, Key: item.targetKey });
    assert.equal(head.ContentLength, item.size); assert.deepEqual(normalizeHeaders(head), item.headers);
    const response = await request(client, GetObjectCommand, { Bucket: manifest.targetBucket, Key: item.targetKey, IfMatch: head.ETag });
    assert.equal(hash(await bodyBytes(response, item.size)), item.sha256, 'Destination SHA mismatch');
    const acl = await request(source, GetObjectAclCommand, { Bucket: manifest.targetBucket, Key: item.targetKey });
    assert(acl.Owner?.ID && acl.Grants?.length === 1 && acl.Grants[0].Grantee?.ID === acl.Owner.ID &&
      acl.Grants[0].Permission === 'FULL_CONTROL' && !acl.Grants[0].Grantee?.URI, 'Destination ACL must be private');
  };
  const selected = mode === 'verify-support-boundary' ? manifest.objects.filter(item => item.owner === 'support') : manifest.objects;
  for (const item of selected) {
    if (mode === 'copy' || mode === 'verify-support-boundary') {
      const head = await request(source, HeadObjectCommand, { Bucket: item.sourceBucket, Key: item.key, IfMatch: item.etag });
      assert.equal(head.ContentLength, item.size); assert.equal(head.ETag, item.etag);
      assert(!head.VersionId || head.VersionId === 'null'); assert.deepEqual(normalizeHeaders(head), item.headers);
      const response = await request(source, GetObjectCommand, { Bucket: item.sourceBucket, Key: item.key, IfMatch: item.etag });
      const bytes = await bodyBytes(response, item.size); assert.equal(hash(bytes), item.sha256, 'Source SHA mismatch');
      if (mode === 'copy') {
        let exists = true;
        // Absence checks use migration read capability: Support intentionally has no ListBucket and may receive 403 for a missing key.
        try { await request(source, HeadObjectCommand, { Bucket: manifest.targetBucket, Key: item.targetKey }); }
        catch (error) { if (error?.$metadata?.httpStatusCode !== 404) throw error; exists = false; }
        if (!exists) await request(destinations[item.owner], PutObjectCommand, { Bucket: manifest.targetBucket, Key: item.targetKey,
          Body: bytes, IfNoneMatch: '*', ...item.headers,
          ...(item.headers.Expires ? { Expires: new Date(item.headers.Expires) } : {}) });
      }
      await verifyDestination(item);
      // Source must remain identical after a physical copy.
      const after = await request(source, HeadObjectCommand, { Bucket: item.sourceBucket, Key: item.key, IfMatch: item.etag });
      assert.equal(after.ETag, item.etag); assert.equal(after.ContentLength, item.size);
      assert.deepEqual(normalizeHeaders(after), item.headers);
    } else await verifyDestination(item);
  }
  if (mode === 'cleanup-mail') {
    const versioning = await request(source, GetBucketVersioningCommand, { Bucket: 'backup-services' });
    assert(!versioning.Status, 'Source bucket versioning changed before cleanup');
    const versions = await request(source, ListObjectVersionsCommand, { Bucket: 'backup-services', Prefix: 'mail/', MaxKeys: 7 });
    const keys = manifest.objects.filter(item => item.owner === 'mail').map(item => item.key);
    assert(!versions.IsTruncated && !versions.DeleteMarkers?.length && (versions.Versions || []).every(version =>
      version.VersionId === 'null' && keys.includes(version.Key)), 'Unexpected Mail versions before cleanup');
    const multipart = await request(source, ListMultipartUploadsCommand, { Bucket: 'backup-services', Prefix: 'mail/', MaxUploads: 1 });
    assert(!multipart.IsTruncated && !multipart.Uploads?.length, 'Mail has an unfinished source writer before cleanup');
  }
  if (mode === 'cleanup-mail') for (const item of manifest.objects.filter(item => item.owner === 'mail')) {
    let head;
    try { head = await request(source, HeadObjectCommand, { Bucket: item.sourceBucket, Key: item.key, IfMatch: item.etag }); }
    catch (error) { if (error?.$metadata?.httpStatusCode === 404) continue; throw error; }
    assert.equal(head.ETag, item.etag); assert.equal(head.ContentLength, item.size);
    assert(!head.VersionId || head.VersionId === 'null'); assert.deepEqual(normalizeHeaders(head), item.headers);
    const response = await request(source, GetObjectCommand, { Bucket: item.sourceBucket, Key: item.key, IfMatch: item.etag });
    assert.equal(hash(await bodyBytes(response, item.size)), item.sha256);
    await request(source, DeleteObjectCommand, { Bucket: item.sourceBucket, Key: item.key, IfMatch: item.etag });
    try { await request(source, HeadObjectCommand, { Bucket: item.sourceBucket, Key: item.key }); assert.fail('Source cleanup not confirmed'); }
    catch (error) { if (error?.$metadata?.httpStatusCode !== 404) throw error; }
  }
  return { ok: true, mode, objects: selected.length, manifestSha256: hash(Buffer.from(JSON.stringify(manifest))) };
}
module.exports = { validateManifest, normalizeHeaders, runCopy };
if (require.main === module) (async () => {
  if (process.argv[2] === '--stage') {
    assert.equal(process.argv.length, 5);
    const text = process.env.CRM_RUNTIME_STORAGE_MANIFEST_BUNDLE || '';
    const bytes = Buffer.from(text.endsWith('\n') ? text : `${text}\n`);
    validateManifest(bytes, process.argv[4]);
    fs.writeFileSync(process.argv[3], bytes, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ manifestHash: process.argv[4] })); return;
  }
  const { createRequire } = require('node:module');
  const sdk = createRequire('/app/package.json')('@aws-sdk/client-s3');
  const manifest = validateManifest(fs.readFileSync('/reviewed/storage-manifest.json'), process.env.STORAGE_MANIFEST_HASH);
  const sourceConfig = JSON.parse(fs.readFileSync('/reviewed/source-storage.json'));
  const values = JSON.parse(fs.readFileSync('/reviewed/runtime-storage-env.json'));
  assert.deepEqual({ endpoint: sourceConfig.endpoint, region: sourceConfig.region, forcePathStyle: sourceConfig.forcePathStyle }, manifest.provider);
  const source = new sdk.S3Client({ ...sourceConfig, maxAttempts: 1 });
  const destinations = Object.fromEntries([['support', 'SUPPORT'], ['mail', 'CRM_MAIL']].map(([owner, prefix]) => {
    assert.equal(values[`${prefix}_S3_BUCKET`], manifest.targetBucket);
    return [owner, new sdk.S3Client({ ...manifest.provider, maxAttempts: 1, credentials: {
      accessKeyId: values[`${prefix}_S3_ACCESS_KEY_ID`], secretAccessKey: values[`${prefix}_S3_SECRET_ACCESS_KEY`] } })];
  }));
  try { console.log(JSON.stringify(await runCopy({ manifest, source, destinations, sdk, mode: process.env.STORAGE_COPY_MODE || 'copy' }))); }
  finally { source.destroy(); Object.values(destinations).forEach(client => client.destroy()); }
})().catch(() => { console.error('Reviewed storage transfer failed; private details withheld'); process.exitCode = 1; });
