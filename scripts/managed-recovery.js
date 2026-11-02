#!/usr/bin/env node
'use strict';
// Independent of app startup: no transport, secret generation or implicit DB.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const { quarantine } = require('./email-restore-safety');
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
function absolute(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\r\n\0]/.test(input)) throw new Error('Absolute path required');
  return path.resolve(input);
}
function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe snapshot path');
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new Error('Unsafe snapshot path');
  return target;
}
function regularPath(target, directory = false) {
  let ancestor = target;
  while (true) {
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Recovery paths cannot contain symlinks');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const stat = fs.lstatSync(target);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Expected regular file or directory');
  return stat;
}
function rejectNestedMounts(root) {
  if (!fs.existsSync('/proc/self/mountinfo')) return;
  for (const row of fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')) {
    const mount = row.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (mount && within(root, mount)) throw new Error('Nested mountpoint refused');
  }
}
function filesUnder(root, prefix = '') {
  const result = [];
  for (const name of fs.readdirSync(prefix ? safePath(root, prefix) : root).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(safePath(root, relative));
    if (stat.isSymbolicLink()) throw new Error('Snapshot symlink refused');
    if (stat.isDirectory()) result.push(...filesUnder(root, relative));
    else if (stat.isFile()) result.push(relative);
    else throw new Error('Non-regular snapshot input');
  }
  return result;
}
function sha256(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(128 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function copyTree(source, target) {
  regularPath(source, true);
  fs.mkdirSync(target, { mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name), to = path.join(target, name), stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('Backup symlink refused');
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o600); }
    else throw new Error('Non-regular backup input');
  }
}
function encryptionKey(snapshot) {
  const configPath = path.join(snapshot, 'configuration', '.env'), secretsPath = path.join(snapshot, 'data', '.secrets');
  const config = fs.existsSync(configPath) ? dotenv.parse(fs.readFileSync(configPath)) : {};
  const secrets = fs.existsSync(secretsPath) ? JSON.parse(fs.readFileSync(secretsPath, 'utf8')) : {};
  const value = config.ENCRYPTION_KEY && config.ENCRYPTION_KEY !== 'auto' ? config.ENCRYPTION_KEY : secrets.encryption_key;
  if (!/^[a-f0-9]{64}$/i.test(value || '')) throw new Error('Matching private encryption key missing');
  return Buffer.from(value, 'hex');
}
function validateDatabase(snapshot) {
  const filename = path.join(snapshot, 'data', 'vault.db');
  regularPath(filename);
  const key = encryptionKey(snapshot), db = new Database(filename, { readonly: true, fileMustExist: true });
  let encryptedValues = 0, documents = 0;
  try {
    const check = db.pragma('integrity_check');
    if (check.length !== 1 || check[0].integrity_check !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('Snapshot integrity failed');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      for (const column of db.prepare(`PRAGMA table_info(${quoted})`).all().filter(c => c.name.endsWith('_encrypted'))) {
        const field = '"' + column.name.replaceAll('"', '""') + '"';
        for (const row of db.prepare(`SELECT ${field} AS value FROM ${quoted} WHERE ${field} IS NOT NULL`).iterate()) {
          const parts = String(row.value).split(':');
          if (parts.length !== 3 || !/^[a-f0-9]{32}$/i.test(parts[0]) || !/^[a-f0-9]{32}$/i.test(parts[1]) || !/^(?:[a-f0-9]{2})*$/i.test(parts[2])) throw new Error('Invalid encrypted value');
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'));
          decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
          decipher.update(Buffer.from(parts[2], 'hex')); decipher.final(); encryptedValues++;
        }
      }
    }
    if (tables.some(table => table.name === 'managed_documents')) {
      for (const doc of db.prepare('SELECT stored_filename,sha256,size_bytes FROM managed_documents').iterate()) {
        const target = safePath(path.join(snapshot, 'managed-documents'), doc.stored_filename);
        if (regularPath(target).size !== doc.size_bytes || sha256(target) !== doc.sha256) throw new Error('Managed document checksum mismatch');
        documents++;
      }
    }
    return { encryptedValues, documents };
  } finally { db.close(); }
}
function newDestination(destination, sources) {
  const target = absolute(destination);
  regularPath(path.dirname(target), true);
  if (fs.existsSync(target)) throw new Error('Destination already exists');
  for (const source of sources) if (within(source, target) || within(target, source)) throw new Error('Destination must be independent');
  return target;
}
function backup({ appDir, documentsDir, destination, serviceUnitPath }) {
  const app = absolute(appDir), docs = absolute(documentsDir);
  regularPath(app, true); regularPath(docs, true);
  rejectNestedMounts(path.join(app, 'data')); rejectNestedMounts(docs);
  const target = newDestination(destination, [app, docs]), configPath = path.join(app, '.env');
  filesUnder(path.join(app, 'data')); filesUnder(docs);
  if (fs.existsSync(configPath)) regularPath(configPath);
  if (serviceUnitPath) regularPath(absolute(serviceUnitPath));
  fs.mkdirSync(target, { mode: 0o700 });
  try {
    copyTree(path.join(app, 'data'), path.join(target, 'data'));
    copyTree(docs, path.join(target, 'managed-documents'));
    fs.mkdirSync(path.join(target, 'configuration'), { mode: 0o700 });
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, path.join(target, 'configuration', '.env'), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(target, 'configuration', '.env'), 0o600);
    }
    if (serviceUnitPath) {
      fs.copyFileSync(serviceUnitPath, path.join(target, 'configuration', 'service-effective.txt'), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(target, 'configuration', 'service-effective.txt'), 0o600);
    }
    // Consolidate only the stopped copy. This preserves committed WAL rows and
    // prevents later read-only verification from changing a manifest's SHM file.
    const copyDb = new Database(path.join(target, 'data', 'vault.db'), { fileMustExist: true });
    try { copyDb.pragma('wal_checkpoint(TRUNCATE)'); copyDb.pragma('journal_mode = DELETE'); }
    finally { copyDb.close(); }
    let revision = 'unrecorded';
    try { revision = execFileSync('git', ['-C', app, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    fs.writeFileSync(path.join(target, 'source-commit.txt'), revision + '\n', { mode: 0o600 });
    const recovered = validateDatabase(target);
    const files = filesUnder(target).map(relative => {
      const filename = safePath(target, relative);
      return { path: relative, bytes: fs.statSync(filename).size, sha256: sha256(filename) };
    });
    fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), files }, null, 2) + '\n', { mode: 0o600 });
    verify(target);
    return { result: 'snapshot_verified', files: files.length, ...recovered };
  } catch (error) {
    // Retain incomplete copies for inspection, without a valid completion marker.
    fs.rmSync(path.join(target, 'manifest.json'), { force: true });
    throw error;
  }
}
function verify(snapshotPath) {
  const snapshot = absolute(snapshotPath);
  regularPath(snapshot, true); regularPath(path.join(snapshot, 'manifest.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported manifest');
  const expected = new Set();
  for (const entry of manifest.files) {
    if (expected.has(entry.path) || entry.path === 'manifest.json') throw new Error('Duplicate manifest entry');
    expected.add(entry.path);
    const target = safePath(snapshot, entry.path);
    if (regularPath(target).size !== entry.bytes || sha256(target) !== entry.sha256) throw new Error('Snapshot checksum mismatch');
  }
  const actual = filesUnder(snapshot).filter(relative => relative !== 'manifest.json');
  if (actual.length !== expected.size || actual.some(relative => !expected.has(relative))) throw new Error('Untracked snapshot files');
  return { result: 'snapshot_verified', files: actual.length, ...validateDatabase(snapshot) };
}
function restore({ snapshotPath, destination }) {
  const snapshot = absolute(snapshotPath), validation = verify(snapshot);
  const target = newDestination(destination, [snapshot]);
  copyTree(snapshot, target);
  const email = quarantine(path.join(target, 'data', 'vault.db'));
  const sourceConfig = path.join(target, 'configuration', '.env');
  const config = fs.existsSync(sourceConfig) ? fs.readFileSync(sourceConfig, 'utf8') : '';
  fs.writeFileSync(path.join(target, '.env'), config + '\n# Isolated recovery settings; review before production cutover.\n' +
    'NOTIFICATIONS_ENABLED=false\nLISTEN_HOST=127.0.0.1\nPORT=4445\n' +
    `DOCUMENT_STORAGE_ROOT=${JSON.stringify(path.join(target, 'managed-documents'))}\n`, { mode: 0o600, flag: 'wx' });
  const report = { result: 'restored_quarantined', originalSnapshot: validation, email, ...validateDatabase(target) };
  fs.writeFileSync(path.join(target, 'restore-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}
function main(args) {
  try {
    let result;
    if (args[0] === 'verify' && args.length === 2) result = verify(args[1]);
    else if (args[0] === 'backup' && args[1] === '--service-stopped' && [5,6].includes(args.length)) result = backup({ appDir: args[2], documentsDir: args[3], destination: args[4], serviceUnitPath: args[5] });
    else if (args[0] === 'restore' && args[1] === '--service-stopped' && args.length === 4) result = restore({ snapshotPath: args[2], destination: args[3] });
    else {
      process.stderr.write('Usage: managed-recovery.js backup --service-stopped /app /managed-documents /new-snapshot [/effective-unit.txt]\n       managed-recovery.js verify /snapshot\n       managed-recovery.js restore --service-stopped /snapshot /new-staging-directory\n');
      return 2;
    }
    process.stdout.write(JSON.stringify(result) + '\n'); return 0;
  } catch {
    process.stderr.write('Recovery failed: check paths, stopped writers, matching private keys, manifest, database integrity and media hashes. Keep the service stopped; existing sources were retained.\n');
    return 1;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { backup, verify, restore, validateDatabase, main };
