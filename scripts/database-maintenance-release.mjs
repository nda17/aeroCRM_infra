#!/usr/bin/env node
// Runs the service-owned maintenance CLI under the same host lock as backend releases.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { apps, assertRuntime, imageVariables, rolesForPlan, portsForPlan, validateState } from './backend-release-state.mjs';

const root = '/opt/aerocrm';
const ledgerDir = `${root}/maintenance/ledger`;
const sha = /^[a-f0-9]{40}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const targets = new Set(apps.filter(app => app !== 'api-gateway'));
const [mode, requestFile, infraSha, ciRunId] = process.argv.slice(2);

function command(label, executable, args, options = {}) {
  try {
    return execFileSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000, maxBuffer: 32 * 1024 * 1024, ...options }).trim();
  } catch {
    throw new Error(`${label} failed; private command output suppressed`);
  }
}
function inspect(ids) {
  return JSON.parse(command('Backend container inspection', 'docker', ['inspect', ...ids]));
}
function runtime(manifest) {
  const compose = JSON.parse(command('Backend Compose inventory', 'docker', ['compose',
    '--project-name', 'aerocrm-backend', '--env-file', `${root}/releases/backend-images.env`,
    '-f', `${root}/compose/backend.yml`, 'config', '--format', 'json'], {
    env: { ...process.env, COMPOSE_PROFILES: '', IMAGE_SHA: manifest.releaseSha, ...imageVariables(manifest) }
  }));
  const expectedRoles = rolesForPlan(compose.services);
  const ids = command('Backend container IDs', 'docker', ['ps', '-aq',
    '--filter', 'label=com.docker.compose.project=aerocrm-backend']).split('\n').filter(Boolean);
  assert(ids.length > 0, 'No backend runtime containers');
  const containers = inspect(ids).filter(container => !['postgres', 'rabbitmq'].includes(
    container.Config.Labels?.['com.docker.compose.service'])).map(container => ({
    role: container.Config.Labels?.['com.docker.compose.service'], id: container.Id,
    imageId: container.Image, image: container.Config.Image,
    revision: container.Config.Env.find(value => value.startsWith('APP_REVISION='))?.slice(13),
    running: container.State.Running
  }));
  assertRuntime(manifest, containers, null, true, expectedRoles);
  return { containers, expectedRoles, ports: portsForPlan(compose) };
}
function privateFile(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 &&
    fs.realpathSync(file) === file, 'Expected private regular file with mode 0600');
  return fs.readFileSync(file, 'utf8');
}
function prepareOperationsOwnership(image, source, destination, directory = false) {
  command('Prepare private Operations maintenance bind', 'docker', ['run', '--rm', '--network', 'none',
    '--user', '0:0', '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${source},dst=${destination}`,
    image, '-eu', '-c', `chown 1001:1001 ${destination}; chmod ${directory ? '0700' : '0600'} ${destination}`]);
}
function durableLedger(image) {
  fs.mkdirSync(`${root}/maintenance`, { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(`${root}/maintenance`);
  assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() &&
    (parent.mode & 0o777) === 0o700,
    'Maintenance directory is not private');
  const created = !fs.existsSync(ledgerDir);
  fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(ledgerDir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Maintenance ledger must be a real directory');
  if (created) prepareOperationsOwnership(image, ledgerDir, '/ledger', true);
  const owned = fs.lstatSync(ledgerDir);
  assert(owned.uid === 1001 && owned.gid === 1001 &&
    (owned.mode & 0o777) === 0o700 && fs.realpathSync(ledgerDir) === ledgerDir,
    'Host maintenance ledger ownership or mode differs');
}
function request(value) {
  assert(value?.schemaVersion === 1 && typeof value.action === 'string' &&
    ['inventory', 'inspect', 'backup', 'restore', 'rollback', 'status'].includes(value.action) &&
    sha.test(value.expectedRevision), 'Invalid maintenance request');
  const keys = ['schemaVersion', 'action', 'expectedRevision'];
  if (value.action !== 'inventory') assert(uuid.test(value.operationId) && targets.has(value.target),
    'Invalid maintenance operation or target');
  if (value.action !== 'inventory') keys.push('operationId', 'target');
  if (['backup', 'restore', 'rollback', 'status'].includes(value.action))
    assert(/^\d{10,30}$/.test(value.expectedClusterSystemIdentifier), 'Exact cluster ID required');
  if (['backup', 'restore', 'rollback', 'status'].includes(value.action)) keys.push('expectedClusterSystemIdentifier');
  if (['inspect', 'restore'].includes(value.action)) assert(uuid.test(value.backupJobId), 'Backup job ID required');
  if (['inspect', 'restore'].includes(value.action)) keys.push('backupJobId');
  if (value.action === 'restore') assert(/^[a-f0-9]{64}$/.test(value.expectedArtifactSha256),
    'Inspected artifact SHA required');
  if (value.action === 'restore') keys.push('expectedArtifactSha256');
  if (['restore', 'rollback'].includes(value.action)) assert(Number.isSafeInteger(value.expectedStateRevision) &&
    value.expectedStateRevision >= 0 && value.confirmation === `${value.action.toUpperCase()} ${value.target}`,
    'Maintenance CAS or confirmation differs');
  if (['restore', 'rollback'].includes(value.action)) keys.push('expectedStateRevision', 'confirmation');
  assert.deepEqual(Object.keys(value).sort(), keys.sort(), 'Unexpected maintenance request fields');
  return value;
}
function maintenance(image, requestPath, revision, adminUrl) {
  const result = command('Operations maintenance CLI', 'docker', ['run', '--rm', '--network', 'host',
    '--user', '0:0', '--env-file', `${root}/env/backend/operations-worker.env`,
    '--env', 'APP_REVISION', '--env', 'DATABASE_MAINTENANCE_ADMIN_URL',
    '--env', 'DATABASE_MAINTENANCE_ACTOR', '--env', 'DATABASE_MAINTENANCE_LEDGER_DIR=/run/restore/ledger',
    '--mount', `type=bind,src=${ledgerDir},dst=/run/restore/ledger`,
    '--mount', `type=bind,src=${requestPath},dst=/run/restore/request.json,readonly`,
    '--mount', `type=bind,src=${root}/secrets/database-backup-provenance-private-key.pem,dst=/run/secrets/database-backup-provenance-private-key-source,readonly`,
    image, 'node', 'dist/src/maintenance/database-maintenance.cli.js', '--request', '/run/restore/request.json'], {
    timeout: 2 * 60 * 60 * 1000,
    env: { ...process.env, APP_REVISION: revision, DATABASE_MAINTENANCE_ADMIN_URL: adminUrl,
      DATABASE_MAINTENANCE_ACTOR: process.env.DATABASE_MAINTENANCE_ACTOR }
  });
  return JSON.parse(result);
}
function startWriters(writers, manifest) {
  command('Start reviewed service writers', 'docker', ['start', ...writers.map(writer => writer.id)]);
  const after = runtime(manifest);
  assert(after.containers.every(container => container.running), 'Backend runtime did not return to running state');
  for (const port of after.ports) command(`Backend readiness ${port}`, 'curl', ['--fail', '--silent',
    '--show-error', '--retry', '20', '--retry-delay', '3', '--retry-connrefused', '--connect-timeout', '2',
    '--max-time', '5', '--retry-max-time', '90', `http://127.0.0.1:${port}/health/ready`], { timeout: 100_000 });
}

if (mode === '--policy-self-test') {
  const revision = 'a'.repeat(40);
  const operationId = '11111111-1111-4111-8111-111111111111';
  assert.equal(request({ schemaVersion: 1, action: 'inventory', expectedRevision: revision }).action, 'inventory');
  assert.equal(request({ schemaVersion: 1, action: 'restore', expectedRevision: revision, operationId,
    target: 'crm-sales', expectedClusterSystemIdentifier: '1234567890123456789', backupJobId: operationId,
    expectedArtifactSha256: 'b'.repeat(64), expectedStateRevision: 0,
    confirmation: 'RESTORE crm-sales' }).action, 'restore');
  assert.throws(() => request({ schemaVersion: 1, action: 'inventory', expectedRevision: revision, target: 'crm-sales' }));
  console.log('Database maintenance release request policy fixtures verified');
  process.exit(0);
}
if (process.platform !== 'linux' || fs.realpathSync('.') !== root) throw new Error('Linux backend host required');
if (mode !== '--locked') {
  assert(mode === '--request' && process.argv.length === 6, 'Expected request, infra SHA and CI run ID');
  const child = spawnSync('flock', ['-n', `${root}/release.lock`, process.execPath, process.argv[1],
    '--locked', requestFile, infraSha, ciRunId], { stdio: 'inherit', env: process.env });
  process.exit(child.status ?? 1);
}
assert(process.argv.length === 6 && sha.test(infraSha) && /^\d+$/.test(ciRunId), 'Invalid reviewed release IDs');
assert(/^github:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_-]+\/\d+$/.test(process.env.DATABASE_MAINTENANCE_ACTOR ?? ''),
  'Expected audited GitHub actor');
assert(!process.env.DATABASE_MAINTENANCE_REHEARSAL_CLUSTER, 'Production runner cannot use rehearsal mode');
assert(fs.realpathSync(requestFile).startsWith(`${root}/releases/staging/maintenance-`),
  'Request must belong to private maintenance stage');
const input = request(JSON.parse(privateFile(requestFile)));
if (['restore', 'rollback'].includes(input.action))
  assert(!fs.lstatSync(`${root}/releases/database-maintenance-rehearsal.pending.json`, { throwIfNoEntry: false }),
    'Recover pending rehearsal writers before a restore or rollback');
assert(fs.statSync(requestFile).size <= 16 * 1024, 'Maintenance request exceeds 16 KiB');
assert(!fs.existsSync(`${root}/releases/backend-release.pending.json`) &&
  !fs.existsSync(`${root}/releases/crm-contract-cutover.pending`) &&
  !fs.existsSync(`${root}/releases/backend-rollback-blocked.pending`), 'Resolve pending backend release first');
const state = validateState(JSON.parse(privateFile(`${root}/releases/backend-state.json`)));
assert(state.infraSha === infraSha && state.manifest.ciRunId === ciRunId,
  'Maintenance review IDs differ from canonical backend state');
const envHash = command('Backend environment hash', 'bash', ['-c',
  'cd "$1"; find . -maxdepth 1 -type f -name "*.env" -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1',
  '_', `${root}/env/backend`]);
assert(envHash === state.envHash, 'Backend environment differs from canonical release state');
const composeBytes = Buffer.concat(['backend.yml', 'rabbitmq.conf'].map(name =>
  Buffer.concat([Buffer.from(`${name}\0`), fs.readFileSync(`${root}/compose/${name}`)])));
assert(createHash('sha256').update(composeBytes).digest('hex') === state.composeHash,
  'Backend Compose differs from canonical release state');
assert(state.manifest.services.operations.sourceSha === input.expectedRevision,
  'Maintenance image revision differs from canonical backend state');
const image = `aerocrm/operations:${input.expectedRevision}`;
const imageObject = JSON.parse(command('Operations image inspection', 'docker', ['image', 'inspect', image]))[0];
assert(imageObject.Id === state.manifest.services.operations.imageId &&
  imageObject.Config.Labels?.['org.opencontainers.image.revision'] === input.expectedRevision,
  'Operations image identity differs from canonical backend state');
const postgres = parseEnv(privateFile(`${root}/env/backend/postgres.env`));
privateFile(`${root}/env/backend/operations-worker.env`);
assert(Object.keys(postgres).sort().join() === ['POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER'].sort().join() &&
  postgres.POSTGRES_USER === 'aerocrm_cluster_admin' && postgres.POSTGRES_DB === 'postgres' &&
  !!postgres.POSTGRES_PASSWORD, 'Private PostgreSQL admin environment differs');
const adminUrl = new URL('postgresql://aerocrm_cluster_admin@127.0.0.1:5432/postgres');
adminUrl.password = postgres.POSTGRES_PASSWORD;
durableLedger(image);
prepareOperationsOwnership(image, requestFile, '/request.json');
const current = runtime(state.manifest);
const inventoryFile = `${path.dirname(requestFile)}/inventory.json`;
fs.writeFileSync(inventoryFile, `${JSON.stringify({ schemaVersion: 1, action: 'inventory',
  expectedRevision: input.expectedRevision })}\n`, { mode: 0o600, flag: 'wx' });
prepareOperationsOwnership(image, inventoryFile, '/inventory.json');
let inventory;
try { inventory = maintenance(image, inventoryFile, input.expectedRevision, adminUrl.toString()); }
finally { fs.rmSync(inventoryFile, { force: true }); }
assert(inventory.schemaVersion === 1 && inventory.revision === input.expectedRevision &&
  Array.isArray(inventory.targets) && inventory.targets.length === 12, 'Maintenance inventory differs');
assert.deepEqual(inventory.targets.map(target => target.target).sort(), [...targets].sort(),
  'Maintenance image target registry differs from reviewed service owners');
if (input.target) assert(inventory.targets.some(target => target.target === input.target),
  'Maintenance target absent from image registry');
if (input.expectedClusterSystemIdentifier)
  assert(inventory.clusterSystemIdentifier === input.expectedClusterSystemIdentifier,
    'Maintenance cluster differs from reviewed request');
if (input.action === 'inventory') { console.log(JSON.stringify(inventory)); process.exit(0); }
if (['inspect', 'status', 'backup'].includes(input.action)) {
  console.log(JSON.stringify(maintenance(image, requestFile, input.expectedRevision, adminUrl.toString())));
  process.exit(0);
}
const writers = current.containers.filter(container => current.expectedRoles[input.target].includes(container.role));
assert(writers.length === current.expectedRoles[input.target].length, 'Service writer inventory differs');
const stopped = writers.filter(writer => !writer.running);
assert(stopped.length === 0 || stopped.length === writers.length,
  'Partial writer stop requires investigation');
assert(current.containers.filter(container => !writers.includes(container)).every(container => container.running),
  'Other backend writers must remain running');
if (!stopped.length) {
  command('Stop reviewed service writers', 'docker', ['stop', '-t', '60', ...writers.map(writer => writer.id)]);
  const afterStop = runtime(state.manifest);
  assert(writers.every(writer => afterStop.containers.find(container => container.id === writer.id)?.running === false),
    'Service writer fence did not stop all reviewed processes');
}
const result = maintenance(image, requestFile, input.expectedRevision, adminUrl.toString());
if (['COMMITTED', 'ROLLED_BACK'].includes(result.state?.phase))
  startWriters(writers, state.manifest);
else throw new Error('Maintenance result is non-terminal; selected service writers remain stopped');
console.log(JSON.stringify(result));
