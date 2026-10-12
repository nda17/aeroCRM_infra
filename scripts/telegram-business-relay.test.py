#!/usr/bin/env python3
"""Offline reload-race and rollback checks for the scoped relay update."""
import base64
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPT = Path(__file__).with_name('telegram-business-relay.py')
SPEC = importlib.util.spec_from_file_location('telegram_business_relay', SCRIPT)
RELAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELAY)


class RelayProbeTests(unittest.TestCase):
    def test_probe_requires_both_http_401_and_verified_tls(self):
        route = RELAY.WEBHOOK_ROUTES['business']
        for fields, accepted in [(b'401 0', True), (b'404 0', False), (b'401 1', False)]:
            with self.subTest(fields=fields), mock.patch.object(RELAY.subprocess, 'run',
                    return_value=SimpleNamespace(returncode=0, stdout=fields)):
                self.assertEqual(RELAY.probe(route), accepted)

    def test_transient_business_404_passes_when_next_reload_probe_is_strict_401_tls0(self):
        calls = []
        pauses = []

        def probe(route):
            calls.append(route)
            if route == RELAY.WEBHOOK_ROUTES['business'] and len(calls) <= 3:
                return 'http404_tls0'
            return 'http401_tls0'

        good, attempts, statuses = RELAY.probe_after_reload(probe, pauses.append)
        self.assertTrue(good)
        self.assertEqual(attempts, 2)
        self.assertEqual(len(calls), 6)
        self.assertEqual(pauses, [0.5])
        self.assertEqual(set(statuses.values()), {'http401_tls0'})

    def test_persistent_probe_failure_restores_both_files_and_reloads_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            vhost = root / 'telegram.aerocrm.space'
            enabled = root / 'zz-telegram.aerocrm.space'
            snippet = root / 'aerocrm-telegram-webhooks.conf'
            marker = root / '.aerocrm-telegram-business-relay.json'
            original_vhost = (b'server {\n  location ~ ^/telegram-api/(bot[0-9]+:[A-Za-z0-9_-]+)/('
                              + RELAY.OLD_METHODS + b')$ {\n    return 404;\n  }\n}\n')
            original_snippet = (b'location = /api/v1/telegram-bot/webhook {\n return 401;\n}\n\n'
                                b'location = /api/v1/telegram-bot/support-webhook {\n return 401;\n}\n')
            target_snippet = (original_snippet.rstrip(b'\n') + b'\n\n'
                              b'location = /api/v1/telegram-bot/business-webhook {\n return 401;\n}\n')
            vhost.write_bytes(original_vhost)
            snippet.write_bytes(original_snippet)
            enabled.symlink_to(vhost)
            reloads = []

            def run(command):
                if command == ['systemctl', 'reload', 'nginx']:
                    reloads.append(command)
                return True

            real_retry = RELAY.probe_after_reload
            failed_retry = lambda: real_retry(lambda _: 'http404_tls0', lambda _: None)
            output = io.StringIO()
            with mock.patch.multiple(RELAY, VHOST=vhost, ENABLED=enabled, SNIPPET=snippet,
                                     MARKER=marker, BASE_VHOST_HASH=RELAY.sha(original_vhost),
                                     BASE_SNIPPET_HASH=RELAY.sha(original_snippet)), \
                    mock.patch.object(RELAY.os, 'geteuid', return_value=0), \
                    mock.patch.object(RELAY, 'run', side_effect=run), \
                    mock.patch.object(RELAY, 'probe', return_value=True), \
                    mock.patch.object(RELAY, 'probe_after_reload', side_effect=failed_retry), \
                    mock.patch.dict(os.environ, {'TELEGRAM_SNIPPET_BASE64':
                                                  base64.b64encode(target_snippet).decode()}), \
                    contextlib.redirect_stdout(output):
                with self.assertRaises(SystemExit) as stopped:
                    RELAY.main()
            self.assertEqual(stopped.exception.code, 1)
            self.assertEqual(vhost.read_bytes(), original_vhost)
            self.assertEqual(snippet.read_bytes(), original_snippet)
            self.assertFalse(marker.exists())
            self.assertEqual(len(reloads), 2, output.getvalue())
            result = json.loads(output.getvalue())
            self.assertEqual(result['failedStage'], 'webhook_probe')
            self.assertEqual(result['webhookProbeAttempts'], 5)
            self.assertEqual(result['webhookProbeStatuses']['business'], 'http404_tls0')
            self.assertTrue(result['rollbackValid'] and result['rollbackReloaded'])


if __name__ == '__main__':
    unittest.main()
