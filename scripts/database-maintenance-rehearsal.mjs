#!/usr/bin/env node
// Fresh signed backups from the reviewed runtime, followed by an isolated PG18 rehearsal.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { apps, assertRuntime, imageVariables, portsForPlan, rolesForPlan, validateState } from './backend-release-state.mjs';

const root = '/opt/aerocrm';
const sha = /^[a-f0-9]{40}$/;
const stagePrefix = `${root}/releases/staging/maintenance-rehearsal-`;
const [mode, stage, infraSha, ciRunId, operationsRevision] = process.argv.slice(2);
const targetNames = apps.filter(name => name !== 'api-gateway').sort();
let interruptionSignal;
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'])
  process.on(signal, () => { interruptionSignal = signal; });
function checkInterrupted() {
  if (interruptionSignal) throw new Error(`Rehearsal interrupted by ${interruptionSignal}`);
}

function command(label, executable, args, options = {}) {
  try {
    return execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000, maxBuffer: 32 * 1024 * 1024, ...options }).trim();
  } catch {
    throw new Error(`${label} failed; private command output suppressed`);
  }
}
function privateFile(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    fs.realpathSync(file) === file, 'Expected private regular file with mode 0600');
  return fs.readFileSync(file, 'utf8');
}
function prepareOwnership(image, source, destination, directory = false) {
  command('Prepare private rehearsal bind', 'docker', ['run', '--rm', '--network', 'none',
    '--user', '0:0', '--entrypoint', '/bin/sh', '--mount', `type=bind,src=${source},dst=${destination}`,
    image, '-eu', '-c', `chown 1001:1001 ${destination}; chmod ${directory ? '0700' : '0600'} ${destination}`]);
}
function canonicalRuntime(manifest) {
  const compose = JSON.parse(command('Backend Compose inventory', 'docker', ['compose',
    '--project-name', 'aerocrm-backend', '--env-file', `${root}/releases/backend-images.env`,
    '-f', `${root}/compose/backend.yml`, 'config', '--format', 'json'], {
    env: { ...process.env, COMPOSE_PROFILES: '', IMAGE_SHA: manifest.releaseSha, ...imageVariables(manifest) }
  }));
  const expectedRoles = rolesForPlan(compose.services);
  const ids = command('Backend container IDs', 'docker', ['ps', '-aq',
    '--filter', 'label=com.docker.compose.project=aerocrm-backend']).split('\n').filter(Boolean);
  assert(ids.length > 0, 'No backend runtime containers');
  const containers = JSON.parse(command('Backend container inventory', 'docker', ['inspect', ...ids]))
    .filter(container => !['postgres', 'rabbitmq'].includes(container.Config.Labels?.['com.docker.compose.service']))
    .map(container => ({ role: container.Config.Labels?.['com.docker.compose.service'], id: container.Id,
      imageId: container.Image, image: container.Config.Image,
      revision: container.Config.Env.find(value => value.startsWith('APP_REVISION='))?.slice(13),
      running: container.State.Running }));
  assertRuntime(manifest, containers, null, true, expectedRoles);
  return { containers, ports: portsForPlan(compose) };
}
function request(name, value) {
  const file = `${stage}/${name}.json`;
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}
function maintenance(requestFile) {
  return JSON.parse(command('Reviewed service maintenance', process.execPath,
    [`${stage}/scripts/database-maintenance-release.mjs`, '--locked', requestFile, infraSha, ciRunId],
    { timeout: 2 * 60 * 60 * 1000 }));
}
function restartWriters(manifest, original, ports) {
  const current = canonicalRuntime(manifest);
  const originalIds = original.map(container => container.id).sort();
  assert.deepEqual(current.containers.map(container => container.id).sort(), originalIds,
    'Reviewed backend containers changed during rehearsal');
  const stopped = current.containers.filter(container => !container.running).map(container => container.id);
  if (stopped.length) command('Restart reviewed writers', 'docker', ['start', ...stopped]);
  assert(canonicalRuntime(manifest).containers.every(container => container.running),
    'Backend writers did not all restart');
  for (const port of ports) command(`Backend readiness ${port}`, 'curl', ['--fail', '--silent',
    '--show-error', '--retry', '20', '--retry-delay', '3', '--retry-connrefused', '--connect-timeout', '2',
    '--max-time', '5', '--retry-max-time', '90', `http://127.0.0.1:${port}/health/ready`], { timeout: 100_000 });
}
function isolatedClone(image, jobsFile, ledgerDir) {
  const name = `aerocrm-maintenance-rehearsal-${path.basename(stage).slice(22)}`;
  assert(/^[a-zA-Z0-9_.-]{1,100}$/.test(name));
  const password = randomBytes(24).toString('hex');
  const adminUrl = `postgresql://aerocrm_cluster_admin:${password}@127.0.0.1:15439/postgres`;
  const source = `${stage}/source`;
  assert(fs.statSync(`${source}/aeroCRM_services/apps/operations/test/integration/database-maintenance-all-targets-postgres18.integration.mjs`).isFile(),
    'Reviewed source rehearsal script is missing');
  assert(fs.statSync(source).mode & 0o004, 'Source bind must be readable by Operations UID');
  command('Start isolated PostgreSQL 18', 'docker', ['run', '--detach', '--rm', '--name', name,
    '--network', 'host', '--env', 'POSTGRES_USER=aerocrm_cluster_admin', '--env', 'POSTGRES_DB=postgres',
    '--env', 'POSTGRES_PASSWORD', 'postgres:18', '-c', 'listen_addresses=127.0.0.1', '-c', 'port=15439'],
  { env: { ...process.env, POSTGRES_PASSWORD: password } });
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      checkInterrupted();
      const ready = spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-p', '15439',
        '-U', 'aerocrm_cluster_admin', '-d', 'postgres'], { stdio: 'ignore' });
      if (ready.status === 0) break;
      if (attempt === 29) throw new Error('Isolated PostgreSQL 18 did not become ready');
      command('Wait for isolated PostgreSQL', 'sleep', ['2']);
    }
    const summary = command('All-target real-S3 restore rehearsal', 'docker', ['run', '--rm', '--network', 'host',
      '--user', '1001:1001', '--entrypoint', 'node', '--env-file', `${root}/env/backend/operations-worker.env`,
      '--env', 'APP_REVISION', '--env', 'DATABASE_MAINTENANCE_TEST_SOURCE=real-s3',
      '--env', 'DATABASE_MAINTENANCE_TEST_ADMIN_URL', '--env', 'DATABASE_MAINTENANCE_TEST_APPS_DIR=/source/aeroCRM_services/apps',
      '--env', 'DATABASE_MAINTENANCE_TEST_JOBS_FILE=/run/restore/jobs.json',
      '--env', 'DATABASE_MAINTENANCE_TEST_LEDGER_DIR=/run/restore/ledger', '--env', 'DATABASE_MAINTENANCE_ACTOR',
      '--mount', `type=bind,src=${source},dst=/source,readonly`,
      '--mount', `type=bind,src=${jobsFile},dst=/run/restore/jobs.json,readonly`,
      '--mount', `type=bind,src=${ledgerDir},dst=/run/restore/ledger`,
      image, '/source/aeroCRM_services/apps/operations/test/integration/database-maintenance-all-targets-postgres18.integration.mjs'],
    { timeout: 4 * 60 * 60 * 1000,
      env: { ...process.env, APP_REVISION: operationsRevision, DATABASE_MAINTENANCE_TEST_ADMIN_URL: adminUrl } });
    checkInterrupted();
    const result = JSON.parse(summary.split('\n').at(-1));
    assert(result.schemaVersion === 1 && result.source === 'real-s3' &&
      result.revision === operationsRevision && Array.isArray(result.targets) && result.targets.length === 12 &&
      result.targets.every(target => target.phase === 'COMMITTED'), 'All-target rehearsal summary differs');
    return result;
  } finally {
    command('Remove isolated PostgreSQL 18', 'docker', ['stop', '-t', '60', name], { timeout: 120_000 });
  }
}

