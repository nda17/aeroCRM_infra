#!/usr/bin/env node
// Target host only. Called by the reviewed GitHub release workflow under release.lock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const accessFiles = ['crm-access-api.env', 'crm-access-worker.env', 'crm-access-outbox-publisher.env'];
const backendApps = ['api-gateway', 'notification-delivery', 'campaigns', 'reporting', 'billing',
  'identity', 'platform', 'support', 'operations', 'crm-access', 'crm-intake', 'crm-customers', 'crm-sales'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => /^[a-f0-9]{64}$/.test(value || '');
const isSha = value => /^[a-f0-9]{40}$/.test(value || '');

function aggregate(files) {
  const lines = [...files.entries()].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([name, bytes]) => `${sha256(bytes)}  ./${name}\n`).join('');
  return sha256(lines);
}
function projections(files, beforeHash, afterHash) {
  const before = new Map(files);
  const after = new Map(files);
  for (const name of accessFiles) {
    const bytes = files.get(name);
    assert(bytes, `Missing CRM Access env: ${name}`);
    const current = bytes.toString('utf8');
    assert(Buffer.from(current).equals(bytes), `CRM Access env must be UTF-8: ${name}`);
    const matches = current.match(/^CRM_ACCESS_CLOSURE_ENABLED='(?:false|true)'$/gm) || [];
    assert(matches.length === 1, `Expected exactly one closure gate line: ${name}`);
    const gateLine = /^CRM_ACCESS_CLOSURE_ENABLED='(?:false|true)'$/m;
    before.set(name, Buffer.from(current.replace(gateLine, "CRM_ACCESS_CLOSURE_ENABLED='false'")));
    after.set(name, Buffer.from(current.replace(gateLine, "CRM_ACCESS_CLOSURE_ENABLED='true'")));
  }
  assert(aggregate(before) === beforeHash, 'Backend env before-hash mismatch');
  assert(aggregate(after) === afterHash, 'Backend env after-hash mismatch');
  return after;
}
function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === directory &&
    stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
  'Unsafe backend env directory');
}
function readEnvironment(directory) {
  privateDirectory(directory);
  const files = new Map();
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.env'))) {
    assert(/^[a-z0-9-]+\.env$/.test(name), 'Unexpected backend env filename');
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() &&
      (stat.mode & 0o777) === 0o600, `Unsafe backend env metadata: ${name}`);
    files.set(name, fs.readFileSync(file));
  }
  assert(files.size >= accessFiles.length, 'Backend env inventory is incomplete');
  return files;
}
function marker(root, name) {
  return fs.readFileSync(path.join(root, 'releases', name), 'utf8').trim();
}
function validateMarkers(root, sha) {
  assert(marker(root, 'backend.sha') === sha && marker(root, 'workspace-closure-compatible.sha') === sha,
    'Closure gate requires the exact compatible running backend SHA');
  assert(!fs.existsSync(path.join(root, 'releases/crm-contract-cutover.pending')) &&
    !fs.existsSync(path.join(root, 'releases/backend-rollback-blocked.pending')),
  'Pending cutover or blocked rollback forbids closure gate change');
}
function validateImages(sha) {
  for (const app of backendApps) {
    let revision;
    try {
      revision = execFileSync('docker', ['image', 'inspect', '--format',
        '{{ index .Config.Labels "org.opencontainers.image.revision" }}', `aerocrm/${app}:${sha}`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 }).trim();
    } catch {
      throw new Error(`Exact-SHA backend image unavailable: ${app}`);
    }
    assert(revision === sha, `Backend image revision mismatch: ${app}`);
  }
}
function replaceFile(directory, name, expected, desired) {
  const target = path.join(directory, name);
  assert(fs.readFileSync(target).equals(expected), `Concurrent backend env edit: ${name}`);
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, desired);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function enable(root, sha, beforeHash, afterHash) {
  assert(isSha(sha) && isHash(beforeHash) && isHash(afterHash) && beforeHash !== afterHash,
    'Exact SHA and distinct approved backend env hashes required');
  assert(fs.realpathSync(root) === root, 'Unsafe release root');
  validateMarkers(root, sha);
  validateImages(sha);
  const envRoot = path.join(root, 'env');
  privateDirectory(envRoot);
  const directory = path.join(envRoot, 'backend');
  const current = readEnvironment(directory);
  const desired = projections(current, beforeHash, afterHash);
  for (const name of accessFiles) {
    if (!current.get(name).equals(desired.get(name)))
      replaceFile(directory, name, current.get(name), desired.get(name));
  }
  assert(aggregate(readEnvironment(directory)) === afterHash, 'Backend env after-write hash mismatch');
}
function selfTest() {
  const sha = 'a'.repeat(40);
  const originals = new Map([
    ['billing-api.env', Buffer.from("NODE_ENV='production'\n")],
    ...accessFiles.map(name => [name, Buffer.from("CRM_ACCESS_CLOSURE_ENABLED='false'\nNODE_ENV='production'\n")])
  ]);
  const enabled = new Map(originals);
  for (const name of accessFiles)
    enabled.set(name, Buffer.from("CRM_ACCESS_CLOSURE_ENABLED='true'\nNODE_ENV='production'\n"));
  const beforeHash = aggregate(originals);
  const afterHash = aggregate(enabled);
  assert(aggregate(projections(originals, beforeHash, afterHash)) === afterHash);
  assert(aggregate(projections(enabled, beforeHash, afterHash)) === afterHash);
  const mixed = new Map(originals);
  mixed.set(accessFiles[0], enabled.get(accessFiles[0]));
  assert(aggregate(projections(mixed, beforeHash, afterHash)) === afterHash);
  assert.throws(() => projections(originals, '0'.repeat(64), afterHash));
  assert.throws(() => projections(originals, beforeHash, '0'.repeat(64)));
  assert.throws(() => projections(new Map([...originals].map(([name, bytes]) =>
    [name, name === 'billing-api.env' ? Buffer.from("NODE_ENV='changed'\n") : bytes])), beforeHash, afterHash));
  const duplicate = new Map(originals);
  duplicate.set(accessFiles[0], Buffer.from("CRM_ACCESS_CLOSURE_ENABLED='false'\nCRM_ACCESS_CLOSURE_ENABLED='false'\n"));
  assert.throws(() => projections(duplicate, beforeHash, afterHash));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aerocrm-closure-enable-')));
  try {
    fs.mkdirSync(path.join(root, 'releases'));
    fs.mkdirSync(path.join(root, 'env'), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'env/backend'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'releases/backend.sha'), `${sha}\n`);
    fs.writeFileSync(path.join(root, 'releases/workspace-closure-compatible.sha'), `${sha}\n`);
    validateMarkers(root, sha);
    assert.throws(() => validateMarkers(root, 'b'.repeat(40)));
    fs.writeFileSync(path.join(root, 'releases/workspace-closure-enabled.sha'), `${'b'.repeat(40)}\n`);
    validateMarkers(root, sha);
    fs.writeFileSync(path.join(root, 'releases/crm-contract-cutover.pending'), 'pending\n');
    assert.throws(() => validateMarkers(root, sha));
    fs.unlinkSync(path.join(root, 'releases/crm-contract-cutover.pending'));
    for (const [name, bytes] of originals)
      fs.writeFileSync(path.join(root, 'env/backend', name), bytes, { mode: 0o600 });
    const directory = path.join(root, 'env/backend');
    const initial = readEnvironment(directory);
    assert(aggregate(initial) === beforeHash);
    const target = projections(initial, beforeHash, afterHash);
    replaceFile(directory, accessFiles[0], initial.get(accessFiles[0]), target.get(accessFiles[0]));
    const partial = readEnvironment(directory);
    const resumed = projections(partial, beforeHash, afterHash);
    for (const name of accessFiles) {
      if (!partial.get(name).equals(resumed.get(name)))
        replaceFile(directory, name, partial.get(name), resumed.get(name));
    }
    assert(aggregate(readEnvironment(directory)) === afterHash);
    const link = path.join(root, 'env/backend/other.env');
    fs.symlinkSync(path.join(root, 'env/backend/billing-api.env'), link);
    assert.throws(() => readEnvironment(path.join(root, 'env/backend')));
    fs.unlinkSync(link);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Workspace closure enable policy fixtures verified');
}

if (process.argv.length === 3 && process.argv[2] === '--policy-self-test') {
  selfTest();
  process.exit(0);
}
assert(process.platform === 'linux' && fs.realpathSync('.') === '/opt/aerocrm',
  'Run on the backend host from /opt/aerocrm');
assert(process.argv.length === 5, 'Expected exact SHA, before hash, after hash');
enable('/opt/aerocrm', ...process.argv.slice(2));
console.log('CRM Access closure gate env enabled and aggregate hash verified');
