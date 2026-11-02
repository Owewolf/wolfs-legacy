'use strict';
const express=require('express');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const multer=require('multer');
const {getDb}=require('../db');
const {authenticateToken}=require('../middleware/auth');
const legacy=require('../legacy-content');
const store=require('../document-store');
const {renderMarkdown}=require('../legacy-markdown');
const {stripPhotoMetadata}=require('../legacy-media');
const {sendDocument}=require('../document-response');
const ownerRouter=express.Router(),beneficiaryRouter=express.Router();
const quotaSetting=Number(process.env.LEGACY_STORAGE_QUOTA_MB||2048);
const QUOTA_BYTES=(Number.isFinite(quotaSetting)&&quotaSetting>0?quotaSetting:2048)*1024*1024;
function handler(fn) {return (req,res,next)=>{try {return fn(req,res,next);}catch(e){return next(e);}};}
function errorHandler(err,req,res,next) {
  if(res.headersSent)return next(err);
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&[403,404].includes(err.status)) {
    // Mutation transactions have rolled back before this point. A denied
    // attempt must survive that rollback, without logging submitted values.
    try {legacy.event(getDb(),{userId:req.user?.id??req.legacyBeneficiary?.user_id??null,
      beneficiaryId:req.legacyBeneficiary?.id??null,type:'access_denied'});}catch {return res.status(500).json({error:'Access audit unavailable'});}
  }
  res.status(err.status||500).json({error:err.status&&err.status<500?err.message:'Legacy content request failed'});
}
function attachment(db,row,id) {
  const doc=db.prepare(`SELECT d.* FROM managed_documents d JOIN legacy_content_attachments a ON a.document_id=d.id
    WHERE a.content_id=? AND d.id=? AND d.user_id=? AND d.legacy_restricted=1`).get(row.id,id,row.user_id);
  if(!doc) {legacy.event(db,{userId:row.user_id,contentId:row.id,type:'attachment_denied'});throw legacy.error('Attachment not found',404);}
  return doc;
}
function revisionForAttachment(db,row) {
  const at=legacy.now();
  const snapshot={...legacy.payload(row),attachments:db.prepare('SELECT document_id FROM legacy_content_attachments WHERE content_id=?').all(row.id)};
  db.prepare('INSERT INTO legacy_content_versions(content_id,revision,payload_encrypted,editor_id,created_at) VALUES (?,?,?,?,?)')
    .run(row.id,row.revision,store.encrypt(JSON.stringify(snapshot)),row.user_id,at);
  db.prepare("UPDATE legacy_contents SET revision=revision+1,status=CASE WHEN status='released' THEN 'draft' ELSE status END,updated_at=? WHERE id=?").run(at,row.id);
  legacy.invalidateReleases(db,row.id,at,'attachment_revision_withdrawn');
}
ownerRouter.use((req,res,next)=>{
  let authorised=false;
  authenticateToken(req,res,()=>{authorised=true;next();});
  if(!authorised)legacy.event(getDb(),{type:'owner_auth_denied'});
});
ownerRouter.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
ownerRouter.get('/config',(req,res)=>res.json({max_file_bytes:store.MAX_FILE_BYTES,accepted:'.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.txt,.mp3,.m4a,.wav,.mp4,.mov',quota_bytes:QUOTA_BYTES}));
ownerRouter.post('/preview',handler((req,res)=>{
  if(typeof req.body?.body_markdown!=='string'||req.body.body_markdown.length>100000)throw legacy.error('Invalid Markdown');
  res.json({html:renderMarkdown(req.body.body_markdown)});
}));
ownerRouter.get('/reviews/due',handler((req,res)=>res.json(legacy.list(getDb(),req.user.id).filter(x=>x.review_enabled&&['due_soon','overdue'].includes(x.review_state)&&x.status!=='archived'))));
ownerRouter.get('/legacy',handler((req,res)=>{
  const db=getDb();legacy.event(db,{userId:req.user.id,type:'owner_list'});res.json(legacy.list(db,req.user.id,req.query));
}));
ownerRouter.post('/legacy',handler((req,res)=>res.status(201).json(legacy.save(getDb(),req.user.id,req.body))));
ownerRouter.get('/legacy/:id',handler((req,res)=>{
  const db=getDb(),row=legacy.owned(db,req.user.id,req.params.id);legacy.event(db,{userId:req.user.id,contentId:row.id,type:'owner_view'});res.json(legacy.toView(db,row));
}));
ownerRouter.patch('/legacy/:id',handler((req,res)=>res.json(legacy.save(getDb(),req.user.id,req.body,req.params.id))));
ownerRouter.delete('/legacy/:id',handler((req,res)=>res.json(legacy.permanentlyDelete(getDb(),req.user.id,req.params.id))));
ownerRouter.put('/legacy/:id/beneficiaries',handler((req,res)=>{
  const db=getDb();res.json(db.transaction(()=>{
    const row=legacy.owned(db,req.user.id,req.params.id);
    const recipients=legacy.validateRecipients(db,req.user.id,req.body?.beneficiary_ids);
    legacy.replaceRecipients(db,req.user.id,row.id,recipients);
    legacy.event(db,{userId:req.user.id,contentId:row.id,type:'recipients_updated'});
    return legacy.toView(db,row);
  })());
}));
ownerRouter.post('/legacy/:id/release',handler((req,res)=>res.json(legacy.manualRelease(getDb(),req.user.id,req.params.id,req.body))));
ownerRouter.post('/legacy/:id/revoke',handler((req,res)=>{
  const db=getDb();res.json(db.transaction(()=>{
    const row=legacy.owned(db,req.user.id,req.params.id);
    if(req.body?.confirm!==true)throw legacy.error('Explicit revocation confirmation is required');
    const maps=db.prepare('SELECT beneficiary_id FROM legacy_content_beneficiaries WHERE content_id=?').all(row.id);
    const selected=req.body.beneficiary_ids===undefined?maps.map(x=>x.beneficiary_id):legacy.validateRecipients(db,req.user.id,req.body.beneficiary_ids);
    const at=legacy.now();
    for(const b of selected) {
      if(!maps.some(x=>x.beneficiary_id===b))throw legacy.error('Recipient not assigned');
      db.prepare('UPDATE legacy_content_beneficiaries SET revoked_at=? WHERE content_id=? AND beneficiary_id=?').run(at,row.id,b);
      legacy.event(db,{userId:req.user.id,contentId:row.id,beneficiaryId:b,type:'revoked',at});
    }
    return legacy.toView(db,row);
  })());
}));
ownerRouter.post('/legacy/:id/review',handler((req,res)=>res.json(legacy.review(getDb(),req.user.id,req.params.id,req.body))));
const upload=multer({storage:multer.diskStorage({destination:(req,file,cb)=>{try{cb(null,store.tempDirectory());}catch(e){cb(e);}},
  filename:(req,file,cb)=>cb(null,'upload-'+crypto.randomUUID())}),limits:{fileSize:store.MAX_FILE_BYTES,files:8,fields:4,parts:12}});
