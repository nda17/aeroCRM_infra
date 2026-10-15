import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { remoteConfigureScript, sshArguments } from './frontend-edge-recovery.mjs';
import { assertAndroidApkProxy } from './android-apk-proxy-contract.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(scripts);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const python = String.raw`
import contextlib, fcntl, hashlib, importlib.util, json, os, shutil, stat, subprocess, tempfile, unittest
from pathlib import Path

BASE = Path.cwd().parent
SCRIPT = Path.cwd() / 'frontend-edge-configure.py'
spec = importlib.util.spec_from_file_location('frontend_edge_configure', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
APK = b'synthetic APK contract fixture\n' * (1411514 // len(b'synthetic APK contract fixture\n'))
APK += b'x' * (1411514 - len(APK))
UID, GID = os.getuid(), os.getgid()
RUNTIME, NEW = 'a' * 40, module.NEW_CONFIG
OLD_BYTES, OLD_HELPER_BYTES = b'synthetic prior static upstream config\n', b'synthetic prior root helper\n'
OLD, OLD_HELPER = hashlib.sha256(OLD_BYTES).hexdigest(), hashlib.sha256(OLD_HELPER_BYTES).hexdigest()
module.OLD_CONFIG, module.OLD_HELPER, module.APK_SHA = OLD, OLD_HELPER, hashlib.sha256(APK).hexdigest()

def sha(data): return hashlib.sha256(data).hexdigest()
def file_sha(path): return sha(Path(path).read_bytes())

class Harness(module.Controller):
    """Exercise the real transaction with a temporary filesystem and fake host commands."""
    def __init__(self, root, **faults):
        super().__init__(root)
        self.faults, self.calls, self.apk_requests, self.apk_attempts, self.health_requests, self.nginx_tests, self.reloads = faults, [], 0, 0, 0, 0, 0
        self.crash_phase = None

    # The fixture is owned by the CI user. Keep real type/mode checks while mapping its
    # owner to the production root/nginx owners the transaction expects.
    def regular(self, path, root_owned=False):
        info = path.lstat()
        module.require(stat.S_ISREG(info.st_mode), 'Expected regular non-symlink file: ' + str(path))
        if root_owned:
            module.require((info.st_uid, info.st_gid) == (UID, GID), 'Expected synthetic root-owned file')
        if path == self.files['staged'] and (UID, GID) != (1000, 1000):
            from types import SimpleNamespace
            return SimpleNamespace(st_uid=1000, st_gid=1000, st_mode=info.st_mode, st_dev=info.st_dev, st_ino=info.st_ino)
        return info

    def secure_directory(self, path):
        info = path.lstat()
        module.require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) == (UID, GID)
                       and stat.S_IMODE(info.st_mode) == 0o700, 'Expected private synthetic root-owned directory')

    def atomic(self, path, data, uid=None, gid=None, mode=0o600):
        if (uid, gid) == (1000, 1000) and (UID, GID) != (1000, 1000):
            uid, gid = UID, GID
        return super().atomic(path, data, UID if uid is None else uid, GID if gid is None else gid, mode)

    def validate_inputs(self, runtime, env_hash, old_config=None):
        if old_config is None: old_config = OLD
        actual = module.os.geteuid
        module.os.geteuid = lambda: 0
        try: return super().validate_inputs(runtime, env_hash, old_config)
        finally: module.os.geteuid = actual

    @contextlib.contextmanager
    def lock(self, inherited=False):
        lock = self.path('/opt/aerocrm/release.lock')
        self.regular(lock)
        fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally: os.close(fd)

    def command(self, args, timeout=30):
        args = list(args)
        self.calls.append(args)
        if args[0] == 'docker':
            app = args[-1].removeprefix('aerocrm-frontend-').removesuffix('-1')
            number = {'landing': 1, 'crm': 2, 'admin-panel': 3}[app]
            return (f'{number:064x} sha256:{number:064x} aerocrm/{app}:{RUNTIME} true {RUNTIME} '
                    f'2026-10-15T00:00:00Z 0 false').encode()
        if args[0] == 'nginx':
            self.nginx_tests += 1
            if self.faults.get('nginx_test') == 'always' or (self.faults.get('nginx_test') and self.nginx_tests == 1):
                raise RuntimeError('synthetic nginx -t failure')
            return b''
        if args[0] == 'systemctl':
            operation = args[1]
            if operation == 'show': return (self.faults.get('service_state', 'active') + '\n').encode()
            if operation == 'reload':
                self.reloads += 1
                if self.faults.get('reload') == 'always' or (self.faults.get('reload') and self.reloads == 1):
                    raise RuntimeError('synthetic reload failure')
            if operation == 'start' and self.faults.get('start'): raise RuntimeError('synthetic start failure')
            return b''
        if args[0] != 'curl': raise RuntimeError('unexpected command ' + args[0])
        url = args[-1]
        if '/__frontend/health' in url:
            self.health_requests += 1
            if self.faults.get('health_always') or (self.faults.get('health_once') and self.health_requests == self.faults['health_once']):
                raise RuntimeError('synthetic HTTPS health failure')
            import re
            domain = re.search(r'https?://([^/:]+)', url).group(1)
            app = {'aerocrm.space': 'landing', 'workspace.aerocrm.space': 'crm',
                   'admin.aerocrm.space': 'admin-panel'}.get(domain)
            if not app:
                port = re.search(r':(3100|3200|3300)/', url).group(1)
                app = {'3100': 'landing', '3200': 'crm', '3300': 'admin-panel'}[port]
            return json.dumps({'status': 'ok', 'application': app, 'revision': RUNTIME}).encode()
        if not url.startswith('https://aerocrm.space/downloads/aeroCRM.apk'):
            raise RuntimeError('unexpected curl URL')
        module.require('--max-filesize' in args and args[args.index('--max-filesize') + 1] == '2000000',
                       'APK response limit missing')
        self.apk_attempts += 1
        if self.faults.get('apk_always') or (self.faults.get('apk_once') and self.apk_attempts == 1):
            raise RuntimeError('synthetic APK failure')
        headers = Path(args[args.index('-D') + 1])
        body = Path(args[args.index('-o') + 1])
        method, ranged = 'GET', False
        for i, value in enumerate(args):
            if value == '-X': method = args[i + 1]
            if value == '--head': method = 'HEAD'
            if value == '-H' and args[i + 1].startswith('Range: '): ranged = True
        code, data = '200', APK
        output_headers = ['Content-Type: application/vnd.android.package-archive', 'Content-Length: 1411514',
                          'Cache-Control: no-store', 'X-Content-Type-Options: nosniff',
                          'Content-Disposition: attachment; filename="aeroCRM.apk"', 'ETag: "fixture-apk"']
        if method == 'POST': code, data = '405', b''
        elif '?' in url: code, data = '400', b''
        elif method == 'HEAD': data = b''
        elif ranged:
            code, data = '206', APK[:32]
            output_headers.extend(['Content-Range: bytes 0-31/1411514', 'Content-Length: 32'])
        headers.write_text('HTTP/1.1 ' + code + '\r\n' + '\r\n'.join(output_headers) + '\r\n\r\n')
        body.write_bytes(data)
        self.apk_requests += 1
        return code.encode()

    def checkpoint(self, phase):
        if phase == self.crash_phase: raise KeyboardInterrupt('synthetic process interruption')

