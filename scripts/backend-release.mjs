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
import { stageChatEnvironment, validateChatBundle } from './backend-chat-env.mjs';
import { stageRuntimeStorageEnvironment, validateRuntimeStorageBundle, privateBytes, storageOwners, storageReferenceHash, validateFrozenAvatarReferences } from './backend-runtime-storage-env.mjs';
import { createRequire } from 'node:module';
const { validateManifest: validateStorageManifest } = createRequire(import.meta.url)('./runtime-storage-copy.cjs');
import { atomic, publishRabbitmqConfig, recoverRabbitmqConfig, validateRabbitmqContainer } from './backend-rabbitmq-config.mjs';

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
  fileImports = 'false', fileImportsHash = '', planner = 'false', plannerHash = '', ux = 'false', uxHash = '', collaboration = 'false', collaborationHash = '', meeting3 = 'false', meeting3Hash = ''] = args;
assert.equal(role, 'backend'); assert(/^[a-f0-9]{40}$/.test(sha));
assert(/^[a-f0-9]{64}$/.test(expectedEnvHash));
assert(/^[a-f0-9]{40}$/.test(process.env.INFRA_SHA ?? ''));
assert(/^[0-9]+$/.test(process.env.CI_RUN_ID ?? ''));
assert(args.length >= 3 && args.length <= 27, 'Invalid backend release argument count');
const flagPairs = [[billing, billingHash], [custom, customHash], [commerce, commerceHash],
  [intake, intakeHash], [closureMigration, closureHash], [aclRepair, aclHash], [mail, mailHash], [fileImports, fileImportsHash], [planner, plannerHash], [ux, uxHash], [collaboration, collaborationHash], [meeting3, meeting3Hash]];
for (const [enabled, hash] of flagPairs) {
  assert(['true', 'false'].includes(enabled), 'Invalid migration flag');
  assert(enabled === 'true' ? /^[a-f0-9]{64}$/.test(hash) : hash === '', 'Invalid migration env hash');
}
assert.equal(billing, custom, 'Billing and custom-role hooks must be paired');
if (meeting3 === 'true') assert([billing, custom, commerce, intake, closureMigration, aclRepair, mail, fileImports, planner, ux, collaboration].every(value => value === 'false'), 'Meeting 3 cannot combine migration hooks');
if (planner === 'true')
  assert([billing, custom, commerce, intake, closureMigration, aclRepair, mail, fileImports, ux, collaboration].every(value => value === 'false'),
    'CRM planner customization cannot combine migration hooks');
if (ux === 'true')
  assert([billing, custom, commerce, intake, closureMigration, aclRepair, mail, fileImports, planner, collaboration].every(value => value === 'false'),
    'CRM UX unification cannot combine migration hooks');
if (collaboration === 'true')
  assert([billing, custom, commerce, intake, closureMigration, aclRepair, mail, fileImports, planner, ux].every(value => value === 'false'),
    'Workspace collaboration cannot combine migration hooks');
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
const flags = [billing, custom, commerce, intake, closureMigration, aclRepair, mail, fileImports, planner, ux, collaboration, meeting3];
assert(flags.every(value => ['true', 'false'].includes(value)));
const migrationRequested = flags.includes('true');
const mailEnvInstall = process.env.CRM_MAIL_ENV_INSTALL ?? 'false';
const mailEnvBeforeHash = process.env.CRM_MAIL_ENV_BEFORE_HASH ?? '';
const mailEnvBundleHash = process.env.CRM_MAIL_ENV_BUNDLE_HASH ?? '';
assert(['true', 'false'].includes(mailEnvInstall), 'Invalid Customers env installation flag');
assert(mailEnvInstall === 'true' ? /^[a-f0-9]{64}$/.test(mailEnvBeforeHash) &&
  /^[a-f0-9]{64}$/.test(mailEnvBundleHash) : !mailEnvBeforeHash && !mailEnvBundleHash,
  'Invalid reviewed Customers env hashes');
assert(mailEnvInstall !== 'true' || [billing, custom, commerce, intake, closureMigration, aclRepair, fileImports, planner, ux, collaboration, meeting3].every(value => value === 'false'),
  'Customers env installation cannot combine unrelated migration hooks');
