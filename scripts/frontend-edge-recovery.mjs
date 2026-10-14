#!/usr/bin/env node
// GitHub-only bootstrap transport. The reviewed root helper owns recovery gates.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function remoteRecoveryScript({ helperBytes, oldHelperHash, currentSha, envHash }) {
  assert(Buffer.isBuffer(helperBytes) && helperBytes.length > 0);
  assert(/^[a-f0-9]{64}$/.test(oldHelperHash) && /^[a-f0-9]{64}$/.test(envHash));
  assert(/^[a-f0-9]{40}$/.test(currentSha));
  const helperHash = digest(helperBytes);
  const configHash = helperBytes.toString('utf8').match(/^candidate_sha=([a-f0-9]{64})$/m)?.[1];
  assert(configHash, 'Reviewed helper config hash missing');
  return `set -euo pipefail
umask 077
[[ $(id -u) -eq 0 && $(cat /etc/aerocrm-host-role) == frontend ]]
lock=/opt/aerocrm/release.lock
[[ -f "$lock" && ! -L "$lock" ]]
exec 9<"$lock"
[[ ! -L "$lock" && $(stat -Lc '%d:%i' /proc/self/fd/9) == $(stat -c '%d:%i' "$lock") ]]
flock -n 9
helper=/usr/local/sbin/aerocrm-nginx-release
marker=/opt/aerocrm/releases/frontend.sha
state=/var/lib/aerocrm/nginx-release
[[ -f "$helper" && ! -L "$helper" && $(stat -c '%u:%g:%a' "$helper") == 0:0:755 ]]
[[ -f "$marker" && ! -L "$marker" && $(cat "$marker") == '${currentSha}' ]]
[[ ! -e "$state/pending.sha" && ! -L "$state/pending.sha" && ! -e "$state/previous.conf" && ! -L "$state/previous.conf" ]]
[[ -f "$state/current.sha" && ! -L "$state/current.sha" && $(cat "$state/current.sha") == '${configHash}' ]]
[[ -f /etc/nginx/sites-available/aerocrm && ! -L /etc/nginx/sites-available/aerocrm &&
   -L /etc/nginx/sites-enabled/aerocrm && $(readlink -f /etc/nginx/sites-enabled/aerocrm) == /etc/nginx/sites-available/aerocrm ]]
[[ $(sha256sum /etc/nginx/sites-available/aerocrm | cut -d' ' -f1) == '${configHash}' &&
   $(sha256sum /opt/aerocrm/nginx/frontends.conf | cut -d' ' -f1) == '${configHash}' ]]
[[ -d /opt/aerocrm/env/frontend && ! -L /opt/aerocrm/env/frontend ]]
[[ $(find /opt/aerocrm/env/frontend -maxdepth 1 -type f -name '*.env' | wc -l) -eq 3 &&
   -z $(find /opt/aerocrm/env/frontend -maxdepth 1 -name '*.env' \\( -type l -o -perm /077 \\) -print) ]]
env_hash=$(cd /opt/aerocrm/env/frontend && find . -maxdepth 1 -type f -name '*.env' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
[[ "$env_hash" == '${envHash}' ]]
installed_hash=$(sha256sum "$helper" | cut -d' ' -f1)
[[ "$installed_hash" == '${oldHelperHash}' || "$installed_hash" == '${helperHash}' ]]
if [[ "$installed_hash" != '${helperHash}' ]]; then
  candidate=$(mktemp /usr/local/sbin/.aerocrm-nginx-release.XXXXXXXX)
  trap 'rm -f "$candidate"' EXIT
  base64 --decode > "$candidate" <<'REVIEWED_HELPER'
${helperBytes.toString('base64')}
REVIEWED_HELPER
  [[ $(sha256sum "$candidate" | cut -d' ' -f1) == '${helperHash}' ]]
  bash -n "$candidate"
  chown root:root "$candidate"
  chmod 0755 "$candidate"
  [[ $(stat -c '%u:%g:%a' "$candidate") == 0:0:755 &&
     -f "$helper" && ! -L "$helper" && $(stat -c '%u:%g:%a' "$helper") == 0:0:755 &&
     $(sha256sum "$helper" | cut -d' ' -f1) == "$installed_hash" ]]
  mv -f "$candidate" "$helper"
  trap - EXIT
fi
[[ $(sha256sum "$helper" | cut -d' ' -f1) == '${helperHash}' ]]
# The helper independently locks and repeats every live recovery proof.
flock -u 9
"$helper" recover '${currentSha}' '${envHash}'
echo 'Reviewed root helper installed; frontend edge recovery completed'
`;
}

export function sshArguments({ host, port, knownHosts }) {
  assert(typeof host === 'string' && /^[A-Za-z0-9.-]+$/.test(host));
  assert(/^[0-9]{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535);
  assert(path.isAbsolute(knownHosts));
  return ['-F', '/dev/null', '-p', port, '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'LogLevel=ERROR', '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no',
    `root@${host}`, 'bash', '-s'];
}

function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Bootstrap runs only through GitHub CI/CD');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/prod_0.1.0');
  assert(process.env.FRONTEND_EDGE_BOOTSTRAP_PASSWORD, 'Temporary frontend bootstrap secret required');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aerocrm-edge-bootstrap-'));
  fs.chmodSync(directory, 0o700);
  try {
    const knownHosts = path.join(directory, 'known_hosts');
    assert(process.env.SSH_KNOWN_HOSTS, 'Existing verified SSH host keys required');
    fs.writeFileSync(knownHosts, process.env.SSH_KNOWN_HOSTS, { mode: 0o600 });
    const askpass = path.join(directory, 'askpass');
    fs.writeFileSync(askpass, `#!${process.execPath}\nprocess.stdout.write(process.env.FRONTEND_EDGE_BOOTSTRAP_PASSWORD || '');\n`, { mode: 0o700 });
    const helperBytes = fs.readFileSync(new URL('./aerocrm-nginx-release.sh', import.meta.url));
    const input = remoteRecoveryScript({ helperBytes, oldHelperHash: process.env.INSTALLED_HELPER_SHA256,
      currentSha: process.env.CURRENT_FRONTEND_SHA, envHash: process.env.FRONTEND_ENV_HASH });
    const result = spawnSync('ssh', sshArguments({ host: process.env.FRONTEND_SSH_HOST,
      port: process.env.FRONTEND_SSH_PORT || '22', knownHosts }), {
      env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' },
      input, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (result.stdout) process.stdout.write(result.stdout);
    assert.equal(result.status, 0, 'Frontend edge bootstrap/recovery failed; private stderr suppressed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
