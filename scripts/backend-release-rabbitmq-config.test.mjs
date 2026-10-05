import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, publishRabbitmqConfig, recoverRabbitmqConfig } from './backend-rabbitmq-config.mjs';

const config = 'listeners.tcp.1 = 127.0.0.1:5672\nmanagement.tcp.ip = 127.0.0.1\nmanagement.tcp.port = 15672\n';
const mode = file => fs.statSync(file).mode & 0o777;

function fixture(t, liveMode = 0o600, contents = config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aerocrm-rabbitmq-unit-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const liveFile = path.join(dir, 'rabbitmq.conf');
  const approvedFile = path.join(dir, 'approved.conf');
  fs.writeFileSync(approvedFile, config, { mode: 0o600 });
  fs.writeFileSync(liveFile, contents, { mode: liveMode });
  const inspect = overrides => () => [{
    Id: 'container-id',
    Config: { Labels: { 'com.docker.compose.project': 'aerocrm-backend', 'com.docker.compose.service': 'rabbitmq' } },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    State: { Running: true, Restarting: false, Health: { Status: 'healthy' } },
    Mounts: [{ Type: 'bind', Source: liveFile, Destination: '/etc/rabbitmq/rabbitmq.conf', RW: false }],
    ...overrides
  }];
  return { dir, liveFile, approvedFile, inspect };
}

test('atomic publication keeps private files at 0600 and publishes only the exact broker config at 0644', t => {
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aerocrm-rabbitmq-writer-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secret = path.join(dir, '.env');
  atomic(secret, 'SYNTHETIC_SECRET=only-for-test\n');
  assert.equal(mode(secret), 0o600);

  const live = path.join(dir, 'rabbitmq.conf');
  publishRabbitmqConfig(live, config);
  assert.equal(mode(live), 0o644);
  assert.equal(fs.readFileSync(live, 'utf8'), config);
  assert.throws(() => publishRabbitmqConfig(live, 'loopback plus an unreviewed setting\n'), /known loopback-only/);
  assert.equal(mode(secret), 0o600);
  assert.throws(() => atomic(path.join(dir, 'bad-mode'), 'x', 0o640), /Invalid atomic file mode/);
});

test('repairs only mode on the existing inode after matching approved snapshot bytes', t => {
  const { liveFile, approvedFile, inspect } = fixture(t);
  const before = fs.statSync(liveFile);
  let healthyId;
  const changed = recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: inspect(),
    waitForHealth: id => { healthyId = id; } });
  const after = fs.statSync(liveFile);
  assert.equal(changed, true);
  assert.equal(healthyId, 'container-id');
  assert.equal(after.ino, before.ino, 'recovery must preserve the live bind source inode');
  assert.equal(mode(liveFile), 0o644);
  assert.equal(fs.readFileSync(liveFile, 'utf8'), config);
});

test('healthy 0644 config is inspected and retained without rewriting', t => {
  const { liveFile, approvedFile, inspect } = fixture(t, 0o644);
  const before = fs.statSync(liveFile);
  let inspected = false;
  let waitedFor;
  const check = inspect();
  assert.equal(recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: () => { inspected = true; return check(); },
    waitForHealth: id => { waitedFor = id; } }), false);
  assert(inspected);
  assert.equal(waitedFor, 'container-id');
  assert.equal(fs.statSync(liveFile).ino, before.ino);
  assert.equal(mode(liveFile), 0o644);
});

test('rejects unapproved bytes even if they are present in a caller supplied snapshot list', t => {
  const altered = `${config}loopback_user = ignored\n`;
  const { liveFile, approvedFile, inspect } = fixture(t, 0o600, altered);
  assert.throws(() => recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: inspect(), waitForHealth() {} }), /validated release snapshots/);
  assert.throws(() => recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile, liveFile], inspect: inspect(), waitForHealth() {} }), /known loopback-only/);
  assert.equal(mode(liveFile), 0o600);
});

test('rejects symlink, hardlink, unexpected owner, and unexpected file mode', t => {
  const { dir, liveFile, approvedFile, inspect } = fixture(t);
  const linked = path.join(dir, 'rabbitmq-hardlink.conf');
  fs.linkSync(liveFile, linked);
  assert.throws(() => recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: inspect(), waitForHealth() {} }), /hard links/);
  fs.unlinkSync(linked);
  const target = path.join(dir, 'target.conf');
  fs.renameSync(liveFile, target);
  fs.symlinkSync(target, liveFile);
  assert.throws(() => recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: inspect(), waitForHealth() {} }));
  fs.unlinkSync(liveFile);
  fs.renameSync(target, liveFile);
  assert.throws(() => recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: inspect(), waitForHealth() {}, uid: fs.statSync(liveFile).uid + 1 }), /owner mismatch/);
  fs.chmodSync(liveFile, 0o640);
  assert.throws(() => recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: inspect(), waitForHealth() {} }), /Unexpected RabbitMQ config mode/);
});

test('rejects an explicitly stopped broker, unexpected bind mount, and changed restart policy', t => {
  const cases = [
    [{ State: { Running: false, Restarting: false, Health: { Status: 'healthy' } } }, /explicitly stopped/],
    [{ Mounts: [{ Type: 'bind', Source: '/elsewhere/rabbitmq.conf', Destination: '/etc/rabbitmq/rabbitmq.conf', RW: false }] }, null],
    [{ HostConfig: { RestartPolicy: { Name: 'no' } } }, null]
  ];
  for (const [overrides, expected] of cases) {
    const { liveFile, approvedFile, inspect } = fixture(t);
    assert.throws(() => recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: inspect(overrides), waitForHealth() {} }), expected ?? undefined);
    assert.equal(mode(liveFile), 0o600, 'failed validation must not change config permissions');
  }
});

test('propagates broker health timeout after mode repair so release remains failed', t => {
  const { liveFile, approvedFile, inspect } = fixture(t);
  assert.throws(() => recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: inspect(), waitForHealth: () => { throw new Error('health timeout'); } }), /health timeout/);
  assert.equal(mode(liveFile), 0o644, 'safe readable mode remains in place for the next controlled retry');
});

test('a retry after a health timeout still waits for an unhealthy broker', t => {
  const { liveFile, approvedFile, inspect } = fixture(t);
  assert.throws(() => recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile], inspect: inspect(), waitForHealth: () => { throw new Error('first timeout'); } }), /first timeout/);
  let waited = false;
  assert.equal(recoverRabbitmqConfig({ liveFile, approvedFiles: [approvedFile],
    inspect: inspect({ State: { Running: true, Restarting: false, Health: { Status: 'starting' } } }),
    waitForHealth: id => { waited = id === 'container-id'; } }), false);
  assert(waited);
});
