#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/publish-android-apk.mjs\nPublishes the verified root aeroCRM.apk and updates Android release metadata.');
  process.exit(0);
}
assert.equal(process.argv.length, 2, 'Unexpected publication arguments');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const android = path.join(root, 'aeroCRM_monorepo/aeroCRM_android');
const manifest = JSON.parse(fs.readFileSync(path.join(android, 'twa-manifest.json'), 'utf8'));
assert.equal(manifest.packageId, 'space.aerocrm.workspace');
assert(/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.appVersionName));
assert.equal(manifest.minSdkVersion, 29);
const apk = path.join(root, 'aeroCRM.apk');
const body = fs.readFileSync(apk);
const sha256 = createHash('sha256').update(body).digest('hex');
const localConfig = JSON.parse(fs.readFileSync(path.join(root, '.private/android/bubblewrap-config.json'), 'utf8'));
const verify = execFileSync(path.join(localConfig.androidSdkPath, 'build-tools/35.0.0/apksigner'),
  ['verify', '--print-certs', apk], { encoding: 'utf8', env: { ...process.env, JAVA_HOME: localConfig.jdkPath } });
const fingerprint = /Signer #1 certificate SHA-256 digest: ([a-f0-9]+)/i.exec(verify)?.[1].toUpperCase();
assert(manifest.fingerprints.some(item => item.value.replaceAll(':', '') === fingerprint), 'Signing certificate mismatch');
const require = createRequire(path.join(root, 'aeroCRM_monorepo/aeroCRM_services/apps/identity/package.json'));
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const env = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
const input = name => {
  const value = env[`IDENTITY_AVATAR_S3_${name}`];
  assert(value, `Missing S3 ${name}`);
  return value;
};
const Bucket = input('BUCKET');
assert.equal(Bucket, 'content-files', 'Only the agreed shared content bucket is allowed');
const endpoint = new URL(input('ENDPOINT'));
assert.equal(endpoint.protocol, 'https:');
const Key = `aerocrm/android/${manifest.appVersionName}/aeroCRM.apk`;
const forcePathStyle = input('FORCE_PATH_STYLE') === 'true';
const sourceUrl = new URL(endpoint);
if (forcePathStyle) sourceUrl.pathname = `/${Bucket}/${Key}`;
else { sourceUrl.hostname = `${Bucket}.${sourceUrl.hostname}`; sourceUrl.pathname = `/${Key}`; }
const downloadUrl = 'https://aerocrm.space/downloads/aeroCRM.apk';
assert(fs.readFileSync(path.join(root, 'aeroCRM_infra/nginx/frontends.conf'), 'utf8')
  .includes(`proxy_pass ${sourceUrl.href};`), 'APK proxy must target the same immutable S3 version');
const client = new S3Client({ endpoint: endpoint.href, region: input('REGION'), forcePathStyle,
  credentials: { accessKeyId: input('ACCESS_KEY_ID'), secretAccessKey: input('SECRET_ACCESS_KEY') }, maxAttempts: 2 });
try {
  let existing;
  try { existing = await client.send(new HeadObjectCommand({ Bucket, Key })); }
  catch (error) { if (error.$metadata?.httpStatusCode !== 404) throw error; }
  if (existing) assert.equal(existing.Metadata?.sha256, sha256, 'Version already exists with different bytes; increment the version');
  else await client.send(new PutObjectCommand({ Bucket, Key, Body: body, ACL: 'public-read',
    ContentType: 'application/vnd.android.package-archive', ContentDisposition: 'attachment; filename="aeroCRM.apk"',
    CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha256 }, ContentLength: body.length }));
  const stored = await client.send(new GetObjectCommand({ Bucket, Key }));
  assert(Buffer.from(await stored.Body.transformToByteArray()).equals(body), 'Authenticated S3 readback differs');
  const response = await fetch(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, 'Anonymous APK download is unavailable');
  assert.equal(response.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert(response.headers.get('content-disposition')?.includes('aeroCRM.apk'));
  assert(Buffer.from(await response.arrayBuffer()).equals(body), 'Public APK download differs');
  const releaseFile = path.join(root, 'aeroCRM_monorepo/aeroCRM_frontends/brand/android-release.json');
  const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
  Object.assign(release, { available: true, versionName: manifest.appVersionName, versionCode: manifest.appVersionCode,
    packageId: manifest.packageId, downloadUrl, sizeBytes: body.length, sha256,
    minSdk: manifest.minSdkVersion, minAndroidVersion: '10', compatibleBrowser: 'Актуальный Chrome или другой браузер с поддержкой TWA' });
  fs.writeFileSync(releaseFile, `${JSON.stringify(release, null, 2)}\n`);
  console.log(JSON.stringify({ downloadUrl, sourceUrl: sourceUrl.href, sizeBytes: body.length, sha256, publicReadbackVerified: true }));
} catch (error) {
  if (error.code === 'ERR_ASSERTION') throw error;
  throw new Error(`S3 publication failed: ${error.name} HTTP ${error.$metadata?.httpStatusCode ?? 'n/a'}; private details withheld`);
} finally { client.destroy(); }
