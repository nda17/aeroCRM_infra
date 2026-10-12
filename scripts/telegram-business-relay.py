#!/usr/bin/env python3
"""Scoped, repeatable nginx update for the existing Telegram relay."""
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

VHOST = Path('/etc/nginx/sites-available/telegram.aerocrm.space')
ENABLED = Path('/etc/nginx/sites-enabled/zz-telegram.aerocrm.space')
SNIPPET = Path('/etc/nginx/snippets/aerocrm-telegram-webhooks.conf')
MARKER = Path('/etc/nginx/.aerocrm-telegram-business-relay.json')
BASE_VHOST_HASH = 'a5a42d9aac4f58211c10cbfbaf07b180ef75509379c6ff02617d51a1af0811ef'
BASE_SNIPPET_HASH = 'f62888c938e14b75dfccda946e0a513c50ab6515a7d4fa4dc5f2d9da1feeb387'
OLD_METHODS = b'getMe|getWebhookInfo|deleteWebhook|setWebhook|sendMessage|sendDocument|getFile|copyMessage|answerCallbackQuery'
NEW_METHODS = OLD_METHODS + b'|getBusinessConnection'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fail(reason):
    print(json.dumps({'applied': False, 'reason': reason}, sort_keys=True), flush=True)
    raise SystemExit(1)


def run(args):
    try:
        result = subprocess.run(args, capture_output=True, timeout=30, check=False)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def write_atomic(destination, data, mode):
    fd, temporary = tempfile.mkstemp(prefix='.aerocrm-telegram-business-', dir=destination.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def backup(destination, data, stamp):
    saved = destination.with_name(destination.name + '.pre-telegram-business-' + stamp)
    fd = os.open(saved, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    return saved


def probe(webhook_path):
    try:
        result = subprocess.run([
            'curl', '--noproxy', '*', '--silent', '--show-error',
            '--resolve', 'telegram.aerocrm.space:443:127.0.0.1',
            '--connect-timeout', '5', '--max-time', '15', '--request', 'POST',
            '--header', 'Content-Type: application/json', '--data', '{}',
            '--output', '/dev/null', '--write-out', '%{http_code} %{ssl_verify_result}',
            'https://telegram.aerocrm.space' + webhook_path
        ], capture_output=True, timeout=18)
        return result.returncode == 0 and result.stdout.split() == [b'401', b'0']
    except (OSError, subprocess.TimeoutExpired):
        return False


if os.geteuid() != 0:
    fail('root_required')
if not ENABLED.is_symlink() or ENABLED.resolve() != VHOST:
    fail('unexpected_enabled_vhost')
for item in (VHOST, SNIPPET):
    if not item.is_file() or item.is_symlink():
        fail('unexpected_nginx_file')
if not run(['nginx', '-t']):
    fail('existing_nginx_config_invalid')
try:
    content = base64.b64decode(os.environ['TELEGRAM_SNIPPET_BASE64'], validate=True)
except (KeyError, ValueError):
    fail('invalid_reviewed_snippet')
if len(content) > 16_384 or content.count(b'location = /api/v1/telegram-bot/business-webhook {') != 1:
    fail('unexpected_reviewed_snippet')
original_vhost = VHOST.read_bytes()
original_snippet = SNIPPET.read_bytes()
vhost_hash = sha(original_vhost)
snippet_hash = sha(original_snippet)
target_line = b'location ~ ^/telegram-api/(bot[0-9]+:[A-Za-z0-9_-]+)/(' + NEW_METHODS + b')$ {'
original_line = b'location ~ ^/telegram-api/(bot[0-9]+:[A-Za-z0-9_-]+)/(' + OLD_METHODS + b')$ {'

if MARKER.exists():
    marker_stat = MARKER.lstat()
    if MARKER.is_symlink() or not MARKER.is_file() or marker_stat.st_mode & 0o777 != 0o600:
        fail('unsafe_existing_marker')
    try:
        marker = json.loads(MARKER.read_text())
    except (OSError, ValueError):
        fail('invalid_existing_marker')
    if marker != {'baseVhostSha256': BASE_VHOST_HASH, 'baseSnippetSha256': BASE_SNIPPET_HASH,
                  'targetVhostSha256': vhost_hash, 'targetSnippetSha256': sha(content)} or \
            original_snippet != content or original_vhost.count(target_line) != 1:
        fail('relay_drift_after_install')
    if not all(probe(route) for route in (
        '/api/v1/telegram-bot/webhook', '/api/v1/telegram-bot/support-webhook',
        '/api/v1/telegram-bot/business-webhook'
    )):
        fail('relay_probe_failed_after_install')
    print(json.dumps({'applied': False, 'unchanged': True, 'vhostSha256': vhost_hash,
                      'snippetSha256': snippet_hash}, sort_keys=True))
    raise SystemExit(0)

if vhost_hash != BASE_VHOST_HASH or snippet_hash != BASE_SNIPPET_HASH:
    fail('relay_changed_since_review')
if original_vhost.count(original_line) != 1 or original_vhost.count(target_line) != 0:
    fail('unexpected_egress_allowlist')
if original_snippet.count(b'location = /api/v1/telegram-bot/') != 2 or \
        not content.startswith(original_snippet.rstrip(b'\n') + b'\n\n'):
    fail('reviewed_snippet_changed_existing_routes')
updated_vhost = original_vhost.replace(original_line, target_line, 1)
if not probe('/api/v1/telegram-bot/webhook') or not probe('/api/v1/telegram-bot/support-webhook'):
    fail('existing_webhook_probe_failed')

stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(os.getpid())
vhost_backup = backup(VHOST, original_vhost, stamp)
snippet_backup = backup(SNIPPET, original_snippet, stamp)
stage = 'write'
try:
    write_atomic(SNIPPET, content, 0o644)
    write_atomic(VHOST, updated_vhost, 0o644)
    stage = 'nginx_test'
    if not run(['nginx', '-t']):
        raise RuntimeError(stage)
    stage = 'nginx_reload'
    if not run(['systemctl', 'reload', 'nginx']):
        raise RuntimeError(stage)
    stage = 'webhook_probe'
    if not all(probe(route) for route in (
        '/api/v1/telegram-bot/webhook', '/api/v1/telegram-bot/support-webhook',
        '/api/v1/telegram-bot/business-webhook'
    )):
        raise RuntimeError(stage)
    marker = {'baseVhostSha256': BASE_VHOST_HASH, 'baseSnippetSha256': BASE_SNIPPET_HASH,
              'targetVhostSha256': sha(updated_vhost), 'targetSnippetSha256': sha(content)}
    write_atomic(MARKER, (json.dumps(marker, sort_keys=True) + '\n').encode(), 0o600)
except Exception:
    write_atomic(VHOST, original_vhost, 0o644)
    write_atomic(SNIPPET, original_snippet, 0o644)
    valid = run(['nginx', '-t'])
    reloaded = valid and run(['systemctl', 'reload', 'nginx'])
    print(json.dumps({'applied': False, 'failedStage': stage, 'rollbackValid': valid,
                      'rollbackReloaded': reloaded, 'vhostBackup': str(vhost_backup),
                      'snippetBackup': str(snippet_backup)}, sort_keys=True))
    raise SystemExit(1)

print(json.dumps({'applied': True, 'vhostSha256': sha(updated_vhost),
                  'snippetSha256': sha(content), 'webhookProbes': 3,
                  'vhostBackup': str(vhost_backup), 'snippetBackup': str(snippet_backup)}, sort_keys=True))