if (mode === '--policy-self-test') {
  assert.equal(targetNames.length, 12);
  assert(targetNames.includes('operations') && targetNames.includes('crm-sales'));
  console.log('Database maintenance rehearsal policy fixtures verified');
  process.exit(0);
}
if (process.platform !== 'linux' || fs.realpathSync('.') !== root) throw new Error('Linux backend host required');
if (mode !== '--locked') {
  assert(mode === '--rehearse' && process.argv.length === 7, 'Expected rehearsal stage and reviewed IDs');
  const child = spawnSync('flock', ['-n', `${root}/release.lock`, process.execPath, process.argv[1],
    '--locked', stage, infraSha, ciRunId, operationsRevision], { stdio: 'inherit', env: process.env });
  process.exit(child.status ?? 1);
}
assert(process.argv.length === 7 && sha.test(infraSha) && /^\d+$/.test(ciRunId) && sha.test(operationsRevision),
  'Invalid reviewed rehearsal IDs');
assert(/^github:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_-]+\/\d+$/.test(process.env.DATABASE_MAINTENANCE_ACTOR ?? ''),
  'Expected audited GitHub actor');
assert(fs.realpathSync(stage).startsWith(stagePrefix) && fs.lstatSync(stage).isDirectory(),
  'Expected private maintenance rehearsal stage');
