#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(scriptDir, '../nginx/telegram-bridge/telegram-webhooks.locations.conf');
const sshPath = path.join(scriptDir, 'ssh.mjs');
const configBase64 = fs.readFileSync(configPath).toString('base64');

// Read-only relay inspection on 2026-09-20. Refuse a changed vhost for review.
const expectedVhostSha256 = '91d9434f652289081fd0acc7a09649230b563d5690da118ed73291dde3caeac0';
const remoteScript = String.raw`#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import base64
import datetime
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

vhost = Path('/etc/nginx/sites-available/telegram.aerocrm.space')
enabled = Path('/etc/nginx/sites-enabled/zz-telegram.aerocrm.space')
snippet = Path('/etc/nginx/snippets/aerocrm-telegram-webhooks.conf')
expected = '${expectedVhostSha256}'
content = base64.b64decode('${configBase64}', validate=True)

def report(**values):
    print(json.dumps(values, sort_keys=True), flush=True)

def run(args, timeout=30):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    return result.returncode == 0

def atomic_write(destination, data):
    fd, temporary = tempfile.mkstemp(prefix='.aerocrm-telegram-', dir=destination.parent)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

if os.geteuid() != 0:
    report(applied=False, reason='root_required')
    raise SystemExit(1)
if not enabled.is_symlink() or enabled.resolve() != vhost:
    report(applied=False, reason='unexpected_enabled_vhost')
    raise SystemExit(1)
if snippet.exists():
    report(applied=False, reason='snippet_already_exists')
    raise SystemExit(1)
original = vhost.read_bytes()
if hashlib.sha256(original).hexdigest() != expected:
    report(applied=False, reason='vhost_changed_since_inspection')
    raise SystemExit(1)
if not run(['nginx', '-t']):
    report(applied=False, reason='existing_nginx_config_invalid')
    raise SystemExit(1)

text = original.decode('utf-8')
fallback = list(re.finditer(r'(?m)^([ \t]*)location / \{\r?\n[ \t]+return 404;\r?\n[ \t]*\}', text))
if len(fallback) != 2:
    report(applied=False, reason='unexpected_fallback_layout')
    raise SystemExit(1)
last = fallback[-1]
include = last.group(1) + 'include /etc/nginx/snippets/aerocrm-telegram-webhooks.conf;\n\n'
updated = (text[:last.start()] + include + text[last.start():]).encode('utf-8')

stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = vhost.with_name(vhost.name + '.pre-crm-webhooks-' + stamp + '-' + str(os.getpid()))
with backup.open('xb') as output:
    os.fchmod(output.fileno(), 0o644)
    output.write(original)
    output.flush()
    os.fsync(output.fileno())

stage = 'install'
probe_results = {}
try:
    atomic_write(snippet, content)
    atomic_write(vhost, updated)
    stage = 'nginx_test'
    if not run(['nginx', '-t']):
        raise RuntimeError(stage)
    stage = 'nginx_reload'
    if not run(['systemctl', 'reload', 'nginx']):
        raise RuntimeError(stage)
    stage = 'loopback_probe'
    for webhook_path in ('/api/v1/telegram-bot/webhook', '/api/v1/telegram-bot/support-webhook'):
        samples = []
        for attempt in range(10):
            result = subprocess.run([
                'curl', '--noproxy', '*', '--silent', '--show-error',
                '--resolve', 'telegram.aerocrm.space:443:127.0.0.1',
                '--connect-timeout', '5', '--max-time', '15', '--request', 'POST',
                '--header', 'Content-Type: application/json', '--data', '{}',
                '--output', '/dev/null', '--write-out', '%{http_code} %{ssl_verify_result}',
                'https://telegram.aerocrm.space' + webhook_path
            ], capture_output=True, timeout=18)
            values = result.stdout.split()
            samples.append({'exit': result.returncode,
                            'http': values[0].decode() if values else None,
                            'tls': values[1].decode() if len(values) > 1 else None})
            if result.returncode == 0 and values == [b'401', b'0']:
                break
            if attempt < 9:
                time.sleep(0.5)
        probe_results[webhook_path] = samples[-3:]
        if samples[-1] != {'exit': 0, 'http': '401', 'tls': '0'}:
            raise RuntimeError(stage)
except Exception:
    atomic_write(vhost, original)
    snippet.unlink(missing_ok=True)
    rollback_valid = run(['nginx', '-t'])
    rollback_reloaded = rollback_valid and run(['systemctl', 'reload', 'nginx'])
    report(applied=False, failedStage=stage, rollbackValid=rollback_valid,
           rollbackReloaded=rollback_reloaded, backup=str(backup),
           probeResults=probe_results)
    raise SystemExit(1)

report(applied=True, backup=str(backup),
       vhostSha256=hashlib.sha256(updated).hexdigest(),
       snippetSha256=hashlib.sha256(content).hexdigest(),
       probeResults=probe_results)
PY
`;

const result = spawnSync(process.execPath, [sshPath, 'telegram-relay', '/dev/stdin'], {
  cwd: scriptDir,
  input: remoteScript,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exitCode = result.status || 1;
