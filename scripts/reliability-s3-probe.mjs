#!/usr/bin/env node
// Provider capability probe for newly provisioned Backup and APK users.
// Uses only synthetic objects; never emits credentials or provider error details.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReliabilityBundle } from './backend-reliability-env.mjs';

const [mode, sdkPackage, prepareFile, prepareHash, apkFile, apkHash] = process.argv.slice(2);
const hash = value => createHash('sha256').update(value).digest('hex');
function privateBytes(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    (!process.getuid || stat.uid === process.getuid()),
    'S3 probe private file metadata mismatch');
  return fs.readFileSync(file);
}
function apkConfig(bytes, expectedHash) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid APK probe bundle'); }
  const names = ['ENDPOINT', 'REGION', 'BUCKET', 'FORCE_PATH_STYLE', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'];
  assert(/^[a-f0-9]{64}$/.test(expectedHash) && hash(bytes) === expectedHash &&
    value && !Array.isArray(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(names) &&
    names.every(name => typeof value[name] === 'string' && value[name] && !/[\r\n\0']/.test(value[name])) &&
    bytes.equals(Buffer.from(JSON.stringify(value) + '\n')) && value.BUCKET === 'content-files' &&
    ['true', 'false'].includes(value.FORCE_PATH_STYLE), 'Invalid APK probe contract');
  return value;
}
function provider(values, prefix, sdk) {
  const endpoint = new URL(values[`${prefix}_ENDPOINT`]);
  assert(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password &&
    !endpoint.search && !endpoint.hash, 'Invalid S3 probe endpoint');
  return new sdk.S3Client({ endpoint: endpoint.href, region: values[`${prefix}_REGION`],
    forcePathStyle: values[`${prefix}_FORCE_PATH_STYLE`] === 'true', maxAttempts: 1,
    credentials: { accessKeyId: values[`${prefix}_ACCESS_KEY_ID`],
      secretAccessKey: values[`${prefix}_SECRET_ACCESS_KEY`] } });
}
async function readBody(result) {
  assert(result.Body, 'S3 probe object has no body');
  return Buffer.from(await result.Body.transformToByteArray());
}
function denied(error) {
  const code = error?.$metadata?.httpStatusCode;
  return code === 403 || ['AccessDenied', 'Forbidden', 'Unauthorized'].includes(error?.name);
}
async function expectDenied(operation) {
  try { await operation(); } catch (error) {
    assert(denied(error), 'S3 negative probe failed without an authorization denial');
    return;
  }
  throw new Error('S3 negative probe was unexpectedly authorized');
}
async function backupProbe(client, sdk) {
  const Bucket = 'backup-services';
  const prefix = `database-backups/__capability_probe__/${randomUUID()}/`;
  const Key = `${prefix}small.bin`;
  const multipartKey = `${prefix}multipart.bin`;
  const bytes = Buffer.from(`aerocrm-backup-probe:${randomUUID()}`);
  let uploadId;
  try {
    await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: bytes, ContentLength: bytes.length }));
    const head = await client.send(new sdk.HeadObjectCommand({ Bucket, Key }));
    assert.equal(head.ContentLength, bytes.length, 'Backup HEAD differs');
    assert((await readBody(await client.send(new sdk.GetObjectCommand({ Bucket, Key })))).equals(bytes),
      'Backup GET differs');
    const list = await client.send(new sdk.ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: 10 }));
    assert(list.Contents?.some(item => item.Key === Key), 'Backup prefix list differs');
    const multipart = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket, Key: multipartKey }));
    uploadId = multipart.UploadId;
    assert(uploadId, 'Backup multipart initiation failed');
    const part = await client.send(new sdk.UploadPartCommand({ Bucket, Key: multipartKey, UploadId: uploadId,
      PartNumber: 1, Body: bytes, ContentLength: bytes.length }));
    assert(part.ETag, 'Backup multipart part ETag missing');
    const parts = await client.send(new sdk.ListPartsCommand({ Bucket, Key: multipartKey, UploadId: uploadId }));
    assert(parts.Parts?.some(item => item.PartNumber === 1 && item.ETag === part.ETag),
      'Backup multipart parts list differs');
    await client.send(new sdk.CompleteMultipartUploadCommand({ Bucket, Key: multipartKey, UploadId: uploadId,
      MultipartUpload: { Parts: [{ ETag: part.ETag, PartNumber: 1 }] } }));
    uploadId = undefined;
    assert((await readBody(await client.send(new sdk.GetObjectCommand({ Bucket, Key: multipartKey })))).equals(bytes),
      'Backup multipart readback differs');
    const aborted = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket,
      Key: `${prefix}aborted.bin` }));
    assert(aborted.UploadId, 'Backup multipart abort probe did not start');
    await client.send(new sdk.AbortMultipartUploadCommand({ Bucket, Key: `${prefix}aborted.bin`,
      UploadId: aborted.UploadId }));
    await expectDenied(() => client.send(new sdk.ListObjectsV2Command({ Bucket, Prefix: '__denied__/', MaxKeys: 1 })));
    await expectDenied(() => client.send(new sdk.PutObjectCommand({ Bucket,
      Key: `__denied__/${randomUUID()}`, Body: Buffer.alloc(0), IfNoneMatch: '*' })));
    await expectDenied(() => client.send(new sdk.DeleteObjectCommand({ Bucket,
      Key: `__denied__/${randomUUID()}` })));
    await expectDenied(() => client.send(new sdk.ListObjectsV2Command({ Bucket: 'content-files',
      Prefix: 'aerocrm/android/', MaxKeys: 1 })));
  } finally {
    if (uploadId) await client.send(new sdk.AbortMultipartUploadCommand({ Bucket, Key: multipartKey,
      UploadId: uploadId })).catch(() => {});
    await client.send(new sdk.DeleteObjectCommand({ Bucket, Key })).catch(() => {});
    await client.send(new sdk.DeleteObjectCommand({ Bucket, Key: multipartKey })).catch(() => {});
  }
}
async function apkProbe(client, sdk, values) {
  const Bucket = 'content-files';
  const Key = `aerocrm/android/__capability_probe__/${randomUUID()}.apk`;
  const bytes = Buffer.from(`aerocrm-apk-probe:${randomUUID()}`);
  await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: bytes, ContentLength: bytes.length,
    ACL: 'public-read', ContentType: 'application/vnd.android.package-archive',
    Metadata: { sha256: hash(bytes) } }));
  const head = await client.send(new sdk.HeadObjectCommand({ Bucket, Key }));
  assert.equal(head.Metadata?.sha256, hash(bytes), 'APK HEAD metadata differs');
  assert((await readBody(await client.send(new sdk.GetObjectCommand({ Bucket, Key })))).equals(bytes),
    'APK authenticated GET differs');
  const url = new URL(values.ENDPOINT);
  if (values.FORCE_PATH_STYLE === 'true') url.pathname = `/${Bucket}/${Key}`;
  else { url.hostname = `${Bucket}.${url.hostname}`; url.pathname = `/${Key}`; }
  const publicRead = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.equal(publicRead.status, 200, 'APK anonymous GET unavailable');
  assert(Buffer.from(await publicRead.arrayBuffer()).equals(bytes), 'APK anonymous readback differs');
  await expectDenied(() => client.send(new sdk.DeleteObjectCommand({ Bucket,
    Key: `aerocrm/android/__capability_probe__/${randomUUID()}.apk` })));
  await expectDenied(() => client.send(new sdk.ListObjectsV2Command({ Bucket,
    Prefix: 'aerocrm/android/', MaxKeys: 1 })));
  await expectDenied(() => client.send(new sdk.PutObjectCommand({ Bucket,
    Key: `mail/__capability_probe__/${randomUUID()}`, Body: Buffer.alloc(0), IfNoneMatch: '*' })));
  await expectDenied(() => client.send(new sdk.ListObjectsV2Command({ Bucket: 'backup-services',
    Prefix: 'database-backups/', MaxKeys: 1 })));
  return Key; // The administrator removes this tiny synthetic public object after reviewing the proof.
}

