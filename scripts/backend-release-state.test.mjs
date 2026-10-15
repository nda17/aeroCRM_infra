import test from 'node:test';
import assert from 'node:assert/strict';
import { apps, roles, rolesForPlan, portsForPlan, validateManifest, validateState, validatePending,
  compositionDiff, uniformManifest, imageVariables, stateKey, assertRuntime, assertEffectiveConfig,
  reviewedStoragePendingAmendment, reviewedReliabilityPendingAmendment,
  reviewedReliabilityPostDdlAmendment, reviewedSalesProductivityPendingAmendment,
  validateSalesRecoveryJournal, nonReliabilityHooksDisabled }
  from './backend-release-state.mjs';
import { auditedMessengerAttempt, isAuditedMessengerAttempt, auditedMessengerAttemptSql,
  validateCommittedStorageRecovery, makeCommittedRecoveryReceipt, validateCommittedRecoveryReceipt,
  messengerTempSql, withMessengerTemp, messengerRecoveryHistory, storageCopyOriginInfra }
  from './backend-storage-prisma-recovery.mjs';

const sha = char => char.repeat(40);
const hash = char => char.repeat(64);
const reliabilityHookFlags = Object.fromEntries([
  'billing', 'custom', 'commerce', 'intake', 'closureMigration', 'aclRepair', 'mail',
  'fileImports', 'planner', 'ux', 'collaboration', 'meeting3', 'telegram', 'stageDuration',
  'reminderFk', 'stageNextAction', 'activityTextTemplates', 'reliability'
].map(name => [name, 'false']));

test('reliability recovery guard permits only reliability migration and rejects every other hook', () => {
  for (const reliability of ['false', 'true']) {
    assert.equal(nonReliabilityHooksDisabled({ ...reliabilityHookFlags, reliability }), true);
  }
  for (const hook of Object.keys(reliabilityHookFlags).filter(name => name !== 'reliability')) {
    assert.equal(nonReliabilityHooksDisabled({ ...reliabilityHookFlags, [hook]: 'true' }), false, hook);
  }
  assert.throws(() => nonReliabilityHooksDisabled({
    ...reliabilityHookFlags,
    unreviewedHook: 'false'
  }), /Unexpected release contract fields/);
  assert.throws(() => nonReliabilityHooksDisabled({
    ...reliabilityHookFlags,
    stageNextAction: true
  }), /Invalid migration flag/);
});

function manifest({ release = sha('a'), run = '101', perApp = {} } = {}) {
  return {
    schemaVersion: 1,
    releaseSha: release,
    ciRunId: run,
    services: Object.fromEntries(apps.map(app => {
      const source = perApp[app]?.sourceSha ?? release;
      const image = perApp[app]?.imageId ?? `sha256:${hash('b')}`;
      return [app, { sourceSha: source, contextHash: perApp[app]?.contextHash ?? hash('c'),
        imageId: image, artifactSha256: hash('d'), ciRunId: perApp[app]?.ciRunId ?? run,
        artifactName: `image-${app}` }];
    }))
  };
}

function runtimeFor(value) {
  return Object.entries(roles).flatMap(([app, processRoles]) => processRoles.map(role => {
    const image = value.services[app];
    return { role, imageId: image.imageId, revision: image.sourceSha,
      image: `aerocrm/${app}:${image.sourceSha}`, running: true, id: `${role}-container` };
  }));
}

function state(release, run) {
  return { schemaVersion: 1, manifest: manifest({ release, run }), infraSha: sha('e'),
    envHash: hash('f'), composeHash: hash('1'),
    closure: { enabled: true, schemaAnchorSha: sha('2') } };
}

function storageRecoveryFixture() {
  const previous = state(sha('a'), '101');
  const target = { ...state(sha('f'), '202'), infraSha: 'dca6f91a1d942fceadfc68317206c9f9c99bb06d' };
  const pending = { schemaVersion: 1, target, previous, phase: 'switching' };
  const canonical = structuredClone(previous);
  const nextTarget = { ...target, infraSha: sha('9') };
  const args = { pending, canonical, target: nextTarget, storageInstall: true,
    storageBeforeHash: previous.envHash, liveEnvHash: previous.envHash, liveComposeHash: previous.composeHash,
    markerPresent: false, chatMigrationAbsent: true, runtimeVerified: true };
  return { previous, target, pending, canonical, nextTarget, args };
}

function reliabilityRecoveryFixture() {
  const previous = { ...state(sha('a'), '101'), envHash: '78e80594fd6a4f780dae4977235f40b5c4074bef8cc7bca90cc2fb206e6aaf55' };
  const pinnedTarget = { ...state('c948a4446496a6d1b83c58f6add04b9f6725a789', '202'),
    infraSha: 'c0751a293f18a282df282ea79810665d879b017e',
    envHash: 'ddb802cce9ffbed372b06921738d652fa914d7134db4d451b2ab90dc8ed5b1cd' };
  const pending = { schemaVersion: 1, target: pinnedTarget, previous, phase: 'switching' };
  const target = { ...pinnedTarget, infraSha: sha('9') };
  const canonical = structuredClone(previous);
  const args = { pending, originalPendingHash: '3dbc2b3e76a9e333a744505ed4c0821fe734bd9d7bad69eef9676e66f6fa7ef4',
    canonical, target, reliabilityInstall: true, reliabilityPhase: 'prepare', reliabilityMigration: true,
    otherHooksDisabled: true, beforeHash: previous.envHash,
    prepareHash: 'ddb802cce9ffbed372b06921738d652fa914d7134db4d451b2ab90dc8ed5b1cd',
    bundleHash: '96db684d51d5f7e8c3c180ebaf2143baec979e10d2e08e71895918e6311782b3',
    migrationEnvHash: 'ed9012223178503b5ecee557e175ff4b153ab62b68166ea9122254c00acd0134',
    liveEnvHash: previous.envHash, liveComposeHash: previous.composeHash,
    runtimeVerified: true, readinessVerified: true, markersVerified: true,
    latestAttemptsAbsent: true, newSchemaAbsent: true };
  return { pending, target, args };
}

