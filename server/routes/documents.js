'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { getDb, audit } = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { hashToken } = require('../crypto');
const { getVaultVisibility } = require('../vault-visibility');
const store = require('../document-store');
const router = express.Router();
const upload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => {
    try { cb(null, store.tempDirectory()); } catch (e) { cb(e); }
  }, filename: (req,file,cb) => cb(null, 'upload-' + crypto.randomUUID()) }),
  limits: { fileSize: store.MAX_FILE_BYTES, files: 8, fields: 4, parts: 12 },
});
function handleUpload(req, res, next) {
  upload.array('files',8)(req, res, err => {
    if (!err) return next();
    if (req.files) for (const f of req.files) { try { fs.unlinkSync(f.path); } catch {} }
    return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File exceeds configured size limit':err.message});
  });
}
function fail(res,msg,code=400){return res.status(code).json({error:msg});}
const { sendDocument } = require('../document-response');
router.post('/beneficiary/content', express.json(), (req,res)=>{
  const {accessToken,documentId,mode} = req.body || {};
  if (typeof accessToken!=='string'||typeof documentId!=='string') return fail(res,'Invalid request');
  const db=getDb();
  const ben=db.prepare('SELECT * FROM beneficiaries WHERE access_token=?').get(hashToken(accessToken));
  if (!ben||!ben.access_granted||(ben.token_expires_at&&new Date()>new Date(ben.token_expires_at))) return fail(res,'Access not granted',403);
  const doc=store.ownedDoc(db,ben.user_id,documentId);
  if(!doc || doc.legacy_restricted) {
    require('../legacy-content').event(db,{userId:ben.user_id,beneficiaryId:ben.id,type:'attachment_denied'});
    return fail(res,'Not found',404);
  }
  const associations=db.prepare('SELECT e.* FROM document_associations a JOIN vault_entries e ON e.id=a.entry_id WHERE a.document_id=? AND e.user_id=?').all(documentId,ben.user_id);
  const visibility=getVaultVisibility(ben.user_id);
  if(!associations.some(entry=>visibility.isVisible(entry))) return fail(res,'Not found',404);
  audit(null,'beneficiary_document_view','managed_document',null,doc.id,req.ip);
  return sendDocument(req,res,doc,mode);
});
router.use(authenticateToken);
router.get('/counts',(req,res)=>{
  const db=getDb();
  const section=req.query.section;
  const rows=db.prepare(`SELECT e.*, COUNT(a.document_id) AS count FROM vault_entries e
    LEFT JOIN document_associations a ON a.entry_id=e.id WHERE e.user_id=? AND (? IS NULL OR e.section=?) GROUP BY e.id`)
    .all(req.user.id,section||null,section||null);
  return res.json(getVaultVisibility(req.user.id).filter(rows).map(entry=>({entry_id:entry.id,count:entry.count})));
});
router.get('/',(req,res)=>{
  const db=getDb();
  if(req.query.unassigned==='true'){
    const docs=db.prepare(`SELECT d.* FROM managed_documents d WHERE d.user_id=?
       AND NOT EXISTS (SELECT 1 FROM document_associations a WHERE a.document_id=d.id) ORDER BY d.created_at DESC`).all(req.user.id);
    return res.json(docs.map(store.toView));
  }
  if (!store.ownedEntry(db,req.user.id,req.query.entryId)) return fail(res,'Entry not found',404);
  return res.json(store.listForEntry(db,req.user.id,req.query.entryId));
});
router.post('/upload',handleUpload,(req,res)=>{
  const files=req.files||[];
  if(!files.length) return fail(res,'Choose at least one file');
  const db=getDb();
  if(!store.ownedEntry(db,req.user.id,req.body?.entryId)){
    files.forEach(f=>{try{fs.unlinkSync(f.path);}catch{}});
    return fail(res,'Entry not found',404);
  }
  const created=[], errors=[];
  for(const file of files){
    let destination;
    try{
      const name=store.originalName(file.originalname);
      const {extension,mime}=store.inspectFile(name,file.path);
      const id=crypto.randomUUID();
      const relative=`owner-${req.user.id}/${id}${extension}`;
      destination=path.join(store.ownerDirectory(req.user.id),`${id}${extension}`);
      fs.renameSync(file.path,destination);
      fs.chmodSync(destination,0o600);
      const sha=store.checksum(destination);
      const insert=db.transaction(()=>{
        db.prepare(`INSERT INTO managed_documents(id,user_id,original_name_encrypted,display_name_encrypted,description_encrypted,
          stored_filename,mime_type,size_bytes,sha256,status) VALUES (?,?,?,?,?,?,?,?,?,'active')`)
          .run(id,req.user.id,store.encrypt(name),store.encrypt(name),null,relative,mime,file.size,sha);
        db.prepare('INSERT INTO document_associations(document_id,entry_id) VALUES (?,?)').run(id,req.body.entryId);
      });
      insert();
      audit(req.user.id,'document_upload','managed_document',null,id,req.ip);
      created.push({id,display_name:name,mime_type:mime,size_bytes:file.size});
    }catch(e){
      errors.push({file:store.originalName(file.originalname),error:e.message});
      if(destination){try{fs.unlinkSync(destination);}catch{}}
      if(fs.existsSync(file.path)){try{fs.unlinkSync(file.path);}catch{}}
    }
  }
  return res.status(errors.length?207:201).json({created,errors});
});
router.patch('/:id',(req,res)=>{
  const db=getDb(), doc=store.ownedDoc(db,req.user.id,req.params.id);
  if(!doc) return fail(res,'Not found',404);
  if(doc.legacy_restricted) return fail(res,'Protected attachment metadata must be revised through its Final Wishes item',409);
  const label=String(req.body?.display_name||'').trim();
  const description=String(req.body?.description||'').trim();
  if(!label||label.length>240||description.length>2000) return fail(res,'Invalid label or description');
  db.prepare('UPDATE managed_documents SET display_name_encrypted=?, description_encrypted=? WHERE id=? AND user_id=?')
    .run(store.encrypt(store.originalName(label)),description?store.encrypt(description):null,doc.id,req.user.id);
  audit(req.user.id,'document_update','managed_document',null,doc.id,req.ip);
  return res.json({ok:true});
});
router.post('/:id/associate',(req,res)=>{
  const db=getDb(), doc=store.ownedDoc(db,req.user.id,req.params.id);
  if(!doc||doc.legacy_restricted||!store.ownedEntry(db,req.user.id,req.body?.entryId)) return fail(res,'Not found',404);
  db.prepare('INSERT OR IGNORE INTO document_associations(document_id,entry_id) VALUES (?,?)').run(doc.id,req.body.entryId);
  audit(req.user.id,'document_associate','managed_document',null,doc.id,req.ip);
  res.json({ok:true});
});
router.delete('/:id/associations/:entryId',(req,res)=>{
  const db=getDb(),doc=store.ownedDoc(db,req.user.id,req.params.id);
  if(!doc||!store.ownedEntry(db,req.user.id,req.params.entryId))return fail(res,'Not found',404);
  const result=db.prepare('DELETE FROM document_associations WHERE document_id=? AND entry_id=?').run(doc.id,req.params.entryId);
  if (!result.changes)return fail(res,'Association not found',404);
  const remaining=db.prepare('SELECT COUNT(*) AS n FROM document_associations WHERE document_id=?').get(doc.id).n;
  if(!remaining) db.prepare("UPDATE managed_documents SET status='unassigned' WHERE id=?").run(doc.id);
  audit(req.user.id,'document_unlink','managed_document',null,doc.id,req.ip);
  return res.json({ok:true,managed_copy_preserved:true});
});
router.get('/:id/content',(req,res)=>{
  const db=getDb(),doc=store.ownedDoc(db,req.user.id,req.params.id);
  if(!doc)return fail(res,'Not found',404);
  const entryId=req.query.entryId;
  if (!store.ownedEntry(db,req.user.id,entryId)) return fail(res,'Entry not found',404);
  const assoc=db.prepare('SELECT 1 FROM document_associations WHERE document_id=? AND entry_id=?').get(doc.id,entryId);
  if(!assoc)return fail(res,'Document is not linked to that entry',403);
  audit(req.user.id,'document_view','managed_document',null,doc.id,req.ip);
  return sendDocument(req,res,doc,req.query.mode);
});
module.exports=router;
