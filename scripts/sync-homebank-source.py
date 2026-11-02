#!/usr/bin/env python3
"""Forward one validated HomeBank copy over explicit, certificate-verified FTPS.

No application initialization, database access or changes to original files.
"""
import argparse
import ftplib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import ssl
import stat
import sys
import tempfile
import uuid

MAX_BYTES = 50 * 1024 * 1024
FIELDS = {'FTP_HOST', 'FTP_PORT', 'FTP_USERNAME', 'FTP_PASSWORD', 'LOCAL_DIRECTORY',
          'SELECTED_FILE', 'REMOTE_DIRECTORY', 'REMOTE_FILENAME', 'STATE_FILE'}


class SyncError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def private_file(filename):
    info = filename.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise SyncError('invalid_config')


def safe_name(value):
    return bool(value and len(value) <= 250 and not value.startswith('.') and
                value.lower().endswith('.xhb') and not any(c in value for c in '/\\\r\n\0'))


def read_config(filename):
    try:
        filename = Path(filename)
        if not filename.is_absolute():
            raise SyncError('invalid_config')
        private_file(filename)
        values = {}
        for line in filename.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            key, separator, value = line.partition('=')
            key, value = key.strip(), value.strip()
            if not separator or key not in FIELDS or key in values:
                raise SyncError('invalid_config')
            if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
                value = value[1:-1]
            if '\0' in value or '\r' in value or '\n' in value:
                raise SyncError('invalid_config')
            values[key] = value
        for key in ['FTP_HOST', 'FTP_USERNAME', 'FTP_PASSWORD', 'LOCAL_DIRECTORY', 'REMOTE_DIRECTORY']:
            if not values.get(key):
                raise SyncError('invalid_config')
        host = values['FTP_HOST']
        if any(c.isspace() or c in '/\\:@' for c in host):
            raise SyncError('invalid_config')
        port = int(values.get('FTP_PORT') or '21')
        if not 1 <= port <= 65535:
            raise SyncError('invalid_config')
        local = Path(values['LOCAL_DIRECTORY'])
        remote = PurePosixPath(values['REMOTE_DIRECTORY'])
        selected = values.get('SELECTED_FILE', '')
        remote_name = values.get('REMOTE_FILENAME') or 'current.xhb'
        state = Path(values.get('STATE_FILE') or str(filename) + '.state')
        if (not local.is_absolute() or not local.is_dir() or not remote.is_absolute() or
                '..' in remote.parts or not state.is_absolute() or not state.parent.is_dir() or
                state.suffix.lower() == '.xhb' or state.resolve() == filename.resolve() or
                (selected and not safe_name(selected)) or not safe_name(remote_name)):
            raise SyncError('invalid_config')
        return {**values, 'FTP_PORT': port, 'LOCAL_DIRECTORY': local,
                'REMOTE_DIRECTORY': str(remote), 'REMOTE_FILENAME': remote_name,
                'SELECTED_FILE': selected, 'STATE_FILE': state}
    except SyncError:
        raise
    except Exception:
        raise SyncError('invalid_config') from None


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_source(filename):
    before = filename.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES:
        raise SyncError('source_invalid')
    with filename.open('rb') as stream:
        if identity(os.fstat(stream.fileno())) != identity(before):
            raise SyncError('source_changed')
        data = stream.read(MAX_BYTES + 1)
        after = os.fstat(stream.fileno())
    if len(data) > MAX_BYTES:
        raise SyncError('source_invalid')
    if identity(before) != identity(after) or identity(before) != identity(filename.lstat()):
        raise SyncError('source_changed')
    return data, identity(before)


def choose_source(config):
    try:
        directory = config['LOCAL_DIRECTORY']
        if config['SELECTED_FILE']:
            selected = directory / config['SELECTED_FILE']
            if not stat.S_ISREG(selected.lstat().st_mode):
                raise SyncError('source_invalid')
            return selected
        candidates = []
        for candidate in directory.iterdir():
            if safe_name(candidate.name) and stat.S_ISREG(candidate.lstat().st_mode):
                candidates.append((candidate.lstat().st_mtime_ns, candidate.name, candidate))
        if not candidates:
            raise SyncError('source_unavailable')
        return sorted(candidates, key=lambda value: (-value[0], value[1]))[0][2]
    except SyncError:
        raise
    except Exception:
        raise SyncError('source_unavailable') from None