function postDdlReliabilityRecoveryFixture() {
  const previous = { ...state(sha('a'), '101'), envHash: '78e80594fd6a4f780dae4977235f40b5c4074bef8cc7bca90cc2fb206e6aaf55' };
  const pinnedTarget = { ...state('c948a4446496a6d1b83c58f6add04b9f6725a789', '202'),
    infraSha: '5cbb3be274cfa65e97cd2764af67d3de243b7ff2',
    envHash: 'ddb802cce9ffbed372b06921738d652fa914d7134db4d451b2ab90dc8ed5b1cd' };
  const pending = { schemaVersion: 1, target: pinnedTarget, previous, phase: 'switching' };
  const target = { ...pinnedTarget, infraSha: sha('9') };
  const args = { pending, originalPendingHash: 'ac5e900177425b8f167aaaf5391583f93677833c44f836af49f527d19bb8ca79',
    canonical: structuredClone(previous), target, reliabilityInstall: true, reliabilityPhase: 'prepare',
    reliabilityMigration: true, otherHooksDisabled: true, beforeHash: previous.envHash,
    prepareHash: 'ddb802cce9ffbed372b06921738d652fa914d7134db4d451b2ab90dc8ed5b1cd',
    bundleHash: '96db684d51d5f7e8c3c180ebaf2143baec979e10d2e08e71895918e6311782b3',
    migrationEnvHash: 'ed9012223178503b5ecee557e175ff4b153ab62b68166ea9122254c00acd0134',
    liveEnvHash: previous.envHash, liveComposeHash: previous.composeHash,
    runtimeVerified: true, readinessVerified: true, markersVerified: true,
    ledgersComplete: true, schemaComplete: true, accessAclExact: true,
    customersLegacyAclExact: true, parentEvidenceVerified: true };
  return { pending, target, args };
}

function salesProductivityRecoveryFixture() {
  const previous = { ...state(sha('a'), '101'), envHash: hash('f') };
  const pendingTarget = { ...state('ef37faa9785b67b4e91effeaea01af4971015ca3', '38814882709'),
    infraSha: 'de4b41f697b6a5fa53774b8ad08a1668c56f30d8',
    envHash: previous.envHash, composeHash: previous.composeHash };
  const pending = { schemaVersion: 1, target: pendingTarget, previous, phase: 'switching' };
  const target = { ...pendingTarget, infraSha: sha('9') };
  const args = { pending, originalPendingHash: 'e302204ad0034a78662bc13c218f462c9f5767dccab27147646de7d742347676',
    canonical: structuredClone(previous), target, isolatedHook: true, runtimeVerified: true,
    readinessVerified: true, schemaVerified: true, liveEnvHash: previous.envHash,
    liveComposeHash: previous.composeHash, markersVerified: true,
    migrationEnvHash: 'ff3e4c649d2936ad96d7cb052e055a7ad9f814dafc816678735d4d9a3b17f546' };
  return { pending, target, args };
}

function committedStorageRecoveryFixture() {
  const previous = { ...state(sha('a'), '101'), infraSha: storageCopyOriginInfra };
  const target = { ...state('d3a2e8d525778f2216f8bfbcedb08dd1e56bbd0c', '303'), infraSha: storageCopyOriginInfra };
  const pending = { schemaVersion: 1, target, previous, phase: 'switching' };
  const nextTarget = { ...target, infraSha: sha('9') };
  const canonical = structuredClone(previous);
  const marker = { schemaVersion: 1, infraSha: storageCopyOriginInfra, phase: 'forward-committed',
    releaseSha: target.manifest.releaseSha, beforeEnvHash: previous.envHash, afterEnvHash: target.envHash,
    bundleHash: hash('b'), manifestHash: hash('c'), targetBucket: 'content-files',
    provider: { endpoint: 'https://s3.twcstorage.ru', region: 'ru-1', forcePathStyle: true },
    principals: { CRM_MAIL: hash('1'), SUPPORT: hash('2'), IDENTITY_AVATAR: hash('3'), CRM_CHAT: hash('4') },
    sourceMailCleaned: false, supportDeleteReady: false };
  const failedAttempt = { ...auditedMessengerAttempt, rolled_back_at_utc: null };
  const migrationProof = { attempt: failedAttempt, attachmentsEmpty: true, uploadReceiptsEmpty: true,
    keyDefinitionHash: 'b9bffbc5b27a8529aa74bdc2049ab6484cf5b53611b52beac718f1104a1b9afa',
    keyValidated: true, keyNoInherit: false, canTemp: false };
  const args = { pending, canonical, target: nextTarget, marker,
    storageBeforeHash: previous.envHash, liveEnvHash: previous.envHash, liveComposeHash: previous.composeHash,
    runtimeVerified: true, writersStopped: true, destinationVerified: true, migrationProof };
  const pendingBytes = Buffer.from(JSON.stringify(pending));
  const markerBytes = Buffer.from(JSON.stringify(marker));
  return { previous, target, nextTarget, pending, canonical, marker, migrationProof, args, pendingBytes, markerBytes };
}

