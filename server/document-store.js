'use strict';
// Managed *copies*. Original files selected by the browser are never changed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encrypt, decrypt } = require('./crypto');
const { getVaultVisibility } = require('./vault-visibility');

const TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.mp4': 'video/mp4', '.mov': 'video/quicktime'
};
const configuredMax = Number(process.env.DOCUMENT_MAX_FILE_MB || 25);
const MAX_MB = Number.isFinite(configuredMax) ? Math.min(100, Math.max(1, configuredMax)) : 25;
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
function inspectMedia(extension, filename) {
  const fd=fs.openSync(filename,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const size=fs.fstatSync(fd).size;
    const read=(position,length)=>{const b=Buffer.alloc(length);return b.subarray(0,fs.readSync(fd,b,0,length,position));};
    const head=read(0,32);
    if(extension==='.mp3') {
      let offset=0;
      if(head.toString('ascii',0,3)==='ID3') {
        if(head.length<10||[...head.subarray(6,10)].some(x=>x&128)) return false;
        offset=10+head[6]*2097152+head[7]*16384+head[8]*128+head[9]+((head[5]&16)?10:0);
      }
      const frame=read(offset,4);
      if(!(frame.length===4 && offset+4<size && frame[0]===255 && (frame[1]&224)===224 &&
        (frame[1]&24)!==8 && (frame[1]&6)!==0 && (frame[2]&240)!==0 && (frame[2]&240)!==240 && (frame[2]&12)!==12))return false;
      const version=(frame[1]>>3)&3,layer=(frame[1]>>1)&3,index=frame[2]>>4,padding=(frame[2]>>1)&1;
      const rates=version===3?
        (layer===3?[0,32,64,96,128,160,192,224,256,288,320,352,384,416,448]:layer===2?[0,32,48,56,64,80,96,112,128,160,192,224,256,320,384]:[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]):
        (layer===3?[0,32,48,56,64,80,96,112,128,144,160,176,192,224,256]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160]);
      const sample=[44100,48000,32000][(frame[2]>>2)&3]/(version===3?1:version===2?2:4);
      const length=layer===3?(Math.floor(12*rates[index]*1000/sample)+padding)*4:
        Math.floor((layer===1&&version!==3?72:144)*rates[index]*1000/sample)+padding;
      return length>=4&&offset+length<=size;
    }
    if(extension==='.wav') {
      if(head.toString('ascii',0,4)!=='RIFF'||head.toString('ascii',8,12)!=='WAVE'||head.readUInt32LE(4)+8!==size) return false;
      let pos=12,format=false,data=false,steps=0;
      while(pos+8<=size&&steps++<10000) {
        const chunk=read(pos,8);const n=chunk.readUInt32LE(4);if(pos+8+n>size)return false;
        if(chunk.toString('ascii',0,4)==='fmt ')format=n>=16;
        if(chunk.toString('ascii',0,4)==='data')data=n>0;
        pos+=8+n+(n%2);
      }
      return format&&data;
    }
    let pos=0,format=false,media=false,metadata=false,steps=0;
    while(pos+8<=size&&steps++<10000) {
      const box=read(pos,32);let length=box.readUInt32BE(0),header=8;
      if(length===1) { if(box.length<16)return false;const big=box.readBigUInt64BE(8);if(big>BigInt(Number.MAX_SAFE_INTEGER))return false;length=Number(big);header=16; }
      if(length===0)length=size-pos;
      if(length<header||pos+length>size) return false;
      const kind=box.toString('ascii',4,8);
      if(kind==='ftyp') {
        const brand=box.toString('ascii',header,header+4);
        format=extension==='.m4a'?['M4A ','M4B ','isom','mp42'].includes(brand):
          ['isom','iso2','mp41','mp42','avc1','M4V ','qt  ','MSNV','dash'].includes(brand);
      }
      if(kind==='moov'&&extension==='.mov')format=true;
      if(kind==='moov'&&length>header)metadata=true;
      if(kind==='mdat'&&length>header)media=true;
      pos+=length;
    }
    return pos===size&&format&&media&&metadata;
  } finally {fs.closeSync(fd);}
}
function inspectFile(filename, tmpPath) {
  const extension = path.extname(filename).toLowerCase();
  const mime = TYPES[extension];
  if (!mime) throw new Error(`Unsupported file type: ${extension || '(none)'}`);
  const fd = fs.openSync(tmpPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let head;
  try { head = Buffer.alloc(64); const length=fs.readSync(fd, head, 0, 64, 0); head=head.subarray(0,length); }
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
  else if (['.mp3','.m4a','.wav','.mp4','.mov'].includes(extension)) ok = inspectMedia(extension,tmpPath);
  if (!ok) throw new Error(`File content does not match ${extension} format`);
  return { extension, mime };
}
function diskPath(relative) {
  if (!/^owner-[0-9]+\/[a-f0-9-]{36}\.(pdf|png|jpg|jpeg|webp|doc|docx|xls|xlsx|txt|mp3|m4a|wav|mp4|mov)$/.test(relative)) throw new Error('Invalid stored path');
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
  if (!st.isFile() || (st.mode & 0o077)!==0) { fs.closeSync(fd); throw new Error('Document is not a private regular file'); }
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
    JOIN vault_entries e ON e.id=a.entry_id WHERE e.id=? AND e.user_id=? AND d.user_id=? AND d.legacy_restricted=0
    ORDER BY a.created_at DESC, d.created_at DESC`).all(entryId, userId, userId).map(toView);
}
function ownedEntry(db, userId, entryId) {
  if (!Number.isSafeInteger(Number(entryId)) || Number(entryId)<=0) return false;
  const entry = db.prepare('SELECT * FROM vault_entries WHERE id=? AND user_id=?').get(entryId, userId);
  return entry && getVaultVisibility(userId).isVisible(entry) ? entry : false;
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