def fixture(case):
    root = Path(tempfile.mkdtemp(prefix='crm-edge-configure-'))
    case.addCleanup(shutil.rmtree, root, True)
    state = root / 'var/lib/aerocrm/nginx-release'
    package = state / ('configure-' + NEW)
    vhost = root / 'etc/nginx/sites-available/aerocrm'
    staged = root / 'opt/aerocrm/nginx/frontends.conf'
    enabled = root / 'etc/nginx/sites-enabled/aerocrm'
    helper = root / 'usr/local/sbin/aerocrm-nginx-release'
    current = state / 'current.sha'
    old_conf, old_helper = OLD_BYTES, OLD_HELPER_BYTES
    new_conf = (BASE / 'nginx/frontends.conf').read_bytes()
    new_helper = (BASE / 'scripts/aerocrm-nginx-release.sh').read_bytes()
    for directory in [state, package, vhost.parent, staged.parent, enabled.parent, helper.parent,
                      root / 'opt/aerocrm/releases', root / 'opt/aerocrm/compose',
                      root / 'opt/aerocrm/env/frontend', root / 'etc/letsencrypt/live/aerocrm.space']:
        directory.mkdir(parents=True, exist_ok=True)
        if directory in (state, package): directory.chmod(0o700)
    (root / 'opt/aerocrm/release.lock').write_text('fixture lock\n')
    (root / 'etc/aerocrm-host-role').parent.mkdir(parents=True, exist_ok=True)
    (root / 'etc/aerocrm-host-role').write_text('frontend\n')
    (root / 'opt/aerocrm/releases/frontend.sha').write_text(RUNTIME + '\n')
    (root / 'opt/aerocrm/compose/frontend.yml').write_text('services: fixture\n')
    (root / 'etc/nginx/nginx.conf').write_text('worker_processes 1;\n')
    for name in ('cert', 'chain', 'fullchain', 'privkey'):
        (root / 'etc/letsencrypt/live/aerocrm.space' / (name + '.pem')).write_text(name + '\n')
    env = root / 'opt/aerocrm/env/frontend'
    for name in ('landing.env', 'crm.env', 'admin-panel.env'):
        item = env / name
        item.write_text(name + '=fixture\n')
        item.chmod(0o600)
    vhost.write_bytes(old_conf); vhost.chmod(0o644)
    staged.write_bytes(old_conf); staged.chmod(0o644)
    helper.write_bytes(old_helper); helper.chmod(0o755)
    current.write_text(OLD + '\n'); current.chmod(0o600)
    enabled.symlink_to(vhost)
    (package / 'after.conf').write_bytes(new_conf)
    (package / 'after-helper').write_bytes(new_helper)
    (package / 'controller.py').write_bytes(SCRIPT.read_bytes())
    return root, Harness(root)