const chatEnvInstall = process.env.CRM_CHAT_ENV_INSTALL ?? 'false';
const chatEnvBeforeHash = process.env.CRM_CHAT_ENV_BEFORE_HASH ?? '';
const chatEnvBundleHash = process.env.CRM_CHAT_ENV_BUNDLE_HASH ?? '';
assert(['true', 'false'].includes(chatEnvInstall), 'Invalid Chat env installation flag');
assert(chatEnvInstall === 'true' ? /^[a-f0-9]{64}$/.test(chatEnvBeforeHash) && /^[a-f0-9]{64}$/.test(chatEnvBundleHash)
  : !chatEnvBeforeHash && !chatEnvBundleHash, 'Invalid reviewed Chat env hashes');
assert(chatEnvInstall !== 'true' || (meeting3 === 'true' && mailEnvInstall === 'false'),
  'Chat installation requires the isolated meeting 3 release');
const storageInstall = process.env.CRM_RUNTIME_STORAGE_INSTALL === 'true';
assert(['true', 'false'].includes(process.env.CRM_RUNTIME_STORAGE_INSTALL ?? 'false'), 'Invalid runtime storage installation flag');
const storageBeforeHash = process.env.CRM_RUNTIME_STORAGE_BEFORE_HASH ?? '';
const storageBundleHash = process.env.CRM_RUNTIME_STORAGE_BUNDLE_HASH ?? '';
const storageManifestHash = process.env.CRM_RUNTIME_STORAGE_MANIFEST_HASH ?? '';
assert(storageInstall ? [storageBeforeHash, storageBundleHash, storageManifestHash].every(hash => /^[a-f0-9]{64}$/.test(hash)) :
  !storageBeforeHash && !storageBundleHash && !storageManifestHash, 'Invalid reviewed storage hashes');
assert(!storageInstall || (meeting3 === 'true' && mailEnvInstall === 'false' && chatEnvInstall === 'false' && uniformManifest(manifest)),
  'Runtime storage requires the isolated full-manifest meeting 3 controller');
