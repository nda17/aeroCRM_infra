import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const knownConfig = Buffer.from('listeners.tcp.1 = 127.0.0.1:5672\nmanagement.tcp.ip = 127.0.0.1\nmanagement.tcp.port = 15672\n');

export function atomic(file, value, mode = 0o600) {
  assert([0o600, 0o644].includes(mode), 'Invalid atomic file mode');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  let ready = false;
  try {
    fs.writeFileSync(fd, value);
    // open(0644) would still become 0600 under the release umask.
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    ready = true;
  } finally {
    fs.closeSync(fd);
    if (!ready) fs.rmSync(temporary, { force: true });
  }
  try { fs.renameSync(temporary, file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function checkedLiveFile(file, approvedFiles, uid) {
  assert.equal(fs.realpathSync(path.dirname(file)), path.dirname(file), 'RabbitMQ config directory must be canonical');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    const link = fs.lstatSync(file);
    assert(stat.isFile() && link.isFile() && !link.isSymbolicLink(), 'RabbitMQ config must be a regular file');
    assert.equal(stat.nlink, 1, 'RabbitMQ config must not have hard links');
    assert.equal(stat.uid, uid, 'RabbitMQ config owner mismatch');
    assert.equal(stat.ino, link.ino, 'RabbitMQ config changed during inspection');
    assert.equal(stat.dev, link.dev, 'RabbitMQ config filesystem changed during inspection');
    const mode = stat.mode & 0o7777;
    assert([0o600, 0o644].includes(mode), 'Unexpected RabbitMQ config mode');
    const contents = fs.readFileSync(fd);
    assert(approvedFiles.some(approved => contents.equals(fs.readFileSync(approved))),
      'Live RabbitMQ config differs from the validated release snapshots');
    return { fd, mode, contents };
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function validateRabbitmqContainer(containers, liveFile) {
  assert.equal(containers.length, 1, 'Expected one existing RabbitMQ container');
  const container = containers[0];
  assert.equal(container.Config?.Labels?.['com.docker.compose.project'], 'aerocrm-backend');
  assert.equal(container.Config?.Labels?.['com.docker.compose.service'], 'rabbitmq');
  assert.equal(container.HostConfig?.RestartPolicy?.Name, 'unless-stopped');
  assert(container.State?.Running || container.State?.Restarting,
    'RabbitMQ was explicitly stopped; automatic recovery cannot start it');
  const mounts = container.Mounts?.filter(mount => mount.Destination === '/etc/rabbitmq/rabbitmq.conf') ?? [];
  assert.equal(mounts.length, 1, 'Expected one RabbitMQ config bind mount');
  assert.equal(mounts[0].Type, 'bind');
  assert.equal(mounts[0].Source, liveFile);
  assert.equal(mounts[0].RW, false);
  return container.Id;
}

export function recoverRabbitmqConfig({ liveFile, approvedFiles, inspect, waitForHealth, uid = process.getuid() }) {
  const { fd, mode, contents } = checkedLiveFile(liveFile, approvedFiles, uid);
  try {
    assert(contents.equals(knownConfig), 'Only the known loopback-only RabbitMQ config may be recovered');
    const containers = inspect();
    const id = validateRabbitmqContainer(containers, liveFile);
    const repaired = mode === 0o600;
    if (repaired) {
      fs.fchmodSync(fd, 0o644);
      fs.fsyncSync(fd);
      assert.equal(fs.fstatSync(fd).mode & 0o7777, 0o644);
    }
    waitForHealth(id);
    return repaired;
  } finally { fs.closeSync(fd); }
}

export function publishRabbitmqConfig(file, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  assert(bytes.equals(knownConfig), 'Only the known loopback-only RabbitMQ config may be published as world-readable');
  let current = null;
  try { current = fs.lstatSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current) {
    assert(current.isFile() && !current.isSymbolicLink(), 'RabbitMQ config publication requires a regular file');
    if ((current.mode & 0o7777) === 0o644 && fs.readFileSync(file).equals(bytes)) return;
  }
  atomic(file, bytes, 0o644);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && (stat.mode & 0o7777) === 0o644 && fs.readFileSync(file).equals(bytes),
    'RabbitMQ config publication failed');
}
