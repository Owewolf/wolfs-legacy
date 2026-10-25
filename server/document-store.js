'use strict';
// Managed *copies*. Original files selected by the browser are never changed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encrypt, decrypt } = require('./crypto');

const TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain'
};
const MAX_MB = Math.min(100, Math.max(1, Number(process.env.DOCUMENT_MAX_FILE_MB || 25)));
const MAX_FILE_BYTES = MAX_MB * 1024 * 1024;
const root = path.resolve(process.env.DOCUMENT_STORAGE_ROOT || '/srv/data/files/legacy-vault-managed-documents');
const forbidden = [
  path.resolve(__dirname, '..', 'public'),
  path.resolve(process.env.HOME || '/home/wolf', 'Documents', 'Property'),
  '/srv/data/files/legacy-vault-library'
];
function isWithin(parent, child) { return child === parent || child.startsWith(parent + path.sep); }

function checkStorage() {
  if (forbidden.some(p => isWithin(p, root))) throw new Error('Managed storage must be outside source documents, public files and legacy link folders');
  // Walk ancestors without following symlinks (including broken symlinks).
  let p = root;
  while (true) {
    try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('Symbolic link in DOCUMENT_STORAGE_ROOT: ' + p); }
    catch(e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  // Reject a bind mount at/below the storage directory. An actual storage disk may
  // be mounted at an ancestor such as /srv/data; create a private subfolder below it.
  try {
    const mounts = fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n');
    for (const row of mounts) {
      const mountPoint = row.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_,o)=>String.fromCharCode(parseInt(o,8)));
      if (mountPoint && isWithin(root, mountPoint)) throw new Error('Refusing storage directory containing a mount point: '+mountPoint);
    }
  } catch(e) { if (e.code !== 'ENOENT') throw e; }
  if (!fs.existsSync(root)) throw new Error('DOCUMENT_STORAGE_ROOT does not exist; create and verify it explicitly before starting the service');
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Storage root must be a regular directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('Storage root must be owned by the Node service user');
  if ((st.mode & 0o077) !== 0) throw new Error('Storage root must have permissions 0700');
  return root;
}
function tempDirectory() {
  const dir = path.join(checkStorage(), '.incoming');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink() || (fs.statSync(dir).mode & 0o077)!==0) throw new Error('Unsafe upload temporary folder');
  return dir;
}
function ownerDirectory(userId) {
  const dir = path.join(checkStorage(), `owner-${Number(userId)}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink() || (fs.statSync(dir).mode & 0o077)!==0) throw new Error('Unsafe owner folder');
  return dir;
}
function originalName(input) {
  const name = String(input || 'Document').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 240).trim();
  return name && name !== '.' && name !== '..' ? name : 'Document';
}
function inspectFile(filename, tmpPath) {
  const extension = path.extname(filename).toLowerCase();
  const mime = TYPES[extension];
  if (!mime) throw new Error(`Unsupported file type: ${extension || '(none)'}`);
  const fd = fs.openSync(tmpPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let head;
  try { head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); }
  finally { fs.closeSync(fd); }
  const starts = arr => head.subarray(0, arr.length).equals(Buffer.from(arr));
  let ok = false;
  if (extension === '.pdf') ok = head.toString('ascii', 0, 5) === '%PDF-';
  else if (extension === '.png') ok = starts([137,80,78,71,13,10,26,10]);
  else if (['.jpg','.jpeg'].includes(extension)) ok = starts([0xff,0xd8,0xff]);
  else if (extension === '.webp') ok = head.toString('ascii',0,4)==='RIFF' && head.toString('ascii',8,12)==='WEBP';
  else if (['.docx','.xlsx'].includes(extension)) ok = starts([0x50,0x4b,0x03,0x04]);
  else if (['.doc','.xls'].includes(extension)) ok = starts([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
  else if (extension === '.txt') ok = !starts([0x7f,0x45,0x4c,0x46]) && !head.includes(0);
  if (!ok) throw new Error(`File content does not match ${extension} format`);
  return { extension, mime };
}
function diskPath(relative) {
  if (!/^owner-[0-9]+\/[a-f0-9-]{36}\.(pdf|png|jpg|jpeg|webp|doc|docx|xls|xlsx|txt)$/.test(relative)) throw new Error('Invalid stored path');
  const target = path.resolve(checkStorage(), relative);
  if (!isWithin(root, target)) throw new Error('Unsafe stored path');
  const dir = path.dirname(target);
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Unsafe owner directory');
  return target;
}
function openDocument(doc) {
  const target = diskPath(doc.stored_filename);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const st = fs.fstatSync(fd);
  if (!st.isFile()) { fs.closeSync(fd); throw new Error('Document is not a regular file'); }
  return { fd, size: st.size };
}
function toView(d) {
  return {
    id: d.id, display_name: decrypt(d.display_name_encrypted), original_name: decrypt(d.original_name_encrypted),
    description: d.description_encrypted ? decrypt(d.description_encrypted) : '',
    mime_type: d.mime_type, size_bytes: d.size_bytes, created_at: d.created_at,
    status: d.status
  };
}
function listForEntry(db, userId, entryId) {
  return db.prepare(`SELECT d.* FROM managed_documents d JOIN document_associations a ON a.document_id=d.id
    JOIN vault_entries e ON e.id=a.entry_id WHERE e.id=? AND e.user_id=? AND d.user_id=?
    ORDER BY a.created_at DESC, d.created_at DESC`).all(entryId, userId, userId).map(toView);
}
function ownedEntry(db, userId, entryId) {
  return Number.isSafeInteger(Number(entryId)) && Number(entryId)>0 &&
    db.prepare('SELECT id FROM vault_entries WHERE id=? AND user_id=?').get(entryId, userId);
}
function ownedDoc(db, userId, id) {
  return db.prepare('SELECT * FROM managed_documents WHERE id=? AND user_id=?').get(id, userId);
}
function checksum(filename) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { const b = Buffer.alloc(131072); let n; while ((n=fs.readSync(fd,b,0,b.length,null))>0) h.update(b.subarray(0,n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
module.exports = { MAX_FILE_BYTES, checkStorage, tempDirectory, ownerDirectory, originalName,
  inspectFile, diskPath, openDocument, checksum, toView, listForEntry, ownedEntry, ownedDoc, encrypt };