function effectiveConfigFixture() {
  const role = 'synthetic-service';
  const service = { image: 'aerocrm/synthetic:abc123', network_mode: 'host', restart: 'unless-stopped',
    security_opt: ['no-new-privileges:true'], environment: { OVERRIDE: 'compose-value', APP_REVISION: 'abc123' },
    volumes: [{ type: 'bind', source: '/private/test-key.pem', target: '/run/secrets/key.pem', read_only: true }] };
  const imageConfig = { Env: ['PATH=/bin', 'IMAGE_DEFAULT=from-image', 'OVERRIDE=image-value',
    'PRIVATE_TOKEN=synthetic-private-token'], Cmd: ['node', 'index.js'], Entrypoint: ['/entrypoint'],
  User: '10001:10001', WorkingDir: '/srv/app' };
  const container = { Config: { Env: ['PATH=/bin', 'IMAGE_DEFAULT=from-image', 'OVERRIDE=compose-value',
    'PRIVATE_TOKEN=synthetic-private-token', 'APP_REVISION=abc123'], Cmd: ['node', 'index.js'],
  Entrypoint: ['/entrypoint'], User: '10001:10001', WorkingDir: '/srv/app' },
  HostConfig: { NetworkMode: 'host', RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    SecurityOpt: ['no-new-privileges:true'], Privileged: false, ReadonlyRootfs: false, CapAdd: [], CapDrop: [],
    Devices: [], Dns: [], PortBindings: {}, Memory: 0, MemoryReservation: 0, NanoCpus: 0, CpuQuota: 0,
    CpuPeriod: 0, CpuShares: 0 },
  Mounts: [{ Type: 'bind', Source: '/private/test-key.pem', Destination: '/run/secrets/key.pem', RW: false,
    Propagation: 'rprivate' }] };
  return { role, service, imageConfig, container };
}

test('manifest accepts the exact 13-service immutable image contract', () => {
  const value = manifest();
  assert.deepEqual(validateManifest(value), value);
});

test('manifest rejects missing, extra, mistyped, or malformed release and service fields', () => {
  const invalid = [
    value => { delete value.services['crm-sales']; },
    value => { value.services.unexpected = value.services.billing; },
    value => { value.releaseSha = 'not-a-sha'; },
    value => { value.ciRunId = 101; },
    value => { delete value.services.billing.artifactSha256; },
    value => { value.services.identity.imageId = `sha256:${hash('z')}`; },
    value => { value.services.operations.artifactName = 'image-other'; },
    value => { value.services.support.unexpected = true; },
    value => { value.releaseSha = [sha('a')]; },
    value => { value.services.billing.sourceSha = [sha('a')]; },
    value => { value.services.billing.contextHash = [hash('c')]; },
    value => { value.services.billing.imageId = [`sha256:${hash('b')}`]; },
    value => { value.services.billing.artifactSha256 = [hash('d')]; }
  ];
  for (const mutate of invalid) {
    const value = manifest();
    mutate(value);
    assert.throws(() => validateManifest(value));
  }
});

test('state contract binds the exact release manifest, environment, compose, and closure anchor', () => {
  const state = { schemaVersion: 1, manifest: manifest(), infraSha: sha('e'), envHash: hash('f'),
    composeHash: hash('1'), closure: { enabled: true, schemaAnchorSha: sha('2') } };
  assert.equal(validateState(state), state);
  assert.equal(stateKey(state), stateKey(structuredClone(state)));
  assert.notEqual(stateKey(state), stateKey({ ...state, envHash: hash('3') }));
  assert.throws(() => validateState({ ...state, closure: { enabled: true, schemaAnchorSha: null } }));
  assert.throws(() => validateState({ ...state, unexpected: true }));
  for (const key of ['infraSha', 'envHash', 'composeHash']) {
    const malformed = { ...state, [key]: [state[key]] };
    assert.throws(() => validateState(malformed), `array value accepted for ${key}`);
  }
  assert.throws(() => validateState({ ...state,
    closure: { enabled: false, schemaAnchorSha: [sha('2')] } }));
});

test('pending journal accepts exact switching state against either canonical side and rejects malformed or conflicting state', () => {
  const previous = state(sha('a'), '101');
  const target = state(sha('f'), '202');
  const pending = { schemaVersion: 1, target, previous, phase: 'switching' };
  assert.equal(validatePending(pending), pending);
  assert.equal(validatePending(pending, previous), pending);
  assert.equal(validatePending(pending, target), pending);

  const invalid = [
    value => { delete value.previous; },
    value => { value.extra = true; },
    value => { value.phase = 'committed'; },
    value => { value.schemaVersion = 2; },
    value => { value.target.envHash = 'invalid'; }
  ];
  for (const mutate of invalid) {
    const value = structuredClone(pending);
    mutate(value);
    assert.throws(() => validatePending(value));
  }
  assert.throws(() => validatePending(pending, state(sha('9'), '303')), /disagrees/);
});

test('reviewed storage recovery amends only infra provenance for the exact pre-marker previous runtime', () => {
  const { pending, args, nextTarget } = storageRecoveryFixture();
  const amended = reviewedStoragePendingAmendment(args);
  assert.deepEqual(amended, { ...pending, target: nextTarget });
  assert.equal(amended.target.infraSha, sha('9'));
  assert.deepEqual(amended.target.manifest, pending.target.manifest);
  assert.equal(amended.previous.envHash, pending.previous.envHash);
  assert.equal(amended.previous.composeHash, pending.previous.composeHash);
});