class ConfigureTests(unittest.TestCase):
    def prepare(self, controller): controller.prepare(RUNTIME, controller.env_hash(), module.OLD_HELPER)

    def test_commit_preserves_permissions_immutable_state_and_active_reload(self):
        root, c = fixture(self)
        c.runtime, c.expected_env = RUNTIME, c.env_hash()
        before = c.snapshot()
        self.prepare(c)
        c.configure(RUNTIME, c.expected_env, OLD)
        self.assertEqual(file_sha(c.files['vhost']), NEW)
        self.assertEqual(file_sha(c.files['staged']), NEW)
        self.assertEqual(file_sha(c.files['helper']), c.tuple()['new_helper'])
        self.assertEqual(c.files['current'].read_text(), NEW + '\n')
        self.assertEqual(c.snapshot(), before)
        self.assertEqual([x[1] for x in c.calls if x[0] == 'systemctl' and x[1] in ('start','reload','restart')], ['reload'])
        self.assertEqual([stat.S_IMODE(c.files[k].stat().st_mode) for k in ('vhost','staged','helper')], [0o644,0o644,0o755])
        self.assertFalse(c.pending.exists())
        self.assertEqual(module.read_json(c.receipt)['result'], 'committed')

    def test_cold_start_starts_inactive_nginx_without_restart(self):
        root, c = fixture(self)
        c.faults['service_state'] = 'inactive'
        self.prepare(c)
        c.configure(RUNTIME, c.expected_env, OLD)
        mutations = [x[1] for x in c.calls if x[0] == 'systemctl' and x[1] in ('start','reload','restart')]
        self.assertEqual(mutations, ['start'])

    def test_interrupted_durable_phases_resume_the_same_frozen_tuple(self):
        for phase in ('prepared','installing','validating','committing','receipt','complete'):
            root, c = fixture(self)
            if phase == 'prepared':
                c.crash_phase = phase
                with self.assertRaises(KeyboardInterrupt): self.prepare(c)
            else:
                self.prepare(c)
                c.crash_phase = phase
                with self.assertRaises(KeyboardInterrupt): c.configure(RUNTIME, c.expected_env, OLD)
            plan = c.package / 'plan.json'
            frozen_sha = file_sha(plan)
            if phase != 'complete': self.assertTrue(c.pending.exists(), phase)
            resumed = Harness(root)
            if phase == 'prepared': self.prepare(resumed)
            resumed.configure(RUNTIME, c.expected_env, OLD)
            self.assertEqual(file_sha(plan), frozen_sha, phase + ': frozen plan changed')
            self.assertEqual(module.read_json(resumed.receipt)['result'], 'committed', phase)
            self.assertFalse(resumed.pending.exists(), phase)

    def test_nginx_reload_health_and_apk_failures_restore_original_tuple(self):
        for fault in ('nginx_test', 'reload', 'health_once', 'apk_once'):
            root, c = fixture(self)
            self.prepare(c)
            c.faults[fault] = c.health_requests + 7 if fault == 'health_once' else True
            with self.assertRaisesRegex(RuntimeError, 'Configure failed', msg=fault):
                c.configure(RUNTIME, c.expected_env, OLD)
            self.assertEqual(file_sha(c.files['vhost']), OLD, fault)
            self.assertEqual(file_sha(c.files['staged']), OLD, fault)
            self.assertEqual(file_sha(c.files['current']), sha((OLD + '\n').encode()), fault)
            self.assertEqual(file_sha(c.files['helper']), module.OLD_HELPER, fault)
            self.assertFalse(c.pending.exists(), fault)
            self.assertEqual(module.read_json(c.receipt)['result'], 'rolled-back')
        root, blocked = fixture(self)
        self.prepare(blocked)
        blocked.faults.update(nginx_test='always')
        with self.assertRaisesRegex(RuntimeError, 'Configure failed'):
            blocked.configure(RUNTIME, blocked.expected_env, OLD)
        self.assertTrue(blocked.pending.exists())
        self.assertEqual(module.read_json(blocked.pending)['phase'], 'rollback-blocked')
        blocked.faults['nginx_test'] = False
        blocked.configure(RUNTIME, blocked.expected_env, OLD)
        self.assertFalse(blocked.pending.exists())
        self.assertEqual(module.read_json(blocked.receipt)['result'], 'committed')

    def test_cas_env_marker_permissions_and_ordinary_pending_rejections_are_read_only(self):
        for case in ('helper','config','env','marker','permissions','pending','backup'):
            root, c = fixture(self)
            before = {key:file_sha(value) for key,value in c.files.items()}
            args = (RUNTIME, c.env_hash(), module.OLD_HELPER)
            if case == 'helper': args = (RUNTIME, c.env_hash(), '0' * 64)
            elif case == 'config': (c.package / 'after.conf').write_bytes(b'wrong candidate')
            elif case == 'env': args = (RUNTIME, 'f' * 64, module.OLD_HELPER)
            elif case == 'marker': (root / 'opt/aerocrm/releases/frontend.sha').write_text('b' * 40 + '\n')
            elif case == 'permissions': (root / 'opt/aerocrm/env/frontend/crm.env').chmod(0o644)
            elif case == 'pending': (c.state / 'pending.sha').write_text('ordinary release pending\n')
            elif case == 'backup': (c.state / 'previous.conf').write_text('ordinary release backup\n')
            with self.assertRaises(Exception): c.prepare(*args)
            self.assertFalse(c.pending.exists(), case)
            self.assertFalse((c.package / 'plan.json').exists(), case)
            for key, value in c.files.items(): self.assertEqual(file_sha(value), before[key], case + ':' + key)

    def test_lock_symlink_and_pending_tuple_mismatch_fail_closed(self):
        root, c = fixture(self)
        lock = root / 'opt/aerocrm/release.lock'
        sentinel = root / 'sentinel'; sentinel.write_text('unchanged')
        lock.unlink(); lock.symlink_to(sentinel)
        with self.assertRaises(Exception): c.prepare(RUNTIME, c.env_hash(), module.OLD_HELPER)
        self.assertEqual(sentinel.read_text(), 'unchanged')
        self.assertFalse((c.package / 'plan.json').exists())
        root, c = fixture(self)
        self.prepare(c)
        pending = module.read_json(c.pending); pending['tuple']['runtime'] = 'b' * 40
        c.write_json(c.pending, pending)
        before = {key:file_sha(value) for key,value in c.files.items()}
        with self.assertRaises(Exception): c.configure(RUNTIME, c.expected_env, OLD)
        for key, value in c.files.items(): self.assertEqual(file_sha(value), before[key], key)

    def test_atomic_write_rejects_symlink_parent_without_touching_target(self):
        root, c = fixture(self)
        target = root / 'target'; target.mkdir()
        victim = target / 'sentinel'; victim.write_bytes(b'unchanged')
        alias = root / 'alias'; alias.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError): c.atomic(alias / 'sentinel', b'overwrite')
        self.assertEqual(victim.read_bytes(), b'unchanged')

    def test_plain_controller_rejects_non_root_before_filesystem_mutation(self):
        if os.geteuid() == 0: self.skipTest('already running as root')
        root, c = fixture(self)
        plain = module.Controller(root)
        with self.assertRaisesRegex(RuntimeError, 'Root required'): plain.validate_inputs(RUNTIME, plain.env_hash(), OLD)
        self.assertFalse(plain.pending.exists())

