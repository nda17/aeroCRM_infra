import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apps } from './backend-release-state.mjs';
import { amendPendingWithEvidence, amendChainedPendingWithEvidence,
  validateAmendedWithEvidence, amendReliabilityPending,
  amendPostDdlReliabilityPending, validatePostDdlAmendedPending,
  reliabilityRecoveryFiles } from './backend-reliability-recovery.mjs';

const sha = value => value.repeat(40);
const hash = value => value.repeat(64);

function manifest(release, run) {
  return { schemaVersion: 1, releaseSha: release, ciRunId: run,
    services: Object.fromEntries(apps.map(app => [app, { sourceSha: release, contextHash: hash('a'),
      imageId: `sha256:${hash('b')}`, artifactSha256: hash('c'), ciRunId: run,
      artifactName: `image-${app}` }])) };
}

function fixture() {
  const previous = { schemaVersion: 1, manifest: manifest(sha('1'), '101'), infraSha: sha('2'),
    envHash: hash('3'), composeHash: hash('4'), closure: { enabled: true, schemaAnchorSha: sha('5') } };
  const pinnedTarget = { schemaVersion: 1, manifest: manifest(sha('6'), '202'), infraSha: sha('7'),
    envHash: hash('8'), composeHash: hash('9'), closure: { enabled: true, schemaAnchorSha: sha('a') } };
  const pending = { schemaVersion: 1, target: pinnedTarget, previous, phase: 'switching' };
  const target = { ...pinnedTarget, infraSha: sha('b') };
  const amended = { ...pending, target };
  const originalPendingBytes = Buffer.from(`${JSON.stringify(pending, null, 2)}\n`);
  const expectedHash = crypto.createHash('sha256').update(originalPendingBytes).digest('hex');
  const receiptFields = { appSha: sha('6'), beforeEnvHash: previous.envHash, prepareEnvHash: target.envHash,
    bundleHash: hash('c'), migrationEnvHash: hash('d') };
  return { pending, target, amended, originalPendingBytes, expectedHash, receiptFields };
}

function tempFiles(t, values = fixture()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-reliability-recovery-'));
  const releases = path.join(root, 'releases');
  fs.mkdirSync(releases, { mode: 0o700 });
  const pendingFile = path.join(releases, 'backend-release.pending.json');
  const stateFile = path.join(releases, 'backend-release.state.json');
  fs.writeFileSync(pendingFile, values.originalPendingBytes, { mode: 0o600 });
  fs.writeFileSync(stateFile, `${JSON.stringify(values.pending.previous, null, 2)}\n`, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { releases, pendingFile, stateFile, ...values,
    validateLive: () => {} };
  return { root, options, ...values, paths: reliabilityRecoveryFiles(releases, values.expectedHash) };
}

function assertPrivate(file) {
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
}

test('archive write interruption preserves the original journal and a retry completes the CAS', t => {
  const f = tempFiles(t);
  // A non-file receipt makes the second durable write fail after the archive has been fsynced.
  fs.mkdirSync(f.paths.receipt);
  assert.throws(() => amendPendingWithEvidence(f.options, f.expectedHash));
  assert.deepEqual(fs.readFileSync(f.paths.archive), f.originalPendingBytes);
  assert.deepEqual(fs.readFileSync(f.options.pendingFile), f.originalPendingBytes);
  assertPrivate(f.paths.archive);

  fs.rmSync(f.paths.receipt, { recursive: true });
  assert.deepEqual(amendPendingWithEvidence(f.options, f.expectedHash), f.amended);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.options.pendingFile, 'utf8')), f.amended);
  assertPrivate(f.paths.receipt);
  validateAmendedWithEvidence({ releases: f.options.releases, pending: f.amended,
    target: f.target, receiptFields: f.receiptFields }, f.expectedHash);
});