test('reviewed storage recovery rejects marker, migration/DDL, applied target, and runtime/config drift', () => {
  const fixture = storageRecoveryFixture();
  const invalid = [
    args => { args.markerPresent = true; },
    args => { args.chatMigrationAbsent = false; },
    args => { args.canonical = structuredClone(args.target); },
    args => { args.liveEnvHash = hash('8'); },
    args => { args.liveComposeHash = hash('8'); },
    args => { args.storageBeforeHash = hash('8'); },
    args => { args.runtimeVerified = false; },
    args => { args.storageInstall = false; },
    args => { args.target = { ...args.target, manifest: manifest({ release: sha('9'), run: '303' }) }; },
    args => { args.target = { ...args.target, envHash: hash('8') }; },
    args => { args.pending = { ...args.pending, previous: { ...args.pending.previous, envHash: hash('8') } }; },
    args => { args.pending = { ...args.pending, target: { ...args.pending.target, infraSha: sha('8') } }; },
    args => { args.target = { ...args.target, composeHash: hash('8') }; },
    args => { args.target = { ...args.target, closure: { ...args.target.closure, enabled: false, schemaAnchorSha: null } }; },
  ];
  for (const mutate of invalid) {
    const args = structuredClone(fixture.args);
    mutate(args);
    assert.throws(() => reviewedStoragePendingAmendment(args));
  }
});

test('reviewed Sales productivity recovery permits only the pinned infra provenance amendment', () => {
  const fixture = salesProductivityRecoveryFixture();
  const amended = reviewedSalesProductivityPendingAmendment(fixture.args);
  assert.deepEqual(amended, { ...fixture.pending, target: fixture.target });
  assert.equal(amended.target.infraSha, sha('9'));
  assert.deepEqual(amended.target.manifest, fixture.pending.target.manifest);
  assert.equal(amended.target.envHash, fixture.pending.target.envHash);
  assert.equal(amended.target.composeHash, fixture.pending.target.composeHash);
  assert.deepEqual(amended.target.closure, fixture.pending.target.closure);

  const invalid = [
    args => { args.originalPendingHash = hash('8'); },
    args => { args.pending = { ...args.pending, target: { ...args.pending.target, infraSha: sha('8') } }; },
    args => { args.pending = { ...args.pending, target: { ...args.pending.target,
      manifest: { ...args.pending.target.manifest, ciRunId: '38814882710' } } }; },
    args => { args.target = { ...args.target, manifest: manifest({ release: sha('8'), run: '404' }) }; },
    args => { args.target = { ...args.target, envHash: hash('8') }; },
    args => { args.target = { ...args.target, composeHash: hash('8') }; },
    args => { args.target = { ...args.target, closure: { enabled: false, schemaAnchorSha: null } }; },
    args => { args.canonical = structuredClone(args.target); },
    args => { args.isolatedHook = false; },
    args => { args.runtimeVerified = false; },
    args => { args.readinessVerified = false; },
    args => { args.schemaVerified = false; },
    args => { args.markersVerified = false; },
    args => { args.liveEnvHash = hash('8'); },
    args => { args.liveComposeHash = hash('8'); },
    args => { args.migrationEnvHash = hash('8'); }
  ];
  for (const mutate of invalid) {
    const args = structuredClone(fixture.args);
    mutate(args);
    assert.throws(() => reviewedSalesProductivityPendingAmendment(args));
  }
});

test('Sales recovery retry accepts archived original after amended canonical state committed', () => {
  const fixture = salesProductivityRecoveryFixture();
  const amended = reviewedSalesProductivityPendingAmendment(fixture.args);
  const committedCanonical = amended.target;

  assert.equal(validatePending(amended, committedCanonical), amended);
  assert.equal(validateSalesRecoveryJournal(fixture.pending, amended, committedCanonical), fixture.pending);
  assert.throws(() => validatePending(fixture.pending, committedCanonical), /disagrees/);
  assert.throws(() => validateSalesRecoveryJournal(fixture.pending, fixture.pending, committedCanonical),
    /differs from archived original/);
});

test('reviewed reliability recovery permits only the pinned infra provenance correction', () => {
  const { pending, target, args } = reliabilityRecoveryFixture();
  assert.deepEqual(reviewedReliabilityPendingAmendment(args), { ...pending, target });
});

test('reviewed reliability recovery rejects journal, migration, environment, manifest, phase, and runtime drift', () => {
  const fixture = reliabilityRecoveryFixture();
  const invalid = [
    args => { args.originalPendingHash = hash('8'); },
    args => { args.latestAttemptsAbsent = false; },
    args => { args.liveEnvHash = hash('8'); },
    args => { args.target = { ...args.target, manifest: manifest({ release: sha('8'), run: '303' }) }; },
    args => { args.target = { ...args.target, composeHash: hash('8') }; },
    args => { args.reliabilityPhase = 'activate'; },
    args => { args.reliabilityMigration = false; },
    args => { args.otherHooksDisabled = false; },
    args => { args.otherHooksDisabled = nonReliabilityHooksDisabled({ ...reliabilityHookFlags, stageDuration: 'true' }); },
    args => { args.runtimeVerified = false; },
    args => { args.readinessVerified = false; },
  ];
  for (const mutate of invalid) {
    const args = structuredClone(fixture.args);
    mutate(args);
    assert.throws(() => reviewedReliabilityPendingAmendment(args));
  }
});

test('reviewed post-DDL recovery permits only the pinned infra correction with complete parent and migration evidence', () => {
  const { pending, target, args } = postDdlReliabilityRecoveryFixture();
  assert.deepEqual(reviewedReliabilityPostDdlAmendment(args), { ...pending, target });
});