const state = validateState(JSON.parse(privateFile(`${root}/releases/backend-state.json`)));
assert(state.infraSha === infraSha && state.manifest.ciRunId === ciRunId &&
  state.manifest.services.operations.sourceSha === operationsRevision,
  'Rehearsal IDs differ from canonical deployed backend state');
const image = `aerocrm/operations:${operationsRevision}`;
const imageObject = JSON.parse(command('Operations image inspection', 'docker', ['image', 'inspect', image]))[0];
assert(imageObject.Id === state.manifest.services.operations.imageId &&
  imageObject.Config.Labels?.['org.opencontainers.image.revision'] === operationsRevision,
  'Operations image differs from canonical backend state');
const original = canonicalRuntime(state.manifest);
assert(original.containers.every(container => container.running), 'All backend writers must be running before rehearsal');
if (spawnSync('docker', ['image', 'inspect', 'postgres:18'], { stdio: 'ignore' }).status !== 0)
  command('Pull isolated PostgreSQL 18 image before writer stop', 'docker', ['pull', 'postgres:18'], { timeout: 600_000 });
assert(/^postgres \(PostgreSQL\) 18\./.test(command('Isolated PostgreSQL version', 'docker',
  ['run', '--rm', '--entrypoint', 'postgres', 'postgres:18', '--version'])), 'Isolated image is not PostgreSQL 18');
await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(15439, '127.0.0.1', () => server.close(resolve));
});
const inventory = maintenance(request('inventory', { schemaVersion: 1, action: 'inventory',
  expectedRevision: operationsRevision }));
assert(inventory.schemaVersion === 1 && inventory.revision === operationsRevision &&
  /^\d{10,30}$/.test(inventory.clusterSystemIdentifier ?? '') &&
  Array.isArray(inventory.targets) && inventory.targets.length === 12, 'Source maintenance inventory differs');
assert.deepEqual(inventory.targets.map(target => target.target).sort(), targetNames,
  'Source inventory does not cover exactly the twelve reviewed owners');
const jobs = { schemaVersion: 1, sourceClusterSystemIdentifier: inventory.clusterSystemIdentifier, targets: {} };
let backupError;
try {
  command('Stop reviewed backend writers for consistent backup set', 'docker', ['stop', '-t', '60',
    ...original.containers.map(container => container.id)], { timeout: 300_000 });
  const stopped = canonicalRuntime(state.manifest);
  assert(stopped.containers.every(container => !container.running), 'Backend writer stop was incomplete');
  for (const target of targetNames) {
    checkInterrupted();
    const operationId = randomUUID();
    const result = maintenance(request(`backup-${target}`, { schemaVersion: 1, action: 'backup',
      expectedRevision: operationsRevision, operationId, target,
      expectedClusterSystemIdentifier: inventory.clusterSystemIdentifier }));
    assert(result && typeof result === 'object', 'Source backup returned no receipt');
    jobs.targets[target] = operationId;
    console.error(`Fresh signed backup completed: ${target}`);
  }
  checkInterrupted();
} catch (error) { backupError = error; }
finally { restartWriters(state.manifest, original.containers, original.ports); }
if (backupError) throw backupError;
checkInterrupted();
const ledgerDir = `${root}/maintenance/rehearsals/${path.basename(stage)}`;
fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
prepareOwnership(image, ledgerDir, '/ledger', true);
const ledger = fs.lstatSync(ledgerDir);
assert(ledger.uid === 1001 && ledger.gid === 1001 && (ledger.mode & 0o777) === 0o700,
  'Rehearsal ledger ownership or mode differs');
const jobsFile = `${stage}/jobs.json`;
fs.writeFileSync(jobsFile, `${JSON.stringify(jobs)}\n`, { flag: 'wx', mode: 0o600 });
prepareOwnership(image, jobsFile, '/jobs.json');
const result = isolatedClone(image, jobsFile, ledgerDir);
console.log(JSON.stringify({ schemaVersion: 1, sourceRevision: operationsRevision,
  sourceClusterSystemIdentifier: inventory.clusterSystemIdentifier,
  cloneClusterSystemIdentifier: result.clusterSystemIdentifier,
  targets: result.targets.map(target => ({ target: target.target, phase: target.phase,
    receiptSha256: target.receiptSha256, verificationSha256: target.verificationSha256 })) }));
