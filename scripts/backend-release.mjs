#!/usr/bin/env node
// Executed by the reviewed, per-run staged release.sh; never builds images on the VPS.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { apps, roles, rolesForPlan, portsForPlan, validateManifest, validateState, uniformManifest, compositionDiff,
  imageVariables, stateKey, assertRuntime, validatePending, assertEffectiveConfig } from './backend-release-state.mjs';

import { runReleaseTransaction } from './backend-release-transaction.mjs';
import { stageMailEnvironment } from './backend-mail-env.mjs';

const root = '/opt/aerocrm';
const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
assert.equal(process.platform, 'linux', 'Backend releases run only on the Linux VPS');
assert.equal(fs.realpathSync('.'), root, 'Run from /opt/aerocrm');
if (args[0] !== '--locked') {
  const child = spawnSync('flock', ['-n', `${root}/release.lock`, process.execPath, script, '--locked', ...args],
    { stdio: 'inherit', env: process.env });
  process.exit(child.status ?? 1);
}
args.shift();
const [role, sha, expectedEnvHash, billing = 'false', billingHash = '', custom = 'false', customHash = '',
  commerce = 'false', commerceHash = '', intake = 'false', intakeHash = '', closureMigration = 'false',
  closureHash = '', aclRepair = 'false', aclHash = '', mail = 'false', mailHash = '',
  fileImports = 'false', fileImportsHash = '', planner = 'false', plannerHash = '', ux = 'false', uxHash = ''] = args;
assert.equal(role, 'backend'); assert(/^[a-f0-9]{40}$/.test(sha));
assert(/^[a-f0-9]{64}$/.test(expectedEnvHash));
assert(/^[a-f0-9]{40}$/.test(process.env.INFRA_SHA ?? ''));
assert(/^[0-9]+$/.test(process.env.CI_RUN_ID ?? ''));
assert(args.length >= 3 && args.length <= 23, 'Invalid backend release argument count');
const flagPairs = [[billing, billingHash], [custom, customHash], [commerce, commerceHash],
  [intake, intakeHash], [closureMigration, closureHash], [aclRepair, aclHash], [mail, mailHash], [fileImports, fileImportsHash], [planner, plannerHash], [ux, uxHash]];
for (const [enabled, hash] of flagPairs) {
  assert(['true', 'false'].includes(enabled), 'Invalid migration flag');
  assert(enabled === 'true' ? /^[a-f0-9]{64}$/.test(hash) : hash === '', 'Invalid migration env hash');
}
assert.equal(billing, custom, 'Billing and custom-role hooks must be paired');
if (planner === 'true')
  assert([billing, custom, commerce, intake, closureMigration, aclRepair, mail, fileImports, ux].every(value => value === 'false'),
    'CRM planner customization cannot combine migration hooks');
if (ux === 'true')
  assert([billing, custom, commerce, intake, closureMigration, aclRepair, mail, fileImports, planner].every(value => value === 'false'),
    'CRM UX unification cannot combine migration hooks');
if (fileImports === 'true')
  assert([billing, custom, commerce, intake, closureMigration, aclRepair, mail].every(value => value === 'false'),
    'CRM file imports cannot combine migration hooks');
if (closureMigration === 'true' || aclRepair === 'true')
  assert([billing, commerce, intake, mail, fileImports].every(value => value === 'false') &&
    !(closureMigration === 'true' && aclRepair === 'true'), 'Incompatible migration flags');
