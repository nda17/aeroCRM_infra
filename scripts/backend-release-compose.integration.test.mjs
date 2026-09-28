import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEffectiveConfig } from './backend-release-state.mjs';

const infraRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeSource = path.join(infraRoot, 'compose/backend.yml');
const apps = ['api-gateway', 'billing', 'operations'];
const roles = ['api-gateway', 'billing-api', 'billing-worker', 'operations-worker'];
const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const project = `aerocrm-selective-${process.pid}`;
let fixture;
let composeFile;
const variables = sha => ({ ...process.env, IMAGE_SHA: sha });
const run = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', ...options });

let dockerAvailable = false;
try { run(['info'], { stdio: 'ignore' }); dockerAvailable = true; } catch {}
const requireDocker = process.env.REQUIRE_DOCKER_COMPOSE_TEST === 'true';

test('Docker Compose changes selected app process roles, retains other containers, repeats cleanly, and rolls back', {
  skip: dockerAvailable ? false : requireDocker ? false : 'Docker daemon is not available on this workstation'
}, t => {
  if (requireDocker) assert(dockerAvailable, 'CI requires a working Docker daemon for the Compose regression');
  fixture = mkdtempSync(path.join(tmpdir(), 'aerocrm-compose-regression-'));
  const composeDir = path.join(fixture, 'compose');
  composeFile = path.join(composeDir, 'backend.yml');
  t.after(() => {
    try { run(['compose', '-p', project, '-f', composeFile, 'down', '--remove-orphans'], { stdio: 'ignore' }); } catch {}
    try { run(['image', 'rm', ...apps.flatMap(app => [`aerocrm/${app}:${oldSha}`, `aerocrm/${app}:${newSha}`])], { stdio: 'ignore' }); } catch {}
    rmSync(fixture, { recursive: true, force: true });
  });

  mkdirSync(composeDir, { recursive: true });
  mkdirSync(path.join(fixture, 'env/backend'), { recursive: true });
  mkdirSync(path.join(fixture, 'secrets'), { recursive: true });
  writeFileSync(composeFile, readFileSync(composeSource));
  writeFileSync(path.join(composeDir, 'rabbitmq.conf'), '');
  writeFileSync(path.join(fixture, 'secrets/database-backup-provenance-private-key.pem'), 'test fixture only\n');
  const composeText = readFileSync(composeSource, 'utf8');
  for (const match of composeText.matchAll(/^\s+env_file:\s+\.\.\/env\/backend\/([^\s]+)$/gm)) {
    writeFileSync(path.join(fixture, 'env/backend', match[1]), 'SYNTHETIC_COMPOSE_TEST=true\n');
  }
  const dockerfile = path.join(fixture, 'Dockerfile');
  writeFileSync(dockerfile, [
    'FROM busybox:1.36',
    'ARG REVISION',
    'LABEL org.opencontainers.image.revision="$REVISION"',
    'ENTRYPOINT ["sh", "-c", "exec sleep 86400"]',
    ''
  ].join('\n'));
  for (const app of apps) for (const sha of [oldSha, newSha]) {
    run(['build', '--build-arg', `REVISION=${sha}`, '--tag', `aerocrm/${app}:${sha}`,
      '--file', dockerfile, fixture], { stdio: 'inherit' });
  }

  // Production receives saved artifacts, so provenance binds the imported image ID.
  const tags = apps.flatMap(app => [`aerocrm/${app}:${oldSha}`, `aerocrm/${app}:${newSha}`]);
  const archive = path.join(fixture, 'backend-images.tar');
  run(['image', 'save', '--output', archive, ...tags], { stdio: 'inherit' });
  run(['image', 'rm', ...tags], { stdio: 'inherit' });
  run(['image', 'load', '--input', archive], { stdio: 'inherit' });
  const importedIds = Object.fromEntries(tags.map(tag => {
    const id = JSON.parse(run(['image', 'inspect', tag]))[0].Id;
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    return [tag, id];
  }));
  run(['image', 'rm', ...tags], { stdio: 'inherit' });
  run(['image', 'load', '--input', archive], { stdio: 'inherit' });
  for (const tag of tags) assert.equal(JSON.parse(run(['image', 'inspect', tag]))[0].Id, importedIds[tag],
    `re-importing the same artifact must preserve its immutable image identity: ${tag}`);

  const compose = (env, action) => run(['compose', '-p', project, '-f', composeFile, ...action], {
    env: { ...variables(newSha), ...env }, stdio: 'pipe'
  });
  const snapshot = () => Object.fromEntries(roles.map(role => {
    const id = compose({}, ['ps', '-q', role]).trim();
    assert.match(id, /^[a-f0-9]{64}$/, `Compose did not report a running ${role} container`);
    const container = JSON.parse(run(['inspect', id]))[0];
    const loaded = JSON.parse(run(['image', 'inspect', container.Config.Image]))[0];
    assert.equal(loaded.Id, importedIds[container.Config.Image], 'Runtime tag must resolve to its imported artifact identity');
    assert.equal(container.Image, loaded.Id, 'Running container and imported image inspect IDs must match exactly');
    assert.equal(loaded.Config.Labels['org.opencontainers.image.revision'], container.Config.Image.split(':').at(-1));
    return [role, { id, image: container.Config.Image, imageId: container.Image,
      running: container.State.Running, inspection: container }];
  }));

  const assertSnapshotEffectiveConfig = (env, containers, name) => {
    const stored = path.join(fixture, 'releases/backend-configs', name);
    mkdirSync(path.join(stored, 'compose'), { recursive: true });
    mkdirSync(path.join(stored, 'env/backend'), { recursive: true });
    for (const file of readdirSync(path.join(fixture, 'env/backend')))
      writeFileSync(path.join(stored, 'env/backend', file), readFileSync(path.join(fixture, 'env/backend', file)));
    // Mirror the controller: private snapshot env, stable live bind sources.
    const rendered = composeText.replaceAll('./rabbitmq.conf:', `${composeDir}/rabbitmq.conf:`)
      .replaceAll('../secrets/', `${fixture}/secrets/`);
    const expected = path.join(stored, 'compose/effective-check.yml');
    writeFileSync(expected, rendered);
    const plan = JSON.parse(run(['compose', '-p', project, '-f', expected, 'config', '--format', 'json'],
      { env: { ...variables(newSha), ...env }, stdio: 'pipe' }));
    for (const role of roles) {
      const imageConfig = JSON.parse(run(['image', 'inspect', containers[role].imageId]))[0].Config;
      assertEffectiveConfig(plan.services[role], imageConfig, containers[role].inspection, role);
      const drifted = structuredClone(containers[role].inspection);
      drifted.Config.Env.push('UNREVIEWED_CONFIG_DRIFT=1');
      assert.throws(() => assertEffectiveConfig(plan.services[role], imageConfig, drifted, role), /environment drift/);
    }
  };

  const unchanged = { API_GATEWAY_IMAGE_SHA: oldSha, OPERATIONS_IMAGE_SHA: oldSha };
  compose({ ...unchanged, BILLING_IMAGE_SHA: oldSha }, ['up', '-d', ...roles]);
  const baseline = snapshot();
  assertSnapshotEffectiveConfig({ ...unchanged, BILLING_IMAGE_SHA: oldSha }, baseline, 'baseline');
  assert(roles.every(role => baseline[role].running));
  assert.equal(baseline['api-gateway'].image, `aerocrm/api-gateway:${oldSha}`);
  assert.equal(baseline['billing-api'].image, `aerocrm/billing:${oldSha}`);
  assert.equal(baseline['billing-worker'].image, `aerocrm/billing:${oldSha}`);
  const workerMounts = JSON.parse(run(['inspect', baseline['operations-worker'].id]))[0].Mounts;
  assert(workerMounts.some(mount => mount.Source === path.join(fixture,
    'secrets/database-backup-provenance-private-key.pem') &&
    mount.Destination === '/run/secrets/database-backup-provenance-private-key-source' && !mount.RW),
  'operations-worker must retain its stable read-only provenance-key mount');

  compose({ ...unchanged, BILLING_IMAGE_SHA: newSha }, ['up', '-d', ...roles]);
  const released = snapshot();
  assertSnapshotEffectiveConfig({ ...unchanged, BILLING_IMAGE_SHA: newSha }, released, 'released');
  assert.equal(released['api-gateway'].id, baseline['api-gateway'].id,
    'unchanged service must keep its existing container');
  assert.equal(released['operations-worker'].id, baseline['operations-worker'].id,
    'unchanged operations worker must keep its stable container and bind mount');
  for (const role of ['billing-api', 'billing-worker']) {
    assert.notEqual(released[role].id, baseline[role].id, `${role} must be recreated with the changed image`);
    assert.equal(released[role].image, `aerocrm/billing:${newSha}`);
    assert.equal(released[role].imageId, released['billing-api'].imageId,
      'process roles from one app must run the same immutable image');
  }

  compose({ ...unchanged, BILLING_IMAGE_SHA: newSha }, ['up', '-d', ...roles]);
  const repeated = snapshot();
  assertSnapshotEffectiveConfig({ ...unchanged, BILLING_IMAGE_SHA: newSha }, repeated, 'same-content-different-snapshot-directory');
  for (const role of roles) assert.equal(repeated[role].id, released[role].id,
    `repeating the same desired manifest must keep ${role} container`);

  compose({ ...unchanged, BILLING_IMAGE_SHA: oldSha }, ['up', '-d', ...roles]);
  const rolledBack = snapshot();
  assertSnapshotEffectiveConfig({ ...unchanged, BILLING_IMAGE_SHA: oldSha }, rolledBack, 'rollback');
  assert.equal(rolledBack['api-gateway'].id, released['api-gateway'].id,
    'rollback must preserve the unaffected service container');
  assert.equal(rolledBack['operations-worker'].id, released['operations-worker'].id,
    'rollback must preserve the unaffected operations worker container');
  for (const role of ['billing-api', 'billing-worker']) {
    assert.notEqual(rolledBack[role].id, released[role].id, `${role} must be recreated during rollback`);
    assert.equal(rolledBack[role].image, `aerocrm/billing:${oldSha}`);
    assert.equal(rolledBack[role].imageId, baseline[role].imageId);
  }
});