test('reviewed post-DDL recovery rejects broken parent chain, incomplete DDL proof, and runtime/config drift', () => {
  const fixture = postDdlReliabilityRecoveryFixture();
  const invalid = [
    args => { args.originalPendingHash = hash('8'); },
    args => { args.parentEvidenceVerified = false; },
    args => { args.ledgersComplete = false; },
    args => { args.schemaComplete = false; },
    args => { args.accessAclExact = false; },
    args => { args.customersLegacyAclExact = false; },
    args => { args.liveEnvHash = hash('8'); },
    args => { args.liveComposeHash = hash('8'); },
    args => { args.reliabilityPhase = 'activate'; },
    args => { args.reliabilityMigration = false; },
    args => { args.otherHooksDisabled = false; },
    args => { args.otherHooksDisabled = nonReliabilityHooksDisabled({ ...reliabilityHookFlags, stageDuration: 'true' }); },
    args => { args.runtimeVerified = false; },
    args => { args.readinessVerified = false; },
    args => { args.target = { ...args.target, manifest: manifest({ release: sha('8'), run: '303' }) }; },
    args => { args.target = { ...args.target, envHash: hash('8') }; },
  ];
  for (const mutate of invalid) {
    const args = structuredClone(fixture.args);
    mutate(args);
    assert.throws(() => reviewedReliabilityPostDdlAmendment(args));
  }
});

test('Prisma history resolves only the exact reviewed failed row and requires completed immutable history', () => {
  const unresolved = { ...auditedMessengerAttempt, rolled_back_at_utc: null };
  const resolved = { ...unresolved, rolled_back_at_utc: '2026-10-08T00:40:01.000000Z' };
  const completed = { ...unresolved, id: '716e4c95-9415-4c5e-a998-1b390647a3df',
    finished_at_utc: '2026-10-08T00:40:02.000000Z', applied_steps_count: 1 };
  assert.equal(isAuditedMessengerAttempt(unresolved, false), true);
  assert.equal(isAuditedMessengerAttempt(resolved), true);
  assert.equal(isAuditedMessengerAttempt({ ...resolved, checksum: sha('a') }), false);
  assert.equal(isAuditedMessengerAttempt({ ...resolved, id: 'another-attempt' }), false);
  assert.match(auditedMessengerAttemptSql(), /16e78d55-ffb4-44e7-a329-2686cb1afe40/);
  assert.match(auditedMessengerAttemptSql(), /applied_steps_count=0/);
  assert.throws(() => auditedMessengerAttemptSql('m;DROP'));
  assert.deepEqual(messengerRecoveryHistory([unresolved]), { needsResolve: true, completed: false });
  assert.deepEqual(messengerRecoveryHistory([resolved]), { needsResolve: false, completed: false });
  assert.deepEqual(messengerRecoveryHistory([resolved, completed]), { needsResolve: false, completed: true });
  for (const rows of [
    [{ ...unresolved, checksum: sha('a') }],
    [{ ...unresolved, applied_steps_count: 1 }],
    [{ ...unresolved, logs_null: false }],
    [resolved, { ...completed, finished_at_utc: null }],
    [resolved, { ...completed, rolled_back_at_utc: '2026-10-08T00:40:02.000000Z' }],
    [resolved, { ...completed, checksum: sha('b') }],
    [resolved, completed, completed],
  ]) assert.throws(() => messengerRecoveryHistory(rows));
});

test('committed Prisma recovery keeps the original marker and changes only infra provenance', () => {
  const fixture = committedStorageRecoveryFixture();
  const amended = validateCommittedStorageRecovery(fixture.args);
  assert.deepEqual(amended, { ...fixture.pending, target: fixture.nextTarget });
  assert.deepEqual(amended.target.manifest, fixture.pending.target.manifest);
  assert.equal(amended.target.envHash, fixture.pending.target.envHash);
  assert.equal(amended.target.composeHash, fixture.pending.target.composeHash);
  assert.equal(fixture.marker.infraSha, storageCopyOriginInfra);
  assert.equal(fixture.marker.phase, 'forward-committed');
  const receipt = makeCommittedRecoveryReceipt({ ...fixture.args,
    pendingBytes: fixture.pendingBytes, markerBytes: fixture.markerBytes });
  assert.deepEqual(validateCommittedRecoveryReceipt(receipt).marker, fixture.marker);
  const tampered = { ...receipt, markerBase64: Buffer.from(JSON.stringify({ ...fixture.marker, phase: 'copying' })).toString('base64') };
  assert.throws(() => validateCommittedRecoveryReceipt(tampered));
  const principalTamper = { ...receipt, markerBase64: Buffer.from(JSON.stringify({
    ...fixture.marker, principals: { ...fixture.marker.principals, SUPPORT: hash('5') }
  })).toString('base64') };
  assert.throws(() => validateCommittedRecoveryReceipt(principalTamper));
  for (const [index, mutate] of [
    args => { args.marker = { ...args.marker, phase: 'verified' }; },
    args => { args.marker = { ...args.marker, infraSha: sha('8') }; },
    args => { args.marker = { ...args.marker, beforeEnvHash: hash('8') }; },
    args => { args.marker = { ...args.marker, afterEnvHash: hash('8') }; },
    args => { args.marker = { ...args.marker, sourceMailCleaned: true }; },
    args => { args.marker = { ...args.marker, targetBucket: 'backup-services' }; },
    args => { args.marker = { ...args.marker, provider: { ...args.marker.provider, region: 'other' } }; },
    args => { args.target = { ...args.target, envHash: hash('8') }; },
    args => { args.target = { ...args.target, composeHash: hash('8') }; },
    args => { args.target = { ...args.target, manifest: manifest({ release: sha('8'), run: '808' }) }; },
    args => { args.migrationProof = { ...args.migrationProof, attempt: { ...args.migrationProof.attempt, id: 'other' } }; },
    args => { args.migrationProof = { ...args.migrationProof, canTemp: true }; },
  ].entries()) {
    const args = structuredClone(fixture.args);
    mutate(args);
    assert.throws(() => validateCommittedStorageRecovery(args), `accepted committed recovery drift fixture ${index}`);
  }
});