const stagedRoot = fs.realpathSync(process.env.REVIEWED_INFRA_DIR ?? path.dirname(path.dirname(script)));
assert(stagedRoot.startsWith(`${root}/releases/staging/`), 'Reviewed infra must be staged per run');
assert.equal(path.dirname(script), `${stagedRoot}/scripts`);
const manifestPath = fs.realpathSync(process.env.BACKEND_MANIFEST_PATH ?? '');
assert(manifestPath.startsWith(`${stagedRoot}/`), 'Manifest must belong to the immutable run stage');
const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
assert.equal(manifest.releaseSha, sha); assert.equal(manifest.ciRunId, process.env.CI_RUN_ID);
const releases = `${root}/releases`;
const stateFile = `${releases}/backend-state.json`;
const pendingFile = `${releases}/backend-release.pending.json`;
const previousFile = `${releases}/backend-previous-state.json`;
const zeroHash = '0'.repeat(64);
const flags = [billing, custom, commerce, intake, closureMigration, aclRepair, mail, fileImports, planner, ux];
assert(flags.every(value => ['true', 'false'].includes(value)));
const migrationRequested = flags.includes('true');
const mailEnvInstall = process.env.CRM_MAIL_ENV_INSTALL ?? 'false';
const mailEnvBeforeHash = process.env.CRM_MAIL_ENV_BEFORE_HASH ?? '';
const mailEnvBundleHash = process.env.CRM_MAIL_ENV_BUNDLE_HASH ?? '';
assert(['true', 'false'].includes(mailEnvInstall), 'Invalid Customers env installation flag');
assert(mailEnvInstall === 'true' ? /^[a-f0-9]{64}$/.test(mailEnvBeforeHash) &&
  /^[a-f0-9]{64}$/.test(mailEnvBundleHash) : !mailEnvBeforeHash && !mailEnvBundleHash,
  'Invalid reviewed Customers env hashes');
assert(mailEnvInstall !== 'true' || [billing, custom, commerce, intake, closureMigration, aclRepair, fileImports, planner, ux].every(value => value === 'false'),
  'Customers env installation cannot combine unrelated migration hooks');
assert(!migrationRequested || uniformManifest(manifest),
  'Reviewed migration hooks require a full backend manifest; run CI with force_full_backend');
fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
assert(!fs.existsSync(`${releases}/crm-contract-cutover.pending`), 'Resolve pending CRM contract cutover first');
const blocked = readMarker('backend-rollback-blocked.pending');
assert(!blocked || blocked === sha, 'Repeat the exact target SHA to recover a blocked rollback');

