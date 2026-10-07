// Reviewed runtime-key scope probe in the exact-SHA Access image. Migration read capability confirms absence only.
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
let S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand;
function storageProbePolicy(owner = 'CRM_CHAT') {
  const owners = { CRM_CHAT: 'messenger/', CRM_MAIL: 'mail/', SUPPORT: 'support/attachments/', IDENTITY_AVATAR: 'identity/avatars/' };
  if (!owners[owner]) throw new Error('Unreviewed storage owner');
  return { prefix: owners[owner], allowOwnList: ['CRM_CHAT', 'CRM_MAIL'].includes(owner), rootListDenied: true,
    forbidden: [...Object.values(owners), 'database-backups/', 'chat/'].filter(prefix => prefix !== owners[owner]) };
}
module.exports = { storageProbePolicy, confirmStorageAbsence };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const status = error => error?.$metadata?.httpStatusCode;
const close = response => response?.Body?.destroy?.();
let requests = 0;
const started = Date.now();
const cleanup = new Set();
let client, bucket, verificationClient;
async function request(command, reserve = false) {
  if (++requests > 40 || Date.now() - started > (reserve ? 120000 : 100000)) fail('PROBE_UNAVAILABLE');
  return client.send(command, { abortSignal: AbortSignal.timeout(Math.min(10000, 120000 - (Date.now() - started))) });
}
async function confirmStorageAbsence(readObject, readHead) {
  try { const response = await readObject(); close(response); fail('CLEANUP_UNCONFIRMED'); }
  catch (error) {
    if (status(error) === 404) return;
    if (status(error) !== 403 || !readHead) throw error;
    try { await readHead(); fail('CLEANUP_UNCONFIRMED'); }
    catch (verificationError) { if (status(verificationError) !== 404) throw verificationError; }
  }
}
async function confirmAbsent(key, reserve = false) {
  // Without unconditional ListBucket, a missing key can return 403. The migration client uses only HEAD.
  return confirmStorageAbsence(() => request(new GetObjectCommand({ Bucket: bucket, Key: key }), reserve),
    verificationClient ? () => {
      if (++requests > 40 || Date.now() - started > 120000) fail('PROBE_UNAVAILABLE');
      return verificationClient.send(new HeadObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(Math.min(10000, 120000 - (Date.now() - started))) });
    } : null);
}
async function denied(command, ownPutKey) {
  try {
    const response = await request(command);
    close(response);
    if (ownPutKey) cleanup.add(ownPutKey);
    fail('SCOPE_VIOLATION');
  } catch (error) {
    if (status(error) === 403) return;
    if (error.safeCode) throw error;
    fail(status(error) ? 'SCOPE_VIOLATION' : 'PROBE_UNAVAILABLE');
  }
}
if (require.main === module) (async () => {
  ({ S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand } = createRequire('/app/package.json')('@aws-sdk/client-s3'));
  let result = 'PROBE_UNAVAILABLE';
  let objectHash;
  try {
    let values = JSON.parse(fs.readFileSync('/reviewed/chat-env.json', 'utf8'));
    const owner = process.env.STORAGE_OWNER || 'CRM_CHAT';
    const policy = storageProbePolicy(owner);
    const prefix = policy.prefix;
    values = Object.fromEntries(['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'FORCE_PATH_STYLE'].map(field =>
      [`CRM_CHAT_S3_${field}`, values[`${owner}_S3_${field}`]]));
    if (values.CRM_CHAT_S3_BUCKET !== 'content-files') fail('SCOPE_VIOLATION');
    bucket = values.CRM_CHAT_S3_BUCKET;
    client = new S3Client({ endpoint: values.CRM_CHAT_S3_ENDPOINT, region: values.CRM_CHAT_S3_REGION,
      forcePathStyle: values.CRM_CHAT_S3_FORCE_PATH_STYLE === 'true', maxAttempts: 1,
      credentials: { accessKeyId: values.CRM_CHAT_S3_ACCESS_KEY_ID, secretAccessKey: values.CRM_CHAT_S3_SECRET_ACCESS_KEY } });
    if (fs.existsSync('/reviewed/source-storage.json')) {
      const sourceConfig = JSON.parse(fs.readFileSync('/reviewed/source-storage.json'));
      if (sourceConfig.endpoint !== values.CRM_CHAT_S3_ENDPOINT || sourceConfig.region !== values.CRM_CHAT_S3_REGION ||
          String(sourceConfig.forcePathStyle) !== values.CRM_CHAT_S3_FORCE_PATH_STYLE ||
          sourceConfig.credentials.accessKeyId === values.CRM_CHAT_S3_ACCESS_KEY_ID) fail('SCOPE_VIOLATION');
      verificationClient = new S3Client({ ...sourceConfig, maxAttempts: 1 });
    }
    const key = `${prefix}${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    const bytes = Buffer.from(`aerocrm-chat-probe-${randomUUID()}`);
    objectHash = hash(bytes);
    // Track before PUT: a lost successful response still requires cleanup.
    cleanup.add(key);
    try { await request(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/octet-stream' })); }
    catch (error) { fail(status(error) === 403 ? 'PERMISSION_DENIED' : 'PROBE_UNAVAILABLE'); }
    const received = await request(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = []; let size = 0;
    const readTimer = setTimeout(() => close(received), 10000);
    try {
      for await (const chunk of received.Body) {
        size += chunk.length;
        if (size > 1024) fail('INTEGRITY_FAILED');
        chunks.push(chunk);
      }
    } finally { clearTimeout(readTimer); close(received); }
    if (hash(Buffer.concat(chunks)) !== objectHash) fail('INTEGRITY_FAILED');
    if (policy.allowOwnList) {
      const listed = await request(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }));
      if (listed.Contents?.length !== 1 || listed.Contents[0].Key !== key) fail('INTEGRITY_FAILED');
    } else await denied(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }));
    const url = new URL(values.CRM_CHAT_S3_ENDPOINT);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${values.CRM_CHAT_S3_FORCE_PATH_STYLE === 'true' ? `${encodeURIComponent(bucket)}/` : ''}${key.split('/').map(encodeURIComponent).join('/')}`;
    if (values.CRM_CHAT_S3_FORCE_PATH_STYLE !== 'true') url.hostname = `${bucket}.${url.hostname}`;
    if (++requests > 40) fail('PROBE_UNAVAILABLE');
    const anonymous = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000) });
    await anonymous.body?.cancel();
    if (anonymous.status !== 403) fail(anonymous.status === 200 ? 'PUBLIC_OBJECT' : 'PROBE_UNAVAILABLE');
    await request(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await confirmAbsent(key);
    cleanup.delete(key);
    await denied(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    for (const forbidden of policy.forbidden) {
      const foreign = `${forbidden}aerocrm-probe-${randomUUID()}/${randomUUID()}`;
      await denied(new GetObjectCommand({ Bucket: bucket, Key: foreign }));
      // Track potentially accepted/lost PUT responses, without touching existing objects.
      cleanup.add(foreign);
      try { await denied(new PutObjectCommand({ Bucket: bucket, Key: foreign, Body: bytes }), foreign); }
      catch (error) { throw error; }
      cleanup.delete(foreign); // confirmed 403: nothing was created
      await denied(new ListObjectsV2Command({ Bucket: bucket, Prefix: foreign, MaxKeys: 1 }));
      await denied(new DeleteObjectCommand({ Bucket: bucket, Key: foreign }));
    }
    result = 'PASS';
  } catch (error) {
    result = ['SCOPE_VIOLATION', 'PERMISSION_DENIED', 'INTEGRITY_FAILED', 'PUBLIC_OBJECT', 'CLEANUP_UNCONFIRMED', 'PROBE_UNAVAILABLE']
      .includes(error.safeCode) ? error.safeCode : status(error) === 403 ? 'PERMISSION_DENIED' : 'PROBE_UNAVAILABLE';
  } finally {
    for (const key of cleanup) {
      try {
        await request(new DeleteObjectCommand({ Bucket: bucket, Key: key }), true);
        await confirmAbsent(key, true);
      } catch { result = 'CLEANUP_UNCONFIRMED'; }
    }
    client?.destroy(); verificationClient?.destroy();
  }
  process.stdout.write(`${JSON.stringify({ code: result, ok: result === 'PASS', ...(objectHash ? { objectHash } : {}) })}\n`);
  process.exitCode = result === 'PASS' ? 0 : 1;
})();
