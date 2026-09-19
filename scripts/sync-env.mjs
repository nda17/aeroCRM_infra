#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const role = process.argv[2];
if (!['frontend', 'backend'].includes(role)) throw new Error('Usage: sync-env.mjs frontend|backend');
const input = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
const prefix = `CRM_${role.toUpperCase()}_`;
const localDir = path.join(root, '.deploy/env', role);
const snapshotDir = path.join(root, '.deploy/synced-env', role);
const remoteDir = `/opt/aerocrm/env/${role}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = fs.readdirSync(localDir).filter(name => /^[a-z0-9-]+\.env$/.test(name)).sort();
if (!files.length) throw new Error('No runtime env files');
const desired = Object.fromEntries(files.map(name => {
  const source = path.join(localDir, name);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error(`Unsafe local env: ${name}`);
  return [name, fs.readFileSync(source)];
}));
const sshArgs = ['-p', input[`${prefix}SSH_PORT`] || '22', '-i', input[`${prefix}SSH_PRIVATE_KEY_FILE`],
  '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${path.join(root, '.deploy/known_hosts')}`, '-o', 'ConnectTimeout=15',
  `${input[`${prefix}DEPLOY_SSH_USER`]}@${input[`${prefix}VPS_HOST`]}`, 'bash', '-s'];
function remote(python) {
  const script = `set -euo pipefail\numask 077\nexec 9>/opt/aerocrm/release.lock\nflock -w 30 9\npython3 - <<'AEROCRM_PRIVATE_SYNC'\n${python}\nAEROCRM_PRIVATE_SYNC\n`;
  const result = spawnSync('ssh', sshArgs, { input: script, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  // stdout may contain secrets. Parse in memory; never forward either stream.
  if (result.status !== 0) throw new Error('Private env SSH sync failed; remote output withheld');
  return JSON.parse(result.stdout);
}
const readScript = `import os, pathlib, json, base64, stat
root = pathlib.Path(${JSON.stringify(remoteDir)})
result = {}
if root.is_symlink(): raise RuntimeError('Unsafe env directory')
for name in ${JSON.stringify(files)}:
 p = root / name
 if p.is_symlink(): raise RuntimeError('Unsafe env file')
 if p.exists():
  info = p.stat()
  if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077: raise RuntimeError('Unsafe env metadata')
  result[name] = base64.b64encode(p.read_bytes()).decode('ascii')
 else: result[name] = None
print(json.dumps(result))`;
const before = remote(readScript);
for (const name of files) {
  if (before[name] === null) {
    if (fs.existsSync(path.join(snapshotDir, name))) throw new Error(`Previously synced VPS env is missing: ${name}`);
    continue;
  }
  const bytes = Buffer.from(before[name], 'base64');
  const previous = path.join(snapshotDir, name);
  if (!bytes.equals(desired[name]) && (!fs.existsSync(previous) || !bytes.equals(fs.readFileSync(previous)))) {
    throw new Error(`Unexplained local/VPS difference; no changes applied: ${name}`);
  }
}
const payload = Object.fromEntries(files.map(name => [name, {
  before: before[name] === null ? null : hash(Buffer.from(before[name], 'base64')),
  content: desired[name].toString('base64'),
}]));
remote(`import os, pathlib, json, base64, hashlib, tempfile
root = pathlib.Path(${JSON.stringify(remoteDir)})
payload = json.loads(${JSON.stringify(JSON.stringify(payload))})
if root.is_symlink(): raise RuntimeError('Unsafe env directory')
root.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(root.parent, 0o700)
os.chmod(root, 0o700)
for name, item in payload.items():
 p = root / name
 if p.is_symlink(): raise RuntimeError('Unsafe env file')
 current = hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
 if current != item['before']: raise RuntimeError('Concurrent remote edit')
for name, item in payload.items():
 fd, tmp = tempfile.mkstemp(prefix='.' + name + '.', dir=root)
 try:
  with os.fdopen(fd, 'wb') as out: out.write(base64.b64decode(item['content']))
  os.chmod(tmp, 0o600)
  os.replace(tmp, root / name)
 finally:
  if os.path.exists(tmp): os.unlink(tmp)
print(json.dumps({'saved': len(payload)}))`);
const after = remote(readScript);
fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
for (const name of files) {
  const actual = Buffer.from(after[name], 'base64');
  if (!actual.equals(desired[name])) throw new Error(`VPS roundtrip mismatch: ${name}`);
  for (const target of [path.join(localDir, name), path.join(snapshotDir, name)]) {
    const temporary = `${target}.sync-${process.pid}`;
    fs.writeFileSync(temporary, actual, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  }
}
console.log(JSON.stringify({ role, files: files.length, mode: '0600', downloadedAndByteVerified: true }));