if __name__ == '__main__': unittest.main(verbosity=2)
`;

test('config-only controller transaction uses frozen state, resumes safely, and restores failures', () => {
  const result = spawnSync('python3', ['-c', python], {
    cwd: scripts,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  assert.match(result.stdout + result.stderr, /Ran 8 tests/);
  assert.match(result.stdout + result.stderr, /OK/);
});

test('APK proxy contract accepts the one pinned object and rejects drift or ambiguity', () => {
  const config = fs.readFileSync(path.join(project, 'nginx/frontends.conf'), 'utf8');
  const source = 'https://s3.twcstorage.ru/content-files/aerocrm/android/1.0.0/aeroCRM.apk';
  assert.doesNotThrow(() => assertAndroidApkProxy(config, source));
  assert.throws(() => assertAndroidApkProxy(config.replace('/1.0.0/', '/0.9.9/'), source));
  assert.throws(() => assertAndroidApkProxy(config + '\n' + config.match(/  location = \/downloads\/aeroCRM\.apk \{[\s\S]*?\n  \}/)[0], source));
  assert.throws(() => assertAndroidApkProxy(config, 'https://user:pass@s3.twcstorage.ru/content-files/aerocrm/android/1.0.0/aeroCRM.apk'));
});

test('configure transport pins helper/config/controller bytes and keeps password out of argv and script', t => {
  const helperBytes = fs.readFileSync(path.join(scripts, 'aerocrm-nginx-release.sh'));
  const configBytes = fs.readFileSync(path.join(project, 'nginx/frontends.conf'));
  const controllerBytes = fs.readFileSync(path.join(scripts, 'frontend-edge-configure.py'));
  const oldHelperHash = '1785a8966a1acbd075f96264d879139fdef1ba6f81bcab170447e5e442a2938f';
  const currentConfigHash = '9c150bf83575156e605798e9e805f4f80f1ca3b3314a1fa4766bdaa0970b80bb';
  const currentSha = 'a'.repeat(40);
  const envHash = 'b'.repeat(64);
  const remote = remoteConfigureScript({ helperBytes, configBytes, controllerBytes, oldHelperHash,
    currentSha, envHash, currentConfigHash });
  assert(remote.includes(digest(configBytes)));
  assert(remote.includes(digest(helperBytes)));
  assert(remote.includes(digest(controllerBytes)));
  assert(remote.indexOf("python3 \"$package/controller.py\" prepare") < remote.indexOf(`configure '${currentSha}'`));
  assert(remote.includes("exec 9<\"$lock\""));
  assert(remote.includes("flock -u 9"));
  assert.equal(remote.includes('FRONTEND_EDGE_BOOTSTRAP_PASSWORD'), false);

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-edge-configure-transport-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const argsFile = path.join(root, 'ssh-args.json');
  const scriptFile = path.join(root, 'remote-input.sh');
  const secret = 'temporary-configure-secret-test-only';
  const fakeSsh = path.join(bin, 'ssh');
  fs.writeFileSync(fakeSsh, `#!/usr/bin/env bash
