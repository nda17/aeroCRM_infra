import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const retiredAdministratorKeyIdSha256 = 'dcced4179112aad2737538a0a2c8b5561d9864b3ffd2d355b525221a242b3a1f';
// New delivery candidates must never revive the retired shared administrator.
// Historical immutable snapshots remain readable for provenance inspection.
export function assertScopedS3PrincipalFingerprint(fingerprint, field = 'S3 access key ID') {
  assert(/^[a-f0-9]{64}$/.test(fingerprint));
  assert.notEqual(fingerprint, retiredAdministratorKeyIdSha256,
    `Shared legacy S3 administrator is forbidden in a new candidate: ${field}`);
}
export function assertScopedS3Principals(values) {
  for (const [field, value] of Object.entries(values)) if (/(?:^|_)S3_ACCESS_KEY_ID$/.test(field) && value)
    assertScopedS3PrincipalFingerprint(createHash('sha256').update(value).digest('hex'), field);
}