def parser():
    location = Path(__file__).resolve().parents[1] / 'server' / 'homebank_parse.py'
    spec = importlib.util.spec_from_file_location('homebank_sync_parser', location)
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module.parse


def stable_source(filename, expected_identity, expected_hash):
    try:
        data, current_identity = read_source(filename)
        if current_identity != expected_identity or hashlib.sha256(data).hexdigest() != expected_hash:
            raise SyncError('source_changed')
    except Exception:
        raise SyncError('source_changed') from None


def saved_state(filename):
    try:
        if not filename.exists() and not filename.is_symlink():
            return None
        private_file(filename)
        return json.loads(filename.read_text(encoding='utf-8'))
    except Exception:
        raise SyncError('state_unavailable') from None


def save_state(filename, value):
    temporary = None
    try:
        if filename.exists() or filename.is_symlink():
            private_file(filename)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', prefix='.homebank-sync-',
                                         dir=filename.parent, delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            json.dump(value, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, filename)
    except Exception:
        raise SyncError('state_unavailable') from None
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def sync_once(config, force=False, ftp_factory=ftplib.FTP_TLS):
    source = choose_source(config)
    try:
        data, source_identity = read_source(source)
        source_hash = hashlib.sha256(data).hexdigest()
        parser()(str(source))
        stable_source(source, source_identity, source_hash)
    except SyncError:
        raise
    except Exception:
        raise SyncError('source_invalid') from None
    target = json.dumps([config['FTP_HOST'], config['FTP_PORT'], config['FTP_USERNAME'],
                         config['REMOTE_DIRECTORY'], config['REMOTE_FILENAME']])
    state = {'sha256': source_hash, 'filename': source.name,
             'target': hashlib.sha256(target.encode('utf-8')).hexdigest()}
    if saved_state(config['STATE_FILE']) == state and not force:
        return 'unchanged'
    ftp = None
    temporary = None
    try:
        ftp = ftp_factory(context=ssl.create_default_context(), timeout=60)
        ftp.connect(config['FTP_HOST'], config['FTP_PORT'])
        ftp.login(config['FTP_USERNAME'], config['FTP_PASSWORD'])
        ftp.prot_p()
        ftp.cwd(config['REMOTE_DIRECTORY'])
        temporary = '.homebank-source.' + uuid.uuid4().hex + '.uploading'
        ftp.storbinary('STOR ' + temporary, io.BytesIO(data), blocksize=65536)
        stable_source(source, source_identity, source_hash)
        ftp.rename(temporary, config['REMOTE_FILENAME'])
        temporary = None
        save_state(config['STATE_FILE'], state)
        return 'uploaded'
    except SyncError:
        raise
    except Exception:
        raise SyncError('transfer_failed') from None
    finally:
        if ftp is not None:
            if temporary is not None:
                try:
                    ftp.delete(temporary)
                except Exception:
                    pass
            try:
                ftp.quit()
            except Exception:
                try:
                    ftp.close()
                except Exception:
                    pass


def main(argv=None):
    class SafeArguments(argparse.ArgumentParser):
        def error(self, message):
            self.exit(2, 'homebank_sync: invalid_arguments\n')
    arguments = SafeArguments(description='Forward one private HomeBank source over verified FTPS')
    arguments.add_argument('--config', required=True, help='Absolute path to a private 0600 configuration file')
    arguments.add_argument('--force', action='store_true', help='Transfer even when the successful source hash is unchanged')
    args = arguments.parse_args(argv)
    try:
        outcome = sync_once(read_config(args.config), force=args.force)
        print('homebank_sync: ' + outcome)
        return 0
    except SyncError as error:
        print('homebank_sync: ' + error.code, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('homebank_sync: interrupted', file=sys.stderr)
        return 130
    except Exception:
        print('homebank_sync: failed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