const storageMarker = `${releases}/runtime-storage-forward.json`;
const storageBundleFile = `${stagedRoot}/runtime-storage-env.json`;
const storageManifestFile = `${stagedRoot}/storage-manifest.json`;
const envInstall = mailEnvInstall === 'true' || chatEnvInstall === 'true' || storageInstall;
const envBeforeHash = storageInstall ? storageBeforeHash : chatEnvInstall === 'true' ? chatEnvBeforeHash : mailEnvBeforeHash;
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
function rabbitmqContainers() {
  const ids = execute('RabbitMQ runtime inventory', 'docker', ['ps', '-aq',
    '--filter', 'label=com.docker.compose.project=aerocrm-backend',
    '--filter', 'label=com.docker.compose.service=rabbitmq']).split('\n').filter(Boolean);
  assert.equal(ids.length, 1, 'Expected one existing RabbitMQ container');
  return JSON.parse(execute('RabbitMQ runtime inspection', 'docker', ['inspect', ...ids]));
}
function waitForRabbitmqHealth(id) {
  const deadline = Date.now() + 180_000;
  do {
    const containers = rabbitmqContainers();
    assert.equal(validateRabbitmqContainer(containers, `${root}/compose/rabbitmq.conf`), id,
      'RabbitMQ container changed during automatic recovery');
    if (containers[0].State.Health?.Status === 'healthy') return;
    if (Date.now() >= deadline) break;
    execute('RabbitMQ health wait', 'sleep', ['2']);
  } while (true);
  throw new Error('RabbitMQ did not regain Docker health within 180 seconds');
}
function recoverRabbitmq(previous, target = null) {
  const approvedFiles = [previous, target].filter(Boolean).map(state => `${configDirectory(state)}/compose/rabbitmq.conf`);
  const repaired = recoverRabbitmqConfig({ liveFile: `${root}/compose/rabbitmq.conf`, approvedFiles,
    inspect: rabbitmqContainers, waitForHealth: waitForRabbitmqHealth });
  if (repaired) console.log('Verified RabbitMQ config permissions repaired on the existing bind source');
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
  if (fs.existsSync(storageMarker)) {
    const marker = JSON.parse(privateBytes(storageMarker));
    assert.equal(marker.targetBucket, 'content-files');
    assert.deepEqual(marker.provider, { endpoint: 'https://s3.twcstorage.ru', region: 'ru-1', forcePathStyle: true },
      'Forward storage marker provider tuple differs from the reviewed contract');
    for (const [owner, names] of Object.entries(storageOwners)) for (const name of names) {
      const values = parseEnv(privateBytes(`${source}/${name}`).toString('utf8'));
      assert.equal(values[`${owner}_S3_BUCKET`], 'content-files', 'Old runtime storage configuration restore is forbidden');
      for (const [field, expected] of Object.entries({ ENDPOINT: marker.provider.endpoint, REGION: marker.provider.region, FORCE_PATH_STYLE: String(marker.provider.forcePathStyle) }))
        assert.equal(values[`${owner}_S3_${field}`], expected, 'Forward storage provider tuple differs from its sealed capability');
      assert.equal(digest(`${values[`${owner}_S3_ACCESS_KEY_ID`]}\0${values[`${owner}_S3_SECRET_ACCESS_KEY`]}`), marker.principals[owner],
        'Forward storage principal differs from its sealed capability');
    }
  }
  fs.mkdirSync(`${root}/env/backend`, { recursive: true, mode: 0o700 });
  const expected = fs.readdirSync(source);
  for (const name of expected) atomic(`${root}/env/backend/${name}`, fs.readFileSync(`${source}/${name}`));
  for (const name of fs.readdirSync(`${root}/env/backend`).filter(name => name.endsWith('.env')))
    if (!expected.includes(name)) fs.rmSync(`${root}/env/backend/${name}`);
  atomic(`${root}/compose/backend.yml`, fs.readFileSync(`${configDirectory(state)}/compose/backend.yml`));
  publishRabbitmqConfig(`${root}/compose/rabbitmq.conf`, fs.readFileSync(`${configDirectory(state)}/compose/rabbitmq.conf`));
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
function storageDatabase(service, sql) {
  const schema = service.replace('-', '_');
  // Support has no migration env; its immutable runtime binding already grants own-table SELECT.
  const runtimeInspection = service === 'support';
  const file = runtimeInspection ? `${configDirectory(previous)}/env/backend/support-api.env` : `${root}/env/migrations/${service}.env`;
  const values = parseEnv(privateBytes(file).toString('utf8'));
  let url;
  try { url = new URL(values[`${schema.toUpperCase()}_DATABASE_URL`]); } catch { throw new Error('Invalid private storage inspection binding'); }
  const principal = `aerocrm_${schema}_${runtimeInspection ? 'runtime' : 'migration'}`;
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1');
  assert(!url.port || url.port === '5432'); assert.equal(url.pathname, `/aerocrm_${schema}`);
  assert.equal(decodeURIComponent(url.username), principal); assert(url.password && !url.hash && url.searchParams.getAll('schema').length === 1 && url.searchParams.get('schema') === schema);
  return JSON.parse(execute('Frozen owner storage reference inspection', 'docker', ['run', '--rm', '--network', 'host',
    '--env', 'PGPASSWORD', '--entrypoint', 'psql', 'postgres:18', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', '5432', '-U', principal, '-d', `aerocrm_${schema}`, '-c', `BEGIN READ ONLY; SET LOCAL TIME ZONE 'UTC'; ${sql} COMMIT;`],
    { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) } }));
}
function verifyStorageReferences(objects) {
  const mail = storageDatabase('crm-customers', `SELECT COALESCE(json_agg(row),'[]'::json)::text FROM (
    SELECT json_build_array('mail','attachment',private_object_key,state,sha256,byte_size,
      CASE WHEN expires_at IS NULL THEN NULL ELSE to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) AS row
      FROM crm_customers.mail_attachments
    UNION ALL SELECT json_build_array('mail','mime',mime_object_key,state,mime_hash,NULL,NULL)
      FROM crm_customers.mail_send_intents) r;`);
  const support = storageDatabase('support', `SELECT COALESCE(json_agg(json_build_array('support','attachment',storage_key,status::text,
    content_hash,byte_size,CASE WHEN expires_at IS NULL THEN NULL ELSE to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)), '[]'::json)::text FROM support.web_attachments;`);
  const rows = [...mail, ...support];
  assert.equal(storageReferenceHash(rows), objects.referencesHash, 'Frozen storage reference snapshot changed since approval');
  const allowed = { 'mail/attachment': ['DEFERRED','UNAVAILABLE','VALIDATED'], 'mail/mime': ['ACCEPTED'], 'support/attachment': ['ATTACHED','DELETED'] };
  assert(rows.length === 164 && rows.every(([owner, kind, key, state]) => allowed[`${owner}/${kind}`]?.includes(state) &&
    (owner === 'mail' && kind === 'attachment' && state !== 'VALIDATED' ? key === null : !!key)),
    'Reviewed bounded storage reference states changed');
  const required = rows.filter(([owner, , , state]) => owner === 'mail' ? ['VALIDATED','ACCEPTED'].includes(state) : state === 'ATTACHED');
  assert.equal(required.length, 7); assert.equal(new Set(required.map(row => row[2])).size, 7);
  assert.equal(required.filter(row => row[0] === 'mail' && row[1] === 'attachment').length, 2);
  assert.equal(required.filter(row => row[0] === 'mail' && row[1] === 'mime').length, 4);
  assert.equal(required.filter(row => row[0] === 'support').length, 1);
  for (const [owner, kind, key, , sha256, size] of required) {
    const item = objects.objects.find(item => item.owner === owner && item.key === key);
    assert(item && item.sha256 === sha256 && (kind === 'mime' || item.size === size), 'Required storage reference lacks a verified destination object');
  }
  assert(objects.objects.every(item => required.some(row => row[0] === item.owner && row[2] === item.key)),
    'Reviewed transfer contains an unexpected object');
  const mailDrain = storageDatabase('crm-customers', `SELECT json_build_object('jobsDrained',NOT EXISTS(
    SELECT 1 FROM crm_customers.mail_jobs WHERE state='RUNNING' OR lease_owner IS NOT NULL OR lease_until IS NOT NULL),
    'intentsDrained',NOT EXISTS(SELECT 1 FROM crm_customers.mail_send_intents WHERE state IN ('PREPARING','SENDING')))::text;`);
  const supportDrain = storageDatabase('support', `SELECT json_build_object('drained',NOT EXISTS(
    SELECT 1 FROM support.web_attachments WHERE lease_token IS NOT NULL OR lease_expires_at IS NOT NULL
      OR status::text IN ('PREPARED','TEMPORARY','DELETE_PENDING','DELETING')))::text;`);
  assert([...Object.values(mailDrain), ...Object.values(supportDrain)].every(value => value === true),
    'Runtime storage freeze must contain no active leases or incomplete physical writes');
  const access = storageDatabase('crm-access', `SELECT json_build_object('attachmentsEmpty',NOT EXISTS(SELECT 1 FROM crm_access.crm_chat_attachments),
    'uploadsEmpty',NOT EXISTS(SELECT 1 FROM crm_access.crm_team_command_receipts WHERE command_type='chat.upload'))::text;`);
  assert(Object.values(access).every(value => value === true), 'Legacy Chat history requires a separate reviewed transfer');
  const identity = storageDatabase('identity', `SELECT json_build_object(
    'paths',COALESCE((SELECT json_agg(avatar_path) FROM identity.users WHERE avatar_path IS NOT NULL),'[]'::json),
    'mediaEmpty',NOT EXISTS(SELECT 1 FROM identity.avatar_media_objects))::text;`);
  validateFrozenAvatarReferences(identity);
}
function storageInputs() {
  const values = validateRuntimeStorageBundle(privateBytes(storageBundleFile), storageBundleHash);
  const objects = validateStorageManifest(privateBytes(storageManifestFile), storageManifestHash);
  const tuple = { schemaVersion: 1, releaseSha: sha, infraSha: process.env.INFRA_SHA,
    beforeEnvHash: storageBeforeHash, afterEnvHash: expectedEnvHash, bundleHash: storageBundleHash,
    manifestHash: storageManifestHash, targetBucket: 'content-files', provider: objects.provider,
    principals: Object.fromEntries(Object.keys(storageOwners).map(owner => [owner,
      digest(`${values[`${owner}_S3_ACCESS_KEY_ID`]}\0${values[`${owner}_S3_SECRET_ACCESS_KEY`]}`)])) };
  if (fs.existsSync(storageMarker)) {
    const marker = JSON.parse(privateBytes(storageMarker));
    assert.deepEqual(Object.fromEntries(Object.keys(tuple).map(key => [key, marker[key]])), tuple,
      'Forward-only storage recovery requires the original sealed tuple');
  }
  return { values, objects, tuple };
}
function withStorageSource(action) {
  const source = parseEnv(privateBytes(`${configDirectory(previous)}/env/backend/operations-worker.env`).toString('utf8'));
  const sourceFile = `${stagedRoot}/private-source-storage-${randomUUID()}.json`;
  const values = Object.fromEntries(['ENDPOINT', 'REGION', 'FORCE_PATH_STYLE', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].map(field => [field, source[`CRM_BACKUP_S3_${field}`]]));
  assert.equal(values.ENDPOINT, 'https://s3.twcstorage.ru'); assert.equal(values.REGION, 'ru-1'); assert.equal(values.FORCE_PATH_STYLE, 'true');
  assert(values.ACCESS_KEY_ID && values.SECRET_ACCESS_KEY);
  const runtimeValues = validateRuntimeStorageBundle(privateBytes(storageBundleFile), storageBundleHash);
  assert(Object.keys(storageOwners).every(owner => runtimeValues[`${owner}_S3_ACCESS_KEY_ID`] !== values.ACCESS_KEY_ID),
    'Migration capability must never be a runtime storage principal');
  fs.writeFileSync(sourceFile, JSON.stringify({ endpoint: values.ENDPOINT, region: values.REGION, forcePathStyle: true,
    credentials: { accessKeyId: values.ACCESS_KEY_ID, secretAccessKey: values.SECRET_ACCESS_KEY } }) + '\n', { mode: 0o600, flag: 'wx' });
  try { return action(sourceFile); }
  finally { fs.rmSync(sourceFile, { force: true }); }
}
function storageCopy(mode) {
  return withStorageSource(sourceFile => execute(`Reviewed storage ${mode}`, 'timeout', ['310s', 'docker', 'run', '--rm', '--read-only', '--user', '0:0',
    '--network', 'host', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
    '--env', `STORAGE_MANIFEST_HASH=${storageManifestHash}`, '--env', `STORAGE_COPY_MODE=${mode}`,
    '--mount', `type=bind,src=${storageBundleFile},dst=/reviewed/runtime-storage-env.json,readonly`,
    '--mount', `type=bind,src=${storageManifestFile},dst=/reviewed/storage-manifest.json,readonly`,
    '--mount', `type=bind,src=${sourceFile},dst=/reviewed/source-storage.json,readonly`,
    '--mount', `type=bind,src=${stagedRoot}/scripts/runtime-storage-copy.cjs,dst=/reviewed/runtime-storage-copy.cjs,readonly`,
    '--entrypoint', 'node', `aerocrm/crm-access:${sha}`, '/reviewed/runtime-storage-copy.cjs'], { timeout: 320000 }));
}
function runtimeStorageProbe() {
  return withStorageSource(sourceFile => {
    for (const owner of Object.keys(storageOwners)) execute('Reviewed independent runtime storage scope probe', 'timeout', ['130s',
      'docker', 'run', '--rm', '--read-only', '--user', '0:0', '--network', 'host', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
      '--env', `STORAGE_OWNER=${owner}`, '--mount', `type=bind,src=${storageBundleFile},dst=/reviewed/chat-env.json,readonly`,
      '--mount', `type=bind,src=${sourceFile},dst=/reviewed/source-storage.json,readonly`,
      '--mount', `type=bind,src=${stagedRoot}/scripts/chat-storage-probe.cjs,dst=/reviewed/chat-storage-probe.cjs,readonly`,
      '--entrypoint', 'node', `aerocrm/crm-access:${sha}`, '/reviewed/chat-storage-probe.cjs']);
  });
}
function runStorageCutover() {
  const { objects, tuple } = storageInputs();
  // Mail's worker shutdown can drain a current 30-second operation while Access authorization stays alive.
  const mailWriters = runtime().filter(c => c.running && ['crm-customers-api', 'crm-customers-mail-sync', 'crm-customers-mail-send'].includes(c.role));
  if (mailWriters.length) execute('Drain Mail storage writers', 'docker', ['stop', '-t', '60', ...mailWriters.map(c => c.id)]);
  const otherWriters = runtime().filter(c => c.running && ['identity-api', 'support-api', 'crm-access-api'].includes(c.role));
  if (otherWriters.length) execute('Stop remaining runtime storage writers', 'docker', ['stop', '-t', '60', ...otherWriters.map(c => c.id)]);
  assert(!runtime().some(c => c.running && Object.values(storageOwners).flat().map(name => name.slice(0, -4)).includes(c.role)),
    'Every runtime storage writer and sweeper must be stopped before freeze');
  if (!fs.existsSync(storageMarker)) verifyStorageReferences(objects);
  runtimeStorageProbe();
  if (fs.existsSync(storageMarker)) {
    // The durable capability proves the original frozen references and copy were already verified.
    // New writes made by a partially started target belong to content-files and must not be resealed as source data.
    storageCopy('verify');
  } else {
    storageCopy('copy');
    writeJson(storageMarker, { ...tuple, phase: 'forward-committed', sourceMailCleaned: false });
  }
  console.log('Seven reviewed runtime objects verified; forward-only storage capability committed');
}
function completeStorageCutover() {
  const { tuple } = storageInputs();
  assert(fs.existsSync(storageMarker), 'Forward storage capability missing after release commit');
  const marker = JSON.parse(privateBytes(storageMarker));
  applyConfiguration(target);
  const current = verifyRuntime(target);
  assert(current.filter(c => Object.values(storageOwners).flat().map(name => name.slice(0, -4)).includes(c.role)).every(c => c.running));
  // Revoke stale delete-ready evidence before every fresh proof, including a same-tuple retry.
  writeJson(storageMarker, { ...tuple, phase: 'verify-delete-ready', sourceMailCleaned: marker.sourceMailCleaned, supportDeleteReady: false });
  if (!marker.sourceMailCleaned) {
    storageCopy('cleanup-mail');
    writeJson(storageMarker, { ...tuple, phase: 'mail-cleaned', sourceMailCleaned: true, supportDeleteReady: false });
  }
  // Delete-ready is fresh evidence; a completed/retried Mail cleanup cannot certify the Support source boundary.
  storageCopy('verify-support-boundary');
  writeJson(storageMarker, { ...tuple, phase: 'verified', sourceMailCleaned: true, supportDeleteReady: true });
  console.log(JSON.stringify({ storage: 'content-files', migratedObjects: 7, sourceMailObjectsRemoved: 6,
    backupObjectsPreserved: true, supportSourceDeleted: false, supportDeleteReady: true }));
}
function runMigrations() {
  if (storageInstall) runStorageCutover();
  if (chatEnvInstall === 'true') {
    const bundleFile = `${stagedRoot}/crm-access-chat-env.json`;
    const stat = fs.lstatSync(bundleFile);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid(),
      'Private Chat probe configuration metadata mismatch');
    validateChatBundle(fs.readFileSync(bundleFile), chatEnvBundleHash);
    execute('Reviewed independent Chat storage scope probe', 'timeout', ['130s', 'docker', 'run', '--rm',
      '--read-only', '--user', '0:0', '--network', 'host', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,src=${bundleFile},dst=/reviewed/chat-env.json,readonly`,
      '--mount', `type=bind,src=${stagedRoot}/scripts/chat-storage-probe.cjs,dst=/reviewed/chat-storage-probe.cjs,readonly`,
      '--entrypoint', 'node', `aerocrm/crm-access:${sha}`, '/reviewed/chat-storage-probe.cjs']);
  }
  const hooks = [['billing-capacity-migration.mjs', billing, billingHash],
    ['crm-custom-roles-migration.mjs', custom, customHash], ['crm-sales-commerce-migration.mjs', commerce, commerceHash],
    ['crm-intake-notifications-migration.mjs', intake, intakeHash], ['workspace-closure-migration.mjs', closureMigration, closureHash], ['crm-corporate-mail-migration.mjs', mail, mailHash],
    ['crm-file-imports-migration.mjs', fileImports, fileImportsHash],
    ['crm-planner-customization-migration.mjs', planner, plannerHash],
    ['crm-ux-unification-migration.mjs', ux, uxHash],
    ['workspace-collaboration-migration.mjs', collaboration, collaborationHash], ['meeting3-migration.mjs', meeting3, meeting3Hash]];
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
  assert(envInstall ? liveHash === envBeforeHash ||
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
if (envInstall) {
  // Build the candidate from the immutable previous snapshot, never from a
  // potentially half-applied live directory during pending recovery.
  let sourceState = previous;
  if (!pending && envBeforeHash !== expectedEnvHash && canonical?.envHash === expectedEnvHash && canonical.manifest.releaseSha === sha) {
    assert(fs.existsSync(previousFile), 'Committed Customers env retry requires its previous snapshot');
    sourceState = validateState(JSON.parse(fs.readFileSync(previousFile, 'utf8')));
  }
  validateSnapshot(sourceState);
  assert.equal(sourceState.envHash, envBeforeHash, 'Reviewed Customers before env hash mismatch');
  const candidate = `${stagedRoot}/private-env-candidate-${randomUUID()}`;
  try {
    if (storageInstall) stageRuntimeStorageEnvironment({ bundleFile: storageBundleFile, bundleHash: storageBundleHash,
      sourceDirectory: `${configDirectory(sourceState)}/env/backend`, candidateDirectory: candidate });
    else if (chatEnvInstall === 'true') stageChatEnvironment({ bundleFile: `${stagedRoot}/crm-access-chat-env.json`,
      bundleHash: chatEnvBundleHash, sourceDirectory: `${configDirectory(sourceState)}/env/backend`,
      candidateDirectory: candidate });
    else stageMailEnvironment({ bundleFile: `${stagedRoot}/crm-customers-mail-env.json`,
      bundleHash: mailEnvBundleHash, sourceDirectory: `${configDirectory(sourceState)}/env/backend`,
      candidateDirectory: candidate });
    validateEnv(candidate);
    assert.equal(envHash(candidate), expectedEnvHash, 'Reviewed Customers after env hash mismatch');
    snapshot(target, `${stagedRoot}/compose`, candidate);
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
} else snapshot(target, `${stagedRoot}/compose`, `${root}/env/backend`);
rolesForPlan(expectedEffectivePlan(target), true);
if (pending) assert.deepEqual(pending.target, target, 'Pending target config or provenance differs; fail closed');
recoverRabbitmq(previous, pending ? target : null);
if (canonical && stateKey(canonical) === stateKey(target)) {
  const retained = verifyRuntime(target); readiness(target, closureMigration === 'true');
  applyConfiguration(target); projections(target);
  if (storageInstall) completeStorageCutover();
  fs.rmSync(pendingFile, { force: true });
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
  project: () => { applyConfiguration(target); projections(target); if (storageInstall) completeStorageCutover(); },
  clearPending: () => {
    fs.rmSync(pendingFile, { force: true });
    fs.rmSync(`${releases}/backend-rollback-blocked.pending`, { force: true });
  },
  report: error => console.error(error.message),
  isCommitted: () => fs.existsSync(stateFile) &&
    stateKey(validateState(JSON.parse(fs.readFileSync(stateFile, 'utf8')))) === stateKey(target),
  validatePrevious: () => verifyRuntime(previous),
  forwardOnly: () => storageInstall,
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
