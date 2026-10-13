import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { reliabilityRoleEnvironmentFields } from './backend-reliability-env.mjs';

const legacyId = 'legacy-key';
const legacyKey = Buffer.alloc(32, 1).toString('base64');
const aesId = 'credential-next';
const aesKey = Buffer.alloc(32, 2).toString('base64');
const hmacId = 'hmac-next';
const hmacKey = Buffer.alloc(32, 3).toString('base64');
const credentialRing = JSON.stringify({ [legacyId]: legacyKey, [aesId]: aesKey });
const hmacRing = JSON.stringify({ [legacyId]: legacyKey, [hmacId]: hmacKey });
const rotatingMail = {
  CRM_MAIL_ENABLED: 'true',
  CRM_MAIL_CREDENTIAL_KEY_ID: legacyId,
  CRM_MAIL_CREDENTIAL_KEY: legacyKey,
  CRM_MAIL_CREDENTIAL_KEYRING: credentialRing,
  CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID: aesId,
  CRM_MAIL_HMAC_KEYRING: hmacRing,
  CRM_MAIL_HMAC_ACTIVE_KEY_ID: hmacId,
  CRM_MAIL_KEY_ROTATION_ENABLED: 'true',
};

function envText(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key}='${value}'\n`)
    .join('');
}

test('Mail runtime role mapping preserves legacy and active keyrings with quoted JSON roundtrip', () => {
  const roles = ['api', 'mail-sync', 'mail-send'];
  const expectedFields = [
    'CRM_MAIL_CREDENTIAL_KEY_ID',
    'CRM_MAIL_CREDENTIAL_KEY',
    'CRM_MAIL_CREDENTIAL_KEYRING',
    'CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID',
    'CRM_MAIL_HMAC_KEYRING',
    'CRM_MAIL_HMAC_ACTIVE_KEY_ID',
    'CRM_MAIL_KEY_ROTATION_ENABLED',
  ].sort();

  for (const role of roles) {
    const fields = reliabilityRoleEnvironmentFields(rotatingMail, 'crm-customers', role);
    assert.deepEqual(Object.keys(fields).sort(), expectedFields);
    assert.deepEqual(fields, {
      CRM_MAIL_KEY_ROTATION_ENABLED: 'true',
      CRM_MAIL_CREDENTIAL_KEY_ID: legacyId,
      CRM_MAIL_CREDENTIAL_KEY: legacyKey,
      CRM_MAIL_CREDENTIAL_KEYRING: credentialRing,
      CRM_MAIL_CREDENTIAL_ACTIVE_KEY_ID: aesId,
      CRM_MAIL_HMAC_KEYRING: hmacRing,
      CRM_MAIL_HMAC_ACTIVE_KEY_ID: hmacId,
    });
    assert.deepEqual(parseEnv(envText(fields)), fields);
  }
});

test('legacy-only disabled Mail keeps the legacy key pair and an explicit disabled rotation gate', () => {
  assert.deepEqual(
    reliabilityRoleEnvironmentFields(
      {
        CRM_MAIL_ENABLED: 'false',
        CRM_MAIL_CREDENTIAL_KEY_ID: legacyId,
        CRM_MAIL_CREDENTIAL_KEY: legacyKey,
      },
      'crm-customers',
      'mail-sync',
    ),
    {
      CRM_MAIL_KEY_ROTATION_ENABLED: 'false',
      CRM_MAIL_CREDENTIAL_KEY_ID: legacyId,
      CRM_MAIL_CREDENTIAL_KEY: legacyKey,
    },
  );
});

test('Access role mapping defaults retention off and ignores other roles', () => {
  for (const role of ['api', 'telegram-worker'])
    assert.deepEqual(
      reliabilityRoleEnvironmentFields({}, 'crm-access', role),
      { CRM_ACCESS_RETENTION_ENABLED: 'false' },
    );
  assert.deepEqual(
    reliabilityRoleEnvironmentFields(
      { CRM_ACCESS_RETENTION_ENABLED: 'true' },
      'crm-access',
      'worker',
    ),
    {},
  );
});

test('rejects incomplete keyrings and any loss of the retained legacy read key', () => {
  assert.throws(
    () =>
      reliabilityRoleEnvironmentFields(
        { ...rotatingMail, CRM_MAIL_HMAC_ACTIVE_KEY_ID: undefined },
        'crm-customers',
        'api',
      ),
    /keyrings and active IDs must be complete/,
  );

  const lostLegacy = JSON.stringify({
    [hmacId]: hmacKey,
    'older-hmac': Buffer.alloc(32, 4).toString('base64'),
  });
  assert.throws(
    () =>
      reliabilityRoleEnvironmentFields(
        { ...rotatingMail, CRM_MAIL_HMAC_KEYRING: lostLegacy },
        'crm-customers',
        'mail-sync',
      ),
    /must preserve the legacy key/,
  );

  assert.throws(
    () =>
      reliabilityRoleEnvironmentFields(
        { ...rotatingMail, CRM_MAIL_CREDENTIAL_KEY: undefined },
        'crm-customers',
        'mail-send',
      ),
    /Mail legacy key is incomplete/,
  );
});
