'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const { encrypt, decrypt, hashToken } = require('./crypto');
const { renderMarkdown } = require('./legacy-markdown');
const { utc } = require('./notifications/time');
const store = require('./document-store');
const autoWish = require('./beneficiary-auto-wish');
const { createVaultVisibility } = require('./vault-visibility');
const TYPES = ['letter','recording','family_history','instruction','review'];
const POLICIES = ['owner_only','manual_release','dead_switch_release','emergency_access_release'];
const now = () => new Date().toISOString();
function error(message, status=400) { return Object.assign(new Error(message), {status}); }
function hasSchema(db) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_contents'").get(); }
function event(db, {userId=null,contentId=null,beneficiaryId=null,type,key=null,at=now()}={}) {
  const result = db.prepare(`INSERT OR IGNORE INTO legacy_release_events
    (user_id,content_id,beneficiary_id,event_type,event_key,created_at) VALUES (?,?,?,?,?,?)`)
    .run(userId,contentId,beneficiaryId,type,key,at);
  if (result.changes) db.prepare('INSERT INTO audit_log(user_id,action,target_type,detail,created_at) VALUES (?,?,?,?,?)')
    .run(userId,'legacy_'+type,'legacy_content',contentId,at);
}
function owned(db,userId,id) {
  const row=db.prepare('SELECT * FROM legacy_contents WHERE id=? AND user_id=?').get(id,userId);
  if (!row) { event(db,{userId,type:'access_denied'}); throw error('Content not found',404); }
  return row;
}
function payload(row) {
  try { return JSON.parse(decrypt(row.payload_encrypted)); } catch { throw error('Content could not be decrypted',500); }
}
function text(value,name,max=100000) {
  if (typeof value!=='string' || value.length>max || value.includes('\u0000')) throw error('Invalid '+name);
  return value;
}
function calendarDate(value,partial=false) {
  if(typeof value!=='string'||!(partial?/^\d{4}(?:-\d\d(?:-\d\d)?)?$/:/^\d{4}-\d\d-\d\d$/).test(value)) return false;
  const complete=value.length===4?value+'-01-01':value.length===7?value+'-01':value;
  const parsed=new Date(complete+'T00:00:00Z');
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===complete;
}
function date(value,name) {
  if (value===null || value==='') return null;
  if (typeof value!=='string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))?$/.test(value) || !Number.isFinite(Date.parse(value))) throw error('Invalid '+name);
  if(!calendarDate(value.slice(0,10)) || (value.length>10 && (Number(value.slice(11,13))>23 || Number(value.slice(14,16))>59 || (value[16]===':'&&Number(value.slice(17,19))>59)))) throw error('Invalid '+name);
  const normalized=new Date(value).toISOString();
  if (normalized.slice(0,10)!==value.slice(0,10) && value.length===10) throw error('Invalid '+name);
  return normalized;
}
function ids(input) {
  if (!Array.isArray(input) || input.length>200 || input.some(x=>!Number.isSafeInteger(x)||x<1)) throw error('Invalid beneficiary selection');
  return [...new Set(input)];
}
function validateRecipients(db,userId,input) {
  const result=ids(input);
  for(const id of result) if(!db.prepare('SELECT 1 FROM beneficiaries WHERE id=? AND user_id=?').get(id,userId)) throw error('Beneficiary not found',404);
  return result;
}
function validateLinks(db,userId,links) {
  if(!Array.isArray(links)||links.length>100) throw error('Invalid linked records');
  return [...new Set(links.map(link=>{
    if(!link || !store.ownedEntry(db,userId,link.entry_id)) throw error('Linked vault record not found',404);
    return Number(link.entry_id);
  }))];
}
function validateMetadata(value) {
  if (!value || typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>30000) throw error('Invalid metadata');
  const out=JSON.parse(JSON.stringify(value));
  function check(node,depth=0) {
    if(depth>8) throw error('Metadata too deeply nested');
    if(typeof node==='string') text(node,'metadata',10000);
    else if(Array.isArray(node)) { if(node.length>200) throw error('Too many metadata values'); node.forEach(x=>check(x,depth+1)); }
    else if(node && typeof node==='object') { for(const [key,val] of Object.entries(node)) { if(['__proto__','constructor','prototype'].includes(key)) throw error('Invalid metadata key'); check(val,depth+1); } }
  }
  check(out);
  if(out.date_precision && !['exact','approximate','unknown'].includes(out.date_precision)) throw error('Invalid date precision');
  if(out.event_date && !calendarDate(out.event_date,true)) throw error('Invalid family history date');
  if(out.recorded_at)out.recorded_at=date(out.recorded_at,'recording date');
  if(out.checklist!==undefined) {
    if(!Array.isArray(out.checklist)||out.checklist.length>100) throw error('Invalid checklist');
    const used=new Set();
    out.checklist=out.checklist.map(step=>{
      if(!step||typeof step!=='object') throw error('Invalid checklist step');
      const id=step.id||crypto.randomUUID();
      if(typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,80}$/.test(id)||used.has(id)) throw error('Invalid checklist step id');
      used.add(id);return {id,text:text(step.text,'checklist step',2000)};
    });
  }
  return out;
}
function validateContactRecipients(db,userId,metadata,previous={}) {
  const wishes=metadata.final_wishes;
  if(!wishes || typeof wishes!=='object' || Array.isArray(wishes) || wishes.contact_recipients===undefined) return;
  const recipients=wishes.contact_recipients;
  if(!Array.isArray(recipients)||recipients.length>200) throw error('Invalid contact recipient selection');
  const prior=Array.isArray(previous?.final_wishes?.contact_recipients)?previous.final_wishes.contact_recipients:[];
  const used=new Set();
  wishes.contact_recipients=recipients.map(recipient=>{
    if(!recipient||typeof recipient!=='object'||Array.isArray(recipient)||!Number.isSafeInteger(recipient.entry_id)||recipient.entry_id<1||used.has(recipient.entry_id))
      throw error('Invalid contact recipient selection');
    const id=recipient.entry_id;
    used.add(id);
    const entry=store.ownedEntry(db,userId,id);
    let name;
    if(entry&&entry.section==='contacts') {
      let fields;
      try {fields=JSON.parse(decrypt(entry.fields_encrypted));} catch {throw error('Contact could not be decrypted',500);}
      name=fields?.name||entry.title;
    } else {
      // A saved wish retains the name it originally addressed even after the
      // contact disappears. The request cannot invent or rename a stale ID.
      const snapshot=prior.find(item=>item?.entry_id===id);
      if(!snapshot) throw error('Contact recipient not found',404);
      name=snapshot.name;
    }
    name=text(name,'contact recipient name',10000).trim();
    if(!name) throw error('Contact recipient name is required');
    return {entry_id:id,name};
  });
  if(JSON.stringify(metadata).length>30000) throw error('Invalid metadata');
}
function reviewState(row,at=now()) {
  if(row.status==='archived') return 'archived';
  if(!row.review_enabled||!row.next_review_at) return 'current';
  const time=Date.parse(row.next_review_at), current=Date.parse(at);
  return time<current?'overdue':time<=current+14*86400000?'due_soon':'current';
}
function toView(db,row,{beneficiary=null,detail=true}={}) {
  const data=payload(row);
  const automatic=autoWish.forContent(db,row.id);
  const binding=automatic&&autoWish.validBinding(db,automatic)?automatic:null;
  const currentBeneficiary=beneficiary?db.prepare('SELECT access_granted FROM beneficiaries WHERE id=? AND user_id=?')
    .get(beneficiary.id,row.user_id):null;
  const visibility=currentBeneficiary?.access_granted?createVaultVisibility({getDb:()=>db}).forUser(row.user_id):null;
  const visibleEntry=id=>{
    const entry=store.ownedEntry(db,row.user_id,id);
    return entry&&(!beneficiary||(visibility&&visibility.isVisible(entry)));
  };
  const view={...data,id:row.id,type:row.type,status:row.status,release_policy:row.release_policy,
    auto_generated:!!automatic,
    auto_wish_retired:!!automatic?.retired_at,
    ...(automatic?{locked_beneficiary:{id:automatic.beneficiary_id,name:automatic.beneficiary_name}}:{}),
    revision:row.revision,final_wishes_entry_id:row.final_wishes_entry_id,
    review_enabled:!!row.review_enabled,review_interval_months:row.review_interval_months,
    last_reviewed_at:row.last_reviewed_at,next_review_at:row.next_review_at,review_snoozed_until:row.review_snoozed_until,
    review_state:reviewState(row),created_at:row.created_at,updated_at:row.updated_at,
    body_html:renderMarkdown(data.body_markdown),
    attachments:db.prepare(`SELECT d.* FROM managed_documents d JOIN legacy_content_attachments a ON a.document_id=d.id
      WHERE a.content_id=? AND d.user_id=? AND d.legacy_restricted=1 AND d.status='active' ORDER BY a.display_order,d.created_at`).all(row.id,row.user_id).map(d=>({...store.toView(d),sha256:d.sha256})),
    links:db.prepare('SELECT entry_id FROM legacy_content_links WHERE content_id=?').all(row.id)
      .filter(link=>visibleEntry(link.entry_id))};
  if(beneficiary) {
    view.access_scope=binding&&binding.beneficiary_id===beneficiary.id?'personal_final_wish':'released_content';
    if(!visibleEntry(view.final_wishes_entry_id))view.final_wishes_entry_id=null;
    view.acknowledgements=db.prepare('SELECT step_id,acknowledged,updated_at FROM legacy_content_acknowledgements WHERE content_id=? AND beneficiary_id=?').all(row.id,beneficiary.id);
    return view;
  }
  view.beneficiaries=db.prepare(`SELECT m.beneficiary_id,b.name,m.released_at,m.revoked_at,m.release_scope
    FROM legacy_content_beneficiaries m JOIN beneficiaries b ON b.id=m.beneficiary_id WHERE m.content_id=? AND b.user_id=?`).all(row.id,row.user_id);
  view.beneficiary_ids=view.beneficiaries.map(x=>x.beneficiary_id);
  if(detail) {
    view.versions=db.prepare('SELECT revision,payload_encrypted,editor_id,created_at FROM legacy_content_versions WHERE content_id=? ORDER BY revision DESC LIMIT 100').all(row.id)
      .map(v=>({revision:v.revision,payload:JSON.parse(decrypt(v.payload_encrypted)),editor_id:v.editor_id,created_at:v.created_at}));
    view.reviews=db.prepare('SELECT id,reviewer_id,action,next_review_at,created_at FROM legacy_content_reviews WHERE content_id=? ORDER BY id DESC LIMIT 100').all(row.id);
    view.release_events=db.prepare('SELECT id,beneficiary_id,event_type,created_at FROM legacy_release_events WHERE content_id=? ORDER BY id DESC LIMIT 100').all(row.id);
    view.acknowledgements=db.prepare('SELECT beneficiary_id,step_id,acknowledged,updated_at FROM legacy_content_acknowledgements WHERE content_id=?').all(row.id);
  }
  return view;
}
function list(db,userId,filters={},beneficiary=null) {
  for(const bound of ['from','to'])if(filters[bound]&&!calendarDate(filters[bound]))throw error('Invalid date range');
  if(filters.from&&filters.to&&filters.from>filters.to)throw error('Invalid date range');
  let rows=db.prepare('SELECT * FROM legacy_contents WHERE user_id=? ORDER BY updated_at DESC,id').all(userId);
  if(beneficiary) rows=rows.filter(row=>canRead(db,beneficiary,row));
  if(filters.type) rows=rows.filter(row=>row.type===filters.type);
  if(filters.status) rows=rows.filter(row=>row.status===filters.status);
  if(filters.beneficiary_id) rows=rows.filter(row=>db.prepare('SELECT 1 FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').get(row.id,filters.beneficiary_id));
  return rows.map(row=>toView(db,row,{beneficiary,detail:false})).filter(view=>{
    const q=String(filters.q||'').toLowerCase();
    if(q&&!JSON.stringify([view.title,view.body_markdown,view.metadata,view.description]).toLowerCase().includes(q)) return false;
    const eventDate=view.metadata?.event_date||'';
    const first=eventDate.length===4?eventDate+'-01-01':eventDate.length===7?eventDate+'-01':eventDate;
    const last=eventDate.length===4?eventDate+'-12-31':eventDate.length===7?eventDate+'-31':eventDate;
    if(filters.from&&(!eventDate||last<String(filters.from))) return false;
    if(filters.to&&(!eventDate||first>String(filters.to))) return false;
    return true;
  });
}
function save(db,userId,input,id=null,{allowAutomaticOrigin=false}={}) {
  return db.transaction(()=>{
    if(!input||typeof input!=='object'||Array.isArray(input)) throw error('Invalid content');
    const before=id?owned(db,userId,id):null;
    const old=before?payload(before):{};
    const data={title:input.title??old.title??'',body_markdown:input.body_markdown??old.body_markdown??'',
      introduction:input.introduction??old.introduction??'',description:input.description??old.description??'',
      metadata:validateMetadata(input.metadata??old.metadata??{})};
    const automatic=before?autoWish.forContent(db,before.id):null;
    if(['auto_generated','locked_beneficiary','auto_wish_identity','auto_beneficiary_id','owner_user_id']
      .some(key=>Object.prototype.hasOwnProperty.call(input,key))||(input.id!==undefined&&input.id!==id))throw error('Automatic wish identity is managed by the server');
    if(automatic) {
      if(automatic.retired_at)throw error('The beneficiary was removed; this personal wish must remain archived',409);
      if(automatic.owner_user_id!==userId||!autoWish.validBinding(db,automatic))throw error('Automatic wish ownership requires reconciliation',409);
      if(JSON.stringify(data.metadata.origin)!==JSON.stringify(old.metadata?.origin))throw error('Automatic wish identity cannot be changed');
      if(input.beneficiary_ids!==undefined&&(!Array.isArray(input.beneficiary_ids)||input.beneficiary_ids.length!==1||input.beneficiary_ids[0]!==automatic.beneficiary_id))
        throw error('Automatically assigned recipients cannot be changed');
      const contacts=data.metadata.final_wishes?.contact_recipients;
      if(contacts!==undefined&&(!Array.isArray(contacts)||contacts.length))throw error('Automatic wishes cannot have contact recipients');
    } else if(allowAutomaticOrigin&&!before) {
      const origin=data.metadata.origin;
      if(origin?.type!=='beneficiary'||!Number.isSafeInteger(origin.beneficiary_id)||
        !db.prepare('SELECT 1 FROM beneficiaries WHERE id=? AND user_id=?').get(origin.beneficiary_id,userId)||
        !Array.isArray(input.beneficiary_ids)||input.beneficiary_ids.length!==1||input.beneficiary_ids[0]!==origin.beneficiary_id)
        throw error('Invalid automatic wish identity');
    } else if(JSON.stringify(data.metadata.origin)!==JSON.stringify(old.metadata?.origin))throw error('Content origin is managed by the server');
    validateContactRecipients(db,userId,data.metadata,old.metadata);
    text(data.title,'title',500);if(!data.title.trim()) throw error('Title is required');
    if(data.metadata.related_legacy_content_id) {
      if(typeof data.metadata.related_legacy_content_id!=='string'||!db.prepare('SELECT 1 FROM legacy_contents WHERE id=? AND user_id=?').get(data.metadata.related_legacy_content_id,userId)) throw error('Related personal content not found',404);
    }
    data.title=data.title.trim();text(data.body_markdown,'Markdown body');text(data.introduction,'introduction',10000);text(data.description,'description',10000);
    const type=input.type??before?.type;
    const policy=input.release_policy??before?.release_policy??'owner_only';
    let status=input.status??before?.status??'draft';
    if(!TYPES.includes(type)||!POLICIES.includes(policy)||!['draft','ready','released','archived'].includes(status)) throw error('Invalid content type, status or release policy');
    if(status==='released' && (!before||before.status!=='released')) throw error('Use the confirmed release action');
    const changed=before&&(JSON.stringify(old)!==JSON.stringify(data)||type!==before.type||policy!==before.release_policy||
      input.beneficiary_ids!==undefined||input.links!==undefined||input.final_wishes_entry_id!==undefined);
    if(before?.status==='released'&&changed) status='draft';
    const recipients=input.beneficiary_ids===undefined?null:validateRecipients(db,userId,input.beneficiary_ids);
    const links=input.links===undefined?null:validateLinks(db,userId,input.links);
    const parent=input.final_wishes_entry_id===undefined?before?.final_wishes_entry_id??null:input.final_wishes_entry_id;
    if(parent!==null) { const entry=store.ownedEntry(db,userId,parent); if(!entry||entry.section!=='final_wishes') throw error('Related Final Wishes entry not found',404); }
    const interval=input.review_interval_months??before?.review_interval_months??12;
    if(!Number.isInteger(interval)||interval<1||interval>120) throw error('Invalid review interval');
    const enabled=input.review_enabled===undefined?(before?.review_enabled??(input.next_review_at?1:0)):(input.review_enabled===true||input.review_enabled===1?1:0);
    let next=input.next_review_at===undefined?before?.next_review_at??null:date(input.next_review_at,'next review date');
    if(enabled&&!next)next=addMonths(now(),interval);
    const at=now();id=id||crypto.randomUUID();
    if(before) {
      db.prepare('INSERT INTO legacy_content_versions(content_id,revision,payload_encrypted,editor_id,created_at) VALUES (?,?,?,?,?)')
        .run(id,before.revision,encrypt(JSON.stringify({...old,status:before.status,release_policy:before.release_policy})),userId,at);
      db.prepare(`UPDATE legacy_contents SET type=?,payload_encrypted=?,status=?,release_policy=?,final_wishes_entry_id=?,
        revision=revision+1,review_enabled=?,review_interval_months=?,next_review_at=?,updated_at=? WHERE id=? AND user_id=?`)
        .run(type,encrypt(JSON.stringify(data)),status,policy,parent,enabled,interval,next,at,id,userId);
      if(changed||status!=='released'||policy==='owner_only') invalidateReleases(db,id,at,'revision_withdrawn');
      if(changed) db.prepare('DELETE FROM legacy_content_acknowledgements WHERE content_id=?').run(id);
    } else db.prepare(`INSERT INTO legacy_contents(id,user_id,type,payload_encrypted,status,release_policy,final_wishes_entry_id,
      review_enabled,review_interval_months,next_review_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,userId,type,encrypt(JSON.stringify(data)),status,policy,parent,enabled,interval,next,at,at);
    if(recipients) replaceRecipients(db,userId,id,recipients,at);
    if(links) { db.prepare('DELETE FROM legacy_content_links WHERE content_id=?').run(id); for(const link of links) db.prepare('INSERT INTO legacy_content_links VALUES (?,?)').run(id,link); }
    event(db,{userId,contentId:id,type:before?'updated':'created',at});
    return toView(db,owned(db,userId,id));
  })();
}

function versionAttachmentIds(rows) {
  const result=new Set();
  for(const row of rows) {
    const snapshot=JSON.parse(decrypt(row.payload_encrypted));
    for(const attachment of Array.isArray(snapshot.attachments)?snapshot.attachments:[])
      if(typeof attachment?.document_id==='string')result.add(attachment.document_id);
  }
  return result;
}

// Deletion is distinct from archiving. The short-lived permission allows only
// this owned content's append-only events to be erased in the same transaction.
// Managed copies are staged privately until commit and restored on rollback;
// browser-selected original files are never read or removed here.
function permanentlyDelete(db,userId,id) {
  const initial=owned(db,userId,id),automatic=autoWish.forContent(db,id);
  if(automatic&&(!automatic.retired_at||initial.status!=='archived'))throw error('Archive the automatic wish instead; its beneficiary assignment must remain intact',409);
  if(db.inTransaction)throw error('Permanent deletion requires its own transaction',409);
  const staged=[];
  let result;
  try {
    result=db.transaction(()=>{
      const row=owned(db,userId,id),at=now();
      const assignment=autoWish.forContent(db,id);
      if(assignment&&(!assignment.retired_at||row.status!=='archived'))throw error('The automatic wish assignment must remain intact',409);
      const candidates=versionAttachmentIds(db.prepare('SELECT payload_encrypted FROM legacy_content_versions WHERE content_id=?').all(id));
      for(const attachment of db.prepare('SELECT document_id FROM legacy_content_attachments WHERE content_id=?').all(id))
        candidates.add(attachment.document_id);
      const historicalShared=versionAttachmentIds(db.prepare(`SELECT v.payload_encrypted FROM legacy_content_versions v
        JOIN legacy_contents c ON c.id=v.content_id WHERE c.user_id=? AND c.id<>?`).all(userId,id));
      const documents=[];
      for(const documentId of candidates) {
        const doc=store.ownedDoc(db,userId,documentId);
        if(!doc?.legacy_restricted||historicalShared.has(documentId)||
          db.prepare('SELECT 1 FROM legacy_content_attachments WHERE document_id=? AND content_id<>?').get(documentId,id)||
          db.prepare('SELECT 1 FROM document_associations WHERE document_id=?').get(documentId))continue;
        documents.push(doc);
        if(db.prepare('SELECT 1 FROM managed_documents WHERE stored_filename=? AND id<>?').get(doc.stored_filename,documentId))continue;
        if(!doc.stored_filename.startsWith(`owner-${Number(userId)}/`))throw error('Invalid managed attachment owner',500);
        const filename=store.diskPath(doc.stored_filename);
        let stat;
        try {stat=fs.lstatSync(filename);}catch(e){if(e.code==='ENOENT')continue;throw e;}
        if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
          (typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw error('Unsafe managed attachment',500);
        const temporary=filename+'.deleting-'+crypto.randomUUID();
        fs.renameSync(filename,temporary);
        staged.push({filename,temporary});
      }
      db.prepare('INSERT INTO legacy_content_deletion_permissions(content_id,user_id) VALUES(?,?)').run(id,userId);
      db.prepare('DELETE FROM legacy_release_events WHERE content_id=?').run(id);
      db.prepare("DELETE FROM audit_log WHERE user_id=? AND target_type='legacy_content' AND detail=?").run(userId,id);
      // Review reminder payloads identify this content even after it is gone.
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_outbox'").get()) {
        for(const job of db.prepare("SELECT id,data_json FROM notification_outbox WHERE user_id=? AND event_type='legacy_review_due'").all(userId)) {
          let data;try{data=JSON.parse(job.data_json);}catch{continue;}
          if(data?.contentId===id)db.prepare('DELETE FROM notification_outbox WHERE id=? AND user_id=?').run(job.id,userId);
        }
      }
      db.prepare('DELETE FROM legacy_contents WHERE id=? AND user_id=?').run(id,userId);
      for(const doc of documents)db.prepare('DELETE FROM managed_documents WHERE id=? AND user_id=?').run(doc.id,userId);
      return {deleted:true,id:row.id};
    }).immediate();
  } catch(e) {
    for(const file of staged.reverse())fs.renameSync(file.temporary,file.filename);
    throw e;
  }
  for(const file of staged)fs.unlinkSync(file.temporary);
  return result;
}
function replaceRecipients(db,userId,id,recipients,at=now()) {
  const automatic=autoWish.forContent(db,id);
  if(automatic&&(automatic.owner_user_id!==userId||!autoWish.validBinding(db,automatic)||recipients.length!==1||recipients[0]!==automatic.beneficiary_id))
    throw error('Automatically assigned recipients cannot be changed');
  for(const m of db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=?').all(id)) {
    if(!recipients.includes(m.beneficiary_id)) {
      event(db,{userId,contentId:id,beneficiaryId:m.beneficiary_id,type:'recipient_removed',at});
      db.prepare('DELETE FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').run(id,m.beneficiary_id);
    }
  }
  for(const b of recipients) db.prepare('INSERT OR IGNORE INTO legacy_content_beneficiaries(content_id,beneficiary_id) VALUES (?,?)').run(id,b);
}
function invalidateReleases(db,id,at,type) {
  const row=db.prepare('SELECT user_id FROM legacy_contents WHERE id=?').get(id);
  for(const m of db.prepare('SELECT beneficiary_id FROM legacy_content_beneficiaries WHERE content_id=? AND released_at IS NOT NULL').all(id))
    event(db,{userId:row.user_id,contentId:id,beneficiaryId:m.beneficiary_id,type,at});
  db.prepare('UPDATE legacy_content_beneficiaries SET released_at=NULL,release_scope=NULL WHERE content_id=?').run(id);
}
function canRead(db,beneficiary,row) {
  if(!beneficiary?.id||Number(beneficiary.user_id)!==Number(row.user_id))return false;
  const fresh=db.prepare('SELECT * FROM beneficiaries WHERE id=? AND user_id=?').get(beneficiary.id,row.user_id);
  if(!fresh||fresh.access_token!==beneficiary.access_token)return false;
  if(fresh.token_expires_at) {
    try {if(utc(fresh.token_expires_at).getTime()<=Date.now())return false;}catch{return false;}
  }
  const automatic=autoWish.forContent(db,row.id);
  if(automatic) {
    const mapping=db.prepare('SELECT revoked_at FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').get(row.id,fresh.id);
    return automatic.beneficiary_id===fresh.id&&automatic.owner_user_id===fresh.user_id&&autoWish.validBinding(db,automatic)&&
      !fresh.auto_wish_access_revoked_at&&!mapping?.revoked_at&&row.status!=='archived';
  }
  if(row.status!=='released'||row.release_policy==='owner_only') return false;
  const mapping=db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=? AND beneficiary_id=?').get(row.id,beneficiary.id);
  if(!mapping?.released_at||mapping.revoked_at)return false;
  // Only an explicit Share now confirmation grants token access to this wish.
  // Earlier manual and event-driven releases retain their general-vault gate.
  if(row.release_policy==='manual_release'&&mapping.release_scope==='manual_token_share')return true;
  return !!(fresh.access_granted&&mapping.release_scope===row.release_policy);
}
function authenticateBeneficiary(db,token) {
  const b=typeof token==='string'&&token.length>=1&&token.length<=256
    ?db.prepare('SELECT * FROM beneficiaries WHERE access_token=?').get(hashToken(token)):null;
  let expires=Infinity;
  try {if(b?.token_expires_at)expires=utc(b.token_expires_at).getTime();}catch{expires=NaN;}
  if(!b||!Number.isFinite(expires)&&expires!==Infinity||expires<=Date.now()) {
    event(db,{userId:b?.user_id??null,beneficiaryId:b?.id??null,type:'access_denied'});
    throw error('Beneficiary access is not authorised',403);
  }
  return b;
}
function beneficiaryItem(db,beneficiary,id) {
  const row=db.prepare('SELECT * FROM legacy_contents WHERE id=? AND user_id=?').get(id,beneficiary.user_id);
  if(!row||!canRead(db,beneficiary,row)) { event(db,{userId:beneficiary.user_id,beneficiaryId:beneficiary.id,type:'access_denied'});throw error('Content not found',404); }
  return row;
}
function releaseForEvent(db,{userId,beneficiaryId,policy,eventKey,at=now()}) {
  if(!hasSchema(db)) return 0;
  if(!['dead_switch_release','emergency_access_release'].includes(policy)) throw error('Invalid release event');
  return db.transaction(()=>{
    const conditionKey=`condition:${userId}:${policy}:${beneficiaryId??'all'}:${eventKey}`;
    if(db.prepare('SELECT 1 FROM legacy_release_events WHERE event_key=?').get(conditionKey)) return 0;
    event(db,{userId,beneficiaryId:beneficiaryId??null,type:'release_condition',key:conditionKey,at});
    let count=0;
    const rows=db.prepare("SELECT * FROM legacy_contents WHERE user_id=? AND release_policy=? AND status IN ('ready','released')").all(userId,policy);
    for(const row of rows) {
      const mappings=db.prepare(`SELECT m.* FROM legacy_content_beneficiaries m JOIN beneficiaries b ON b.id=m.beneficiary_id
        WHERE m.content_id=? AND b.user_id=? AND b.access_granted=1 AND m.revoked_at IS NULL AND m.released_at IS NULL
        AND (? IS NULL OR b.id=?)`).all(row.id,userId,beneficiaryId??null,beneficiaryId??null);
      for(const m of mappings) {
        const key=`${eventKey}:${row.id}:${m.beneficiary_id}:${row.revision}`;
        if(db.prepare('SELECT 1 FROM legacy_release_events WHERE event_key=?').get(key)) continue;
        db.prepare('UPDATE legacy_content_beneficiaries SET released_at=?,release_scope=? WHERE content_id=? AND beneficiary_id=?')
          .run(at,policy,row.id,m.beneficiary_id);
        db.prepare("UPDATE legacy_contents SET status='released',updated_at=? WHERE id=?").run(at,row.id);
        event(db,{userId,contentId:row.id,beneficiaryId:m.beneficiary_id,type:'released',key,at});count++;
      }
    }
    return count;
  })();
}
function revokeForBeneficiary(db,{userId,beneficiaryId,at=now(),eventKey}) {
  if(!hasSchema(db)) return;
  db.transaction(()=>{
    for(const m of db.prepare(`SELECT m.* FROM legacy_content_beneficiaries m JOIN legacy_contents c ON c.id=m.content_id
      WHERE c.user_id=? AND m.beneficiary_id=?`).all(userId,beneficiaryId)) {
      db.prepare('UPDATE legacy_content_beneficiaries SET revoked_at=? WHERE content_id=? AND beneficiary_id=?').run(at,m.content_id,beneficiaryId);
      event(db,{userId,contentId:m.content_id,beneficiaryId,type:'revoked',key:eventKey?`${eventKey}:${m.content_id}`:null,at});
    }
  })();
}
function manualRelease(db,userId,id,input) {
  return db.transaction(()=>{
    const row=owned(db,userId,id);
    if(input?.confirm!==true) throw error('Explicit release confirmation is required');
    if(row.release_policy!=='manual_release'||!['ready','released'].includes(row.status)) throw error('Only ready manual-release content can be released');
    const mappings=db.prepare('SELECT * FROM legacy_content_beneficiaries WHERE content_id=?').all(id);
    const selected=input.beneficiary_ids===undefined?mappings.map(x=>x.beneficiary_id):validateRecipients(db,userId,input.beneficiary_ids);
    if(!selected.length||selected.some(b=>!mappings.some(m=>m.beneficiary_id===b))) throw error('Choose assigned recipients');
    const at=now();
    for(const b of selected) {
      const mapping=mappings.find(m=>m.beneficiary_id===b);
      if(mapping.released_at&&!mapping.revoked_at) continue;
      db.prepare('UPDATE legacy_content_beneficiaries SET released_at=?,revoked_at=NULL,release_scope=? WHERE content_id=? AND beneficiary_id=?').run(at,row.release_policy,id,b);
      event(db,{userId,contentId:id,beneficiaryId:b,type:'released',at});
    }
    db.prepare("UPDATE legacy_contents SET status='released',updated_at=? WHERE id=?").run(at,id);
    return toView(db,owned(db,userId,id));
  })();
}
function shareNow(db,userId,id,input) {
  return db.transaction(()=>{
    const row=owned(db,userId,id);
    if(input?.confirm!==true)throw error('Explicit sharing confirmation is required');
    if(!Number.isSafeInteger(input.expected_revision)||input.expected_revision!==row.revision)
      throw error('This wish has changed. Refresh it before confirming sharing.',409);
    if(autoWish.forContent(db,id)||row.status==='archived')throw error('This wish cannot be shared with this action',409);
    const selected=validateRecipients(db,userId,input.beneficiary_ids);
    const assigned=db.prepare('SELECT beneficiary_id FROM legacy_content_beneficiaries WHERE content_id=?').all(id);
    if(!selected.length||selected.some(b=>!assigned.some(m=>m.beneficiary_id===b)))throw error('Choose assigned recipients');
    // Preserve earlier recipient grants when extending a shared manual wish.
    // Converting another release policy withdraws its previous grants first.
    if(row.release_policy!=='manual_release'||row.status==='draft') {
      const saved=save(db,userId,{release_policy:'manual_release',status:'ready'},id);
      // Editing a released conditional wish normally creates a private draft.
      // This confirmed transaction proceeds directly to the selected release.
      if(saved.status==='draft')db.prepare("UPDATE legacy_contents SET status='ready' WHERE id=? AND user_id=?").run(id,userId);
    }
    manualRelease(db,userId,id,{confirm:true,beneficiary_ids:selected});
    for(const beneficiaryId of selected) {
      const changed=db.prepare("UPDATE legacy_content_beneficiaries SET release_scope='manual_token_share' WHERE content_id=? AND beneficiary_id=? AND release_scope IS NOT 'manual_token_share'").run(id,beneficiaryId);
      if(changed.changes)event(db,{userId,contentId:id,beneficiaryId,type:'token_shared'});
    }
    return toView(db,owned(db,userId,id));
  }).immediate();
}
function addMonths(at,months) {
  const d=new Date(at),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString();
}
function review(db,userId,id,input) {
  return db.transaction(()=>{
    const row=owned(db,userId,id),action=input?.action,at=now();
    if(autoWish.forContent(db,id)?.retired_at)throw error('The beneficiary was removed; this personal wish must remain archived',409);
    if(!['no_change','updated','reschedule','snooze','disable'].includes(action)) throw error('Invalid review action');
    let next=row.next_review_at,snooze=null,last=row.last_reviewed_at,enabled=row.review_enabled;
    if(action==='no_change'||action==='updated') {last=at;next=input.next_review_at?date(input.next_review_at,'next review date'):addMonths(at,row.review_interval_months);enabled=1;}
    if(action==='reschedule') {next=date(input.next_review_at,'next review date');if(!next) throw error('Next review date is required');enabled=1;}
    if(action==='snooze') {snooze=date(input.snooze_until,'snooze date');if(!snooze||snooze<=at) throw error('Snooze must be in the future');}
    if(action==='disable') enabled=0;
    db.prepare('UPDATE legacy_contents SET last_reviewed_at=?,next_review_at=?,review_snoozed_until=?,review_enabled=?,updated_at=? WHERE id=?').run(last,next,snooze,enabled,at,id);
    db.prepare('INSERT INTO legacy_content_reviews(content_id,reviewer_id,action,next_review_at,created_at) VALUES (?,?,?,?,?)').run(id,userId,action,next,at);
    event(db,{userId,contentId:id,type:'review_'+action,at});
    return toView(db,owned(db,userId,id));
  })();
}
module.exports={TYPES,POLICIES,error,hasSchema,event,owned,payload,toView,list,save,permanentlyDelete,ids,validateRecipients,replaceRecipients,invalidateReleases,
  canRead,authenticateBeneficiary,beneficiaryItem,releaseForEvent,revokeForBeneficiary,manualRelease,shareNow,review,reviewState,now};