test('temporary migration privilege is database and role scoped and is revoked after success or failure', () => {
  assert.equal(messengerTempSql(true), 'GRANT TEMPORARY ON DATABASE aerocrm_crm_access TO aerocrm_crm_access_migration;');
  assert.equal(messengerTempSql(false), 'REVOKE TEMPORARY ON DATABASE aerocrm_crm_access FROM aerocrm_crm_access_migration;');
  const order = [];
  assert.equal(withMessengerTemp({ grant: () => order.push('grant'), run: () => { order.push('run'); return 'ok'; },
    revoke: () => order.push('revoke'), verifyRevoked: () => order.push('verify') }), 'ok');
  assert.deepEqual(order, ['grant', 'run', 'revoke', 'verify']);
  order.length = 0;
  assert.throws(() => withMessengerTemp({ grant: () => { order.push('grant'); throw new Error('grant failed'); },
    run: () => { order.push('run'); }, revoke: () => order.push('revoke'), verifyRevoked: () => order.push('verify') }), /grant failed/);
  assert.deepEqual(order, ['grant', 'revoke', 'verify'], 'failed grant must never run the migration');
  for (const failedCleanup of ['revoke', 'verify']) {
    order.length = 0;
    assert.throws(() => withMessengerTemp({ grant: () => order.push('grant'), run: () => { order.push('run'); return 'ok'; },
      revoke: () => { order.push('revoke'); if (failedCleanup === 'revoke') throw new Error('revoke failed'); },
      verifyRevoked: () => { order.push('verify'); if (failedCleanup === 'verify') throw new Error('verify failed'); } }),
    new RegExp(`${failedCleanup} failed`));
    assert.deepEqual(order, failedCleanup === 'revoke'
      ? ['grant', 'run', 'revoke'] : ['grant', 'run', 'revoke', 'verify']);
  }
  order.length = 0;
  assert.throws(() => withMessengerTemp({ grant: () => order.push('grant'),
    run: () => { order.push('run'); throw new Error('migration failed'); },
    revoke: () => order.push('revoke'), verifyRevoked: () => order.push('verify') }), /migration failed/);
  assert.deepEqual(order, ['grant', 'run', 'revoke', 'verify']);
});

test('composition diff selects only services whose source revision or immutable image changed', () => {
  const previous = manifest();
  const retained = Object.fromEntries(apps.map(app => [app, { sourceSha: sha('a'), ciRunId: '101' }]));
  const target = manifest({ release: sha('f'), run: '202', perApp: {
    ...retained,
    billing: { sourceSha: sha('f'), ciRunId: '202', imageId: `sha256:${hash('3')}` },
    'crm-sales': { sourceSha: sha('a'), ciRunId: '101', imageId: `sha256:${hash('4')}` }
  } });
  assert.deepEqual(compositionDiff(previous, target), ['billing', 'crm-sales']);
  assert.deepEqual(compositionDiff(target, target), []);
  assert.deepEqual(compositionDiff(null, target), apps);
});

test('runtime accepts a selective mixed-revision release and rejects drift in a retained process role', () => {
  const target = manifest({ release: sha('f'), run: '202', perApp: {
    billing: { sourceSha: sha('a'), ciRunId: '101' }
  } });
  const runtime = runtimeFor(target);
  assert.equal(assertRuntime(target, runtime), true);
  const retainedRole = runtime.find(container => container.role === 'crm-sales-api');
  retainedRole.imageId = `sha256:${hash('9')}`;
  assert.throws(() => assertRuntime(target, runtime), /Unexpected immutable runtime image/);
});

test('runtime rejects missing, duplicate, stopped, and unsupported rollback roles', () => {
  const current = manifest({ release: sha('f'), run: '202' });
  const previous = manifest({ release: sha('a'), run: '101' });
  const runtime = runtimeFor(current);
  assert.throws(() => assertRuntime(current, runtime.slice(1)), /roles differ/);
  assert.throws(() => assertRuntime(current, [...runtime, runtime[0]]), /roles differ/);
  runtime[0].running = false;
  assert.throws(() => assertRuntime(current, runtime), /not running/);
  assert.equal(assertRuntime(current, runtime, null, true), true);
  runtime[0].running = true;
  runtime[0].imageId = `sha256:${hash('8')}`;
  assert.throws(() => assertRuntime(current, runtime, previous), /Unexpected immutable runtime image/);
  const rollbackRuntime = runtimeFor(previous);
  assert.equal(assertRuntime(current, rollbackRuntime, previous), true);
});

