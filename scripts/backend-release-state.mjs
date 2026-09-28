// Pure release contracts, shared by the controller, compatibility guard and fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
  'crm-customers': ['crm-customers-api', 'crm-customers-mail-sync', 'crm-customers-mail-send'], 'crm-sales': ['crm-sales-api', 'crm-sales-reminders']
};
export const ports = [4100, 4401, 4500, 4600, 4800, 4801, 4802, 4803, 4900, 4901, 4902,
  5000, 5001, 5100, 5101, 5102, 5200, 5201, 5202, 5300, 5301, 5302, 5310, 5311, 5312,
  5317, 5318, 5320, 5321, 5322, 5330, 5331];
// Historical immutable Compose snapshots have 30 roles. A reviewed target must
// have both mail roles; never accept only one worker or infer from live containers.
export function rolesForPlan(services, requireMail = false) {
  const hasSync = Object.hasOwn(services, 'crm-customers-mail-sync');
  const hasSend = Object.hasOwn(services, 'crm-customers-mail-send');
  assert.equal(hasSync, hasSend, 'Mail process roles must be paired');
  assert(!requireMail || hasSync, 'Reviewed target requires both mail process roles');
  return { ...roles, 'crm-customers': hasSync ? roles['crm-customers'] : ['crm-customers-api'] };
}
export function portsForPlan(services) {
  const selected = rolesForPlan(services);
  return selected['crm-customers'].length === 3 ? ports : ports.filter(port => ![5321, 5322].includes(port));
}
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
export function assertRuntime(manifest, containers, alternate = null, allowStopped = false, expectedRoles = roles, alternateRoles = null) {
  validateManifest(manifest); if (alternate) validateManifest(alternate);
  const expected = Object.values(expectedRoles).flat().sort();
  const present = containers.map(c => c.role).sort();
  let inspectedRoles = expectedRoles;
  if (alternateRoles && allowStopped) {
    assert(alternate, 'Pending role recovery requires both reviewed manifests');
    const alternative = Object.values(alternateRoles).flat();
    const allowed = new Set([...expected, ...alternative]);
    const required = expected.filter(role => alternative.includes(role));
    // Compose may be interrupted between worker additions/removals. Only the
    // durable pending path permits that subset; stable verification remains exact.
    assert(new Set(present).size === present.length && present.every(role => allowed.has(role)) &&
      required.every(role => present.includes(role)), 'Pending runtime roles differ from both reviewed inventories');
    inspectedRoles = Object.fromEntries(apps.map(app => [app,
      [...new Set([...expectedRoles[app], ...alternateRoles[app]])].filter(role => present.includes(role))]));
  } else assert.deepEqual(present, expected, 'Backend runtime roles differ from reviewed inventory');
  for (const app of apps) for (const role of inspectedRoles[app]) {
    const container = containers.find(c => c.role === role);
    const candidates = [
      ...(expectedRoles[app].includes(role) ? [manifest.services[app]] : []),
      ...(alternate && (!alternateRoles || alternateRoles[app].includes(role)) ? [alternate.services[app]] : [])
    ];
    assert(candidates.some(entry => container.imageId === entry.imageId && container.revision === entry.sourceSha &&
      container.image === `aerocrm/${app}:${entry.sourceSha}`), `Unexpected immutable runtime image: ${role}`);
    assert(allowStopped || container.running, `Backend runtime is not running: ${role}`);
  }
  return true;
}

function envValues(values = []) {
  assert(Array.isArray(values), 'Expected Docker environment array');
  return Object.fromEntries(values.map(value => {
    const separator = value.indexOf('=');
    assert(separator > 0, 'Invalid Docker environment entry');
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}
function securityOptions(values = []) {
  return [...values].map(value => value.replace(/:true$/, '')).sort();
}
export function assertEffectiveConfig(service, imageConfig, container, role = 'backend') {
  const allowed = ['image', 'environment', 'env_file', 'network_mode', 'restart', 'security_opt',
    'user', 'volumes', 'command', 'entrypoint', 'working_dir', 'profiles'];
  assert(Object.keys(service).every(key => allowed.includes(key)), `Unreviewed Compose option: ${role}`);
  assert(service.network_mode === 'host' && service.restart === 'unless-stopped', `Unexpected network/restart policy: ${role}`);
  const expectedEnv = { ...envValues(imageConfig.Env), ...(service.environment ?? {}) };
  assert(isDeepStrictEqual(envValues(container.Config.Env), expectedEnv), `Runtime environment drift: ${role}`);
  const command = service.command ?? imageConfig.Cmd ?? null;
  const entrypoint = service.entrypoint ?? imageConfig.Entrypoint ?? null;
  assert(isDeepStrictEqual(container.Config.Cmd ?? null, command), `Runtime command drift: ${role}`);
  assert(isDeepStrictEqual(container.Config.Entrypoint ?? null, entrypoint), `Runtime entrypoint drift: ${role}`);
  assert.equal(container.Config.User ?? '', service.user ?? imageConfig.User ?? '', `Runtime user drift: ${role}`);
  assert.equal(container.Config.WorkingDir ?? '', service.working_dir ?? imageConfig.WorkingDir ?? '', `Runtime working directory drift: ${role}`);
  const host = container.HostConfig;
  assert.equal(host.NetworkMode, service.network_mode, `Runtime network drift: ${role}`);
  assert.equal(host.RestartPolicy?.Name, service.restart, `Runtime restart policy drift: ${role}`);
  assert.equal(host.RestartPolicy?.MaximumRetryCount ?? 0, 0, `Runtime retry policy drift: ${role}`);
  assert(isDeepStrictEqual(securityOptions(host.SecurityOpt ?? []), securityOptions(service.security_opt ?? [])),
    `Runtime security option drift: ${role}`);
  assert(!host.Privileged && !host.ReadonlyRootfs && !(host.CapAdd?.length) && !(host.CapDrop?.length) &&
    !(host.Devices?.length) && !(host.Dns?.length) && !Object.keys(host.PortBindings ?? {}).length,
  `Runtime privilege/network override drift: ${role}`);
  assert(!(host.Memory || host.MemoryReservation || host.NanoCpus || host.CpuQuota || host.CpuPeriod || host.CpuShares),
    `Runtime resource policy drift: ${role}`);
  const mounts = (service.volumes ?? []).map(volume => {
    assert(volume.type === 'bind' && typeof volume.source === 'string' && volume.source.startsWith('/') &&
      typeof volume.target === 'string', `Unreviewed volume policy: ${role}`);
    assert(!volume.bind?.propagation || volume.bind.propagation === 'rprivate', `Unreviewed bind propagation: ${role}`);
    return { type: 'bind', source: volume.source, target: volume.target, readOnly: volume.read_only === true };
  }).sort((a, b) => a.target.localeCompare(b.target));
  const actualMounts = (container.Mounts ?? []).map(mount => ({ type: mount.Type, source: mount.Source,
    target: mount.Destination, readOnly: !mount.RW })).sort((a, b) => a.target.localeCompare(b.target));
  assert(isDeepStrictEqual(actualMounts, mounts), `Runtime mount drift: ${role}`);
  for (const mount of container.Mounts ?? [])
    assert(!mount.Propagation || mount.Propagation === 'rprivate', `Runtime bind propagation drift: ${role}`);
  return true;
}