test('crash after archive and receipt but before CAS can retry without replacing evidence', t => {
  const f = tempFiles(t);
  let checks = 0;
  f.options.validateLive = () => {
    checks += 1;
    if (checks === 2) throw new Error('simulated interruption before CAS');
  };
  assert.throws(() => amendPendingWithEvidence(f.options, f.expectedHash), /simulated interruption/);
  assert(fs.existsSync(f.paths.archive));
  assert(fs.existsSync(f.paths.receipt));
  assert.deepEqual(fs.readFileSync(f.options.pendingFile), f.originalPendingBytes);
  const archiveBytes = fs.readFileSync(f.paths.archive);
  const receiptBytes = fs.readFileSync(f.paths.receipt);

  f.options.validateLive = () => {};
  assert.deepEqual(amendPendingWithEvidence(f.options, f.expectedHash), f.amended);
  assert.deepEqual(fs.readFileSync(f.paths.archive), archiveBytes);
  assert.deepEqual(fs.readFileSync(f.paths.receipt), receiptBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.options.pendingFile, 'utf8')), f.amended);
  validateAmendedWithEvidence({ releases: f.options.releases, pending: f.amended,
    target: f.target, receiptFields: f.receiptFields }, f.expectedHash);
});

test('canonical or pending drift between proof passes blocks CAS and preserves the changed file', t => {
  for (const driftFile of ['stateFile', 'pendingFile']) {
    const f = tempFiles(t);
    const changedBytes = driftFile === 'stateFile'
      ? Buffer.from(`${JSON.stringify({ ...f.pending.previous, envHash: hash('e') }, null, 2)}\n`)
      : Buffer.from('{"externalChange":true}\n');
    let checks = 0;
    f.options.validateLive = () => {
      checks += 1;
      if (checks === 1) fs.writeFileSync(f.options[driftFile], changedBytes, { mode: 0o600 });
    };
    assert.throws(() => amendPendingWithEvidence(f.options, f.expectedHash),
      driftFile === 'stateFile' ? /canonical state changed/ : /pending changed/);
    assert.deepEqual(fs.readFileSync(f.options.pendingFile),
      driftFile === 'pendingFile' ? changedBytes : f.originalPendingBytes);
    assert.equal(fs.existsSync(f.paths.archive), false);
    assert.equal(fs.existsSync(f.paths.receipt), false);
  }
});

test('canonical or pending drift in the final live callback is rechecked before CAS', t => {
  for (const driftFile of ['stateFile', 'pendingFile']) {
    const f = tempFiles(t);
    const changedBytes = driftFile === 'stateFile'
      ? Buffer.from(`${JSON.stringify({ ...f.pending.previous, envHash: hash('e') }, null, 2)}\n`)
      : Buffer.from('{"externalChange":true}\n');
    let checks = 0;
    f.options.validateLive = () => {
      checks += 1;
      if (checks === 2) fs.writeFileSync(f.options[driftFile], changedBytes, { mode: 0o600 });
    };
    assert.throws(() => amendPendingWithEvidence(f.options, f.expectedHash),
      driftFile === 'stateFile' ? /canonical state changed/ : /pending changed/);
    assert.deepEqual(fs.readFileSync(f.options.pendingFile),
      driftFile === 'pendingFile' ? changedBytes : f.originalPendingBytes);
  }
});

test('amended journal survives restart validation and tampered archive or receipt is rejected', t => {
  const f = tempFiles(t);
  amendPendingWithEvidence(f.options, f.expectedHash);
  const validation = { releases: f.options.releases, pending: f.amended,
    target: f.target, receiptFields: f.receiptFields };
  validateAmendedWithEvidence(validation, f.expectedHash);

  const receipt = fs.readFileSync(f.paths.receipt);
  fs.writeFileSync(f.paths.receipt, Buffer.from(`${receipt.toString('utf8')} `), { mode: 0o600 });
  assert.throws(() => validateAmendedWithEvidence(validation, f.expectedHash), /receipt differs/);

  fs.writeFileSync(f.paths.receipt, receipt, { mode: 0o600 });
  const archive = fs.readFileSync(f.paths.archive);
  fs.writeFileSync(f.paths.archive, Buffer.from(`${archive.toString('utf8')} `), { mode: 0o600 });
  assert.throws(() => validateAmendedWithEvidence(validation, f.expectedHash), /archive hash differs/);
});

