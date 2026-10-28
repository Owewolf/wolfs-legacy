'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-vault-managed-doc-test-'));
fs.chmodSync(tmp,0o700);
process.env.DOCUMENT_STORAGE_ROOT=tmp;
const store=require('../server/document-store');
const base='a.pdf';
try{
  assert.equal(store.checkStorage(),tmp);
  const src=path.join(tmp,'test-source.pdf');
  const bytes=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  fs.writeFileSync(src,bytes);
  assert.equal(store.inspectFile(base,src).mime,'application/pdf');
  assert.equal(store.originalName('../my.pdf'),'.._my.pdf');
  assert.equal(store.checksum(src),crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(store.ownerDirectory(123),path.join(tmp,'owner-123'));
  const d=path.join(store.ownerDirectory(123),'00000000-0000-4000-8000-000000000000.pdf');
  fs.copyFileSync(src,d);
  fs.chmodSync(d,0o600);
  const {fd}=store.openDocument({stored_filename:'owner-123/00000000-0000-4000-8000-000000000000.pdf'});
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(src).toString(),bytes.toString(),'original was changed');
  assert.throws(()=>store.diskPath('../Documents/Property/important.pdf'));
  console.log('document-store: 8 smoke assertions passed');
}finally{ fs.rmSync(tmp,{recursive:true,force:true}); }