function execute(label, command, commandArgs, options = {}) {
  try {
    return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000, maxBuffer: 8 * 1024 * 1024, ...options }).trim();
  } catch (error) {
    const failure = new Error(`${label} failed; private command output suppressed`);
    failure.status = error.status; throw failure;
  }
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function readMarker(name) { return fs.existsSync(`${releases}/${name}`) ? fs.readFileSync(`${releases}/${name}`, 'utf8').trim() : ''; }
function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function writeJson(file, value) { atomic(file, `${JSON.stringify(value, null, 2)}\n`); }
function envHash(directory) {
  return execute('Environment hash', 'bash', ['-c',
    'cd "$1"; find . -maxdepth 1 -type f -name "*.env" -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1', '_', directory]);
}
function validateEnv(directory) {
  const directoryStat = fs.lstatSync(directory);
  assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && fs.realpathSync(directory) === directory,
    'Environment directory must have its canonical regular path');
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.env'))) {
    const stat = fs.lstatSync(`${directory}/${file}`);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600,
      'Environment files must be private regular files with mode 0600');
  }
}
function closureGate(directory) {
  const values = ['crm-access-api', 'crm-access-worker', 'crm-access-outbox-publisher'].map(runtime =>
    parseEnv(fs.readFileSync(`${directory}/${runtime}.env`, 'utf8')).CRM_ACCESS_CLOSURE_ENABLED);
  assert(values.every(value => value === 'true') || values.every(value => value === 'false'),
    'CRM Access closure gate must be explicit and uniform');
  return values[0] === 'true';
}
function composeHash(directory) {
  return digest(Buffer.concat(['backend.yml', 'rabbitmq.conf'].map(name =>
    Buffer.concat([Buffer.from(`${name}\0`), fs.readFileSync(`${directory}/${name}`)]))));
}
function configDirectory(state) { return `${releases}/backend-configs/${stateKey(state)}`; }
function snapshot(state, sourceCompose, sourceEnv) {
  const destination = configDirectory(state);
  if (!fs.existsSync(destination)) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    fs.mkdirSync(`${temporary}/compose`, { recursive: true, mode: 0o700 });
    fs.mkdirSync(`${temporary}/env/backend`, { recursive: true, mode: 0o700 });
    for (const name of ['backend.yml', 'rabbitmq.conf']) fs.copyFileSync(`${sourceCompose}/${name}`, `${temporary}/compose/${name}`);
    for (const name of fs.readdirSync(sourceEnv).filter(name => name.endsWith('.env'))) {
      fs.copyFileSync(`${sourceEnv}/${name}`, `${temporary}/env/backend/${name}`);
      fs.chmodSync(`${temporary}/env/backend/${name}`, 0o600);
    }
    // The private provenance signing key remains in its stable, access-controlled host path.
    fs.symlinkSync(`${root}/secrets`, `${temporary}/secrets`);
    writeJson(`${temporary}/manifest.json`, state.manifest);
    fs.renameSync(temporary, destination);
  }
  validateSnapshot(state);
  return destination;
}
function validateSnapshot(state) {
  const directory = configDirectory(state);
  assert.equal(composeHash(`${directory}/compose`), state.composeHash, 'Snapshot compose hash mismatch');
  validateEnv(`${directory}/env/backend`);
  assert.equal(envHash(`${directory}/env/backend`), state.envHash, 'Snapshot env hash mismatch');
  assert.equal(closureGate(`${directory}/env/backend`), state.closure.enabled);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${directory}/manifest.json`, 'utf8')), state.manifest);
}
function compose(state, commandArgs) {
  validateSnapshot(state);
  return execute('Reviewed backend compose', 'docker', ['compose', '--project-name', 'aerocrm-backend', '--env-file', `${releases}/backend-images.env`, '-f', `${root}/compose/backend.yml`, ...commandArgs],
    { env: { ...process.env, COMPOSE_PROFILES: '', IMAGE_SHA: state.manifest.releaseSha, ...imageVariables(state.manifest) } });
}
function inspectImages(candidate) {
  for (const app of apps) {
    const entry = candidate.services[app];
    const image = `aerocrm/${app}:${entry.sourceSha}`;
    const object = JSON.parse(execute(`${app} image verification`, 'docker', ['image', 'inspect', image]))[0];
    assert.equal(object.Id, entry.imageId, `Immutable image mismatch: ${app}`);
    assert.equal(object.Config.Labels?.['org.opencontainers.image.revision'], entry.sourceSha,
      `Image revision mismatch: ${app}`);
  }
}
function runtime() {
  const ids = execute('Backend runtime inventory', 'docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=aerocrm-backend']).split('\n').filter(Boolean);
  assert(ids.length > 0, 'No baseline backend runtime');
  return JSON.parse(execute('Backend runtime verification', 'docker', ['inspect', ...ids]))
    .filter(c => !['postgres', 'rabbitmq'].includes(c.Config.Labels?.['com.docker.compose.service']))
    .map(c => ({ role: c.Config.Labels?.['com.docker.compose.service'], id: c.Id, imageId: c.Image,
      image: c.Config.Image, revision: c.Config.Env.find(value => value.startsWith('APP_REVISION='))?.slice(13), running: c.State.Running,
      inspection: c,
      closureGate: c.Config.Env.find(value => value.startsWith('CRM_ACCESS_CLOSURE_ENABLED='))?.split('=')[1] }));
}
const effectivePlans = new Map();
const imageConfigs = new Map();
function expectedEffectivePlan(state) {
  const key = stateKey(state);
  if (effectivePlans.has(key)) return effectivePlans.get(key);
  const directory = configDirectory(state);
  const expectedFile = `${directory}/compose/effective-check.yml`;
  // Resolve private snapshot env files while preserving stable live bind sources.
  const template = fs.readFileSync(`${directory}/compose/backend.yml`, 'utf8')
    .replaceAll('./rabbitmq.conf:', `${root}/compose/rabbitmq.conf:`)
    .replaceAll('../secrets/', `${root}/secrets/`);
  atomic(expectedFile, template);
  const plan = JSON.parse(execute('Expected backend effective configuration', 'docker', ['compose', '--project-name', 'aerocrm-backend',
    '-f', expectedFile, 'config', '--format', 'json'],
    { env: { ...process.env, COMPOSE_PROFILES: '', IMAGE_SHA: state.manifest.releaseSha, ...imageVariables(state.manifest) } }));
  const allowedRoles = [...Object.values(roles).flat(), 'postgres', 'rabbitmq', 'operations-restore-worker'];
  assert(Object.keys(plan.services).every(role => allowedRoles.includes(role)), 'Unexpected role in reviewed backend Compose');
  const plannedRoles = rolesForPlan(plan.services);
  for (const app of apps) {
    const entry = state.manifest.services[app];
    if (!imageConfigs.has(entry.imageId)) imageConfigs.set(entry.imageId,
      JSON.parse(execute(`${app} effective image defaults`, 'docker', ['image', 'inspect', entry.imageId]))[0].Config);
    for (const role of plannedRoles[app]) {
      const service = plan.services[role];
      assert(service, `Missing reviewed Compose role: ${role}`);
      assert.equal(service.image, `aerocrm/${app}:${entry.sourceSha}`, `Unexpected planned image: ${role}`);
      assert.equal(service.environment?.APP_REVISION, entry.sourceSha, `Unexpected planned revision: ${role}`);
    }
  }
  if (plan.services['operations-restore-worker'])
    assert.deepEqual(plan.services['operations-restore-worker'].profiles, ['restore'], 'Restore must remain profile-only');
  effectivePlans.set(key, plan.services);
  return plan.services;
}
function verifyRuntime(state, alternate = null, allowStopped = false) {
  const current = runtime();
  const expected = expectedEffectivePlan(state);
  const alternative = alternate ? expectedEffectivePlan(alternate) : null;
  assertRuntime(state.manifest, current, alternate?.manifest, allowStopped, rolesForPlan(expected),
    alternative ? rolesForPlan(alternative) : null);
  for (const container of current) {
    try { assertEffectiveConfig(expected[container.role], imageConfigs.get(container.imageId), container.inspection, container.role); }
    catch (error) {
      if (!alternative) throw error;
      assertEffectiveConfig(alternative[container.role], imageConfigs.get(container.imageId), container.inspection, container.role);
    }
  }
  for (const container of current.filter(c => roles['crm-access'].includes(c.role)))
    assert.equal(container.closureGate, String(state.closure.enabled), `Closure runtime gate mismatch: ${container.role}`);
  return current;
}
function readiness(state, includeClosure = false) {
  for (const port of portsForPlan(expectedEffectivePlan(state))) execute(`Readiness ${port}`, 'curl', ['--fail', '--silent', '--show-error', '--retry', '20',
    '--retry-delay', '3', '--retry-connrefused', '--connect-timeout', '2', '--max-time', '5', '--retry-max-time', '90',
    `http://127.0.0.1:${port}/health/ready`]);
  if (state.closure.enabled || includeClosure) {
    const access = execute('Closure access capability', 'curl', ['--silent', '--show-error', '--connect-timeout', '2',
      '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:5300/api/v1/crm/access/workspace-closures']);
    assert(['401', '403'].includes(access), 'Closure access capability unavailable');
    for (const port of [4900, 4800, 5320, 5330, 5310, 4401]) {
      const status = execute(`Closure fence capability ${port}`, 'curl', ['--silent', '--show-error', '--connect-timeout', '2',
        '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-H', 'Content-Type: application/json',
        '-H', 'x-aerocrm-service: crm-access', '--data', '{}', `http://127.0.0.1:${port}/internal/v1/workspace-closures/fence`]);
      assert(['401', '403'].includes(status), `Closure fence capability unavailable: ${port}`);
    }
  }
}
function projections(state) {
  atomic(`${releases}/backend.sha`, `${state.manifest.releaseSha}\n`);
  if (state.closure.schemaAnchorSha) atomic(`${releases}/workspace-closure-compatible.sha`, `${state.closure.schemaAnchorSha}\n`);
  if (state.closure.enabled) atomic(`${releases}/workspace-closure-enabled.sha`, `${state.manifest.releaseSha}\n`);
  else fs.rmSync(`${releases}/workspace-closure-enabled.sha`, { force: true });
}
function applyConfiguration(state) {
  validateSnapshot(state);
  // Apply under the shared lock; stable host paths prevent unnecessary bind-mount changes.
  const source = `${configDirectory(state)}/env/backend`;
  fs.mkdirSync(`${root}/env/backend`, { recursive: true, mode: 0o700 });
  const expected = fs.readdirSync(source);
  for (const name of expected) atomic(`${root}/env/backend/${name}`, fs.readFileSync(`${source}/${name}`));
  for (const name of fs.readdirSync(`${root}/env/backend`).filter(name => name.endsWith('.env')))
    if (!expected.includes(name)) fs.rmSync(`${root}/env/backend/${name}`);
  for (const name of ['backend.yml', 'rabbitmq.conf']) atomic(`${root}/compose/${name}`, fs.readFileSync(`${configDirectory(state)}/compose/${name}`));
  // Persist per-service substitutions for legacy docker-compose invocations after adoption.
  atomic(`${releases}/backend-images.env`, Object.entries({ IMAGE_SHA: state.manifest.releaseSha, ...imageVariables(state.manifest) })
    .map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}
function compatibility(state) {
  const modes = state.closure.enabled ? ['--closure-enabled'] : [];
  const check = stopped => execute('Persisted backend contract compatibility', process.execPath,
    [`${stagedRoot}/scripts/backend-rollback-compatibility-guard.mjs`, `${configDirectory(state)}/manifest.json`,
      '--manifest', ...(stopped ? ['--writers-stopped'] : []), ...modes], { cwd: root });
  try { check(false); return; } catch (error) { if (error.status !== 2) throw error; }
  const writers = runtime().filter(c => c.running).map(c => c.id);
  try {
    if (writers.length) execute('Stop backend writers for compatibility', 'docker', ['stop', '-t', '30', ...writers]);
    check(true);
  } catch (error) {
    // A schema hook or partial switch may have invalidated the original writers.
    // Only the transaction's complete rollback compatibility check may authorize restarting them.
    error.requiresRollback = true;
    throw error;
  }
}
function runMigrations() {
  const hooks = [['billing-capacity-migration.mjs', billing, billingHash],
    ['crm-custom-roles-migration.mjs', custom, customHash], ['crm-sales-commerce-migration.mjs', commerce, commerceHash],
    ['crm-intake-notifications-migration.mjs', intake, intakeHash], ['workspace-closure-migration.mjs', closureMigration, closureHash], ['crm-corporate-mail-migration.mjs', mail, mailHash],
    ['crm-file-imports-migration.mjs', fileImports, fileImportsHash],
    ['crm-planner-customization-migration.mjs', planner, plannerHash],
    ['crm-ux-unification-migration.mjs', ux, uxHash]];
  for (const [name, enabled, hash] of hooks) if (enabled === 'true')
    execute(`Reviewed ${name}`, process.execPath, [`${stagedRoot}/scripts/${name}`, sha, hash], { cwd: root });
  if (aclRepair === 'true') execute('Reviewed identity closure ACL repair', process.execPath,
    [`${stagedRoot}/scripts/workspace-closure-migration.mjs`, '--repair-identity-workspace-acl', sha, aclHash], { cwd: root });
}
function bootstrap() {
  assert(uniformManifest(manifest), 'First canonical release requires force_full_backend CI');
  const oldSha = readMarker('backend.sha');
  assert(/^[a-f0-9]{40}$/.test(oldSha), 'Coherent legacy backend marker required');
  const enabledSha = readMarker('workspace-closure-enabled.sha');
  const anchor = readMarker('workspace-closure-compatible.sha') || null;
  assert(!enabledSha || enabledSha === oldSha, 'Legacy closure markers disagree; fail closed');
  assert(!anchor || /^[a-f0-9]{40}$/.test(anchor));
  assert(!enabledSha || anchor, 'Enabled closure requires its schema anchor');
  const legacyGate = closureGate(`${root}/env/backend`);
  assert.equal(legacyGate, !!enabledSha, 'Legacy initial closure enable must finish before canonical adoption');
  const services = {};
  for (const app of apps) {
    const object = JSON.parse(execute(`${app} baseline image`, 'docker', ['image', 'inspect', `aerocrm/${app}:${oldSha}`]))[0];
    assert.equal(object.Config.Labels?.['org.opencontainers.image.revision'], oldSha);
    services[app] = { sourceSha: oldSha, contextHash: zeroHash, imageId: object.Id, artifactSha256: zeroHash,
      ciRunId: '0', artifactName: `image-${app}` };
  }
  const baseline = validateState({ schemaVersion: 1, manifest: { schemaVersion: 1, releaseSha: oldSha, ciRunId: '0', services },
    // Legacy markers did not record infra provenance; this identifies the reviewed adopter, not a CI image origin.
    infraSha: process.env.INFRA_SHA, envHash: envHash(`${root}/env/backend`), composeHash: composeHash(`${root}/compose`),
    closure: { enabled: legacyGate, schemaAnchorSha: anchor } });
  snapshot(baseline, `${root}/compose`, `${root}/env/backend`); verifyRuntime(baseline); readiness(baseline);
  return baseline;
}

inspectImages(manifest);
const canonical = fs.existsSync(stateFile) ? validateState(JSON.parse(fs.readFileSync(stateFile, 'utf8'))) : null;
const pending = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')) : null;
if (pending) {
  validatePending(pending, canonical);
  assert.equal(pending.target.manifest.releaseSha, sha, 'Pending release requires the exact original target SHA');
}
if (!pending) {
  validateEnv(`${root}/env/backend`);
  const liveHash = envHash(`${root}/env/backend`);
  assert(mailEnvInstall === 'true' ? liveHash === mailEnvBeforeHash ||
    (canonical?.manifest.releaseSha === sha && liveHash === expectedEnvHash && canonical.envHash === expectedEnvHash) :
    liveHash === expectedEnvHash, 'Active backend env hash mismatch');
}
const previous = pending?.previous ?? canonical ?? bootstrap();
validateSnapshot(previous);
assert.equal(pending ? pending.target.closure.enabled : closureGate(`${root}/env/backend`), previous.closure.enabled,
  'Historical initial closure enable/disable must finish before adoption; canonical releases preserve the gate');
const target = validateState({ schemaVersion: 1, manifest, infraSha: process.env.INFRA_SHA,
  envHash: expectedEnvHash, composeHash: composeHash(`${stagedRoot}/compose`),
  closure: { enabled: previous.closure.enabled,
    schemaAnchorSha: closureMigration === 'true' ? sha : previous.closure.schemaAnchorSha } });
assert(closureMigration !== 'true' || !target.closure.enabled, 'Closure schema migration requires gate OFF');
assert(aclRepair !== 'true' || target.closure.enabled, 'Identity ACL repair requires closure gate ON');
if (mailEnvInstall === 'true') {
  // Build the candidate from the immutable previous snapshot, never from a
  // potentially half-applied live directory during pending recovery.
  let sourceState = previous;
  if (!pending && mailEnvBeforeHash !== expectedEnvHash && canonical?.envHash === expectedEnvHash && canonical.manifest.releaseSha === sha) {
    assert(fs.existsSync(previousFile), 'Committed Customers env retry requires its previous snapshot');
    sourceState = validateState(JSON.parse(fs.readFileSync(previousFile, 'utf8')));
  }
  validateSnapshot(sourceState);
  assert.equal(sourceState.envHash, mailEnvBeforeHash, 'Reviewed Customers before env hash mismatch');
  const candidate = `${stagedRoot}/mail-env-candidate-${randomUUID()}`;
  try {
    stageMailEnvironment({ bundleFile: `${stagedRoot}/crm-customers-mail-env.json`,
      bundleHash: mailEnvBundleHash, sourceDirectory: `${configDirectory(sourceState)}/env/backend`,
      candidateDirectory: candidate });
    validateEnv(candidate);
    assert.equal(envHash(candidate), expectedEnvHash, 'Reviewed Customers after env hash mismatch');
    snapshot(target, `${stagedRoot}/compose`, candidate);
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
} else snapshot(target, `${stagedRoot}/compose`, `${root}/env/backend`);
rolesForPlan(expectedEffectivePlan(target), true);
if (pending) assert.deepEqual(pending.target, target, 'Pending target config or provenance differs; fail closed');
if (canonical && stateKey(canonical) === stateKey(target)) {
  const retained = verifyRuntime(target); readiness(target, closureMigration === 'true');
  applyConfiguration(target); projections(target); fs.rmSync(pendingFile, { force: true });
  fs.rmSync(`${releases}/backend-rollback-blocked.pending`, { force: true });
  const unchanged = retained.map(({ role, id }) => ({ role, id }));
  console.log(JSON.stringify({ releaseSha: sha, changedApps: [], noSwitch: true, before: unchanged, after: unchanged,
    retainedContainerIds: retained.map(container => container.role) }));
  process.exit(0);
}
const before = verifyRuntime(previous, pending ? target : null, !!pending);
console.log(JSON.stringify({ releaseSha: sha, changedApps: compositionDiff(previous.manifest, manifest),
  configurationChanged: previous.envHash !== target.envHash || previous.composeHash !== target.composeHash,
  before: before.map(({ role, id }) => ({ role, id })) }));
// The journal is durable before hooks can stop writers or mutate the schema.
writeJson(previousFile, previous);
writeJson(pendingFile, { schemaVersion: 1, target, previous, phase: 'switching' });
let after;
const outcome = runReleaseTransaction({
  migrate: runMigrations,
  compatibility: () => compatibility(target),
  applyConfiguration: () => applyConfiguration(target),
  switchImages: () => {
    if (digest(fs.readFileSync(`${configDirectory(previous)}/compose/rabbitmq.conf`)) !==
        digest(fs.readFileSync(`${configDirectory(target)}/compose/rabbitmq.conf`)))
      compose(target, ['up', '-d', '--no-deps', '--force-recreate', 'rabbitmq']);
    compose(target, ['up', '-d', '--remove-orphans']);
  },
  validateTarget: () => {
    inspectImages(manifest); after = verifyRuntime(target); readiness(target, closureMigration === 'true');
  },
  commit: () => writeJson(stateFile, target),
  project: () => { applyConfiguration(target); projections(target); },
  clearPending: () => {
    fs.rmSync(pendingFile, { force: true });
    fs.rmSync(`${releases}/backend-rollback-blocked.pending`, { force: true });
  },
  report: error => console.error(error.message),
  isCommitted: () => fs.existsSync(stateFile) &&
    stateKey(validateState(JSON.parse(fs.readFileSync(stateFile, 'utf8')))) === stateKey(target),
  validatePrevious: () => verifyRuntime(previous),
  rollback: () => {
    inspectImages(previous.manifest); compatibility(previous);
    applyConfiguration(previous);
    if (digest(fs.readFileSync(`${configDirectory(previous)}/compose/rabbitmq.conf`)) !==
        digest(fs.readFileSync(`${configDirectory(target)}/compose/rabbitmq.conf`)))
      compose(previous, ['up', '-d', '--no-deps', '--force-recreate', 'rabbitmq']);
    compose(previous, ['up', '-d', '--remove-orphans']); verifyRuntime(previous); readiness(previous);
    writeJson(stateFile, previous); projections(previous);
    console.error('Previous complete backend composition and configuration restored; database changes preserved');
  },
  blockRollback: error => {
    atomic(`${releases}/backend-rollback-blocked.pending`, `${sha}\n`);
    console.error(`Automatic rollback blocked: ${error.message}. Repeat the exact target workflow; keep compatible writers.`);
  }
}, { migrationRequested });
if (outcome.status !== 'committed') {
  if (outcome.status === 'projection-repair-required')
    console.error('Canonical release committed; repeat exact target to repair its projections');
  process.exit(1);
}
console.log(JSON.stringify({ releaseSha: sha, after: after.map(({ role, id }) => ({ role, id })),
  retainedContainerIds: before.filter(c => after.some(next => next.role === c.role && next.id === c.id)).map(c => c.role) }));
