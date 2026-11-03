#!/usr/bin/env node
'use strict';

// Explicit named SQLite file and explicit caller-supplied key only. Importing
// this command never loads the app, default database, environment or secrets.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const USAGE = 'Usage: node scripts/repair-beneficiary-auto-wishes.js --db /absolute/vault.db [--apply --backup /absolute/private/new-backup.db]\nSupply the matching ENCRYPTION_KEY through the environment. Default: dry run on a temporary SQLite online backup.\n';

function refusal(code) { return Object.assign(new Error(code), { safeCode: code }); }
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw refusal('explicit_absolute_path_required');
  return path.resolve(value);
}
function noSymlinks(filename) {
  let current = filename;
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) throw refusal('symlink_path_refused');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function existingDatabase(filename) {
  noSymlinks(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1) throw refusal('existing_regular_database_required');
}
function reserveBackup(filename) {
  const parent = path.dirname(filename);
  noSymlinks(parent);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw refusal('private_backup_directory_required');
  }
  // Exclusive creation prevents overwriting an existing backup or following a
  // destination symlink. The verified backup is always retained after apply.
  const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  fs.closeSync(fd);
}
function checkDatabase(db) {
  const integrity = db.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.pragma('foreign_key_check').length) {
    throw refusal('database_integrity_failure');
  }
}
const quoted = name => '"' + name.replaceAll('"', '""') + '"';
function fingerprint(db) {
  const digest = crypto.createHash('sha256');
  const schema = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`).all();
  digest.update(JSON.stringify(schema));
  for (const table of schema.filter(row => row.type === 'table')) {
    digest.update(table.name);
    // Online backup preserves the complete SQLite snapshot, including internal
    // sequence state. Sort serialized rows to avoid relying on scan order.
    const rows = db.prepare('SELECT * FROM ' + quoted(table.name)).all().map(row => JSON.stringify(row)).sort();
    rows.forEach(row => digest.update(row + '\n'));
  }
  return digest.digest('hex');
}
function verifyEncryption(db, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const columns = {
    legacy_contents: ['payload_encrypted'], legacy_content_versions: ['payload_encrypted'],
    vault_entries: ['fields_encrypted', 'notes_encrypted'],
    managed_documents: ['original_name_encrypted', 'display_name_encrypted', 'description_encrypted']
  };
  let count = 0;
  for (const [table, names] of Object.entries(columns)) {
    const actual = db.prepare('PRAGMA table_info(' + quoted(table) + ')').all().map(column => column.name);
    for (const name of names.filter(column => actual.includes(column))) {
      for (const row of db.prepare('SELECT ' + quoted(name) + ' AS ciphertext FROM ' + quoted(table) +
        ' WHERE ' + quoted(name) + ' IS NOT NULL').iterate()) {
        if (row.ciphertext === '') continue;
        try {
          const parts = typeof row.ciphertext === 'string' ? row.ciphertext.split(':') : [];
          if (parts.length !== 3 || !/^[a-f\d]{32}$/i.test(parts[0]) || !/^[a-f\d]{32}$/i.test(parts[1]) ||
            !/^(?:[a-f\d]{2})*$/i.test(parts[2])) throw new Error();
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'));
          decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
          decipher.update(Buffer.from(parts[2], 'hex')); decipher.final(); count++;
        } catch { throw refusal('encryption_key_or_ciphertext_invalid'); }
      }
    }
  }
  return count;
}
function repair(db) {
  require('../server/legacy-schema').initLegacySchema(db);
  const result = require('../server/beneficiary-final-wishes').backfillBeneficiaryFinalWishes(db);
  checkDatabase(db);
  return {
    created: result.created, total: result.total, adopted: result.adopted, suppressed: result.suppressed,
    automatic_wishes: db.prepare(`SELECT owner_user_id,beneficiary_id,content_id FROM legacy_beneficiary_auto_wishes
      ORDER BY owner_user_id,beneficiary_id`).all(),
    reconciliation: result.reconciliation.map(item => ({ beneficiary_id: item.beneficiary_id,
      replacement_content_id: item.id,
      preserved: item.reconciliation.map(record => ({ content_id: record.content_id, reason: record.reason })) }))
  };
}
async function maintenance({ databasePath, apply = false, backupPath } = {}) {
  const key = process.env.ENCRYPTION_KEY;
  if (typeof key !== 'string' || !/^[a-f\d]{64}$/i.test(key)) throw refusal('explicit_encryption_key_required');
  const sourcePath = absolute(databasePath);
  if (typeof apply !== 'boolean' || (!apply && backupPath !== undefined)) throw refusal('invalid_options');
  const destination = apply ? absolute(backupPath) : null;
  if (destination === sourcePath) throw refusal('distinct_backup_path_required');
  existingDatabase(sourcePath);
  let source, working, temporary, reserved = false, backupVerified = false;
  try {
    source = new Database(sourcePath, { readonly: !apply, fileMustExist: true, timeout: 10000 });
    source.pragma('foreign_keys=ON');
    // The write reservation spans backup verification and the atomic repair,
    // preventing application writes from invalidating the rollback snapshot.
    if (apply) source.exec('BEGIN IMMEDIATE');
    checkDatabase(source);
    const verifiedValues = verifyEncryption(source, key);
    if (apply) {
      reserveBackup(destination); reserved = true;
      const before = fingerprint(source);
      // better-sqlite3 cannot back up a source connection in its own write
      // transaction. A second read-only connection sees the same committed
      // snapshot while the first connection reserves all source writes.
      const backupSource = new Database(sourcePath, { readonly: true, fileMustExist: true });
      try { await backupSource.backup(destination); }
      finally { backupSource.close(); }
      const backup = new Database(destination, { readonly: true, fileMustExist: true });
      try {
        checkDatabase(backup);
        if (fingerprint(backup) !== before) throw refusal('backup_verification_failure');
        backupVerified = true;
      } finally { backup.close(); }
      const result = repair(source);
      source.exec('COMMIT');
      return { mode: 'applied', backup_verified: true, key_verified: verifiedValues > 0,
        key_anchor: verifiedValues ? 'ciphertext' : 'none', encrypted_values_verified: verifiedValues, ...result };
    }
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfs-auto-wish-repair-'));
    fs.chmodSync(temporary, 0o700);
    const copyPath = path.join(temporary, 'dry-run.db');
    reserveBackup(copyPath);
    await source.backup(copyPath);
    working = new Database(copyPath, { fileMustExist: true }); working.pragma('foreign_keys=ON');
    checkDatabase(working);
    // Recheck the copy: a concurrent writer could have added encrypted data
    // while the read-only source was being copied.
    const copiedVerifiedValues = verifyEncryption(working, key);
    const result = working.transaction(() => repair(working)).immediate();
    return { mode: 'dry_run', backup_verified: false, key_verified: copiedVerifiedValues > 0,
      key_anchor: copiedVerifiedValues ? 'ciphertext' : 'none', encrypted_values_verified: copiedVerifiedValues, ...result };
  } catch (error) {
    if (source?.inTransaction) source.exec('ROLLBACK');
    if (reserved && !backupVerified) fs.rmSync(destination, { force: true });
    error.backupVerified = backupVerified;
    throw error;
  } finally {
    if (working?.open) working.close();
    if (source?.open) source.close();
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
function argumentsToOptions(args) {
  const options = {}, names = { '--db': 'databasePath', '--backup': 'backupPath', '--apply': 'apply' };
  for (let index = 0; index < args.length; index++) {
    const name = names[args[index]];
    if (!name || options[name] !== undefined) throw refusal('invalid_options');
    if (name === 'apply') options[name] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw refusal('invalid_options');
      options[name] = args[++index];
    }
  }
  return options;
}
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(USAGE); return 0; }
  try {
    const result = await maintenance(argumentsToOptions(args));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.safeCode || 'maintenance_failed', backup_verified: !!error.backupVerified }) + '\n' + USAGE);
    return 1;
  }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { maintenance, main, argumentsToOptions };
