"""Synthetic source files and a fake FTP transport; no real vault or FTP access."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import stat
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'sync-homebank-source.py'
SPEC = importlib.util.spec_from_file_location('homebank_source_sync_test', SCRIPT)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)
XML = b'<homebank v="1.6"><account key="1" name="Synthetic account" type="1" initial="123"/></homebank>'


class FakeFTP:
    def __init__(self, fail=None, on_transfer=None):
        self.fail = fail
        self.on_transfer = on_transfer
        self.events = []
        self.files = {'current.xhb': b'Prior remote source', '.another.uploading': b'Other process'}
        self.context = None

    def factory(self, *, context, timeout):
        self.context = context
        self.timeout = timeout
        return self

    def connect(self, host, port):
        self.events.append(('connect', host, port))

    def login(self, username, password):
        self.events.append(('login',))
        if self.fail == 'login':
            raise RuntimeError('Private credentials must never appear')

    def prot_p(self):
        self.events.append(('protected_data',))

    def cwd(self, directory):
        self.events.append(('cwd', directory))

    def storbinary(self, command, stream, blocksize):
        name = command.removeprefix('STOR ')
        self.events.append(('store', name))
        self.files[name] = stream.read()
        if self.on_transfer:
            self.on_transfer()
        if self.fail == 'transfer':
            raise RuntimeError('Private transfer detail must never appear')

    def rename(self, before, after):
        self.events.append(('rename', before, after))
        if self.fail == 'rename':
            raise RuntimeError('Private server details must never appear')
        self.files[after] = self.files.pop(before)

    def delete(self, name):
        self.events.append(('delete', name))
        del self.files[name]

    def quit(self):
        self.events.append(('quit',))


class HomeBankSourceSyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='synthetic-homebank-source-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.local = self.root / 'local'
        self.local.mkdir()
        self.source = self.local / 'synthetic.xhb'
        self.source.write_bytes(XML)
        self.config_file = self.root / '.env.homebank-sync'
        self.write_config()

    def write_config(self, extra=''):
        self.config_file.write_text('FTP_HOST=dahost12.vpslocal.co.za\nFTP_PORT=21\n'
                                    'FTP_USERNAME=synthetic-login\nFTP_PASSWORD="synthetic#password"\n'
                                    f'LOCAL_DIRECTORY={self.local}\n'
                                    'REMOTE_DIRECTORY=/private/synthetic-homebank\n' + extra)
        self.config_file.chmod(0o600)
        self.config = sync.read_config(self.config_file)

    def test_verified_control_and_data_upload_then_atomic_replace_and_private_state(self):
        ftp = FakeFTP()
        before = self.source.read_bytes()
        self.assertEqual(sync.sync_once(self.config, ftp_factory=ftp.factory), 'uploaded')
        self.assertTrue(ftp.context.check_hostname)
        self.assertEqual(ftp.context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(ftp.events[0], ('connect', 'dahost12.vpslocal.co.za', 21))
        store = next(event for event in ftp.events if event[0] == 'store')
        self.assertTrue(store[1].startswith('.homebank-source.'))
        self.assertTrue(store[1].endswith('.uploading'))
        self.assertLess(ftp.events.index(('protected_data',)), ftp.events.index(store))
        self.assertEqual(ftp.files['current.xhb'], XML)
        self.assertEqual(ftp.files['.another.uploading'], b'Other process')
        self.assertEqual(self.source.read_bytes(), before)
        state_file = self.config['STATE_FILE']
        self.assertEqual(stat.S_IMODE(state_file.stat().st_mode), 0o600)
        state = json.loads(state_file.read_text())
        self.assertEqual(state['sha256'], hashlib.sha256(XML).hexdigest())
        self.assertEqual(state['filename'], 'synthetic.xhb')
        self.assertNotIn('synthetic#password', state_file.read_text())

    def test_unchanged_skips_ftp_but_force_and_changed_source_transfer(self):
        first = FakeFTP()
        sync.sync_once(self.config, ftp_factory=first.factory)
        unused = FakeFTP()
        self.assertEqual(sync.sync_once(self.config, ftp_factory=unused.factory), 'unchanged')
        self.assertEqual(unused.events, [])
        self.assertEqual(sync.sync_once(self.config, force=True, ftp_factory=unused.factory), 'uploaded')
        self.source.write_bytes(XML.replace(b'123', b'456'))
        changed = FakeFTP()
        self.assertEqual(sync.sync_once(self.config, ftp_factory=changed.factory), 'uploaded')
        self.assertIn(b'456', changed.files['current.xhb'])

    def test_newest_regular_source_selection_and_explicit_selection_never_follow_symlinks(self):
        other = self.local / 'newest.xhb'
        other.write_bytes(XML.replace(b'123', b'987'))
        os.utime(self.source, ns=(1000000000, 1000000000))
        os.utime(other, ns=(2000000000, 2000000000))
        (self.local / 'ignored.xhb').symlink_to(other)
        (self.local / '.hidden.xhb').write_bytes(XML)
        self.assertEqual(sync.choose_source(self.config), other)
        self.write_config('SELECTED_FILE=synthetic.xhb\n')
        self.assertEqual(sync.choose_source(self.config), self.source)
        self.write_config('SELECTED_FILE=ignored.xhb\n')
        with self.assertRaisesRegex(sync.SyncError, 'source_invalid'):
            sync.sync_once(self.config, ftp_factory=FakeFTP().factory)

    def test_malformed_oversized_and_duplicate_account_sources_never_contact_ftp(self):
        for contents in [b'<not-homebank/>', b'<homebank>',
                         b'<homebank><account key="1"/><account key="1"/></homebank>']:
            self.source.write_bytes(contents)
            ftp = FakeFTP()
            with self.assertRaisesRegex(sync.SyncError, 'source_invalid'):
                sync.sync_once(self.config, ftp_factory=ftp.factory)
            self.assertEqual(ftp.events, [])
        with self.source.open('wb') as stream:
            stream.truncate(sync.MAX_BYTES + 1)
        with self.assertRaisesRegex(sync.SyncError, 'source_invalid'):
            sync.sync_once(self.config, ftp_factory=FakeFTP().factory)

    def test_change_during_transfer_preserves_current_and_cleans_only_own_temporary_file(self):
        ftp = FakeFTP(on_transfer=lambda: self.source.write_bytes(XML.replace(b'123', b'456')))
        with self.assertRaisesRegex(sync.SyncError, 'source_changed'):
            sync.sync_once(self.config, ftp_factory=ftp.factory)
        self.assertEqual(ftp.files, {'current.xhb': b'Prior remote source', '.another.uploading': b'Other process'})
        self.assertFalse(any(event[0] == 'rename' for event in ftp.events))
        self.assertFalse(self.config['STATE_FILE'].exists())

    def test_a_change_during_validation_prevents_any_ftp_connection(self):
        ftp = FakeFTP()
        def changed_source(filename):
            Path(filename).write_bytes(XML.replace(b'123', b'456'))
        with mock.patch.object(sync, 'parser', return_value=changed_source):
            with self.assertRaisesRegex(sync.SyncError, 'source_changed'):
                sync.sync_once(self.config, ftp_factory=ftp.factory)
        self.assertEqual(ftp.events, [])

    def test_failed_transfer_or_rename_preserves_current_and_success_state(self):
        sync.sync_once(self.config, ftp_factory=FakeFTP().factory)
        state = self.config['STATE_FILE'].read_bytes()
        self.source.write_bytes(XML.replace(b'123', b'456'))
        for reason in ['login', 'transfer', 'rename']:
            ftp = FakeFTP(fail=reason)
            with self.assertRaisesRegex(sync.SyncError, 'transfer_failed'):
                sync.sync_once(self.config, ftp_factory=ftp.factory)
            self.assertEqual(ftp.files, {'current.xhb': b'Prior remote source', '.another.uploading': b'Other process'})
            self.assertEqual(self.config['STATE_FILE'].read_bytes(), state)

    def test_a_different_remote_destination_is_not_skipped_by_an_old_success_hash(self):
        sync.sync_once(self.config, ftp_factory=FakeFTP().factory)
        self.write_config('REMOTE_FILENAME=alternate.xhb\n')
        ftp = FakeFTP()
        self.assertEqual(sync.sync_once(self.config, ftp_factory=ftp.factory), 'uploaded')
        self.assertEqual(ftp.files['alternate.xhb'], XML)
        self.assertEqual(ftp.files['current.xhb'], b'Prior remote source')

    def test_configuration_rejects_public_permissions_relative_paths_and_command_injection(self):
        self.config_file.chmod(0o644)
        with self.assertRaisesRegex(sync.SyncError, 'invalid_config'):
            sync.read_config(self.config_file)
        self.write_config()
        with self.assertRaisesRegex(sync.SyncError, 'invalid_config'):
            sync.read_config('.env.homebank-sync')
        original = self.config_file.read_text()
        for invalid in [original + 'SELECTED_FILE=../synthetic.xhb\n',
                        original + 'REMOTE_FILENAME=../current.xhb\n',
                        original + f'STATE_FILE={self.source}\n',
                        original + f'STATE_FILE={self.config_file}\n',
                        original.replace('dahost12.vpslocal.co.za', 'not-allowed@host'),
                        original.replace('/private/synthetic-homebank', '/private/../elsewhere')]:
            self.config_file.write_text(invalid)
            with self.assertRaisesRegex(sync.SyncError, 'invalid_config'):
                sync.read_config(self.config_file)

    def test_cli_reports_only_sanitized_status_for_invalid_private_source(self):
        self.source.write_bytes(b'Synthetic private details must never appear')
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = sync.main(['--config', str(self.config_file)])
        self.assertEqual(result, 1)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(errors.getvalue(), 'homebank_sync: source_invalid\n')
        self.assertNotIn(self.source.name, errors.getvalue())


if __name__ == '__main__':
    unittest.main()