function acceptUpload(req,res,next) {
  // Authorise the content before accepting a single byte of disk upload.
  try {req.legacyRow=legacy.owned(getDb(),req.user.id,req.params.id);}catch(e){return next(e);}
  if(!req.is('multipart/form-data'))return next();
  upload.array('files',8)(req,res,err=>{
    if(!err)return next();
    for(const f of req.files||[])try{fs.unlinkSync(f.path);}catch{}
    next(legacy.error(err.code==='LIMIT_FILE_SIZE'?'File exceeds configured size limit':'Invalid attachment upload'));
  });
}
ownerRouter.post('/legacy/:id/attachments',acceptUpload,handler((req,res)=>{
  const db=getDb(),files=req.files||[],destinations=[];
  try {
    if(!files.length && typeof req.body?.document_id!=='string')throw legacy.error('Choose files or an existing protected document');
    const result=db.transaction(()=>{
      const row=legacy.owned(db,req.user.id,req.params.id);
      if(row.status==='archived')throw legacy.error('Restore the archived item before attaching files');
      const total=db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM managed_documents WHERE user_id=?').get(req.user.id).bytes;
      if(total+files.reduce((n,f)=>n+f.size,0)>QUOTA_BYTES)throw legacy.error('Managed storage quota exceeded',413);
      if(db.prepare('SELECT COUNT(*) AS n FROM legacy_content_attachments WHERE content_id=?').get(row.id).n+Math.max(1,files.length)>100)throw legacy.error('Attachment limit reached');
      if(!files.length) {
        const doc=store.ownedDoc(db,req.user.id,req.body.document_id);
        if(!doc)throw legacy.error('Protected managed document not found',404);
        if(!doc.legacy_restricted) {
          if(db.prepare('SELECT 1 FROM document_associations WHERE document_id=?').get(doc.id))throw legacy.error('Choose an unassigned document or upload a separate protected copy');
          db.prepare('UPDATE managed_documents SET legacy_restricted=1 WHERE id=? AND user_id=?').run(doc.id,req.user.id);
        }
        if(db.prepare('SELECT 1 FROM legacy_content_attachments WHERE content_id=? AND document_id=?').get(row.id,doc.id))return {created:[],errors:[]};
        revisionForAttachment(db,row);
        db.prepare('INSERT INTO legacy_content_attachments(content_id,document_id) VALUES (?,?)').run(row.id,doc.id);
        legacy.event(db,{userId:req.user.id,contentId:row.id,type:'attachment_linked'});
        return {created:[{...store.toView(doc),sha256:doc.sha256}],errors:[]};
      }
      revisionForAttachment(db,row);
      const created=[];
      for(const file of files) {
        fs.chmodSync(file.path,0o600);
        const name=store.originalName(file.originalname);
        const {extension,mime}=store.inspectFile(name,file.path);
        stripPhotoMetadata(file.path,mime);
        const id=crypto.randomUUID(),relative=`owner-${req.user.id}/${id}${extension}`;
        const destination=path.join(store.ownerDirectory(req.user.id),`${id}${extension}`);
        // COPYFILE_EXCL guards duplicate names; only the private upload temp is
        // removed. The browser's original file is never referenced by this API.
        fs.copyFileSync(file.path,destination,fs.constants.COPYFILE_EXCL);destinations.push(destination);fs.chmodSync(destination,0o600);
        const size=fs.statSync(destination).size,sha=store.checksum(destination);
        db.prepare(`INSERT INTO managed_documents(id,user_id,original_name_encrypted,display_name_encrypted,stored_filename,mime_type,size_bytes,sha256,status,legacy_restricted)
          VALUES (?,?,?,?,?,?,?,?,'active',1)`).run(id,req.user.id,store.encrypt(name),store.encrypt(name),relative,mime,size,sha);
        db.prepare('INSERT INTO legacy_content_attachments(content_id,document_id,display_order) VALUES (?,?,?)').run(row.id,id,created.length);
        created.push({id,display_name:name,original_name:name,mime_type:mime,size_bytes:size,sha256:sha});
      }
      legacy.event(db,{userId:req.user.id,contentId:row.id,type:'attachments_uploaded'});
      return {created,errors:[]};
    })();
    return res.status(201).json(result);
  }catch(e){
    destinations.forEach(p=>{try{fs.unlinkSync(p);}catch{}});
    if(!e.status)e=legacy.error('Attachment rejected: content must match a supported format');
    throw e;
  }finally{files.forEach(f=>{try{fs.unlinkSync(f.path);}catch{}});}
}));
ownerRouter.delete('/legacy/:id/attachments/:attachmentId',handler((req,res)=>{
  const db=getDb();db.transaction(()=>{
    const row=legacy.owned(db,req.user.id,req.params.id),doc=attachment(db,row,req.params.attachmentId);
    revisionForAttachment(db,row);
    db.prepare('DELETE FROM legacy_content_attachments WHERE content_id=? AND document_id=?').run(row.id,doc.id);
    legacy.event(db,{userId:req.user.id,contentId:row.id,type:'attachment_unlinked'});
  })();res.json({ok:true,managed_copy_preserved:true});
}));
ownerRouter.get('/legacy/:id/attachments/:attachmentId/content',handler((req,res)=>{
  const db=getDb(),row=legacy.owned(db,req.user.id,req.params.id),doc=attachment(db,row,req.params.attachmentId);
  legacy.event(db,{userId:req.user.id,contentId:row.id,type:'attachment_owner_view'});sendDocument(req,res,doc,req.query.mode);
}));
beneficiaryRouter.use(handler((req,res,next)=>{
  res.set('Cache-Control','private, no-store');
  const header=req.headers.authorization;
  const token=typeof header==='string'&&header.startsWith('Bearer ')?header.slice(7):null;
  req.legacyBeneficiary=legacy.authenticateBeneficiary(getDb(),token);next();
}));
beneficiaryRouter.get('/legacy',handler((req,res)=>{
  const db=getDb(),b=req.legacyBeneficiary;
  const items=legacy.list(db,b.user_id,req.query,b);legacy.event(db,{userId:b.user_id,beneficiaryId:b.id,type:'beneficiary_list'});res.json(items);
}));
beneficiaryRouter.get('/legacy/:id',handler((req,res)=>{
  const db=getDb(),b=req.legacyBeneficiary,row=legacy.beneficiaryItem(db,b,req.params.id);
  legacy.event(db,{userId:b.user_id,beneficiaryId:b.id,contentId:row.id,type:'beneficiary_view'});res.json(legacy.toView(db,row,{beneficiary:b}));
}));
beneficiaryRouter.get('/legacy/:id/attachments/:attachmentId/content',handler((req,res)=>{
  const db=getDb(),b=req.legacyBeneficiary,row=legacy.beneficiaryItem(db,b,req.params.id),doc=attachment(db,row,req.params.attachmentId);
  legacy.event(db,{userId:b.user_id,beneficiaryId:b.id,contentId:row.id,type:'attachment_beneficiary_view'});sendDocument(req,res,doc,req.query.mode);
}));
beneficiaryRouter.post('/legacy/:id/acknowledgements',handler((req,res)=>{
  const db=getDb(),b=req.legacyBeneficiary,row=legacy.beneficiaryItem(db,b,req.params.id);
  if(row.type!=='instruction'||typeof req.body?.step_id!=='string'||typeof req.body?.acknowledged!=='boolean'||
    !legacy.payload(row).metadata?.checklist?.some(step=>step.id===req.body.step_id))throw legacy.error('Invalid checklist step');
  db.transaction(()=>{
    const at=legacy.now();db.prepare(`INSERT INTO legacy_content_acknowledgements VALUES (?,?,?,?,?)
      ON CONFLICT(content_id,beneficiary_id,step_id) DO UPDATE SET acknowledged=excluded.acknowledged,updated_at=excluded.updated_at`)
      .run(row.id,b.id,req.body.step_id,req.body.acknowledged?1:0,at);
    legacy.event(db,{userId:b.user_id,beneficiaryId:b.id,contentId:row.id,type:'checklist_acknowledged',at});
  })();res.json(legacy.toView(db,row,{beneficiary:b}));
}));
ownerRouter.use(errorHandler);beneficiaryRouter.use(errorHandler);
module.exports={ownerRouter,beneficiaryRouter};