if (mode === '--policy-self-test') {
  assert(denied({ $metadata: { httpStatusCode: 403 } }));
  assert(!denied({ $metadata: { httpStatusCode: 404 } }));
  const policies = JSON.parse(fs.readFileSync(new URL('./reliability-s3-policies.json', import.meta.url)));
  assert.deepEqual(policies.map(item => [item.name, item.bucket, item.prefix]), [
    ['aerocrm-backup-only', 'backup-services', 'database-backups/'],
    ['aerocrm-apk-publisher', 'content-files', 'aerocrm/android/']
  ]);
  assert.deepEqual(policies[0].policy.Statement.map(item => item.Resource), [
    'arn:aws:s3:::backup-services/database-backups/*', 'arn:aws:s3:::backup-services'
  ]);
  assert.deepEqual(policies[0].policy.Statement[0].Action,
    ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts']);
  assert.deepEqual(policies[0].policy.Statement[1].Condition,
    { StringLike: { 's3:prefix': 'database-backups/*' } });
  assert.deepEqual(policies[1].policy.Statement, [{ Effect: 'Allow',
    Action: ['s3:GetObject', 's3:PutObject', 's3:PutObjectAcl'],
    Resource: 'arn:aws:s3:::content-files/aerocrm/android/*' }]);
  console.log('Reliability S3 probe policy fixtures verified');
} else if (mode === '--probe') {
  try {
    assert.equal(process.argv.length, 8, 'Expected SDK package, prepare bundle/hash and APK bundle/hash');
    const sdk = createRequire(path.resolve(sdkPackage))('@aws-sdk/client-s3');
    const prepare = validateReliabilityBundle(privateBytes(prepareFile), prepareHash);
    assert.equal(prepare.phase, 'prepare');
    const backup = prepare.files['operations-worker.env'];
    const backupValues = {
      CRM_BACKUP_S3_ENDPOINT: 'https://s3.twcstorage.ru', CRM_BACKUP_S3_REGION: 'ru-1',
      CRM_BACKUP_S3_FORCE_PATH_STYLE: 'true', ...backup
    };
    const apk = apkConfig(privateBytes(apkFile), apkHash);
    assert.notEqual(backup.CRM_BACKUP_S3_ACCESS_KEY_ID, apk.ACCESS_KEY_ID,
      'Backup and APK principals must differ');
    const backupClient = provider(backupValues, 'CRM_BACKUP_S3', sdk);
    const apkClient = provider(Object.fromEntries(Object.entries(apk).map(([key, value]) =>
      [`ANDROID_APK_S3_${key}`, value])), 'ANDROID_APK_S3', sdk);
    try {
      await backupProbe(backupClient, sdk);
      const apkProbeKey = await apkProbe(apkClient, sdk, apk);
      console.log(JSON.stringify({ backup: 'verified', apk: 'verified', apkProbeKey,
        backupPrefix: 'backup-services/database-backups/', apkPrefix: 'content-files/aerocrm/android/',
        credentialsWithheld: true }));
    } finally { backupClient.destroy(); apkClient.destroy(); }
  } catch { console.error('Reliability S3 capability probe failed; provider details and credentials withheld'); process.exitCode = 1; }
} else {
  console.error('Expected --probe or --policy-self-test');
  process.exitCode = 1;
}
