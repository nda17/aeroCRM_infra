#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';

// Private inputs live beside both repositories and never enter Git.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = path.join(workspace, '.env');
const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
const [target, scriptPath, option] = process.argv.slice(2);
if (!['frontend', 'backend', 'telegram-relay'].includes(target) || !scriptPath) {
  throw new Error('Usage: node scripts/ssh.mjs frontend|backend|telegram-relay script.sh [--bootstrap]');
}
const prefix = target === 'telegram-relay' ? 'CRM_TELEGRAM_RELAY_' : `CRM_${target.toUpperCase()}_`;
const privateDir = path.join(workspace, '.deploy');
const knownHosts = env[`${prefix}SSH_KNOWN_HOSTS_FILE`] || path.join(privateDir, 'known_hosts');
const host = env[`${prefix}VPS_HOST`];
const port = env[`${prefix}SSH_PORT`] || '22';
if (!host || !/^\d+$/.test(port) || !fs.existsSync(knownHosts)) {
  throw new Error('Verified target and known_hosts are required');
}
const keyPath = env[`${prefix}SSH_PRIVATE_KEY_FILE`];
const useKey = option !== '--bootstrap' && keyPath && fs.existsSync(keyPath);
const user = useKey
  ? env[`${prefix}DEPLOY_SSH_USER`] || env[`${prefix}SSH_USER`]
  : env[`${prefix}SSH_USER`];
if (!user || !/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error('Invalid SSH user');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aerocrm-ssh-'));
fs.chmodSync(tempDir, 0o700);
try {
  const askpass = path.join(tempDir, 'askpass');
  fs.writeFileSync(askpass, `#!${process.execPath}\nconst fs=require('node:fs');const {parseEnv}=require('node:util');const e=parseEnv(fs.readFileSync(process.env.CRM_SSH_ENV,'utf8'));process.stdout.write(e[process.env.CRM_SSH_PREFIX+'SSH_PASSWORD']||'');\n`, { mode: 0o700 });
  const args = ['-p', port, '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'LogLevel=ERROR', '-o', 'NumberOfPasswordPrompts=1'];
  if (useKey) args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes');
  else args.push('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no');
  args.push(`${user}@${host}`, 'bash', '-s');
  const result = spawnSync('ssh', args, {
    env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: ':0', CRM_SSH_ENV: envPath, CRM_SSH_PREFIX: prefix },
    input: fs.readFileSync(scriptPath), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  // Callers must make remote scripts print only deliberate, non-secret results.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    console.error(`SSH operation failed for ${target} (exit ${result.status ?? 'unknown'}); private stderr withheld`);
    process.exitCode = result.status || 1;
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