test('snapshot-derived plans retain 30 historical roles and require both workers and readiness ports for the 33-role Telegram target', () => {
  const historical = Object.fromEntries(Object.values(roles).flat().map(role => [role, {}]));
  delete historical['crm-access-telegram-worker'];
  delete historical['crm-customers-mail-sync'];
  delete historical['crm-customers-mail-send'];
  const target = { ...historical, 'crm-access-telegram-worker': {},
    'crm-customers-mail-sync': {}, 'crm-customers-mail-send': {} };
  assert.equal(Object.values(rolesForPlan(historical)).flat().length, 30);
  const current = { ...historical, 'crm-customers-mail-sync': {}, 'crm-customers-mail-send': {} };
  assert.equal(Object.values(rolesForPlan(current)).flat().length, 32);
  assert(portsForPlan(current).includes(5321) && portsForPlan(current).includes(5322));
  assert(!portsForPlan(current).includes(5303));
  assert.equal(Object.values(rolesForPlan(target, true, true)).flat().length, 33);
  assert(portsForPlan(target).includes(5303) && portsForPlan(target).includes(5321) && portsForPlan(target).includes(5322));
  assert.throws(() => rolesForPlan({ ...historical, 'crm-customers-mail-sync': {} }), /must be paired/);
  assert.throws(() => rolesForPlan(historical, true), /requires both mail process roles/);
  assert.throws(() => rolesForPlan(historical, false, true), /requires Telegram worker/);
});

test('pending 32-to-33 Telegram role transition accepts the current ready baseline and the complete target', () => {
  const targetManifest = manifest({ release: sha('f'), run: '202' });
  const previousManifest = manifest({ release: sha('a'), run: '101' });
  const targetServices = Object.fromEntries(Object.values(roles).flat().map(role => [role, {}]));
  const previousServices = { ...targetServices };
  delete previousServices['crm-access-telegram-worker'];
  const targetRoles = rolesForPlan(targetServices, true, true);
  const previousRoles = rolesForPlan(previousServices);
  const oldRuntime = runtimeFor(previousManifest).filter(({ role }) => role !== 'crm-access-telegram-worker');
  const newRuntime = runtimeFor(targetManifest);
  assert.equal(Object.values(previousRoles).flat().length, 32);
  assert.equal(Object.values(targetRoles).flat().length, 33);
  assert.equal(assertRuntime(targetManifest, oldRuntime, previousManifest, true, targetRoles, previousRoles), true);
  assert.equal(assertRuntime(targetManifest, newRuntime, previousManifest, true, targetRoles, previousRoles), true);
  assert.throws(() => assertRuntime(targetManifest, oldRuntime, null, false, targetRoles), /roles differ/);
});

test('pending 30-to-33 role transition resumes partial worker additions and requires the complete stable target', () => {
  const targetManifest = manifest({ release: sha('f'), run: '202' });
  const previousManifest = manifest({ release: sha('a'), run: '101' });
  const targetServices = Object.fromEntries(Object.values(roles).flat().map(role => [role, {}]));
  const previousServices = { ...targetServices };
  delete previousServices['crm-access-telegram-worker'];
  delete previousServices['crm-customers-mail-sync'];
  delete previousServices['crm-customers-mail-send'];
  const targetRoles = rolesForPlan(targetServices, true, true);
  const previousRoles = rolesForPlan(previousServices);
  const oldRuntime = runtimeFor(previousManifest).filter(({ role }) =>
    role !== 'crm-access-telegram-worker' && role !== 'crm-customers-mail-sync' && role !== 'crm-customers-mail-send');
  const newRuntime = runtimeFor(targetManifest);
  assert.equal(assertRuntime(targetManifest, oldRuntime, previousManifest, true, targetRoles, previousRoles), true);
  assert.equal(assertRuntime(targetManifest, newRuntime, previousManifest, true, targetRoles, previousRoles), true);
  const syncWorker = newRuntime.find(({ role }) => role === 'crm-customers-mail-sync');
  assert.equal(assertRuntime(targetManifest, [...oldRuntime, syncWorker], previousManifest, true,
    targetRoles, previousRoles), true);
  const telegramWorker = newRuntime.find(({ role }) => role === 'crm-access-telegram-worker');
  assert.equal(assertRuntime(targetManifest, [...oldRuntime, telegramWorker], previousManifest, true,
    targetRoles, previousRoles), true);
  assert.throws(() => assertRuntime(targetManifest, [...oldRuntime, syncWorker], null, false, targetRoles), /roles differ/);
  const previousImageWorker = runtimeFor(previousManifest).find(({ role }) => role === 'crm-customers-mail-sync');
  assert.throws(() => assertRuntime(targetManifest, [...oldRuntime, previousImageWorker], previousManifest, true,
    targetRoles, previousRoles), /immutable runtime image|role inventory/i);
  assert.throws(() => rolesForPlan({ ...previousServices, 'crm-customers-mail-sync': {} }), /must be paired/);
  assert.throws(() => assertRuntime(targetManifest, [...oldRuntime,
    { ...newRuntime[0], role: 'crm-customers-mail-preview' }], previousManifest, true,
    targetRoles, previousRoles), /reviewed inventories/);
  const interruptedRemoval = [...oldRuntime, newRuntime.find(({ role }) => role === 'crm-customers-mail-send'), telegramWorker];
  assert.equal(assertRuntime(previousManifest, interruptedRemoval, targetManifest, true,
    previousRoles, targetRoles), true);
});

test('migration gate can distinguish a uniform full release from a mixed baseline', () => {
  assert.equal(uniformManifest(manifest()), true);
  assert.equal(uniformManifest(manifest({ release: sha('f'), run: '202', perApp: {
    billing: { sourceSha: sha('a'), ciRunId: '101' }
  } })), false);
  const variables = imageVariables(manifest({ release: sha('f'), run: '202', perApp: {
    billing: { sourceSha: sha('a'), ciRunId: '101' }
  } }));
  assert.equal(variables.BILLING_IMAGE_SHA, sha('a'));
  assert.equal(variables.CRM_SALES_IMAGE_SHA, sha('f'));
});

