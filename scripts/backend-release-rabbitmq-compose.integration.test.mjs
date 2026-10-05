import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { publishRabbitmqConfig, recoverRabbitmqConfig } from './backend-rabbitmq-config.mjs';

const config = 'listeners.tcp.1 = 127.0.0.1:5672\nmanagement.tcp.ip = 127.0.0.1\nmanagement.tcp.port = 15672\n';
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', ...options });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pauseSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let dockerAvailable = false;
try { docker(['info'], { stdio: 'ignore' }); dockerAvailable = true; } catch {}
const requireDocker = process.env.REQUIRE_DOCKER_COMPOSE_TEST === 'true';

async function waitFor(check, message, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await pause(1500);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

test('RabbitMQ cold boot recovers 0600 config and preserves durable queue data across remount and repeat publication', {
  skip: dockerAvailable ? false : requireDocker ? false : 'Docker daemon is not available on this workstation'
}, async t => {
  if (requireDocker) assert(dockerAvailable, 'CI requires a working Docker daemon for the RabbitMQ regression');
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const name = `aerocrm-rabbitmq-regression-${suffix}`;
  const volume = `aerocrm-rabbitmq-data-${suffix}`;
  const queue = `regression-${suffix}`;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aerocrm-rabbitmq-docker-')));
  const liveFile = path.join(dir, 'rabbitmq.conf');
  const approvedFile = path.join(dir, 'approved.conf');
  fs.writeFileSync(approvedFile, config, { mode: 0o600 });
  fs.writeFileSync(liveFile, config, { mode: 0o600 });
  const mountedFile = `/etc/rabbitmq/rabbitmq.conf`;
  let containerId;
  const start = () => {
    docker(['run', '--detach', '--name', name,
      '--label', 'com.docker.compose.project=aerocrm-backend',
      '--label', 'com.docker.compose.service=rabbitmq',
      '--hostname', `rabbitmq-${suffix}`,
      '--restart', 'unless-stopped',
      '--mount', `type=volume,source=${volume},target=/var/lib/rabbitmq`,
      '--mount', `type=bind,source=${liveFile},target=${mountedFile},readonly`,
      '--env', 'RABBITMQ_DEFAULT_USER=synthetic',
      '--env', 'RABBITMQ_DEFAULT_PASS=synthetic-only',
      'rabbitmq:4-management'], { stdio: 'pipe' });
    containerId = docker(['inspect', '--format', '{{.Id}}', name]).trim();
    return containerId;
  };
  const inspect = () => JSON.parse(docker(['inspect', containerId]));
  const waitForHealth = id => {
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      try { docker(['exec', id, 'rabbitmq-diagnostics', '-q', 'ping'], { stdio: 'ignore' }); return; }
      catch { pauseSync(1500); }
    }
    throw new Error('RabbitMQ did not become healthy after config recovery');
  };
  const cleanup = () => {
    try { docker(['rm', '--force', name], { stdio: 'ignore' }); } catch {}
    try { docker(['volume', 'rm', volume], { stdio: 'ignore' }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  };
  t.after(cleanup);

  try { docker(['image', 'inspect', 'rabbitmq:4-management'], { stdio: 'ignore' }); }
  catch { docker(['pull', 'rabbitmq:4-management'], { stdio: 'inherit' }); }
  docker(['volume', 'create', volume], { stdio: 'pipe' });
  start();

  await waitFor(() => {
    const item = inspect()[0];
    return item.RestartCount > 0 || item.State.Restarting || item.State.Status === 'exited';
  }, '0600 config did not prevent the unprivileged RabbitMQ cold boot', 120_000);
  const failedLogs = docker(['logs', name]);
  assert.match(failedLogs, /rabbitmq\.conf/i);
  assert.match(failedLogs, /eacces|permission denied|failed_to_parse_configuration_file|failed to read/i,
    'initial failure must demonstrate unreadable config, not an unrelated startup issue');
  const failedState = inspect()[0];
  assert.equal(failedState.Mounts.find(mount => mount.Destination === mountedFile)?.RW, false);
  assert.equal(fs.statSync(liveFile).mode & 0o777, 0o600);

  assert.equal(recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect, waitForHealth }), true);
  assert.equal(fs.statSync(liveFile).mode & 0o777, 0o644);
  const runAdmin = args => docker(['exec', containerId, 'rabbitmqadmin', '--username', 'synthetic',
    '--password', 'synthetic-only', '--timeout', '5', '--non-interactive', ...args], { encoding: 'utf8' });
  const managementReady = () => waitFor(() => { runAdmin(['show', 'overview']); return true; }, 'Management API unavailable');
  await managementReady();
  runAdmin(['declare', 'queue', '--name', queue, '--durable', 'true', '--auto-delete', 'false']);
  const publishMessage = () => runAdmin(['publish', 'message', '--exchange', 'amq.default', '--routing-key', queue,
    '--payload', 'synthetic durable regression message', '--properties', '{"delivery_mode":2}']);
  const readMessage = () => {
    const result = runAdmin(['get', 'messages', '--queue', queue, '--count', '1', '--ack-mode', 'ack_requeue_true']);
    assert.match(result, /synthetic durable regression message/);
  };
  publishMessage();
  readMessage();

  const originalStat = fs.statSync(liveFile);
  publishRabbitmqConfig(liveFile, config);
  publishRabbitmqConfig(liveFile, Buffer.from(config));
  assert.equal(fs.statSync(liveFile).ino, originalStat.ino, 'repeat publication should keep the same bind source');
  assert.equal(fs.statSync(liveFile).mode & 0o777, 0o644);
  readMessage();

  // Recreate only the owned fixture container while preserving its named data volume.
  docker(['rm', '--force', name], { stdio: 'ignore' });
  start();
  waitForHealth(containerId);
  await managementReady();
  readMessage();
  publishRabbitmqConfig(liveFile, config); // same validated snapshot used by rollback/replay
  readMessage();
  const finalInspect = inspect()[0];
  assert.equal(finalInspect.Config.Labels['com.docker.compose.project'], 'aerocrm-backend');
  assert.equal(finalInspect.Mounts.find(mount => mount.Destination === mountedFile)?.RW, false);
});
