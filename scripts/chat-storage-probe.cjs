// Reviewed probe executed inside the exact-SHA Access image, never with admin credentials.
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const sdk = createRequire('/app/package.json')('@aws-sdk/client-s3');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = sdk;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const status = error => error?.$metadata?.httpStatusCode;
const close = response => response?.Body?.destroy?.();
let requests = 0;
const started = Date.now();
const cleanup = new Set();
let client, bucket;
async function request(command, reserve = false) {
  if (++requests > 40 || Date.now() - started > (reserve ? 120000 : 100000)) fail('PROBE_UNAVAILABLE');
  return client.send(command, { abortSignal: AbortSignal.timeout(Math.min(10000, 120000 - (Date.now() - started))) });
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
(async () => {
  let result = 'PROBE_UNAVAILABLE';
  let objectHash;
  try {
    const values = JSON.parse(fs.readFileSync('/reviewed/chat-env.json', 'utf8'));
    bucket = values.CRM_CHAT_S3_BUCKET;
    client = new S3Client({ endpoint: values.CRM_CHAT_S3_ENDPOINT, region: values.CRM_CHAT_S3_REGION,
      forcePathStyle: values.CRM_CHAT_S3_FORCE_PATH_STYLE === 'true', maxAttempts: 1,
      credentials: { accessKeyId: values.CRM_CHAT_S3_ACCESS_KEY_ID, secretAccessKey: values.CRM_CHAT_S3_SECRET_ACCESS_KEY } });
    const key = `chat/${randomUUID()}/${randomUUID()}/${randomUUID()}`;
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
    const listed = await request(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }));
    if (listed.Contents?.length !== 1 || listed.Contents[0].Key !== key) fail('INTEGRITY_FAILED');
    const url = new URL(values.CRM_CHAT_S3_ENDPOINT);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${values.CRM_CHAT_S3_FORCE_PATH_STYLE === 'true' ? `${encodeURIComponent(bucket)}/` : ''}${key.split('/').map(encodeURIComponent).join('/')}`;
    if (values.CRM_CHAT_S3_FORCE_PATH_STYLE !== 'true') url.hostname = `${bucket}.${url.hostname}`;
    if (++requests > 40) fail('PROBE_UNAVAILABLE');
    const anonymous = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000) });
    await anonymous.body?.cancel();
    if (anonymous.status !== 403) fail(anonymous.status === 200 ? 'PUBLIC_OBJECT' : 'PROBE_UNAVAILABLE');
    await request(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    try { const response = await request(new GetObjectCommand({ Bucket: bucket, Key: key })); close(response); fail('CLEANUP_UNCONFIRMED'); }
    catch (error) { if (status(error) !== 404) throw error; }
    cleanup.delete(key);
    for (const prefix of ['mail/', 'database-backups/', 'support/attachments/', 'identity/avatars/']) {
      const foreign = `${prefix}aerocrm-probe-${randomUUID()}/${randomUUID()}`;
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
        try { const response = await request(new GetObjectCommand({ Bucket: bucket, Key: key }), true); close(response); fail('CLEANUP_UNCONFIRMED'); }
        catch (error) { if (status(error) !== 404) throw error; }
      } catch { result = 'CLEANUP_UNCONFIRMED'; }
    }
    client?.destroy();
  }
  process.stdout.write(`${JSON.stringify({ code: result, ok: result === 'PASS', ...(objectHash ? { objectHash } : {}) })}\n`);
  process.exitCode = result === 'PASS' ? 0 : 1;
})();
