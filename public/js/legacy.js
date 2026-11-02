/* global API, Docs, RecordCards, SECTIONS, showError, showSuccess */
'use strict';

// These records belong to Final Wishes. They are fetched separately from the
// ordinary vault because every recipient request has item-level permissions.
const Legacy = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const types = {letter:'Personal Letters',recording:'Audio & Video Messages',family_history:'Family History',instruction:'Personal Instructions',review:'Information Reviews'};
  const singular = {letter:'letter',recording:'recording',family_history:'family memory',instruction:'instruction',review:'review record'};
  // The storage type stays compatible with existing protected content; an empty
  // optional content type presents the ordinary Final Wishes form.
  const contentType = item => item.metadata?.final_wishes?.content_type === '' ? '' : item.type;
  const contentLabel = item => types[contentType(item)] || 'Final Wishes';
  const recordCategory = item => item.metadata?.final_wishes?.category || contentLabel(item);
  const hasInformationReview = item => Boolean(item.review_enabled) || (contentType(item)!=='' && (contentType(item)==='review' || (item.reviews || []).length>0 || Boolean(item.last_reviewed_at)));
  const recordIcons = {letter:'envelope',recording:'chat-heart',family_history:'clock-history',instruction:'tools',review:'journal-text'};
  const policies = {owner_only:'Private — owner only',manual_release:'Release manually',dead_switch_release:'Release when the Dead Man’s Switch triggers',emergency_access_release:'Release after emergency access is granted'};
  const reviewNames = {current:'Current',due_soon:'Due soon',overdue:'Overdue',archived:'Archived',disabled:'Not scheduled'};
  const mediaAccept = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.txt,.mp3,.m4a,.wav,.mp4,.mov';
  const urlId = value => encodeURIComponent(String(value));
  const base = '/final-wishes/legacy';
  const normalizedDate = value => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value || '') ? value.replace(' ','T')+'Z' : value;
  function date(value, withTime=false) {
    if (!value) return 'Not set';
    const parsed = new Date(normalizedDate(value));
    if (!Number.isFinite(parsed.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-ZA', {timeZone:'Africa/Johannesburg',dateStyle:'medium',...(withTime?{timeStyle:'short'}:{})}).format(parsed)+(withTime?' SAST':'');
  }
  const dateInput = value => value ? String(value).slice(0,10) : '';
  const list = value => Array.isArray(value) ? value : value ? [String(value)] : [];
  const textList = value => list(value).join(', ');
  const commaList = value => String(value || '').split(',').map(part=>part.trim()).filter(Boolean);
  const stepId = () => 'step-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
  const arrayResult = data => Array.isArray(data) ? data : (data?.items || data?.contents || data?.entries || []);
  const badge = (value,kind='') => `<span class="badge badge-${kind || (['released','current'].includes(value)?'success':['overdue','archived'].includes(value)?'danger':'warning')}">${escape(reviewNames[value] || String(value || 'draft').replace(/_/g,' '))}</span>`;
  const button = (action,label,kind='outline',extra='') => `<button type="button" class="btn btn-${kind} btn-sm" data-legacy-action="${action}" ${extra}>${label}</button>`;
  const selectOptions = (values,chosen) => Object.entries(values).map(([value,label])=>`<option value="${escape(value)}" ${String(chosen)===String(value)?'selected':''}>${escape(label)}</option>`).join('');
  const field = (name,label,value='',options={}) => `<div class="form-group"><label for="legacy-${name}">${escape(label)}</label>${options.textarea?`<textarea id="legacy-${name}" name="${name}" ${options.required?'required':''} ${options.rows?`rows="${options.rows}"`:''}>${escape(value)}</textarea>`:`<input id="legacy-${name}" name="${name}" type="${options.type || 'text'}" value="${escape(value)}" ${options.required?'required':''} ${options.max?`maxlength="${options.max}"`:''} ${options.placeholder?`placeholder="${escape(options.placeholder)}"`:''}>`}</div>`;
  async function countEntries() {
    return arrayResult(await API.request('GET',base)).filter(item=>item.status!=='archived').length;
  }
  function modalClose(overlay) {
    const key=event=>{if(event.key==='Escape')close();};
    const close=()=>{overlay.remove();document.removeEventListener('keydown',key);window.removeEventListener('hashchange',close);window.removeEventListener('pagehide',close);};
    document.addEventListener('keydown',key);window.addEventListener('hashchange',close);window.addEventListener('pagehide',close);
    return close;
  }

  // Only the server's restricted Markdown output is rendered. This second pass
  // keeps unexpected HTML and remote embeds out of all preview surfaces.
  function safeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const allowed = new Set(['P','BR','STRONG','EM','B','I','S','DEL','UL','OL','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','CODE','HR','A']);
    function clean(parent) {
      for (const node of [...parent.children]) {
        if (!allowed.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent)); continue; }
        const href = node.tagName==='A' ? node.getAttribute('href') : null;
        for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
        if (href && /^(https?:\/\/|mailto:)/i.test(href.trim())) { node.setAttribute('href',href.trim());node.setAttribute('target','_blank');node.setAttribute('rel','noopener noreferrer'); }
        clean(node);
      }
    }
    clean(template.content);
    return template.innerHTML;
  }
  async function preview(markdown) {
    const result = await API.request('POST','/final-wishes/preview',{body_markdown:markdown || ''});
    return safeHtml(result.html);
  }
  async function recipientRequest(token,method,path='',body) {
    const response = await fetch('/api/beneficiary-access/legacy'+path,{method,headers:{Authorization:'Bearer '+token,Accept:'application/json','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    const data = await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error || 'Protected content is unavailable');
    return data;
  }
  async function openAttachment(itemId,attachment,mode,token) {
    const endpoint = token ? '/api/beneficiary-access/legacy/' : '/api/final-wishes/legacy/';
    const response = await fetch(endpoint+urlId(itemId)+'/attachments/'+urlId(attachment.id)+'/content?mode='+urlId(mode),{headers:{Authorization:'Bearer '+(token || API.token)}});
    if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error || 'Attachment is unavailable');}
    const blob = await response.blob();
    if(mode==='preview' && Docs.previewable(attachment.mime_type))return Docs.preview(blob,attachment.display_name,attachment.mime_type);
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=attachment.display_name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function attachmentCards(item) {
    return item.attachments?.length ? `<section class="doc-section"><h3>Attached files</h3>${item.attachments.map(attachment=>`<div class="doc-row"><span class="doc-file-name">${escape(attachment.display_name)}<small>${escape(attachment.mime_type)} · ${Math.max(1,Math.ceil(attachment.size_bytes/1024))} KB${attachment.sha256?` · SHA-256 ${escape(attachment.sha256.slice(0,12))}…`:''}</small></span><span class="doc-actions">${Docs.previewable(attachment.mime_type)?`<button type="button" class="btn btn-outline btn-sm" data-legacy-file="${escape(attachment.id)}" data-mode="preview">${/^(audio|video)\//.test(attachment.mime_type)?'Play':'Preview'}</button>`:''}<button type="button" class="btn btn-outline btn-sm" data-legacy-file="${escape(attachment.id)}" data-mode="download">Download</button></span></div>`).join('')}</section>` : '';
  }
  function bindFiles(root,item,token) {
    root.querySelectorAll('[data-legacy-file]').forEach(control=>control.addEventListener('click',async()=>{
      const attachment=(item.attachments || []).find(file=>String(file.id)===control.dataset.legacyFile);
      if(!attachment)return;control.disabled=true;
      try{await openAttachment(item.id,attachment,control.dataset.mode,token);}catch(error){showError(error.message);}finally{control.disabled=false;}
    }));
  }
  const contactRecipients = item => Array.isArray(item.metadata?.final_wishes?.contact_recipients) ? item.metadata.final_wishes.contact_recipients.filter(recipient=>recipient && Number.isSafeInteger(Number(recipient.entry_id)) && Number(recipient.entry_id)>0 && typeof recipient.name==='string') : [];
  function metadataView(item) {
    const metadata = item.metadata || {};
    const wishes = metadata.final_wishes || {};
    const fields = [
      ['Named contacts',contactRecipients(item).map(recipient=>recipient.name).join(', ')],['Details',wishes.details],['Contact person',wishes.contact_person],['Contact phone',wishes.contact_phone],['Notes',wishes.notes],
      ['Date',metadata.event_date ? `${metadata.date_precision==='approximate'?'Approximately ':''}${metadata.event_date}` : item.type==='family_history'?'Unknown':null],
      ['Recorded',metadata.recorded_at],['People',textList(metadata.people)],['Relationship',metadata.relationship],['Place',metadata.place],
      ['Tags',textList(metadata.tags)],['Category',metadata.category],['Priority',metadata.priority],['Responsible people',textList(metadata.responsible_people)],['Helpful contacts',textList(metadata.helpful_contacts)],
    ].filter(([,value])=>value);
    return fields.length?`<dl class="legacy-metadata">${fields.map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value).replace(/\n/g,'<br>')}</dd></div>`).join('')}</dl>`:'';
  }
  function checklistView(item,acknowledge=false) {
    const steps = item.metadata?.checklist || [];
    if(!Array.isArray(steps) || !steps.length)return '';
    const acknowledged = new Set((item.acknowledgements || []).filter(entry=>entry.acknowledged!==false && entry.acknowledged!==0).map(entry=>String(entry.step_id)));
    return `<section class="legacy-checklist"><h3>Instruction checklist</h3><ol>${steps.map((step,index)=>`<li>${acknowledge?`<label><input type="checkbox" data-legacy-step="${escape(step.id)}" ${acknowledged.has(String(step.id))?'checked':''}><span>${escape(step.text)}</span></label>`:`<span>${escape(step.text)}</span>`}</li>`).join('')}</ol>${acknowledge?'<p class="legacy-help">Your confirmations are saved separately from the owner’s instructions.</p>':''}</section>`;
  }
  function contentView(item,html,acknowledge=false) {
    return `${item.introduction?`<p class="legacy-introduction">${escape(item.introduction)}</p>`:''}${item.description?`<p class="legacy-description">${escape(item.description)}</p>`:''}${metadataView(item)}<div class="legacy-markdown">${html || '<p>No written message.</p>'}</div>${checklistView(item,acknowledge)}${attachmentCards(item)}`;
  }
  function ownerRecipientSummary(item) {
    const recipients=item.beneficiaries || [],contacts=contactRecipients(item);
    return `<section class="legacy-subsection"><h3>Recipients and release</h3><p class="legacy-help">${escape(policies[item.release_policy] || item.release_policy)}</p>${recipients.length || contacts.length?`<ul class="legacy-recipients">${recipients.map(recipient=>`<li><strong>${escape(recipient.name || 'Beneficiary')}</strong> ${recipient.revoked_at?badge('revoked','danger'):recipient.released_at?badge('released'):badge('private')}${recipient.released_at?`<small>Released ${escape(date(recipient.released_at,true))}${recipient.release_scope?` · ${escape(recipient.release_scope.replace(/_/g,' '))}`:''}</small>`:''}${recipient.revoked_at?`<small>Revoked ${escape(date(recipient.revoked_at,true))}</small>`:''}</li>`).join('')}${contacts.map(recipient=>`<li><strong>${escape(recipient.name)}</strong> <span class="legacy-recipient-kind">Contact</span><small>Named on this wish; no vault access.</small></li>`).join('')}</ul>`:'<p>No recipients selected.</p>'}</section>`;
  }

  async function mountOwner(root,finalEntries=[],options={}) {
    if(!root)return;
    let items=[],beneficiaries=[],vaultEntries=[],filter={q:'',status:''},detail=null,widget=null,sequence=0;
    let uploadConfig={max_file_bytes:25*1024*1024,accepted:mediaAccept};
    const alive=()=>root.isConnected;
    const message=(text,error=false)=>{if(!alive())return;const target=root.querySelector('[data-legacy-feedback]');if(target){target.textContent=text;target.hidden=false;target.className='alert alert-'+(error?'error':'success');}else (error?showError:showSuccess)(text);};
    const feedback='<div data-legacy-feedback hidden role="status" aria-live="polite"></div>';
    const heading=(title,actions='')=>`<div class="legacy-heading"><h2>${escape(title)}</h2><div class="actions">${actions}</div></div>`;
    function newWish() {
      const recipient=beneficiaries.find(row=>String(row.id)===String(options.beneficiaryId));
      const chosenType=Object.hasOwn(types,options.type)?options.type:'';
      return {type:chosenType || 'instruction',title:recipient?.name || '',metadata:{final_wishes:{content_type:chosenType,category:recipient?'Beneficiary Instructions':''}},beneficiary_ids:recipient?[recipient.id]:[]};
    }
    async function allVaultEntries() {
      const first=await API.request('GET','/vault/entries?limit=100');
      const entries=arrayResult(first);
      for(let page=2;page<=Number(first.pages || 1);page++)entries.push(...arrayResult(await API.request('GET','/vault/entries?limit=100&page='+page)));
      return entries;
    }
    function card(item,timeline=item.type==='family_history') {
      const metadata=item.metadata || {};
      const recipients=[...(item.beneficiaries || []).map(recipient=>recipient.name),...contactRecipients(item).map(recipient=>recipient.name)].filter(Boolean);
      const timelineDate=timeline?`<p class="legacy-timeline-date">${escape(metadata.event_date?`${metadata.date_precision==='approximate'?'Approx. ':''}${metadata.event_date}`:'Unknown date')}</p>`:'';
      return RecordCards.render({
        title:item.title,section:'final_wishes',category:recordCategory(item),iconName:recordIcons[contentType(item)] || 'file-earmark-text',
        badges:`<div class="legacy-badges">${badge(item.status)}${item.review_enabled?badge(item.review_state):''}</div>`,
        className:'legacy-item',
        body:`<div class="record-card-body">${timelineDate}${item.description?`<p class="legacy-description">${escape(item.description)}</p>`:''}<p class="legacy-help">${escape(policies[item.release_policy] || item.release_policy)} · ${recipients.length?`For ${escape(recipients.join(', '))}`:`${(item.beneficiary_ids || item.beneficiaries || []).length} recipient(s)`}${metadata.people?.length?` · ${escape(textList(metadata.people))}`:''}${metadata.tags?.length?`<br>Tags: ${escape(textList(metadata.tags))}`:''}</p><p class="legacy-help">Updated ${escape(date(item.updated_at))}${item.next_review_at?` · Review ${escape(date(item.next_review_at))}`:''}</p></div>`,
        footer:RecordCards.footer({primary:RecordCards.action({label:'Open',iconName:'file-earmark-text',attributes:`data-legacy-action="open" data-item-id="${escape(item.id)}"`}),secondary:RecordCards.action({label:'Delete',iconName:'trash',attributes:`data-legacy-action="delete" data-item-id="${escape(item.id)}"`,danger:true})})
      });
    }
    function drawList() {
      if(!alive())return;
      detail=null;
      const arrangements=!filter.status ? finalEntries.filter(entry=>!filter.q || [entry.title,entry.notes,...Object.values(entry.fields || {})].join(' ').toLowerCase().includes(filter.q.toLowerCase())) : [];
      root.innerHTML=`${feedback}
        <form class="legacy-filters" id="legacy-filter-form">
          <div class="form-group"><label for="legacy-search">Search title, people, tags or text</label><input id="legacy-search" name="q" value="${escape(filter.q)}" type="search" placeholder="Search Final Wishes"></div>
          <div class="form-group"><label for="legacy-filter-status">Status</label><select id="legacy-filter-status" name="status"><option value="">All statuses</option>${selectOptions({draft:'Draft',ready:'Ready',released:'Released',archived:'Archived'},filter.status)}</select></div>
          <button type="submit" class="btn btn-outline btn-sm">Search</button>
        </form>
        <div class="legacy-list">
          ${arrangements.map(entry=>RecordCards.entry(entry,{section:'final_wishes',documentCount:options.documentCounts?.[entry.id] || 0})).join('')}
          ${items.map(item=>card(item)).join('')}
          ${!items.length && !arrangements.length?`<div class="empty-state"><h3>No Final Wishes entries yet</h3><p>${filter.q || filter.status?'Try changing your search filters.':'Use Add Final Wishes Entry to prepare wishes and content for your recipients.'}</p></div>`:''}
        </div>`;
      root.querySelector('#legacy-filter-form').onsubmit=async event=>{event.preventDefault();filter=Object.fromEntries(new FormData(event.target));await load();};
      bindActions();
      options.onRender?.();
    }
    async function load(render=!options.entryForm) {
      const current=++sequence;
      root.setAttribute('aria-busy','true');
      try{const query=new URLSearchParams(Object.entries(filter).filter(([,value])=>value));const result=await API.request('GET',base+(query.size?'?'+query:''));if(alive() && current===sequence){items=arrayResult(result);if(render)drawList();return true;}}
      catch(error){if(alive() && current===sequence){root.innerHTML=feedback+button('reload','Try again');bindActions();message(error.message,true);}return false;}
      finally{if(alive())root.removeAttribute('aria-busy');}
    }
    function reviewControls(item) {
      if(!hasInformationReview(item))return '';
      return `<section class="legacy-subsection"><h3>Information review ${item.review_enabled?badge(item.review_state):''}</h3><dl class="legacy-metadata"><div><dt>Last reviewed</dt><dd>${escape(date(item.last_reviewed_at))}</dd></div><div><dt>Next review</dt><dd>${escape(date(item.next_review_at))}</dd></div><div><dt>Interval</dt><dd>${item.review_interval_months?Number(item.review_interval_months)+' months':'Not scheduled'}</dd></div>${item.review_snoozed_until?`<div><dt>Reminder snoozed until</dt><dd>${escape(date(item.review_snoozed_until))}</dd></div>`:''}</dl><div class="actions">${button('review-no-change','Reviewed — No Change','success')}${button('review-updated','Reviewed and Updated')}${button('review-reschedule','Reschedule')}${item.review_enabled?button('review-snooze','Snooze reminder')+button('review-disable','Disable review'):''}</div><p class="legacy-help">This review records information accuracy and leaves your separate check-in schedule unchanged.</p></section>`;
    }
    function historyView(item) {
      const events=item.release_events || [];
      const reviews=item.reviews || [];
      const versions=item.versions || [];
      return `<details class="legacy-subsection"><summary>Revision history (${versions.length})</summary>${versions.length?versions.map(version=>`<details class="legacy-history-entry"><summary>Revision ${Number(version.revision) || 1} · ${escape(date(version.created_at,true))}</summary><h4>${escape(version.payload?.title || version.title || '')}</h4><pre>${escape(version.payload?.body_markdown || version.body_markdown || JSON.stringify(version.payload || {},null,2))}</pre></details>`).join(''):'<p>No previous revisions yet.</p>'}</details><details class="legacy-subsection"><summary>Release and access history (${events.length})</summary>${events.length?`<ul class="legacy-history">${events.map(event=>`<li><strong>${escape((event.event_type || event.type || event.action || 'Recorded event').replace(/_/g,' '))}</strong><small>${escape(date(event.created_at || event.released_at,true))}${event.beneficiary_id?` · Recipient ${escape(event.beneficiary_id)}`:''}</small></li>`).join('')}</ul>`:'<p>No releases or recipient access recorded.</p>'}</details>${hasInformationReview(item)?`<details class="legacy-subsection"><summary>Review history (${reviews.length})</summary>${reviews.length?`<ul class="legacy-history">${reviews.map(review=>`<li>${escape((review.action || review.status || 'reviewed').replace(/_/g,' '))}<small>${escape(date(review.created_at || review.reviewed_at,true))}${review.reviewer?` · ${escape(review.reviewer)}`:''}</small></li>`).join('')}</ul>`:'<p>No reviews recorded.</p>'}</details>`:''}`;
    }
    async function showDetail(id,recipientPreview=false) {
      const current=++sequence;
      try{
        const item=await API.request('GET',base+'/'+urlId(id));
        const html=await preview(item.body_markdown);
        if(item.links?.length && !vaultEntries.length)vaultEntries=await allVaultEntries();
        if(!alive() || current!==sequence)return;
        detail=item;
        const controls=recipientPreview?button('open','Return to management','outline',`data-item-id="${escape(item.id)}"`):RecordCards.action({label:'Edit',iconName:'pencil',attributes:'data-legacy-action="edit"'})+button('preview','Preview recipient view')+(item.status==='draft'?button('ready','Mark ready','success'):'')+(item.release_policy==='manual_release' && ['ready','released'].includes(item.status)?button('release','Release…','primary'):'')+((item.beneficiaries || []).some(recipient=>recipient.released_at && !recipient.revoked_at)?button('revoke','Revoke release…','warning'):'');
        const archiveControl=!recipientPreview && item.status!=='archived'?RecordCards.action({label:'Archive',iconName:'archive',attributes:'data-legacy-action="archive"'}):'';
        const deleteControl=recipientPreview?'':RecordCards.action({label:'Delete',iconName:'trash',attributes:`data-legacy-action="delete" data-item-id="${escape(item.id)}"`,danger:true});
        root.innerHTML=heading(item.title,button('back','← All Final Wishes'))+feedback+`<div class="card record-card legacy-detail">${RecordCards.heading({title:item.title,section:'final_wishes',category:recordCategory(item),iconName:recordIcons[contentType(item)] || 'file-earmark-text',badges:recipientPreview?'':`<div class="legacy-badges">${badge(item.status)}</div>`})}${recipientPreview?'<div class="alert alert-info">Owner preview of the recipient’s content. Actual recipient access depends on their current authorisation and this item’s release.</div>':''}${contentView(item,html)}${!recipientPreview?ownerRecipientSummary(item)+renderLinks(item)+reviewControls(item)+`<p class="legacy-help">Created ${escape(date(item.created_at,true))} · Updated ${escape(date(item.updated_at,true))} · Revision ${Number(item.revision) || 1}</p>`+historyView(item):''}${RecordCards.footer({primary:controls+archiveControl,secondary:deleteControl})}</div>`;
        bindActions();bindFiles(root,item);
      }catch(error){message(error.message,true);}
    }
    function renderLinks(item) {
      const related=items.find(candidate=>candidate.id===item.metadata?.related_legacy_content_id);
      return (item.links?.length || related)?`<section class="legacy-subsection"><h3>Related records</h3><ul>${(item.links || []).map(link=>{const entry=vaultEntries.find(entry=>String(entry.id)===String(link.entry_id));return `<li>${entry?`<a href="#edit/${urlId(entry.section)}/${urlId(entry.id)}">${escape(SECTIONS[entry.section]?.name || entry.section)} · ${escape(entry.title)}</a>`:`Vault record ${escape(link.entry_id)}`}</li>`;}).join('')}${related?`<li><a href="#section/final_wishes/${urlId(related.id)}">${escape(types[related.type])} · ${escape(related.title)}</a></li>`:''}</ul></section>`:'';
    }
    function metadataFields(item) {
      if(!contentType(item))return '';
      const metadata=item.metadata || {};
      return `<div class="legacy-form-grid">${item.type==='family_history'?field('event_date','Event date',metadata.event_date,{placeholder:'YYYY, YYYY-MM or YYYY-MM-DD; blank if unknown'})+`<div class="form-group"><label for="legacy-date_precision">Date certainty</label><select id="legacy-date_precision" name="date_precision">${selectOptions({unknown:'Unknown',exact:'Exact',approximate:'Approximate'},metadata.date_precision || 'unknown')}</select></div>`+field('relationship','Family relationship',metadata.relationship)+field('place','Place',metadata.place):''}${item.type==='recording'?field('recorded_at','Recording date (optional)',dateInput(metadata.recorded_at),{type:'date'}):''}${['family_history','recording'].includes(item.type)?field('people','People (separate with commas)',textList(metadata.people))+field('tags','Tags (separate with commas)',textList(metadata.tags)):''}${item.type==='family_history'?field('category','Archive category',metadata.category,{placeholder:'Story, event, photograph, certificate…'}):''}${['letter','recording'].includes(item.type)?`<div class="form-group"><label for="legacy-related_legacy_content_id">${item.type==='letter'?'Related recording':'Related letter'} (optional)</label><select id="legacy-related_legacy_content_id" name="related_legacy_content_id"><option value="">None — standalone</option>${items.filter(related=>related.type===(item.type==='letter'?'recording':'letter') && related.id!==item.id).map(related=>`<option value="${escape(related.id)}" ${metadata.related_legacy_content_id===related.id?'selected':''}>${escape(related.title)}</option>`).join('')}</select></div>`:''}${item.type==='instruction'?`<div class="form-group"><label for="legacy-category">Category</label><select id="legacy-category" name="category">${selectOptions({properties:'Properties',maintenance:'Maintenance',vehicles:'Vehicles',equipment:'Equipment',pets:'Pets',household_services:'Household services',subscriptions:'Subscriptions',digital_administration:'Digital administration',other:'Other'},metadata.category || 'other')}</select></div><div class="form-group"><label for="legacy-priority">Priority</label><select id="legacy-priority" name="priority">${selectOptions({low:'Low',normal:'Normal',high:'High',urgent:'Urgent'},metadata.priority || 'normal')}</select></div>`+field('responsible_people','Responsible people (separate with commas)',textList(metadata.responsible_people))+field('helpful_contacts','Helpful contacts (separate with commas)',textList(metadata.helpful_contacts)):''}</div>${item.type==='instruction'?field('checklist','Checklist — one step per line',(metadata.checklist || []).map(step=>step.text).join('\n'),{textarea:true,rows:6})+'<p class="legacy-help">Keep passwords, alarm codes and recovery keys in their protected vault records.</p>':''}`;
    }
    function wishFields(item) {
      const wishes=item.metadata?.final_wishes || {};
      const categories=SECTIONS.final_wishes.fields.find(field=>field.key==='category')?.options || [];
      const choices=Object.fromEntries(categories.map(category=>[category,category]));
      if(wishes.category && !Object.hasOwn(choices,wishes.category))choices[wishes.category]=wishes.category;
      return `<fieldset class="legacy-fieldset"><legend>Final Wishes details</legend>
        ${field('title','Title / subject',item.title,{required:true,max:500})}
        <div class="form-group"><label for="legacy-wish_category">Wish category</label><select id="legacy-wish_category" name="wish_category"><option value="">-- Select --</option>${selectOptions(choices,wishes.category)}</select></div>
        ${field('wish_details','Details',wishes.details,{textarea:true,rows:4})}
        <div class="legacy-form-grid">${field('wish_contact_person','Contact person',wishes.contact_person)}${field('wish_contact_phone','Contact phone',wishes.contact_phone,{type:'tel'})}</div>
        ${field('wish_notes','Notes',wishes.notes,{textarea:true,rows:3})}
      </fieldset>`;
    }
    function mountRecipientPicker(item) {
      const search=root.querySelector('#legacy-recipient-search'),results=root.querySelector('#legacy-recipient-results'),selected=root.querySelector('[data-selected-recipients]'),status=root.querySelector('#legacy-recipient-status');
      const candidates=[
        ...beneficiaries.map(row=>({key:'beneficiary:'+row.id,id:Number(row.id),name:row.name || 'Beneficiary',kind:'Beneficiary',detail:row.relationship || '',search:[row.name,row.relationship,row.role,row.email,row.phone].filter(Boolean).join(' ')})),
        ...vaultEntries.filter(entry=>entry.section==='contacts').map(entry=>({key:'contact:'+entry.id,id:Number(entry.id),name:entry.fields?.name || entry.title || 'Contact',kind:'Contact',detail:entry.fields?.role || '',search:[entry.title,...Object.values(entry.fields || {})].filter(value=>typeof value==='string').join(' ')}))
      ];
      const chosen=new Map();
      for(const id of item.beneficiary_ids || (item.beneficiaries || []).map(recipient=>recipient.beneficiary_id)){
        const recipient=candidates.find(row=>row.key==='beneficiary:'+id);
        if(recipient)chosen.set(recipient.key,recipient);
      }
      for(const contact of contactRecipients(item)){
        const key='contact:'+contact.entry_id,existing=candidates.find(row=>row.key===key);
        chosen.set(key,existing || {key,id:Number(contact.entry_id),name:contact.name,kind:'Contact',detail:'Saved contact'});
      }
      const labels=recipient=>`<span class="legacy-recipient-name">${escape(recipient.name)}</span><span class="legacy-recipient-kind">${recipient.kind}</span>${recipient.detail?`<small>${escape(recipient.detail)}</small>`:''}${recipient.kind==='Contact'?'<small>Named only · no vault access</small>':''}`;
      function drawSelected(){
        selected.innerHTML=[...chosen.values()].map(recipient=>`<li class="legacy-recipient-chip">${recipient.kind==='Beneficiary'?`<input type="hidden" name="beneficiary_ids" value="${escape(recipient.id)}">`:''}<span>${labels(recipient)}</span><button type="button" class="btn btn-outline" data-remove-recipient="${escape(recipient.key)}" aria-label="Remove ${escape(recipient.name)}">×</button></li>`).join('');
        selected.hidden=!chosen.size;
        selected.querySelectorAll('[data-remove-recipient]').forEach(control=>control.onclick=()=>{chosen.delete(control.dataset.removeRecipient);drawSelected();drawResults();search.focus();});
      }
      function drawResults(){
        const query=search.value.trim().toLocaleLowerCase();
        const matches=candidates.filter(recipient=>!chosen.has(recipient.key) && (!query || recipient.search.toLocaleLowerCase().includes(query)));
        results.innerHTML=matches.map(recipient=>`<li><button type="button" class="legacy-recipient-result" data-add-recipient="${escape(recipient.key)}">${labels(recipient)}</button></li>`).join('');
        results.hidden=!matches.length;
        status.textContent=matches.length?`${matches.length} ${query?'matching':'saved'} ${matches.length===1?'recipient':'recipients'}. Choose a person to add them.`:query?'No matching contacts or beneficiaries.':candidates.length?'All saved contacts and beneficiaries are selected.':'No saved contacts or beneficiaries yet.';
        results.querySelectorAll('[data-add-recipient]').forEach(control=>control.onclick=()=>{
          const recipient=candidates.find(row=>row.key===control.dataset.addRecipient);
          if(!recipient)return;
          chosen.set(recipient.key,recipient);search.value='';drawSelected();drawResults();search.focus();
        });
      }
      search.oninput=drawResults;
      search.onfocus=drawResults;
      search.onkeydown=event=>{
        if(event.key==='Enter'){event.preventDefault();results.querySelector('button')?.click();}
        if(event.key==='ArrowDown'){const first=results.querySelector('button');if(first){event.preventDefault();first.focus();}}
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();search.value='';drawResults();}
      };
      results.onkeydown=event=>{
        const controls=[...results.querySelectorAll('button')],index=controls.indexOf(document.activeElement);
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();search.value='';drawResults();search.focus();}
        if(event.key==='ArrowDown'){event.preventDefault();controls[Math.min(index+1,controls.length-1)]?.focus();}
        if(event.key==='ArrowUp'){event.preventDefault();if(index<=0)search.focus();else controls[index-1].focus();}
      };
      drawSelected();drawResults();
      return ()=>[...chosen.values()].filter(recipient=>recipient.kind==='Contact').map(recipient=>({entry_id:recipient.id,name:recipient.name}));
    }
    async function showEditor(item={},reviewAfterSave=false) {
      const current=++sequence;
      item={type:'instruction',status:'draft',release_policy:'owner_only',metadata:{final_wishes:{content_type:''}},...item};
      if(!vaultEntries.length){try{vaultEntries=await allVaultEntries();}catch(error){message(error.message,true);return;}}
      if(!alive() || current!==sequence)return;
      let savedId=item.id;
      let reviewVisible=Boolean(hasInformationReview(item));
      root.innerHTML=(options.entryForm?'':heading(item.id?'Edit Final Wishes Entry':'Add Final Wishes Entry',button(item.id?'open':'back','Cancel','outline',item.id?`data-item-id="${escape(item.id)}"`:'')))+feedback+`<div class="card"><form id="legacy-editor">
        ${item.status==='released'?'<div class="alert alert-warning">Saving an edit returns this content to draft and clears previous releases. Mark it ready and release the revised content when prepared.</div>':''}
        ${reviewAfterSave?'<div class="alert alert-info">Saving this update also records the information review.</div>':''}
        ${wishFields(item)}
        <fieldset class="legacy-fieldset"><legend>Recipients for this wish</legend>
          <p id="legacy-recipient-help" class="legacy-help">Search your beneficiaries and saved contacts. Contacts are named on the wish; access remains separate.</p>
          <ul class="legacy-recipient-selection" data-selected-recipients aria-label="Selected recipients" hidden></ul>
          <div class="form-group"><label for="legacy-recipient-search">Find a recipient</label><input id="legacy-recipient-search" type="search" placeholder="Search name, role, email or phone" autocomplete="off" aria-describedby="legacy-recipient-help legacy-recipient-status" aria-controls="legacy-recipient-results"></div>
          <p id="legacy-recipient-status" class="legacy-help" role="status" aria-live="polite"></p>
          <ul id="legacy-recipient-results" class="legacy-recipient-results" aria-label="Matching recipients" hidden></ul>
        </fieldset>
        <fieldset class="legacy-fieldset"><legend>Content for this wish</legend>
          <div class="form-group"><label for="legacy-type">Content type (optional)</label><select id="legacy-type" name="type"><option value="">-- Select --</option>${selectOptions(types,contentType(item))}</select></div>
          ${field('description','Description',item.description,{textarea:true})}
          ${field('introduction','Personal introduction (optional)',item.introduction,{textarea:true})}
          <div class="form-group"><label for="legacy-body_markdown">Message / narrative / instructions (Markdown)</label><textarea id="legacy-body_markdown" name="body_markdown" rows="12">${escape(item.body_markdown)}</textarea><p class="legacy-help">Use headings, lists, emphasis and safe links. Images and embedded HTML are excluded.</p>${button('markdown-preview','Preview Markdown')}<div id="legacy-editor-preview" class="legacy-markdown legacy-editor-preview" hidden></div></div>
          <div id="legacy-type-fields">${metadataFields(item)}</div>
          ${Docs.panel({accept:uploadConfig.accepted,help:'Drop documents, images, MP3, M4A, WAV, MP4 or MOV files here (up to '+Math.round(uploadConfig.max_file_bytes/1024/1024)+' MB each)'})}
        </fieldset>
        <div class="legacy-form-grid"><div class="form-group"><label for="legacy-status">Status</label><select id="legacy-status" name="status">${selectOptions({draft:'Draft',ready:'Ready',archived:'Archived'},item.status==='released'?'draft':item.status)}</select></div><div class="form-group"><label for="legacy-release_policy">Release policy</label><select id="legacy-release_policy" name="release_policy">${selectOptions(policies,item.release_policy)}</select></div></div>
        <p class="legacy-help">Drafts stay private. A ready item becomes available only after its release condition occurs for an authorised, selected recipient.</p>
        <fieldset id="legacy-review-fields" class="legacy-fieldset" ${reviewVisible?'':'hidden'}><legend>Information review</legend><label class="legacy-check"><input name="review_enabled" type="checkbox" ${item.review_enabled?'checked':''}><span>Schedule information reviews</span></label><div class="legacy-form-grid"><div class="form-group"><label for="legacy-review_interval_months">Review interval</label><select id="legacy-review_interval_months" name="review_interval_months">${selectOptions({3:'Every 3 months',6:'Every 6 months',12:'Every 12 months'},item.review_interval_months || 12)}</select></div>${field('next_review_at','Next review date',dateInput(item.next_review_at),{type:'date'})}</div></fieldset>
        <button type="submit" class="btn btn-primary" id="legacy-save">Save Final Wishes Entry &amp; copy files</button>
      </form></div>`;
      const selectedContacts=mountRecipientPicker(item);
      widget=Docs.mount(savedId,{edit:false,maxBytes:uploadConfig.max_file_bytes,list:async id=>(await API.request('GET',base+'/'+urlId(id))).attachments || [],unlink:(id,attachmentId)=>API.request('DELETE',base+'/'+urlId(id)+'/attachments/'+urlId(attachmentId)),open:(attachment,id,mode)=>openAttachment(id,attachment,mode),upload:async(id,file)=>{const form=new FormData();form.append('files',file,file.name);const response=await fetch('/api'+base+'/'+urlId(id)+'/attachments',{method:'POST',headers:{Authorization:'Bearer '+API.token},body:form});const result=await response.json();if(!response.ok || result.errors?.length)throw new Error(result.errors?.[0]?.error || result.error || 'Upload failed');}});
      bindActions();
      const reviewToggle=root.querySelector('[name="review_enabled"]'),reviewDate=root.querySelector('[name="next_review_at"]');
      function syncReviewDate(){
        reviewDate.required=reviewToggle.checked;
        if(reviewToggle.checked && !reviewDate.value){const next=new Date();next.setUTCMonth(next.getUTCMonth()+Number(root.querySelector('[name="review_interval_months"]').value));reviewDate.value=next.toISOString().slice(0,10);}
      }
      reviewToggle.onchange=syncReviewDate;syncReviewDate();
      root.querySelector('#legacy-type').onchange=event=>{
        const currentType=event.target.value;
        root.querySelector('#legacy-type-fields').innerHTML=metadataFields({...item,type:currentType,metadata:{...item.metadata,final_wishes:{...item.metadata?.final_wishes,content_type:currentType}}});
        reviewVisible=Boolean(hasInformationReview(item) || currentType==='review' || reviewToggle.checked);
        root.querySelector('#legacy-review-fields').hidden=!reviewVisible;
        reviewDate.required=reviewVisible && reviewToggle.checked;
      };
      root.querySelector('#legacy-editor').onsubmit=async event=>{
        event.preventDefault();const form=event.target,values=new FormData(form),save=root.querySelector('#legacy-save');save.disabled=true;
        const metadata={...(item.metadata || {})},chosenType=values.get('type'),type=chosenType || 'instruction';
        metadata.final_wishes={...(metadata.final_wishes || {}),content_type:chosenType,contact_recipients:selectedContacts()};
        ['category','details','contact_person','contact_phone','notes'].forEach(key=>{metadata.final_wishes[key]=values.get('wish_'+key) || '';});
        ['event_date','date_precision','relationship','place','recorded_at','category','priority','related_legacy_content_id'].forEach(key=>{if(values.has(key))metadata[key]=values.get(key);});
        ['people','tags','responsible_people','helpful_contacts'].forEach(key=>{if(values.has(key))metadata[key]=commaList(values.get(key));});
        if(values.has('checklist')){
          const used=new Set();
          metadata.checklist=String(values.get('checklist')).split('\n').map(text=>text.trim()).filter(Boolean).map(text=>{
            const previous=(item.metadata?.checklist || []).find(step=>step.text===text && !used.has(step.id));
            const id=previous?.id || stepId();used.add(id);return {id,text};
          });
        }
        const payload={type,title:values.get('title'),description:values.get('description'),introduction:values.get('introduction') || '',body_markdown:values.get('body_markdown'),status:values.get('status'),release_policy:values.get('release_policy'),metadata,beneficiary_ids:values.getAll('beneficiary_ids').map(Number),links:item.links || [],final_wishes_entry_id:values.has('final_wishes_entry_id')?(values.get('final_wishes_entry_id')?Number(values.get('final_wishes_entry_id')):null):(item.final_wishes_entry_id ?? null),review_enabled:reviewVisible?values.has('review_enabled'):Boolean(item.review_enabled),review_interval_months:reviewVisible?Number(values.get('review_interval_months')):(item.review_interval_months ?? null),next_review_at:reviewVisible?(values.get('next_review_at') || null):(item.next_review_at ?? null)};
        try{
          const result=await API.request(savedId?'PATCH':'POST',base+(savedId?'/'+urlId(savedId):''),payload);
          savedId=result.id || savedId;item={...item,...payload,id:savedId};
          const uploaded=await widget.uploadQueued(savedId);
          if(!alive())return;
          if(uploaded.failed.length){message('Final Wishes entry saved. '+uploaded.failed.length+' file(s) need retrying; save again to retry.',true);save.textContent='Save Changes / Retry Files';return;}
          if(reviewAfterSave)await API.request('POST',base+'/'+urlId(savedId)+'/review',{action:'updated'});
          showSuccess('Final Wishes entry saved');
          if(options.entryForm){window.location.hash='section/final_wishes/'+urlId(savedId);return;}
          await showDetail(savedId);
        }catch(error){message(error.message,true);}finally{if(save.isConnected)save.disabled=false;}
      };
    }
    function dateDialog(action) {
      const snooze=action==='snooze';
      const initial=new Date();initial.setDate(initial.getDate()+(snooze?7:30));
      const overlay=document.createElement('div');overlay.className='modal-overlay';
      overlay.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="legacy-review-dialog"><h2 id="legacy-review-dialog">${snooze?'Snooze reminder':'Reschedule review'}</h2><form>${field('review_date',snooze?'Snooze until':'Next review',initial.toISOString().slice(0,10),{type:'date',required:true})}<div class="modal-actions"><button type="button" class="btn btn-outline" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">Save date</button></div><p data-dialog-error class="legacy-help" role="alert"></p></form></div>`;
      document.body.append(overlay);const close=modalClose(overlay);overlay.querySelector('[data-cancel]').onclick=close;
      overlay.querySelector('form').onsubmit=async event=>{event.preventDefault();try{await API.request('POST',base+'/'+urlId(detail.id)+'/review',{action,...(snooze?{snooze_until:new FormData(event.target).get('review_date')}:{next_review_at:new FormData(event.target).get('review_date')})});close();await showDetail(detail.id);}catch(error){overlay.querySelector('[data-dialog-error]').textContent=error.message;}};
      overlay.onclick=event=>{if(event.target===overlay)close();};overlay.querySelector('input').focus();
    }
    function releaseDialog(revoke=false) {
      const item=detail;
      const recipients=(item.beneficiaries || []).filter(recipient=>!revoke || recipient.released_at && !recipient.revoked_at);
      if(!recipients.length)return message('Select recipients in the editor before releasing this item.',true);
      const overlay=document.createElement('div');overlay.className='modal-overlay';
      overlay.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="legacy-release-dialog"><h2 id="legacy-release-dialog">${revoke?'Revoke':'Release'} “${escape(item.title)}”</h2><p class="legacy-help">${revoke?'Selected recipients will lose access to this item.':'Selected recipients with valid vault access will be able to read this content and its attachments. A notification may announce availability; the message itself stays protected.'}</p><form><fieldset class="legacy-fieldset"><legend>Select recipients</legend>${recipients.map(recipient=>`<label class="legacy-check"><input type="checkbox" name="release_ids" value="${escape(recipient.beneficiary_id)}" checked><span>${escape(recipient.name)}</span></label>`).join('')}</fieldset><label class="legacy-check"><input type="checkbox" name="confirmed" required><span>I confirm this ${revoke?'revocation':'release'} for the selected recipients.</span></label><p data-dialog-error role="alert" class="legacy-help"></p><div class="modal-actions"><button type="button" class="btn btn-outline" data-cancel>Cancel</button><button type="submit" class="btn btn-${revoke?'warning':'primary'}">${revoke?'Revoke':'Release'} content</button></div></form></div>`;
      document.body.append(overlay);const close=modalClose(overlay);overlay.querySelector('[data-cancel]').onclick=close;
      overlay.onclick=event=>{if(event.target===overlay)close();};
      overlay.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=new FormData(event.target);if(!form.has('confirmed'))return;const ids=form.getAll('release_ids').map(Number);if(!ids.length){overlay.querySelector('[data-dialog-error]').textContent='Select at least one recipient.';return;}const submit=event.target.querySelector('[type="submit"]');submit.disabled=true;try{await API.request('POST',base+'/'+urlId(item.id)+(revoke?'/revoke':'/release'),{confirm:true,beneficiary_ids:ids});close();showSuccess(revoke?'Release revoked':'Content released');await showDetail(item.id);}catch(error){overlay.querySelector('[data-dialog-error]').textContent=error.message;submit.disabled=false;}};
      overlay.querySelector('[data-cancel]').focus();
    }
    function bindActions() {
      root.querySelectorAll('[data-legacy-action]').forEach(control=>control.onclick=async()=>{
        const action=control.dataset.legacyAction;
        try{
          if(action==='back'){if(window.location.hash!=='#section/final_wishes'){window.location.hash='section/final_wishes';return;}return load();}
          if(action==='reload'){if(await load() && options.entryForm)return showEditor(newWish());return;}
          if(action==='open')return showDetail(control.dataset.itemId || detail.id);
          if(action==='edit')return showEditor(detail);
          if(action==='preview')return showDetail(detail.id,true);
          if(action==='release')return releaseDialog();
          if(action==='revoke')return releaseDialog(true);
          if(action==='markdown-preview'){const target=root.querySelector('#legacy-editor-preview');target.innerHTML=await preview(root.querySelector('[name="body_markdown"]').value);target.hidden=false;return;}
          if(action==='ready'){await API.request('PATCH',base+'/'+urlId(detail.id),{status:'ready'});return showDetail(detail.id);}
          if(action==='archive'){if(!confirm('Archive this content and remove recipient access? The owner’s record and managed files will be retained.'))return;await API.request('PATCH',base+'/'+urlId(detail.id),{status:'archived'});showSuccess('Content archived');if(window.location.hash!=='#section/final_wishes'){window.location.hash='section/final_wishes';return;}return load();}
          if(action==='delete'){
            const item=items.find(candidate=>String(candidate.id)===String(control.dataset.itemId)) || detail;
            if(!item || !confirm('Permanently delete “'+item.title+'”? This removes the wish, its history, and attached files that are not shared with other records. This cannot be undone.'))return;
            const card=control.closest('.record-card'),controls=[...(card || root).querySelectorAll('button')];
            card?.setAttribute('aria-busy','true');controls.forEach(button=>{button.disabled=true;});
            try{
              await API.request('DELETE',base+'/'+urlId(item.id),{confirm_delete:true});
              showSuccess('Final Wish permanently deleted');
              if(!alive())return;
              if(window.location.hash!=='#section/final_wishes'){window.location.hash='section/final_wishes';return;}
              if(options.onChange)await options.onChange();else await load();
            }finally{card?.removeAttribute('aria-busy');controls.forEach(button=>{button.disabled=false;});}
            return;
          }
          if(action==='review-updated')return showEditor(detail,true);
          if(action==='review-reschedule')return dateDialog('reschedule');
          if(action==='review-snooze')return dateDialog('snooze');
          if(action==='review-no-change' || action==='review-disable'){await API.request('POST',base+'/'+urlId(detail.id)+'/review',{action:action==='review-disable'?'disable':'no_change'});return showDetail(detail.id);}
        }catch(error){message(error.message,true);}
      });
    }
    const initial=await Promise.allSettled([API.getBeneficiaries(),API.request('GET','/final-wishes/config')]);
    if(initial[0].status==='rejected'){root.innerHTML=feedback;message(initial[0].reason.message,true);return;}
    beneficiaries=arrayResult(initial[0].value);
    if(initial[1].status==='fulfilled'){const config=initial[1].value;uploadConfig={max_file_bytes:Number(config.max_file_bytes) || uploadConfig.max_file_bytes,accepted:Array.isArray(config.accepted)?config.accepted.join(','):typeof config.accepted==='string'?config.accepted:mediaAccept};}
    if(!await load() || !alive())return;
    if(options.entryForm)return showEditor(newWish());
    const requested=window.location.hash.slice(1).split('/')[2];
    if(requested==='new' || requested?.startsWith('new?')){
      const params=new URLSearchParams(requested.slice(4));
      window.location.hash='add/final_wishes'+(params.size?'?'+params:'');
    }else if(requested)await showDetail(decodeURIComponent(requested));
  }

  function beneficiaryPanel(beneficiary) {
    return `<details class="legacy-beneficiary-panel" data-legacy-beneficiary="${escape(beneficiary.id)}"><summary>Personal content and release summary</summary><div data-legacy-recipient-items><p class="legacy-help">Open to load messages, recordings, memories and instructions for ${escape(beneficiary.name)}.</p></div></details>`;
  }
  function bindBeneficiaries(root) {
    root.querySelectorAll('[data-legacy-beneficiary]').forEach(panel=>panel.addEventListener('toggle',async()=>{
      if(!panel.open)return;
      const request=Number(panel.dataset.request || 0)+1;panel.dataset.request=String(request);
      const target=panel.querySelector('[data-legacy-recipient-items]');target.textContent='Loading content…';
      try{const items=arrayResult(await API.request('GET','/beneficiaries/'+urlId(panel.dataset.legacyBeneficiary)+'/legacy'));if(!panel.isConnected || !panel.open || Number(panel.dataset.request)!==request)return;target.innerHTML=`<div class="actions legacy-recipient-actions"><a class="btn btn-outline btn-sm" href="#section/final_wishes">Manage in Final Wishes</a>${['letter','recording','instruction'].map(type=>`<a class="btn btn-outline btn-sm" href="#add/final_wishes?type=${type}&amp;beneficiary_id=${urlId(panel.dataset.legacyBeneficiary)}">+ Add ${singular[type]}</a>`).join('')}</div>${items.length?items.map(item=>`<div class="legacy-recipient-row"><div><a href="#section/final_wishes/${urlId(item.id)}"><strong>${escape(item.title)}</strong></a><small>${escape(contentLabel(item))} · ${escape(policies[item.release_policy] || item.release_policy)}</small><small>${item.updated_at?'Updated '+escape(date(item.updated_at)):''}${item.released_at?' · Released '+escape(date(item.released_at)):''}</small></div><div class="legacy-badges">${badge(item.status)}${item.revoked_at?badge('revoked','danger'):item.released_at?badge('released'):badge('private')}</div></div>`).join(''):'<p>No personal content is assigned to this beneficiary yet.</p>'}`;}
      catch(error){if(panel.isConnected && Number(panel.dataset.request)===request)target.textContent=error.message;}
    }));
  }

  async function mountRecipient(root,token,entries=[]) {
    if(!root)return;
    const alive=()=>root.isConnected;
    let sequence=0;
    const header='<h2 class="section-title">🕊 Final Wishes — Personal messages, memories and instructions</h2>';
    async function load() {
      const current=++sequence;
      try{
        const items=arrayResult(await recipientRequest(token,'GET'));
        if(!alive() || current!==sequence)return;
        root.innerHTML=header+(items.length?items.map(item=>RecordCards.render({
          title:item.title,section:'final_wishes',category:recordCategory(item),iconName:recordIcons[contentType(item)] || 'file-earmark-text',className:'legacy-item',
          body:`<div class="record-card-body">${item.description?`<p class="legacy-description">${escape(item.description)}</p>`:''}<p class="legacy-help">Released content · Updated ${escape(date(item.updated_at))}</p></div>`,
          footer:RecordCards.footer({primary:RecordCards.action({label:'Open',iconName:'file-earmark-text',attributes:`data-recipient-content="${escape(item.id)}"`})})
        })).join(''):'<div class="card"><p>No personal content has been released to you.</p></div>');
        root.querySelectorAll('[data-recipient-content]').forEach(control=>control.onclick=()=>open(control.dataset.recipientContent));
      }
      catch(error){if(alive() && current===sequence)root.innerHTML=header+`<div class="alert alert-error">${escape(error.message)}</div>`;}
    }
    async function open(id) {
      const current=++sequence;
      try{
        const item=await recipientRequest(token,'GET','/'+urlId(id));
        if(!alive() || current!==sequence)return;
        // Beneficiary detail includes server-sanitized Markdown; it must never
        // call the owner-only preview route using a beneficiary token.
        const html=safeHtml(item.body_html || item.html || '');
        const linked=(item.links || []).map(link=>entries.find(entry=>String(entry.id)===String(link.entry_id))).filter(Boolean);
        root.innerHTML=header+RecordCards.render({
          title:item.title,section:'final_wishes',category:recordCategory(item),iconName:recordIcons[contentType(item)] || 'file-earmark-text',className:'legacy-detail',
          body:`${contentView(item,html || `<p>${escape(item.body_markdown).replace(/\n/g,'<br>')}</p>`,true)}${linked.length?`<section class="legacy-subsection"><h3>Related vault records</h3><div class="actions">${linked.map(entry=>`<button type="button" class="btn btn-outline btn-sm" data-recipient-linked-entry="${escape(entry.id)}">${escape(entry.title)}</button>`).join('')}</div></section>`:''}<p class="legacy-help">Updated ${escape(date(item.updated_at,true))}</p><div data-recipient-feedback class="legacy-help" role="status" aria-live="polite"></div>`,
          footer:RecordCards.footer({primary:RecordCards.action({label:'All messages',iconName:'envelope',attributes:'data-recipient-back'})})
        });
        root.querySelector('[data-recipient-back]').onclick=load;bindFiles(root,item,token);
        root.querySelectorAll('[data-recipient-linked-entry]').forEach(control=>control.onclick=()=>document.getElementById('beneficiary-vault-entry-'+control.dataset.recipientLinkedEntry)?.scrollIntoView({behavior:'smooth',block:'start'}));
        root.querySelectorAll('[data-legacy-step]').forEach(control=>control.onchange=async()=>{const checked=control.checked;control.disabled=true;try{await recipientRequest(token,'POST','/'+urlId(item.id)+'/acknowledgements',{step_id:control.dataset.legacyStep,acknowledged:checked});if(alive() && current===sequence)root.querySelector('[data-recipient-feedback]').textContent=checked?'Step acknowledged.':'Acknowledgement removed.';}catch(error){control.checked=!checked;if(alive() && current===sequence)root.querySelector('[data-recipient-feedback]').textContent=error.message;}finally{control.disabled=false;}});
      }catch(error){if(alive() && current===sequence)root.innerHTML=header+`<div class="alert alert-error">${escape(error.message)}</div>`;}
    }
    await load();
  }
  return {mountOwner,countEntries,beneficiaryPanel,bindBeneficiaries,mountRecipient};
})();
