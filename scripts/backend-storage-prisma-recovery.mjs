// One audited failed migration; immutable SQL and copy provenance remain unchanged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validatePending, validateState } from './backend-release-state.mjs';

export const storageCopyOriginInfra = '58cdc3a1c91ad6457389fcbf352030b1603484ee';
export const auditedMessengerAttempt = Object.freeze({
  id: '16e78d55-ffb4-44e7-a329-2686cb1afe40',
  migration_name: '20261008010000_messenger_storage_prefix',
  checksum: '394f86ac5af5c20c2d6df6d84ac9220e7f40bc73af18e5b0d5781cb9285ef039',
  started_at_utc: '2026-10-08T00:38:31.736619Z',
  finished_at_utc: null, applied_steps_count: 0, logs_null: true
});
export function isAuditedMessengerAttempt(row, resolved = true) {
  return row && Object.entries(auditedMessengerAttempt).every(([key,value]) => row[key] === value) &&
    (resolved ? typeof row.rolled_back_at_utc === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.rolled_back_at_utc) &&
      row.rolled_back_at_utc > auditedMessengerAttempt.started_at_utc : row.rolled_back_at_utc === null);
}
export function auditedMessengerAttemptSql(alias = 'm') {
  assert(/^[a-z_]+$/.test(alias), 'Invalid audited migration SQL alias');
  return `${alias}.id='${auditedMessengerAttempt.id}' AND ${alias}.migration_name='${auditedMessengerAttempt.migration_name}'
    AND ${alias}.checksum='${auditedMessengerAttempt.checksum}'
    AND ${alias}.started_at=TIMESTAMPTZ '${auditedMessengerAttempt.started_at_utc}'
    AND ${alias}.applied_steps_count=0 AND ${alias}.logs IS NULL AND ${alias}.finished_at IS NULL
    AND ${alias}.rolled_back_at IS NOT NULL AND ${alias}.rolled_back_at>${alias}.started_at`;
}
export function validateCommittedStorageRecovery({ pending, canonical, target, marker, storageBeforeHash,
  liveEnvHash, liveComposeHash, runtimeVerified, writersStopped, destinationVerified, migrationProof }) {
  validatePending(pending, canonical); validateState(target);
  assert.equal(pending.target.infraSha, storageCopyOriginInfra);
  assert.notEqual(target.infraSha, storageCopyOriginInfra);
  assert.equal(target.manifest.releaseSha, 'd3a2e8d525778f2216f8bfbcedb08dd1e56bbd0c');
  assert(isDeepStrictEqual(canonical, pending.previous), 'Committed storage recovery requires original canonical state');
  assert(isDeepStrictEqual(target, { ...pending.target, infraSha: target.infraSha }), 'Committed recovery changes only infra provenance');
  assert.equal(marker.infraSha, storageCopyOriginInfra); assert.equal(marker.phase, 'forward-committed');
  assert.equal(marker.schemaVersion, 1); assert.equal(marker.targetBucket, 'content-files');
  assert.deepEqual(marker.provider, { endpoint: 'https://s3.twcstorage.ru', region: 'ru-1', forcePathStyle: true });
  assert(/^[a-f0-9]{64}$/.test(marker.bundleHash) && /^[a-f0-9]{64}$/.test(marker.manifestHash));
  assert.deepEqual(Object.keys(marker.principals).sort(), ['CRM_MAIL','SUPPORT','IDENTITY_AVATAR','CRM_CHAT'].sort());
  assert(Object.values(marker.principals).every(value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value)));
  assert.equal(marker.releaseSha, target.manifest.releaseSha); assert.equal(marker.sourceMailCleaned, false);
  assert(!marker.supportDeleteReady, 'Source cleanup forbids this reviewed recovery');
  assert.equal(marker.beforeEnvHash, pending.previous.envHash); assert.equal(marker.afterEnvHash, target.envHash);
  assert.equal(storageBeforeHash, pending.previous.envHash); assert.equal(liveEnvHash, pending.previous.envHash);
  assert.equal(liveComposeHash, pending.previous.composeHash);
  assert.equal(runtimeVerified, true); assert.equal(writersStopped, true); assert.equal(destinationVerified, true);
  assert(isAuditedMessengerAttempt(migrationProof.attempt, false), 'Unexpected failed Prisma attempt');
  assert.equal(migrationProof.attachmentsEmpty, true); assert.equal(migrationProof.uploadReceiptsEmpty, true);
  assert.equal(migrationProof.keyDefinitionHash, 'b9bffbc5b27a8529aa74bdc2049ab6484cf5b53611b52beac718f1104a1b9afa');
  assert.equal(migrationProof.keyValidated, true); assert.equal(migrationProof.keyNoInherit, false);
  assert.equal(migrationProof.canTemp, false);
  return { ...pending, target };
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function makeCommittedRecoveryReceipt(args) {
  validateCommittedStorageRecovery(args);
  assert(isDeepStrictEqual(JSON.parse(args.pendingBytes), args.pending));
  assert(isDeepStrictEqual(JSON.parse(args.markerBytes), args.marker));
  return { schemaVersion: 1, originInfraSha: storageCopyOriginInfra, target: args.target,
    pendingBase64: Buffer.from(args.pendingBytes).toString('base64'), pendingSha256: hash(args.pendingBytes),
    markerBase64: Buffer.from(args.markerBytes).toString('base64'), markerSha256: hash(args.markerBytes),
    migrationProof: args.migrationProof };
}
export function validateCommittedRecoveryReceipt(receipt) {
  assert.deepEqual(Object.keys(receipt).sort(), ['schemaVersion','originInfraSha','target','pendingBase64','pendingSha256',
    'markerBase64','markerSha256','migrationProof'].sort());
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.originInfraSha, storageCopyOriginInfra);
  const pendingBytes = Buffer.from(receipt.pendingBase64, 'base64');
  const markerBytes = Buffer.from(receipt.markerBase64, 'base64');
  assert.equal(hash(pendingBytes), receipt.pendingSha256); assert.equal(hash(markerBytes), receipt.markerSha256);
  const pending = JSON.parse(pendingBytes); const marker = JSON.parse(markerBytes);
  validateCommittedStorageRecovery({ pending, canonical: pending.previous, target: receipt.target, marker,
    storageBeforeHash: pending.previous.envHash, liveEnvHash: pending.previous.envHash,
    liveComposeHash: pending.previous.composeHash, runtimeVerified: true, writersStopped: true,
    destinationVerified: true, migrationProof: receipt.migrationProof });
  return { pending, marker, target: receipt.target, migrationProof: receipt.migrationProof };
}
export function messengerTempSql(grant) {
  assert(typeof grant === 'boolean');
  return `${grant ? 'GRANT' : 'REVOKE'} TEMPORARY ON DATABASE aerocrm_crm_access ${grant ? 'TO' : 'FROM'} aerocrm_crm_access_migration;`;
}
export function withMessengerTemp({ grant, revoke, verifyRevoked, run }) {
  try { grant(); return run(); }
  finally { revoke(); verifyRevoked(); }
}
export function messengerRecoveryHistory(rows) {
  assert(Array.isArray(rows) && [1,2].includes(rows.length), 'Unexpected messenger recovery attempt inventory');
  const failed = rows.filter(row => isAuditedMessengerAttempt(row, false) || isAuditedMessengerAttempt(row, true));
  assert.equal(failed.length, 1, 'Recovery requires the exact audited failed attempt');
  const needsResolve = isAuditedMessengerAttempt(failed[0], false);
  const applied = rows.filter(row => row !== failed[0]);
  assert(!needsResolve || applied.length === 0, 'Unresolved failure cannot accompany applied migration');
  for (const row of applied) assert(row.migration_name === auditedMessengerAttempt.migration_name &&
    row.checksum === auditedMessengerAttempt.checksum && typeof row.finished_at_utc === 'string' &&
    row.rolled_back_at_utc === null && row.logs_null === true && row.id !== auditedMessengerAttempt.id &&
    Number.isSafeInteger(row.applied_steps_count) && row.applied_steps_count >= 0,
  'Recovery accepts only the completed immutable messenger migration');
  return { needsResolve, completed: applied.length === 1 };
}
