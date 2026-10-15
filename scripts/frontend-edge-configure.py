#!/usr/bin/env python3
"""One reviewed config-only transition. Root-owned journal survives process/SSH loss."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile

OLD_CONFIG = '9c150bf83575156e605798e9e805f4f80f1ca3b3314a1fa4766bdaa0970b80bb'
NEW_CONFIG = '4d1b6152e68f3997e8ad54f90542cdd8af1a816804ecb54a54df7181d902d35d'
OLD_HELPER = '1785a8966a1acbd075f96264d879139fdef1ba6f81bcab170447e5e442a2938f'
APK_SHA = '630f81528a4a3821978b88215813ef190f03e4be4e21718aaff21ce8212e232b'
TARGETS = [('landing', 'aerocrm.space', 3100), ('crm', 'workspace.aerocrm.space', 3200), ('admin-panel', 'admin.aerocrm.space', 3300)]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON field')
        result[key] = value
    return result

def read_json(path):
    return json.loads(path.read_text(), object_pairs_hook=unique)

class Controller:
    def __init__(self, root=Path('/')):
        self.root = Path(root)
        self.state = self.path('/var/lib/aerocrm/nginx-release')
        self.package = self.state / ('configure-' + NEW_CONFIG)
        self.pending = self.state / 'configure.pending.json'
        self.receipt = self.state / 'configure.receipt.json'
        self.files = {'vhost': self.path('/etc/nginx/sites-available/aerocrm'),
                      'staged': self.path('/opt/aerocrm/nginx/frontends.conf'),
                      'current': self.state / 'current.sha',
                      'helper': self.path('/usr/local/sbin/aerocrm-nginx-release')}

    def path(self, value):
        return self.root / value.lstrip('/')

    def regular(self, path, root_owned=False):
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode), 'Expected regular non-symlink file: ' + str(path))
        if root_owned:
            require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) & 0o022 == 0, 'Expected root-owned non-writable file')
        return info

    def secure_directory(self, path):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                'Expected private root-owned directory')

    def fsync_directory(self, directory):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def atomic(self, path, data, uid=0, gid=0, mode=0o600):
        # Bind writes to the opened directory, even if deploy-writable parent is renamed.
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        name = '.' + path.name + '.' + secrets.token_hex(16)
        created = False
        try:
            try:
                info = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
                require(stat.S_ISREG(info.st_mode), 'Destination must be a regular non-symlink file')
            except FileNotFoundError:
                pass
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            created = True
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fchown(stream.fileno(), uid, gid)
                os.fchmod(stream.fileno(), mode)
                os.fsync(stream.fileno())
            os.replace(name, path.name, src_dir_fd=directory, dst_dir_fd=directory)
            created = False
            os.fsync(directory)
        finally:
            if created:
                os.unlink(name, dir_fd=directory)
            os.close(directory)

    def write_json(self, path, value):
        self.atomic(path, (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode())

    def checkpoint(self, phase):
        """Tests override to simulate abrupt loss after durable phase transitions."""

    @contextlib.contextmanager
    def lock(self, inherited=False):
        lock = self.path('/opt/aerocrm/release.lock')
        info = self.regular(lock)
        fd = 9 if inherited else os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            require((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino), 'Release lock changed')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            if not inherited:
                os.close(fd)

    def command(self, args, timeout=30):
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
        require(result.returncode == 0, 'Command failed: ' + args[0] + ' (private details suppressed)')
        return result.stdout

    def health(self, app, url, domain=None):
        args = ['curl', '--fail', '--silent', '--show-error', '--noproxy', '*', '--connect-timeout', '2', '--max-time', '8']
        if domain:
            args += ['--proto', '=https', '--resolve', domain + ':443:127.0.0.1']
        value = json.loads(self.command(args + [url]), object_pairs_hook=unique)
        require(value == {'status': 'ok', 'application': app, 'revision': self.runtime}, 'Frontend health mismatch')

    def env_hash(self):
        directory = self.path('/opt/aerocrm/env/frontend')
        require(directory.is_dir() and not directory.is_symlink(), 'Env directory invalid')
        files = sorted(directory.glob('*.env'))
        require(len(files) == 3, 'Expected exactly three env files')
        lines = b''
        for file in files:
            info = self.regular(file)
            require(stat.S_IMODE(info.st_mode) & 0o077 == 0, 'Env permissions invalid')
            lines += (digest(file.read_bytes()) + '  ./' + file.name + '\n').encode()
        return digest(lines)

    def snapshot(self):
        marker = self.path('/opt/aerocrm/releases/frontend.sha')
        self.regular(marker)
        require(marker.read_text().strip() == self.runtime, 'Frontend marker mismatch')
        require(self.env_hash() == self.expected_env, 'Frontend env hash mismatch')
        enabled = self.path('/etc/nginx/sites-enabled/aerocrm')
        require(enabled.is_symlink() and enabled.resolve() == self.files['vhost'].resolve(), 'Vhost enablement changed')
        stable = [self.path('/etc/nginx/nginx.conf'), self.path('/opt/aerocrm/compose/frontend.yml'), marker]
        # Certificate symlinks are intentionally followed; only their bytes are recorded.
        stable += [self.path('/etc/letsencrypt/live/aerocrm.space/' + name + '.pem') for name in ('cert', 'chain', 'fullchain', 'privkey')]
        result = {'files': {str(p.relative_to(self.root)): digest(p.read_bytes()) for p in stable}, 'env': self.env_hash(), 'apps': {}}
        for app, domain, port in TARGETS:
            value = self.command(['docker', 'inspect', '--format', '{{.Id}} {{.Image}} {{.Config.Image}} {{.State.Running}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{.State.StartedAt}} {{.RestartCount}} {{.State.OOMKilled}}', 'aerocrm-frontend-' + app + '-1']).decode().strip()
            fields = value.split()
            require(len(fields) == 8 and re.fullmatch('[a-f0-9]{64}', fields[0]) and re.fullmatch('sha256:[a-f0-9]{64}', fields[1]) and fields[2] == 'aerocrm/' + app + ':' + self.runtime and fields[3:5] == ['true', self.runtime] and fields[6].isdigit() and fields[7] == 'false', 'Container identity/health mismatch')
            self.health(app, 'http://127.0.0.1:' + str(port) + '/__frontend/health')
            result['apps'][app] = value
        return result

    def validate_inputs(self, runtime, env_hash, old_config=OLD_CONFIG):
        require(re.fullmatch('[a-f0-9]{40}', runtime) and re.fullmatch('[a-f0-9]{64}', env_hash), 'Invalid exact SHA/hash')
        require(old_config == OLD_CONFIG, 'Only reviewed old config is accepted')
        require(os.geteuid() == 0, 'Root required')
        require(self.path('/etc/aerocrm-host-role').read_text().strip() == 'frontend', 'Wrong host role')
        self.runtime, self.expected_env = runtime, env_hash
        for directory in ('/opt/aerocrm', '/opt/aerocrm/nginx', '/opt/aerocrm/releases', '/opt/aerocrm/env', '/opt/aerocrm/env/frontend', '/opt/aerocrm/compose', '/etc/nginx/sites-available', '/usr/local/sbin'):
            info = self.path(directory).lstat()
            require(stat.S_ISDIR(info.st_mode), 'Fixed parent must be a non-symlink directory')
        self.secure_directory(self.state)
        self.secure_directory(self.package)
        for name in ('after.conf', 'after-helper', 'controller.py'):
            self.regular(self.package / name, True)
        require(digest((self.package / 'after.conf').read_bytes()) == NEW_CONFIG, 'Candidate config hash mismatch')
        for name in ('pending.sha', 'previous.conf'):
            p = self.state / name
            require(not p.exists() and not p.is_symlink(), 'Ordinary release pending')

    def tuple(self):
        return {'version': 1, 'runtime': self.runtime, 'env': self.expected_env, 'old_config': OLD_CONFIG,
                'new_config': NEW_CONFIG, 'old_helper': OLD_HELPER,
                'new_helper': digest((self.package / 'after-helper').read_bytes()),
                'controller': digest((self.package / 'controller.py').read_bytes())}

    def plan(self):
        self.regular(self.package / 'plan.json', True)
        plan = read_json(self.package / 'plan.json')
        require(set(plan) == {'tuple', 'before', 'immutable'}, 'Unexpected plan shape')
        require(plan['tuple'] == self.tuple(), 'Configure tuple mismatch')
        require(set(plan['before']) == set(self.files), 'Incomplete frozen baseline')
        for key, meta in plan['before'].items():
            require(set(meta) == {'sha', 'uid', 'gid', 'mode'}, 'Unexpected baseline metadata')
            frozen = self.package / ('before-' + key)
            self.regular(frozen, True)
            require(digest(frozen.read_bytes()) == meta['sha'], 'Frozen baseline hash mismatch')
        require(plan['before']['vhost']['sha'] == OLD_CONFIG and plan['before']['staged']['sha'] == OLD_CONFIG and plan['before']['helper']['sha'] == OLD_HELPER and (self.package / 'before-current').read_text().strip() == OLD_CONFIG, 'Frozen old baseline mismatch')
        return plan

    def journal(self, phase):
        self.write_json(self.pending, {'tuple': self.tuple(), 'phase': phase})
        self.checkpoint(phase)

    def drift(self, plan):
        require(self.snapshot() == plan['immutable'], 'Immutable frontend state changed')
        for key, path in self.files.items():
            info = self.regular(path, key != 'staged')
            meta = plan['before'][key]
            expected_new = {'vhost': NEW_CONFIG, 'staged': NEW_CONFIG, 'helper': self.tuple()['new_helper'], 'current': digest((NEW_CONFIG + '\n').encode())}[key]
            require(digest(path.read_bytes()) in (meta['sha'], expected_new), 'Unexpected configure file drift: ' + key)
            require((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (meta['uid'], meta['gid'], meta['mode']), 'Configure ownership/mode drift: ' + key)

    def prepare(self, runtime, env_hash, old_helper_hash):
        self.validate_inputs(runtime, env_hash)
        require(old_helper_hash == OLD_HELPER, 'Expected installed helper hash differs')
        with self.lock(inherited=True):
            plan_file = self.package / 'plan.json'
            if not plan_file.exists():
                require(not self.pending.exists() and not self.pending.is_symlink(), 'Pending without frozen plan')
                immutable = self.snapshot()
                before = {}
                for key, path in self.files.items():
                    info = self.regular(path, key != 'staged')
                    expected = OLD_HELPER if key == 'helper' else (digest((OLD_CONFIG + '\n').encode()) if key == 'current' else OLD_CONFIG)
                    require(digest(path.read_bytes()) == expected, 'Old configure baseline mismatch: ' + key)
                    before[key] = {'sha': digest(path.read_bytes()), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}
                    self.atomic(self.package / ('before-' + key), path.read_bytes())
                require(before['helper']['mode'] == 0o755 and before['vhost']['mode'] == 0o644 and (before['staged']['uid'], before['staged']['gid'], before['staged']['mode']) == (1000, 1000, 0o644), 'Unexpected baseline permissions')
                self.write_json(plan_file, {'tuple': self.tuple(), 'before': before, 'immutable': immutable})
            plan = self.plan()
            self.drift(plan)
            if self.pending.exists():
                self.regular(self.pending, True)
                pending = read_json(self.pending)
                require(set(pending) == {'tuple', 'phase'} and pending['tuple'] == self.tuple(), 'Pending tuple mismatch')
            else:
                if self.receipt.exists():
                    self.regular(self.receipt, True)
                    if read_json(self.receipt) == {'tuple': self.tuple(), 'result': 'committed'}:
                        return
                self.journal('prepared')
            # Journal and all rollback bytes already fsynced before replacing privileged helper.
            self.atomic(self.files['helper'], (self.package / 'after-helper').read_bytes(), mode=0o755)

    def service(self):
        active = self.command(['systemctl', 'show', 'nginx', '--property=ActiveState', '--value']).decode().strip()
        require(active in ('active', 'inactive', 'failed'), 'Nginx transitional state')
        self.command(['systemctl', 'reload' if active == 'active' else 'start', 'nginx'])
        self.command(['systemctl', 'is-active', '--quiet', 'nginx'])

    def request(self, suffix='', options=None):
        with tempfile.TemporaryDirectory(prefix='.apk-', dir=self.package) as temporary:
            header, body = Path(temporary) / 'headers', Path(temporary) / 'body'
            args = ['curl', '--silent', '--show-error', '--noproxy', '*', '--proto', '=https', '--connect-timeout', '3', '--max-time', '30', '--max-filesize', '2000000', '-D', str(header), '-o', str(body), '-w', '%{http_code}']
            status = self.command(args + (options or []) + ['https://aerocrm.space/downloads/aeroCRM.apk' + suffix], timeout=35).decode().strip()
            headers = {}
            for line in header.read_text().splitlines():
                if ':' in line:
                    key, value = line.split(':', 1)
                    headers[key.lower()] = value.strip()
            require('location' not in headers and 'set-cookie' not in headers, 'APK leaked redirect/cookie')
            return status, headers, body.read_bytes()

    def probe(self):
        for app, domain, port in TARGETS:
            self.health(app, 'https://' + domain + '/__frontend/health', domain)
            self.health(app, 'https://' + domain + '/__frontend/health')
        status, headers, body = self.request(options=['-H', 'Authorization: Bearer aerocrm-contract-probe', '-H', 'Cookie: aerocrm_contract_probe=1'])
        require(status == '200' and len(body) == 1411514 and digest(body) == APK_SHA, 'APK exact bytes mismatch')
        require(headers.get('content-type', '').split(';')[0] == 'application/vnd.android.package-archive' and headers.get('cache-control') == 'no-store' and headers.get('x-content-type-options') == 'nosniff' and headers.get('content-disposition') == 'attachment; filename="aeroCRM.apk"', 'APK headers mismatch')
        status, head, empty = self.request(options=['--head'])
        require(status == '200' and head.get('content-length') == '1411514', 'APK HEAD mismatch')
        validator = headers.get('etag') or headers.get('last-modified')
        require(validator and '\r' not in validator and '\n' not in validator, 'APK range validator missing')
        status, partial, data = self.request(options=['-H', 'Range: bytes=0-31', '-H', 'If-Range: ' + validator])
        require(status == '206' and partial.get('content-range') == 'bytes 0-31/1411514' and data == body[:32], 'APK Range/If-Range mismatch')
        require(self.request(options=['-X', 'POST'])[0] == '405', 'APK POST gate mismatch')
        require(self.request('?aerocrm_contract_probe=1')[0] == '400', 'APK query gate mismatch')

    def restore(self, plan):
        self.journal('rolling-back')
        # Keep current workers serving even if the old static upstream cannot lint.
        for key in ('vhost', 'staged'):
            meta = plan['before'][key]
            self.atomic(self.files[key], (self.package / ('before-' + key)).read_bytes(), meta['uid'], meta['gid'], meta['mode'])
        self.command(['nginx', '-t'])
        self.service()
        self.probe()
        require(self.snapshot() == plan['immutable'], 'Rollback immutable proof failed')
        for key in ('current', 'helper'):
            meta = plan['before'][key]
            self.atomic(self.files[key], (self.package / ('before-' + key)).read_bytes(), meta['uid'], meta['gid'], meta['mode'])
        self.write_json(self.receipt, {'tuple': self.tuple(), 'result': 'rolled-back'})
        self.pending.unlink()
        self.fsync_directory(self.state)

    def configure(self, runtime, env_hash, old_config_hash):
        self.validate_inputs(runtime, env_hash, old_config_hash)
        with self.lock():
            plan = self.plan()
            self.drift(plan)
            if not self.pending.exists():
                self.regular(self.receipt, True)
                receipt = read_json(self.receipt)
                require(receipt == {'tuple': self.tuple(), 'result': 'committed'}, 'No matching committed receipt')
                require(all(digest(self.files[k].read_bytes()) == expected for k, expected in {'vhost': NEW_CONFIG, 'staged': NEW_CONFIG, 'helper': self.tuple()['new_helper'], 'current': digest((NEW_CONFIG + '\n').encode())}.items()), 'Committed file drift')
                self.probe()
                return
            self.regular(self.pending, True)
            pending = read_json(self.pending)
            require(set(pending) == {'tuple', 'phase'} and pending['tuple'] == self.tuple() and pending['phase'] in ('prepared', 'installing', 'validating', 'committing', 'rolling-back', 'rollback-blocked'), 'Pending tuple/phase mismatch')
            try:
                self.journal('installing')
                for key in ('vhost', 'staged'):
                    meta = plan['before'][key]
                    self.atomic(self.files[key], (self.package / 'after.conf').read_bytes(), meta['uid'], meta['gid'], meta['mode'])
                self.journal('validating')
                self.command(['nginx', '-t'])
                self.service()
                self.probe()
                self.drift(plan)
                self.journal('committing')
                meta = plan['before']['current']
                self.atomic(self.files['current'], (NEW_CONFIG + '\n').encode(), meta['uid'], meta['gid'], meta['mode'])
                self.write_json(self.receipt, {'tuple': self.tuple(), 'result': 'committed'})
                self.checkpoint('receipt')
                self.pending.unlink()
                self.fsync_directory(self.state)
                self.checkpoint('complete')
            except Exception:
                try:
                    self.drift(plan)
                    self.restore(plan)
                except Exception:
                    self.journal('rollback-blocked')
                raise RuntimeError('Configure failed; root-owned receipt/journal retained as applicable; exact rerun required') from None

def main():
    require(len(sys.argv) == 5 and sys.argv[1] in ('prepare', 'configure'), 'Usage: prepare|configure runtimeSHA envHash oldHelperHash|oldConfigHash')
    controller = Controller()
    getattr(controller, sys.argv[1])(*sys.argv[2:])
    print('Frontend config-only transaction verified; runtime/container/env/certificate state preserved')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