test('retry refuses modified archive or receipt evidence before it changes the pending journal', t => {
  for (const evidenceName of ['archive', 'receipt']) {
    const f = tempFiles(t);
    let checks = 0;
    f.options.validateLive = () => {
      checks += 1;
      if (checks === 2) throw new Error('simulated interruption before CAS');
    };
    assert.throws(() => amendPendingWithEvidence(f.options, f.expectedHash), /simulated interruption/);
    const evidence = f.paths[evidenceName];
    const bytes = fs.readFileSync(evidence);
    fs.writeFileSync(evidence, Buffer.from(`${bytes.toString('utf8')} `), { mode: 0o600 });
    f.options.validateLive = () => {};
    assert.throws(() => amendPendingWithEvidence(f.options, f.expectedHash), /evidence changed/);
    assert.deepEqual(fs.readFileSync(f.options.pendingFile), f.originalPendingBytes);
  }
});

test('post-DDL parent evidence is checked before IO and again at CAS, then retry completes with chained receipt', t => {
  const f = tempFiles(t);
  const evidenceFiles = { archive: path.join(f.options.releases, 'post-ddl.original.json'),
    receipt: path.join(f.options.releases, 'post-ddl.receipt.json') };
  const receiptBuilder = (original, target, fields, expectedHash) => Buffer.from(`${JSON.stringify({
    parentEvidence: fields.parentEvidence, expectedHash,
    previousStateKey: JSON.stringify(original.previous), targetInfraSha: target.infraSha
  })}\n`);
  let parentIsValid = true;
  const validateParent = () => assert(parentIsValid, 'Parent evidence changed during retry');
  const options = { ...f.options, receiptFields: { ...f.receiptFields, parentEvidence: 'synthetic-parent-proof' } };
  let liveChecks = 0;
  options.validateLive = () => {
    liveChecks += 1;
    if (liveChecks === 2) parentIsValid = false;
  };

  parentIsValid = false;
  assert.throws(() => amendChainedPendingWithEvidence(options, f.expectedHash, validateParent,
    evidenceFiles, receiptBuilder), /Parent evidence changed/);
  assert.equal(fs.existsSync(evidenceFiles.archive), false);
  parentIsValid = true;
  assert.throws(() => amendChainedPendingWithEvidence(options, f.expectedHash, validateParent,
    evidenceFiles, receiptBuilder), /Parent evidence changed/);
  assert.deepEqual(fs.readFileSync(options.pendingFile), f.originalPendingBytes);
  assert(fs.existsSync(evidenceFiles.archive));
  assert(fs.existsSync(evidenceFiles.receipt));

  parentIsValid = true;
  options.validateLive = () => {};
  assert.deepEqual(amendChainedPendingWithEvidence(options, f.expectedHash, validateParent,
    evidenceFiles, receiptBuilder), f.amended);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.pendingFile, 'utf8')), f.amended);
  assert.deepEqual(fs.readFileSync(evidenceFiles.archive), f.originalPendingBytes);
  assert.match(fs.readFileSync(evidenceFiles.receipt, 'utf8'), /synthetic-parent-proof/);
});

test('production recovery wrapper remains pinned to the reviewed incident hash', t => {
  const f = tempFiles(t);
  assert.throws(() => amendReliabilityPending(f.options), /original journal hash differs/);
  assert.deepEqual(fs.readFileSync(f.options.pendingFile), f.originalPendingBytes);
  assert.equal(fs.existsSync(f.paths.archive), false);
});

test('production post-DDL wrappers reject synthetic state when pinned parent evidence is absent', t => {
  const f = tempFiles(t);
  assert.throws(() => amendPostDdlReliabilityPending(f.options));
  assert.deepEqual(fs.readFileSync(f.options.pendingFile), f.originalPendingBytes);
  assert.equal(fs.existsSync(path.join(f.options.releases,
    'backend-release.pending.ac5e900177425b8f167aaaf5391583f93677833c44f836af49f527d19bb8ca79.original.json')), false);
  assert.throws(() => validatePostDdlAmendedPending({ releases: f.options.releases,
    pending: f.amended, target: f.target, receiptFields: f.receiptFields }));
});
