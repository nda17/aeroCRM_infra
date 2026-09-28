import test from 'node:test';
import assert from 'node:assert/strict';
import { apps, roles, validateManifest, validateState, validatePending, compositionDiff, uniformManifest,
  imageVariables, stateKey, assertRuntime } from './backend-release-state.mjs';

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
