// Pure release contracts, shared by the controller, compatibility guard and fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const apps = ['api-gateway', 'notification-delivery', 'campaigns', 'reporting', 'billing',
  'identity', 'platform', 'support', 'operations', 'crm-access', 'crm-intake', 'crm-customers', 'crm-sales'];
export const roles = {
  'api-gateway': ['api-gateway'], 'notification-delivery': ['notification-delivery-worker'],
  campaigns: ['campaigns-service'], reporting: ['reporting-service'],
  billing: ['billing-api', 'billing-scheduler', 'billing-worker', 'billing-outbox-publisher'],
  identity: ['identity-api', 'identity-worker', 'identity-outbox-publisher'],
  platform: ['platform-api', 'platform-outbox-publisher'],
  support: ['support-api', 'support-worker', 'support-outbox-publisher'],
  operations: ['operations-api', 'operations-worker', 'operations-outbox-publisher'],
  'crm-access': ['crm-access-api', 'crm-access-worker', 'crm-access-outbox-publisher'],
  'crm-intake': ['crm-intake-api', 'crm-intake-worker', 'crm-intake-publisher', 'crm-intake-sla-worker', 'crm-intake-sla-publisher'],
  'crm-customers': ['crm-customers-api'], 'crm-sales': ['crm-sales-api', 'crm-sales-reminders']
};
export const ports = [4100, 4401, 4500, 4600, 4800, 4801, 4802, 4803, 4900, 4901, 4902,
  5000, 5001, 5100, 5101, 5102, 5200, 5201, 5202, 5300, 5301, 5302, 5310, 5311, 5312,
  5317, 5318, 5320, 5330, 5331];
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const runId = /^[0-9]+$/;
function matches(pattern, value) { return typeof value === 'string' && pattern.test(value); }
function keys(object, expected) {
  assert(object && typeof object === 'object' && !Array.isArray(object), 'Object required');
  assert.deepEqual(Object.keys(object).sort(), [...expected].sort(), 'Unexpected release contract fields');
}
export function validateManifest(manifest) {
  keys(manifest, ['schemaVersion', 'releaseSha', 'ciRunId', 'services']);
  assert.equal(manifest.schemaVersion, 1); assert(matches(sha, manifest.releaseSha));
  assert(typeof manifest.ciRunId === 'string' && runId.test(manifest.ciRunId));
  keys(manifest.services, apps);
  for (const app of apps) {
    const entry = manifest.services[app];
    keys(entry, ['sourceSha', 'contextHash', 'imageId', 'artifactSha256', 'ciRunId', 'artifactName']);
    assert(matches(sha, entry.sourceSha) && matches(hash, entry.contextHash) && matches(hash, entry.artifactSha256));
    assert(matches(/^sha256:[a-f0-9]{64}$/, entry.imageId));
    assert(typeof entry.ciRunId === 'string' && runId.test(entry.ciRunId));
    assert.equal(entry.artifactName, `image-${app}`);
  }
  return manifest;
}
export function validateState(state) {
  keys(state, ['schemaVersion', 'manifest', 'infraSha', 'envHash', 'composeHash', 'closure']);
  assert.equal(state.schemaVersion, 1); validateManifest(state.manifest);
  assert(matches(sha, state.infraSha) && matches(hash, state.envHash) && matches(hash, state.composeHash));
  keys(state.closure, ['enabled', 'schemaAnchorSha']);
  assert(typeof state.closure.enabled === 'boolean');
  assert(state.closure.schemaAnchorSha === null || matches(sha, state.closure.schemaAnchorSha));
  assert(!state.closure.enabled || state.closure.schemaAnchorSha !== null);
  return state;
}
export function validatePending(pending, canonical = null) {
  keys(pending, ['schemaVersion', 'target', 'previous', 'phase']);
  assert.equal(pending.schemaVersion, 1); assert.equal(pending.phase, 'switching');
  validateState(pending.target); validateState(pending.previous);
  if (canonical) {
    validateState(canonical);
    assert([stateKey(pending.previous), stateKey(pending.target)].includes(stateKey(canonical)),
      'Canonical state disagrees with the durable release journal');
  }
  return pending;
}
export function compositionDiff(previous, target) {
  validateManifest(target); if (previous) validateManifest(previous);
  return apps.filter(app => !previous || previous.services[app].imageId !== target.services[app].imageId ||
    previous.services[app].sourceSha !== target.services[app].sourceSha);
}
export function uniformManifest(manifest) {
  validateManifest(manifest);
  return apps.every(app => manifest.services[app].sourceSha === manifest.releaseSha);
}
export function imageVariables(manifest) {
  validateManifest(manifest);
  return Object.fromEntries(apps.map(app => [`${app.toUpperCase().replaceAll('-', '_')}_IMAGE_SHA`, manifest.services[app].sourceSha]));
}
export function stateKey(state) {
  validateState(state);
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}
export function assertRuntime(manifest, containers, alternate = null, allowStopped = false) {
  validateManifest(manifest); if (alternate) validateManifest(alternate);
  const expected = Object.values(roles).flat().sort();
  assert.deepEqual(containers.map(c => c.role).sort(), expected, 'Backend runtime roles differ from reviewed inventory');
  for (const app of apps) for (const role of roles[app]) {
    const container = containers.find(c => c.role === role);
    const candidates = [manifest.services[app], ...(alternate ? [alternate.services[app]] : [])];
    assert(candidates.some(entry => container.imageId === entry.imageId && container.revision === entry.sourceSha &&
      container.image === `aerocrm/${app}:${entry.sourceSha}`), `Unexpected immutable runtime image: ${role}`);
    assert(allowStopped || container.running, `Backend runtime is not running: ${role}`);
  }
  return true;
}