test('effective config accepts image defaults merged with Compose overrides and explicit reviewed overrides', () => {
  const { role, service, imageConfig, container } = effectiveConfigFixture();
  assert.equal(assertEffectiveConfig(service, imageConfig, container, role), true);
  const explicit = structuredClone(service);
  explicit.command = ['node', 'server.js']; explicit.entrypoint = ['/custom-entrypoint'];
  explicit.user = '2000:2000'; explicit.working_dir = '/app';
  const configured = structuredClone(container);
  configured.Config.Cmd = explicit.command; configured.Config.Entrypoint = explicit.entrypoint;
  configured.Config.User = explicit.user; configured.Config.WorkingDir = explicit.working_dir;
  assert.equal(assertEffectiveConfig(explicit, imageConfig, configured, role), true);
});

test('effective config rejects secret environment drift without printing the secret value', () => {
  const fixture = effectiveConfigFixture();
  fixture.container.Config.Env = fixture.container.Config.Env.map(value =>
    value.startsWith('PRIVATE_TOKEN=') ? 'PRIVATE_TOKEN=unreviewed-secret-value' : value);
  assert.throws(() => assertEffectiveConfig(fixture.service, fixture.imageConfig, fixture.container, fixture.role),
    error => error.message === `Runtime environment drift: ${fixture.role}` &&
      !error.message.includes('unreviewed-secret-value') && !error.message.includes('synthetic-private-token'));
});

test('effective config rejects command, entrypoint, user, and working-directory drift', () => {
  for (const [field, mutate, message] of [
    ['command', f => { f.container.Config.Cmd = ['sh']; }, /command drift/],
    ['entrypoint', f => { f.container.Config.Entrypoint = ['/unexpected']; }, /entrypoint drift/],
    ['user', f => { f.container.Config.User = '0:0'; }, /user drift/],
    ['working directory', f => { f.container.Config.WorkingDir = '/tmp'; }, /working directory drift/]
  ]) {
    const fixture = effectiveConfigFixture(); mutate(fixture);
    assert.throws(() => assertEffectiveConfig(fixture.service, fixture.imageConfig, fixture.container, fixture.role),
      message, field);
  }
});

test('effective config rejects network, restart, security, privilege, capability, device, DNS, and port drift', () => {
  const cases = [
    ['Compose network mode', f => { f.service.network_mode = 'bridge'; }, /network\/restart/],
    ['Compose restart policy', f => { f.service.restart = 'always'; }, /network\/restart/],
    ['container network mode', f => { f.container.HostConfig.NetworkMode = 'bridge'; }, /network drift/],
    ['container restart policy', f => { f.container.HostConfig.RestartPolicy.Name = 'always'; }, /restart policy drift/],
    ['container retry count', f => { f.container.HostConfig.RestartPolicy.MaximumRetryCount = 5; }, /retry policy drift/],
    ['security options', f => { f.container.HostConfig.SecurityOpt = []; }, /security option drift/],
    ['privileged mode', f => { f.container.HostConfig.Privileged = true; }, /privilege\/network override/],
    ['read-only root', f => { f.container.HostConfig.ReadonlyRootfs = true; }, /privilege\/network override/],
    ['added capability', f => { f.container.HostConfig.CapAdd = ['SYS_ADMIN']; }, /privilege\/network override/],
    ['dropped capability policy', f => { f.container.HostConfig.CapDrop = ['NET_RAW']; }, /privilege\/network override/],
    ['device mapping', f => { f.container.HostConfig.Devices = [{ PathOnHost: '/dev/null' }]; }, /privilege\/network override/],
    ['DNS override', f => { f.container.HostConfig.Dns = ['1.1.1.1']; }, /privilege\/network override/],
    ['published port', f => { f.container.HostConfig.PortBindings = { '80/tcp': [] }; }, /privilege\/network override/],
    ['memory limit', f => { f.container.HostConfig.Memory = 1024; }, /resource policy drift/],
    ['CPU quota', f => { f.container.HostConfig.CpuQuota = 1000; }, /resource policy drift/]
  ];
  for (const [name, mutate, message] of cases) {
    const fixture = effectiveConfigFixture(); mutate(fixture);
    assert.throws(() => assertEffectiveConfig(fixture.service, fixture.imageConfig, fixture.container, fixture.role),
      message, name);
  }
});

test('effective config requires an exact read-only bind mount and rejects unreviewed Compose fields', () => {
  const fixture = effectiveConfigFixture();
  assert.equal(assertEffectiveConfig(fixture.service, fixture.imageConfig, fixture.container, fixture.role), true);
  const cases = [
    ['missing mount', f => { f.container.Mounts = []; }, /mount drift/],
    ['wrong host source', f => { f.container.Mounts[0].Source = '/tmp/other.pem'; }, /mount drift/],
    ['wrong container destination', f => { f.container.Mounts[0].Destination = '/run/other.pem'; }, /mount drift/],
    ['writable bind', f => { f.container.Mounts[0].RW = true; }, /mount drift/],
    ['unreviewed propagation', f => { f.container.Mounts[0].Propagation = 'shared'; }, /bind propagation drift/],
    ['unreviewed volume type', f => { f.service.volumes[0].type = 'volume'; }, /volume policy/],
    ['unknown Compose option', f => { f.service.cap_add = ['SYS_ADMIN']; }, /Unreviewed Compose option/]
  ];
  for (const [name, mutate, message] of cases) {
    const item = effectiveConfigFixture(); mutate(item);
    assert.throws(() => assertEffectiveConfig(item.service, item.imageConfig, item.container, item.role),
      message, name);
  }
});
