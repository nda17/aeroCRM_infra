// One-incident, durable pending-journal amendment for the CRM reliability prepare retry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validatePending, validateState, stateKey } from './backend-release-state.mjs';
import { privateBytes } from './backend-runtime-storage-env.mjs';
import { atomic } from './backend-rabbitmq-config.mjs';

export const reliabilityRecoveryHash = '3dbc2b3e76a9e333a744505ed4c0821fe734bd9d7bad69eef9676e66f6fa7ef4';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const reliabilityRecoveryFiles = (releases, expectedHash = reliabilityRecoveryHash) => ({
  archive: `${releases}/backend-release.pending.${expectedHash}.original.json`,
  receipt: `${releases}/backend-reliability-recovery.${expectedHash}.json`
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
  pending, amended, target, receiptFields, validateLive }, expectedHash) {
  assert(/^[a-f0-9]{64}$/.test(expectedHash), 'Invalid reliability recovery hash');
  assert.equal(digest(originalPendingBytes), expectedHash, 'Reliability original journal hash differs');
  assert.deepEqual(JSON.parse(originalPendingBytes.toString('utf8')), pending,
    'Reliability pending object differs from pinned bytes');
  assert.deepEqual(amended, { ...pending, target }, 'Reliability amendment changes more than target');
  const verify = () => {
    assert(privateBytes(pendingFile).equals(originalPendingBytes), 'Reliability pending changed before amendment');
    assert.deepEqual(validateState(JSON.parse(privateBytes(stateFile).toString('utf8'))), pending.previous,
      'Reliability canonical state changed before amendment');
    validateLive();
  };
  verify();
  const paths = reliabilityRecoveryFiles(releases, expectedHash);
  immutable(paths.archive, originalPendingBytes);
  immutable(paths.receipt, reliabilityReceiptBytes(pending, target, receiptFields, expectedHash));
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
