// One-incident, durable pending-journal amendment for the CRM reliability prepare retry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validatePending, validateState, stateKey } from './backend-release-state.mjs';
import { privateBytes } from './backend-runtime-storage-env.mjs';
import { atomic } from './backend-rabbitmq-config.mjs';

export const reliabilityRecoveryHash = '3dbc2b3e76a9e333a744505ed4c0821fe734bd9d7bad69eef9676e66f6fa7ef4';
export const postDdlRecoveryHash = 'ac5e900177425b8f167aaaf5391583f93677833c44f836af49f527d19bb8ca79';
const parentReceiptHash = '628cbdd21fb4213d5891ca91fb107f6994b162fb33bc6188afe7571872b6604e';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const reliabilityRecoveryFiles = (releases, expectedHash = reliabilityRecoveryHash) => ({
  archive: `${releases}/backend-release.pending.${expectedHash}.original.json`,
  receipt: `${releases}/backend-reliability-recovery.${expectedHash}.json`
});
export const postDdlRecoveryFiles = releases => ({
  archive: `${releases}/backend-release.pending.${postDdlRecoveryHash}.original.json`,
  receipt: `${releases}/backend-reliability-post-ddl-recovery.${postDdlRecoveryHash}.json`
});

function immutable(file, bytes) {
  if (fs.existsSync(file)) {
    assert(privateBytes(file).equals(bytes), 'Reliability recovery evidence changed');
    return;
  }
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function reliabilityReceiptBytes(original, target, fields, expectedHash = reliabilityRecoveryHash) {
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, originalPendingHash: expectedHash,
    oldInfraSha: original.target.infraSha, newInfraSha: target.infraSha,
    appSha: fields.appSha, previousStateKey: stateKey(original.previous), targetStateKey: stateKey(target),
    beforeEnvHash: fields.beforeEnvHash, prepareEnvHash: fields.prepareEnvHash,
    bundleHash: fields.bundleHash, migrationEnvHash: fields.migrationEnvHash }, null, 2)}\n`);
}

export function amendPendingWithEvidence({ releases, pendingFile, stateFile, originalPendingBytes,
  pending, amended, target, receiptFields, validateLive, evidenceFiles, receiptBuilder }, expectedHash) {
  assert(/^[a-f0-9]{64}$/.test(expectedHash), 'Invalid reliability recovery hash');
  assert.equal(digest(originalPendingBytes), expectedHash, 'Reliability original journal hash differs');
  assert.deepEqual(JSON.parse(originalPendingBytes.toString('utf8')), pending,
    'Reliability pending object differs from pinned bytes');
  assert.deepEqual(amended, { ...pending, target }, 'Reliability amendment changes more than target');
  const assertFiles = () => {
    assert(privateBytes(pendingFile).equals(originalPendingBytes), 'Reliability pending changed before amendment');
    assert.deepEqual(validateState(JSON.parse(privateBytes(stateFile).toString('utf8'))), pending.previous,
      'Reliability canonical state changed before amendment');
  };
  const verify = () => {
    assertFiles();
    validateLive();
    assertFiles();
  };
  verify();
  const paths = evidenceFiles ?? reliabilityRecoveryFiles(releases, expectedHash);
  immutable(paths.archive, originalPendingBytes);
  immutable(paths.receipt, (receiptBuilder ?? reliabilityReceiptBytes)(pending, target, receiptFields, expectedHash));
  verify(); // Also covers an interrupted retry after archive/receipt creation.
  atomic(pendingFile, `${JSON.stringify(amended, null, 2)}\n`);
  return amended;
}

export function amendReliabilityPending(options) {
  return amendPendingWithEvidence(options, reliabilityRecoveryHash);
}

export function validateAmendedWithEvidence({ releases, pending, target, receiptFields }, expectedHash) {
  assert(/^[a-f0-9]{64}$/.test(expectedHash), 'Invalid reliability recovery hash');
  const paths = reliabilityRecoveryFiles(releases, expectedHash);
  const originalBytes = privateBytes(paths.archive);
  assert.equal(digest(originalBytes), expectedHash, 'Reliability recovery archive hash differs');
  const original = JSON.parse(originalBytes.toString('utf8'));
  validatePending(original);
  assert.deepEqual(pending, { ...original, target }, 'Reliability recovery journal differs from archive');
  assert(privateBytes(paths.receipt).equals(reliabilityReceiptBytes(original, target, receiptFields, expectedHash)),
    'Reliability recovery receipt differs');
}

export function validateReliabilityAmendedPending(options) {
  return validateAmendedWithEvidence(options, reliabilityRecoveryHash);
}

function validateParentEvidence(releases, pending, receiptFields) {
  const parent = reliabilityRecoveryFiles(releases);
  assert.equal(digest(privateBytes(parent.archive)), reliabilityRecoveryHash,
    'Post-DDL parent archive hash differs');
  assert.equal(digest(privateBytes(parent.receipt)), parentReceiptHash,
    'Post-DDL parent receipt hash differs');
  validateReliabilityAmendedPending({ releases, pending, target: pending.target, receiptFields });
}

function postDdlReceiptBytes(original, target, fields, expectedHash) {
  assert.equal(expectedHash, postDdlRecoveryHash);
  return Buffer.from(`${JSON.stringify({ schemaVersion: 2, originalPendingHash: expectedHash,
    parentArchiveHash: reliabilityRecoveryHash, parentReceiptHash,
    oldInfraSha: original.target.infraSha, newInfraSha: target.infraSha,
    appSha: fields.appSha, previousStateKey: stateKey(original.previous), targetStateKey: stateKey(target),
    beforeEnvHash: fields.beforeEnvHash, prepareEnvHash: fields.prepareEnvHash,
    bundleHash: fields.bundleHash, migrationEnvHash: fields.migrationEnvHash }, null, 2)}\n`);
}

export function amendPostDdlReliabilityPending(options) {
  return amendChainedPendingWithEvidence(options, postDdlRecoveryHash,
    () => validateParentEvidence(options.releases, options.pending, options.receiptFields),
    postDdlRecoveryFiles(options.releases), postDdlReceiptBytes);
}

// Filesystem primitive for crash fixtures; the production wrapper above fixes
// the incident hash, parent evidence, paths, and receipt format.
export function amendChainedPendingWithEvidence(options, expectedHash, validateParent,
  evidenceFiles, receiptBuilder) {
  validateParent();
  return amendPendingWithEvidence({ ...options, evidenceFiles, receiptBuilder,
    validateLive: () => {
      options.validateLive();
      validateParent();
    } }, expectedHash);
}

export function validatePostDdlAmendedPending({ releases, pending, target, receiptFields }) {
  const paths = postDdlRecoveryFiles(releases);
  const originalBytes = privateBytes(paths.archive);
  assert.equal(digest(originalBytes), postDdlRecoveryHash, 'Post-DDL recovery archive hash differs');
  const original = JSON.parse(originalBytes.toString('utf8'));
  validatePending(original);
  validateParentEvidence(releases, original, receiptFields);
  assert.deepEqual(pending, { ...original, target }, 'Post-DDL recovery journal differs from archive');
  assert(privateBytes(paths.receipt).equals(postDdlReceiptBytes(original, target, receiptFields,
    postDdlRecoveryHash)), 'Post-DDL recovery receipt differs');
}
