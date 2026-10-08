import test from 'node:test';
import assert from 'node:assert/strict';
import { apps, roles, rolesForPlan, portsForPlan, validateManifest, validateState, validatePending,
  compositionDiff, uniformManifest, imageVariables, stateKey, assertRuntime, assertEffectiveConfig,
  reviewedStoragePendingAmendment }
  from './backend-release-state.mjs';

const sha = char => char.repeat(40);
const hash = char => char.repeat(64);
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

test('snapshot-derived plans retain 30 historical roles and require both workers and readiness ports for the 32-role target', () => {
  const historical = Object.fromEntries(Object.values(roles).flat().map(role => [role, {}]));
  delete historical['crm-customers-mail-sync'];
  delete historical['crm-customers-mail-send'];
  const target = { ...historical, 'crm-customers-mail-sync': {}, 'crm-customers-mail-send': {} };
  assert.equal(Object.values(rolesForPlan(historical)).flat().length, 30);
  assert.equal(Object.values(rolesForPlan(target, true)).flat().length, 32);
  assert(portsForPlan(target).includes(5321) && portsForPlan(target).includes(5322));
  assert.throws(() => rolesForPlan({ ...historical, 'crm-customers-mail-sync': {} }), /must be paired/);
  assert.throws(() => rolesForPlan(historical, true), /requires both mail process roles/);
});

test('pending 30-to-32 role transition resumes a partial worker addition and requires the complete stable target', () => {
  const targetManifest = manifest({ release: sha('f'), run: '202' });
  const previousManifest = manifest({ release: sha('a'), run: '101' });
  const targetServices = Object.fromEntries(Object.values(roles).flat().map(role => [role, {}]));
  const previousServices = { ...targetServices };
  delete previousServices['crm-customers-mail-sync'];
  delete previousServices['crm-customers-mail-send'];
  const targetRoles = rolesForPlan(targetServices, true);
  const previousRoles = rolesForPlan(previousServices);
  const oldRuntime = runtimeFor(previousManifest).filter(({ role }) =>
    role !== 'crm-customers-mail-sync' && role !== 'crm-customers-mail-send');
  const newRuntime = runtimeFor(targetManifest);
  assert.equal(assertRuntime(targetManifest, oldRuntime, previousManifest, true, targetRoles, previousRoles), true);
  assert.equal(assertRuntime(targetManifest, newRuntime, previousManifest, true, targetRoles, previousRoles), true);
  const syncWorker = newRuntime.find(({ role }) => role === 'crm-customers-mail-sync');
  assert.equal(assertRuntime(targetManifest, [...oldRuntime, syncWorker], previousManifest, true,
    targetRoles, previousRoles), true);
  assert.throws(() => assertRuntime(targetManifest, [...oldRuntime, syncWorker], null, false, targetRoles), /roles differ/);
  const previousImageWorker = runtimeFor(previousManifest).find(({ role }) => role === 'crm-customers-mail-sync');
  assert.throws(() => assertRuntime(targetManifest, [...oldRuntime, previousImageWorker], previousManifest, true,
    targetRoles, previousRoles), /immutable runtime image|role inventory/i);
  assert.throws(() => rolesForPlan({ ...previousServices, 'crm-customers-mail-sync': {} }), /must be paired/);
  assert.throws(() => assertRuntime(targetManifest, [...oldRuntime,
    { ...newRuntime[0], role: 'crm-customers-mail-preview' }], previousManifest, true,
    targetRoles, previousRoles), /reviewed inventories/);
  const interruptedRemoval = [...oldRuntime, newRuntime.find(({ role }) => role === 'crm-customers-mail-send')];
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
