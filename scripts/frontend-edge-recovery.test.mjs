import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { remoteRecoveryScript, sshArguments } from './frontend-edge-recovery.mjs';

const repo = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(repo);
const sha = 'a'.repeat(40);
const candidateHash = '9c150bf83575156e605798e9e805f4f80f1ca3b3314a1fa4766bdaa0970b80bb';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function executable(file, source) {
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -eu\n${source}\n`, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
}

function fixture(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-frontend-edge-recovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const etc = path.join(root, 'etc');
  const opt = path.join(root, 'opt', 'aerocrm');
  const state = path.join(root, 'var', 'lib', 'aerocrm', 'nginx-release');
  const releaseLock = path.join(opt, 'release.lock');
  const serviceState = path.join(root, 'nginx-active-state');
  const vhost = path.join(etc, 'nginx', 'sites-available', 'aerocrm');
  const enabled = path.join(etc, 'nginx', 'sites-enabled', 'aerocrm');
  const staged = path.join(opt, 'nginx', 'frontends.conf');
  const candidate = fs.readFileSync(path.join(project, 'nginx', 'frontends.conf'));
  assert.equal(digest(candidate), candidateHash, 'fixture must use the reviewed candidate config');
  const baseline = Buffer.from('server { listen 443 ssl; server_name baseline.example.test; }\n');
  const baselineHash = digest(baseline);
  fs.mkdirSync(path.dirname(vhost), { recursive: true });
  fs.mkdirSync(path.dirname(enabled), { recursive: true });
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(releaseLock, 'release lock fixture\n', { mode: 0o600 });
  fs.writeFileSync(serviceState, 'active\n');
  fs.writeFileSync(vhost, overrides.baseline ? baseline : candidate);
  fs.writeFileSync(staged, candidate);
  fs.symlinkSync(vhost, enabled);
  fs.writeFileSync(path.join(etc, 'aerocrm-host-role'), 'frontend\n');
  if (!overrides.baseline) fs.writeFileSync(path.join(state, 'current.sha'), `${candidateHash}\n`);
  fs.mkdirSync(path.join(opt, 'releases'), { recursive: true });
  fs.mkdirSync(path.join(opt, 'compose'), { recursive: true });
  fs.writeFileSync(path.join(opt, 'releases', 'frontend.sha'), `${sha}\n`);
  fs.writeFileSync(path.join(opt, 'compose', 'frontend.yml'), 'services: fixture\n');
  fs.writeFileSync(path.join(etc, 'nginx', 'nginx.conf'), 'worker_processes 1;\n');
  const certDir = path.join(etc, 'letsencrypt', 'live', 'aerocrm.space');
  fs.mkdirSync(certDir, { recursive: true });
  for (const name of ['cert.pem', 'chain.pem', 'fullchain.pem', 'privkey.pem']) {
    fs.writeFileSync(path.join(certDir, name), `${name}\n`);
  }
  const envDir = path.join(opt, 'env', 'frontend');
  fs.mkdirSync(envDir, { recursive: true });
  for (const name of ['landing.env', 'crm.env', 'admin-panel.env']) {
    fs.writeFileSync(path.join(envDir, name), `${name}=fixture\n`, { mode: 0o600 });
  }
  // The production fingerprint is sha256sum's canonical output over the three files.
  const envFingerprint = spawnSync('sh', ['-c', `cd "$1" && find . -maxdepth 1 -type f -name '*.env' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1`, 'sh', envDir], { encoding: 'utf8' });
  assert.equal(envFingerprint.status, 0, envFingerprint.stderr);
  const actualEnvHash = envFingerprint.stdout.trim();

  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'calls.log');
  executable(path.join(bin, 'id'), 'if [ "${1:-}" = -u ]; then echo 0; else /usr/bin/id "$@"; fi');
  executable(path.join(bin, 'nginx'), 'printf "nginx %s\\n" "$*" >> "$CASE_LOG"; [ "${CASE_NGINX_TEST_FAIL:-0}" = 0 ]');
  executable(path.join(bin, 'systemctl'), `
state="\${CASE_NGINX_STATE:-active}"
[ ! -f "$CASE_NGINX_STATE_FILE" ] || state=$(cat "$CASE_NGINX_STATE_FILE")
case "\${1:-}" in
  show) echo "$state" ;;
  is-active) [ "$state" = active ] ;;
  start|reload|restart)
    printf "systemctl %s\\n" "$*" >> "$CASE_LOG"
    [ "\${CASE_SYSTEMCTL_FAIL:-}" != "$1" ] || exit 1
    if [[ "$1" = reload && "\${CASE_SYSTEMCTL_FAIL:-}" = reload-once ]]; then
      count=$(cat "$CASE_RELOAD_COUNT"); echo $((count + 1)) > "$CASE_RELOAD_COUNT"; [ "$count" -gt 0 ] || exit 1
    fi
    [ "$1" != start ] || echo active > "$CASE_NGINX_STATE_FILE" ;;
  *) exit 2 ;;
