const assert = require('node:assert/strict');
const test = require('node:test');
const { storageProbePolicy, confirmStorageAbsence } = require('./chat-storage-probe.cjs');

test('uses private owner prefixes and denies root plus every foreign prefix', () => {
  const expected = {
    CRM_CHAT: 'messenger/',
    CRM_MAIL: 'mail/',
    SUPPORT: 'support/attachments/',
    IDENTITY_AVATAR: 'identity/avatars/',
  };
  for (const [owner, prefix] of Object.entries(expected)) {
    const policy = storageProbePolicy(owner);
    assert.equal(policy.prefix, prefix);
    assert.equal(policy.rootListDenied, true);
    assert.equal(policy.allowOwnList, owner === 'CRM_CHAT' || owner === 'CRM_MAIL');
    assert.ok(policy.forbidden.includes('chat/'), 'the old chat prefix must stay denied');
    assert.ok(!policy.forbidden.includes(prefix), 'the owner must not deny its own private prefix');
    for (const foreign of Object.values(expected).filter(value => value !== prefix))
      assert.ok(policy.forbidden.includes(foreign), `${owner} must deny ${foreign}`);
    assert.ok(policy.forbidden.includes('database-backups/'));
  }
  assert.throws(() => storageProbePolicy('UNREVIEWED'));
});

test('confirms absence with runtime 404 or runtime 403 plus independent admin HEAD 404', async () => {
  const notFound = Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
  await confirmStorageAbsence(async () => { throw notFound; });
  let adminCalls = 0;
  await confirmStorageAbsence(async () => { throw Object.assign(new Error('scope hidden'), { $metadata: { httpStatusCode: 403 } }); }, async () => {
    adminCalls++;
    throw notFound;
  });
  assert.equal(adminCalls, 1);
});

test('rejects ambiguous object visibility, including admin HEAD success, 403, and network failure', async () => {
  const runtimeDenied = () => Object.assign(new Error('scope hidden'), { $metadata: { httpStatusCode: 403 } });
  await assert.rejects(confirmStorageAbsence(async () => ({})), /CLEANUP_UNCONFIRMED/);
  await assert.rejects(confirmStorageAbsence(async () => { throw runtimeDenied(); }, async () => ({})), /CLEANUP_UNCONFIRMED/);
  await assert.rejects(confirmStorageAbsence(async () => { throw runtimeDenied(); }, async () => {
    throw Object.assign(new Error('scope hidden'), { $metadata: { httpStatusCode: 403 } });
  }), error => error.$metadata?.httpStatusCode === 403);
  await assert.rejects(confirmStorageAbsence(async () => { throw runtimeDenied(); }, async () => {
    throw new Error('network unavailable');
  }), /network unavailable/);
});