set -eu
for arg in "$@"; do [[ "$arg" != "$FRONTEND_EDGE_BOOTSTRAP_PASSWORD" ]] || exit 91; done
[[ -x "$SSH_ASKPASS" && "$("$SSH_ASKPASS")" = "$EXPECTED_PASSWORD" ]]
printf '%s\\n' "$@" > "$CASE_SSH_ARGS"
cat > "$CASE_REMOTE_SCRIPT"
`, { mode: 0o700 });
  const knownHosts = 'frontend.example ssh-ed25519 AAAAfixture';
  const run = spawnSync(process.execPath, [path.join(scripts, 'frontend-edge-recovery.mjs')], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/prod_0.1.0', FRONTEND_EDGE_OPERATION: 'configure',
      FRONTEND_EDGE_BOOTSTRAP_PASSWORD: secret, EXPECTED_PASSWORD: secret, SSH_KNOWN_HOSTS: knownHosts,
      FRONTEND_SSH_HOST: 'frontend.example', FRONTEND_SSH_PORT: '2222', CURRENT_FRONTEND_SHA: currentSha,
      INSTALLED_HELPER_SHA256: oldHelperHash, FRONTEND_ENV_HASH: envHash,
      CURRENT_NGINX_CONFIG_SHA256: currentConfigHash, CASE_SSH_ARGS: argsFile, CASE_REMOTE_SCRIPT: scriptFile },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const argv = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  const ssh = sshArguments({ host: 'frontend.example', port: '2222', knownHosts: path.join(root, 'known_hosts') });
  assert(argv.includes('StrictHostKeyChecking=yes'));
  assert(argv.includes('root@frontend.example'));
  assert(argv.includes('bash') && argv.includes('-s'));
  assert.equal(argv.includes(secret), false);
  assert.equal(fs.readFileSync(scriptFile, 'utf8').includes(secret), false);
  assert(ssh.includes('StrictHostKeyChecking=yes'));
});