esac`);
  const reloadCount = path.join(root, 'reload-count');
  fs.writeFileSync(reloadCount, '0\n');
  executable(path.join(bin, 'docker'), `
name="\${!#}"
app="\${name#aerocrm-frontend-}"
app="\${app%-1}"
suffix=1; [ "$app" = crm ] && suffix=2; [ "$app" = admin-panel ] && suffix=3
revision="\${CASE_DOCKER_REVISION:-\${CASE_SHA}}"
printf "%064d sha256:%064d aerocrm/%s:%s true %s 2026-10-14T20:00:00Z 0 false\\n" "$suffix" "$suffix" "$app" "$CASE_SHA" "$revision"`);
  executable(path.join(bin, 'curl'), `
printf "curl %s\\n" "$*" >> "$CASE_LOG"
url="\${!#}"
case "$url" in
  *workspace.aerocrm.space*) app=crm ;;
  *admin.aerocrm.space*) app=admin-panel ;;
  *aerocrm.space*) app=landing ;;
  *:3100/*) app=landing ;;
  *:3200/*) app=crm ;;
  *:3300/*) app=admin-panel ;;
  *) exit 2 ;;
esac
if [[ "$url" == http://127.0.0.1:* && ("\${CASE_APP_HEALTH_FAIL:-}" = 1 || "\${CASE_APP_HEALTH_FAIL:-}" = "$app") ]]; then exit 22; fi
status=ok; revision="\${CASE_REVISION:-\${CASE_SHA}}"; [ "\${CASE_BAD_HEALTH:-}" = wrong-status ] && status=degraded
[ "\${CASE_BAD_HEALTH:-}" = wrong-revision ] && revision=wrong
[ "\${CASE_BAD_HEALTH:-}" = wrong-app ] && app=wrong
if [ "\${CASE_BAD_HEALTH:-}" = malformed ]; then echo '{malformed'
elif [ "\${CASE_BAD_HEALTH:-}" = duplicate ]; then printf '{"status":"ok","status":"ok","application":"%s","revision":"%s"}\\n' "$app" "$revision"
elif [ "\${CASE_BAD_HEALTH:-}" = extra ]; then printf '{"status":"ok","application":"%s","revision":"%s","extra":true}\\n' "$app" "$revision"
else printf '{"status":"%s","application":"%s","revision":"%s"}\\n' "$status" "$app" "$revision"; fi`);
  executable(path.join(bin, 'flock'), 'exit 0');
  executable(path.join(bin, 'stat'), `
path="\${!#}"
[ "$path" != /proc/self/fd/9 ] || path="$CASE_RELEASE_LOCK"
python3 -c 'import os,sys; s=os.stat(sys.argv[1]); print(f"{s.st_dev}:{s.st_ino}")' "$path"`);

  const sourceHelper = fs.readFileSync(path.join(repo, 'aerocrm-nginx-release.sh'), 'utf8');
  const gnuAnyPermissionFind = String.raw`find "$directory" -maxdepth 1 -name '*.env' \( -type l -o -perm /077 \) -print`;
  const portableAnyPermissionFind = String.raw`find "$directory" -maxdepth 1 -name '*.env' \( -type l -o -perm -001 -o -perm -002 -o -perm -004 -o -perm -010 -o -perm -020 -o -perm -040 \) -print`;
  assert(sourceHelper.includes(gnuAnyPermissionFind), 'production env-mode check changed');
  const helperText = sourceHelper.replace(gnuAnyPermissionFind, portableAnyPermissionFind)
    .replace(/baseline_sha=[a-f0-9]{64}/, `baseline_sha=${baselineHash}`);
  const replacements = [
    ['/etc/aerocrm-host-role', path.join(etc, 'aerocrm-host-role')],
    ['/etc/nginx/sites-available/aerocrm', vhost],
    ['/etc/nginx/sites-enabled/aerocrm', enabled],
    ['/opt/aerocrm/nginx/frontends.conf', staged],
    ['/var/lib/aerocrm/nginx-release', state],
    ['/opt/aerocrm/release.lock', path.join(opt, 'release.lock')],
    ['/opt/aerocrm/releases/frontend.sha', path.join(opt, 'releases', 'frontend.sha')],
    ['/opt/aerocrm/compose/frontend.yml', path.join(opt, 'compose', 'frontend.yml')],
    ['/opt/aerocrm/env/frontend', envDir],
    ['/etc/nginx/nginx.conf', path.join(etc, 'nginx', 'nginx.conf')],
    ['/etc/letsencrypt/live/aerocrm.space', certDir],
  ];
  const helper = path.join(root, 'aerocrm-nginx-release.sh');
  fs.writeFileSync(helper, replacements.reduce((text, [from, to]) => text.replaceAll(from, to), helperText), { mode: 0o700 });
  const args = ['recover', sha, actualEnvHash];
  const run = (runArgs = args, env = {}) => {
    if (env.CASE_NGINX_STATE) fs.writeFileSync(serviceState, `${env.CASE_NGINX_STATE}\n`);
    return spawnSync('bash', [helper, ...runArgs], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CASE_LOG: log,
      CASE_NGINX_STATE_FILE: serviceState, CASE_RELOAD_COUNT: reloadCount,
      CASE_RELEASE_LOCK: releaseLock, CASE_SHA: sha, ...env },
  });
  };
  return { root, run, log, state, releaseLock, vhost, staged, envDir, certDir, etc, opt, actualEnvHash, baselineHash };
}

function readLog(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

test('recovery starts only an inactive Nginx and preserves exact-SHA app, config, env, and certificate state', t => {
  const f = fixture(t);
  const preservedFiles = [f.vhost, f.staged, path.join(f.state, 'current.sha'),
    f.releaseLock, path.join(f.opt, 'releases', 'frontend.sha'), path.join(f.opt, 'compose', 'frontend.yml'),
    path.join(f.etc, 'nginx', 'nginx.conf'), ...fs.readdirSync(f.certDir).map(name => path.join(f.certDir, name)),
    ...fs.readdirSync(f.envDir).map(name => path.join(f.envDir, name))];
  const before = new Map(preservedFiles.map(file => [file, digest(fs.readFileSync(file))]));
  const result = f.run(undefined, { CASE_NGINX_STATE: 'inactive' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readLog(f.log).filter(line => line.startsWith('systemctl ')), ['systemctl start nginx']);
  for (const file of preservedFiles) assert.equal(digest(fs.readFileSync(file)), before.get(file), `${file} changed`);
  assert.equal(fs.existsSync(path.join(f.state, 'pending.sha')), false);
  assert.equal(fs.existsSync(path.join(f.state, 'previous.conf')), false);
  const curlCalls = readLog(f.log).filter(line => line.startsWith('curl '));
  assert.equal(curlCalls.filter(line => line.includes('http://127.0.0.1:')).length, 6);
  assert(curlCalls.filter(line => line.includes('https://')).length >= 3);
});

test('active Nginx recovery is a no-op for service control and never restarts or reloads', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readLog(f.log).filter(line => line.startsWith('systemctl ')), []);
  assert.equal(readLog(f.log).some(line => /systemctl (restart|reload)/.test(line)), false);
});

test('recovery requires the existing regular release lock and never follows or creates a lock path', t => {
  const missing = fixture(t);
  fs.rmSync(missing.releaseLock);
  const missingResult = missing.run();
  assert.notEqual(missingResult.status, 0);
  assert.deepEqual(readLog(missing.log), []);

  const linked = fixture(t);
  const sentinel = path.join(linked.root, 'sentinel');
  const sentinelBytes = Buffer.from('leave this file untouched\n');
  fs.writeFileSync(sentinel, sentinelBytes);
  fs.rmSync(linked.releaseLock);
  fs.symlinkSync(sentinel, linked.releaseLock);
  const linkedResult = linked.run();
  assert.notEqual(linkedResult.status, 0);
  assert.deepEqual(fs.readFileSync(sentinel), sentinelBytes);
  assert(fs.lstatSync(linked.releaseLock).isSymbolicLink());
  assert.deepEqual(readLog(linked.log), []);
});

test('failed app health aborts before starting inactive Nginx even when HTTPS probes would pass', t => {
  const f = fixture(t);
  const result = f.run(undefined, { CASE_NGINX_STATE: 'inactive', CASE_APP_HEALTH_FAIL: 'landing' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readLog(f.log).filter(line => line.startsWith('systemctl ')), []);
  assert.equal(readLog(f.log).filter(line => line.startsWith('curl ')).length, 1);
});

test('failed Nginx validation or start leaves recovery unsuccessful', t => {
  for (const env of [{ CASE_NGINX_TEST_FAIL: '1' },
    { CASE_NGINX_STATE: 'inactive', CASE_SYSTEMCTL_FAIL: 'start' }]) {
    const f = fixture(t);
    const result = f.run(undefined, env);
    assert.notEqual(result.status, 0);
    if (env.CASE_NGINX_TEST_FAIL) {
      assert.deepEqual(readLog(f.log).filter(line => line.startsWith('systemctl ')), []);
    } else {
      assert.deepEqual(readLog(f.log).filter(line => line.startsWith('systemctl ')), ['systemctl start nginx']);
    }
  }
});

test('a failed active reload makes apply fail and restores the prior config even if Nginx remains active', t => {
  const f = fixture(t, { baseline: true });
  const result = f.run(['apply', sha], { CASE_SYSTEMCTL_FAIL: 'reload-once' });
  assert.notEqual(result.status, 0);
  assert.equal(digest(fs.readFileSync(f.vhost)), f.baselineHash);
  assert.equal(fs.readFileSync(path.join(f.state, 'current.sha'), 'utf8').trim(), f.baselineHash);
  assert.equal(fs.existsSync(path.join(f.state, 'pending.sha')), false);
  assert.equal(fs.existsSync(path.join(f.state, 'previous.conf')), false);
  assert.deepEqual(readLog(f.log).filter(line => line.startsWith('systemctl ')),
    ['systemctl reload nginx', 'systemctl reload nginx']);
});

test('refuses pending release state, live drift, env drift, and malformed or mismatched health JSON', t => {
  for (const [name, setup, env] of [
    ['pending marker', f => fs.writeFileSync(path.join(f.state, 'pending.sha'), `${sha}\n`), {}],
    ['backup file', f => fs.writeFileSync(path.join(f.state, 'previous.conf'), 'pending'), {}],
    ['live config drift', f => fs.appendFileSync(f.vhost, '# drift\n'), {}],
    ['staged config drift', f => fs.appendFileSync(f.staged, '# drift\n'), {}],
    ['env hash drift', f => fs.appendFileSync(path.join(f.envDir, 'crm.env'), 'EXTRA=1\n'), {}],
    ['group-readable env file', f => fs.chmodSync(path.join(f.envDir, 'crm.env'), 0o640), {}],
    ['malformed JSON', () => {}, { CASE_BAD_HEALTH: 'malformed' }],
    ['wrong revision', () => {}, { CASE_BAD_HEALTH: 'wrong-revision' }],
    ['wrong application', () => {}, { CASE_BAD_HEALTH: 'wrong-app' }],
    ['wrong status', () => {}, { CASE_BAD_HEALTH: 'wrong-status' }],
    ['duplicate health field', () => {}, { CASE_BAD_HEALTH: 'duplicate' }],
    ['extra health field', () => {}, { CASE_BAD_HEALTH: 'extra' }],
    ['wrong docker revision', () => {}, { CASE_DOCKER_REVISION: 'wrong' }],
  ]) {
    const f = fixture(t);
    setup(f);
    const result = f.run(undefined, env);
    assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
    assert.equal(readLog(f.log).some(line => /systemctl (start|reload|restart)/.test(line)), false,
      `${name} reached a service mutation`);
  }
});

test('bootstrap remote script installs only from the reviewed old helper hash using a root-owned CAS', () => {
  const helperBytes = fs.readFileSync(path.join(repo, 'aerocrm-nginx-release.sh'));
  const oldHelperHash = 'c'.repeat(64);
  const currentSha = sha;
  const remote = remoteRecoveryScript({ helperBytes, oldHelperHash, currentSha, envHash: 'd'.repeat(64) });
  const helperHash = digest(helperBytes);
  assert(helperBytes.toString().includes('exec 9<"$lock"'));
  assert(helperBytes.toString().includes('stat -Lc \'%d:%i\' /proc/self/fd/9'));
  assert.match(remote, new RegExp(`installed_hash.*${oldHelperHash}`));
  assert(remote.includes(`installed_hash" == '${helperHash}'`));
  assert(remote.includes('$(sha256sum "$helper" | cut -d\' \' -f1) == "$installed_hash"'));
  assert.match(remote, /mv -f "\$candidate" "\$helper"/);
  assert(remote.includes(`"$helper" recover '${currentSha}'`));
  assert(remote.includes('exec 9<"$lock"'));
  assert(remote.includes('stat -Lc \'%d:%i\' /proc/self/fd/9'));
  assert.equal(remote.includes('FRONTEND_EDGE_BOOTSTRAP_PASSWORD'), false);
  const args = sshArguments({ host: 'frontend.example', port: '2222', knownHosts: '/tmp/verified-hosts' });
  assert(args.includes('StrictHostKeyChecking=yes'));
  assert(args.includes('UserKnownHostsFile=/tmp/verified-hosts'));
  assert(args.includes('root@frontend.example'));
  assert(!args.includes('temporary-bootstrap-secret-test-only'));
});

test('SSH transport pins known_hosts and keeps the temporary password out of argv', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-edge-bootstrap-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const argsFile = path.join(root, 'ssh-args.json');
  const scriptFile = path.join(root, 'remote-input.sh');
  const secret = 'temporary-bootstrap-secret-test-only';
  executable(path.join(bin, 'ssh'), `
for arg in "$@"; do [[ "$arg" != "$FRONTEND_EDGE_BOOTSTRAP_PASSWORD" ]] || exit 91; done
[[ -x "$SSH_ASKPASS" && "$("$SSH_ASKPASS")" = "$EXPECTED_PASSWORD" ]]
printf '%s\\n' "$@" > "$CASE_SSH_ARGS"
cat > "$CASE_REMOTE_SCRIPT"
`);
  const result = spawnSync(process.execPath, [path.join(repo, 'frontend-edge-recovery.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/prod_0.1.0', FRONTEND_EDGE_BOOTSTRAP_PASSWORD: secret,
      EXPECTED_PASSWORD: secret, SSH_KNOWN_HOSTS: 'frontend.example ssh-ed25519 AAAAfixture',
      FRONTEND_SSH_HOST: 'frontend.example', FRONTEND_SSH_PORT: '2222',
      CURRENT_FRONTEND_SHA: sha, INSTALLED_HELPER_SHA256: 'e'.repeat(64),
      FRONTEND_ENV_HASH: 'f'.repeat(64), CASE_SSH_ARGS: argsFile, CASE_REMOTE_SCRIPT: scriptFile },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const sshArgv = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  assert.equal(sshArgv.includes(secret), false);
  assert(sshArgv.includes('StrictHostKeyChecking=yes'));
  assert(sshArgv.some(value => value.startsWith('UserKnownHostsFile=')));
  assert(sshArgv.includes('root@frontend.example'));
  assert(sshArgv.includes('bash') && sshArgv.includes('-s'));
  const remote = fs.readFileSync(scriptFile, 'utf8');
  assert(remote.includes(`'${sha}'`));
  assert.equal(remote.includes(secret), false);
});
