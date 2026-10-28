/* global API */
'use strict';
const Docs = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const size = n => n > 1024*1024 ? (n/(1024*1024)).toFixed(1) + ' MB' : Math.ceil(n/1024) + ' KB';
  const previewable = mime => mime === 'application/pdf' || /^image\/(png|jpeg|webp)$/.test(mime) || /^(audio|video)\//.test(mime);
  const accepted = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.txt';
  const routes = { list: id => `/api/documents?entryId=${encodeURIComponent(id)}`,
    content:(id,entry,mode)=>`/api/documents/${encodeURIComponent(id)}/content?entryId=${encodeURIComponent(entry)}&mode=${mode}` };
  async function json(method,url,body){
    const r = await fetch(url, {method, headers:{'Authorization':'Bearer '+API.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'Document request failed'); return d;
  }
  async function counts(section){
    const items = await json('GET','/api/documents/counts?section='+encodeURIComponent(section));
    return Object.fromEntries(items.map(i=>[i.entry_id,Number(i.count)]));
  }
  function panel(options={}){
    return `<section class="doc-section" aria-labelledby="doc-heading">
      <div class="doc-head"><h3 id="doc-heading">📎 Documents <span id="doc-count"></span></h3><p>Keep a managed copy with this record. Original files on your computer remain untouched.</p></div>
      <div class="doc-drop" id="doc-drop" tabindex="0" role="button" aria-label="Choose or drop documents">
        <div>${escape(options.help || 'Drop PDF, image, Word, Excel or text files here')}</div>
        <button type="button" class="btn btn-outline btn-sm" id="doc-choose">Choose Files</button>
        <input type="file" id="doc-file-input" accept="${escape(options.accept || accepted)}" multiple hidden>
      </div>
      <div id="doc-queue" aria-live="polite"></div>
      <div id="doc-upload-progress" class="doc-progress" role="status"></div>
      <div id="doc-list" aria-live="polite"></div>
    </section>`;
  }
  function viewModal(blob,filename,mime){
    const url=URL.createObjectURL(blob);
    const overlay=document.createElement('div'); overlay.className='modal-overlay doc-preview-overlay';
    overlay.innerHTML=`<div class="modal doc-preview-modal" role="dialog" aria-modal="true" aria-label="Document preview">
      <div class="doc-modal-head"><h3>${escape(filename)}</h3><button type="button" class="btn btn-outline btn-sm" id="close-doc-modal">Close</button></div>
      <div class="doc-preview-body"></div></div>`;
    const content=overlay.querySelector('.doc-preview-body');
    if(mime.startsWith('image/')){
      const img=document.createElement('img');img.src=url;img.alt=filename;content.append(img);
    }else if(/^(audio|video)\//.test(mime)){
      const player=document.createElement(mime.startsWith('audio/')?'audio':'video');
      player.controls=true;player.preload='metadata';player.src=url;player.setAttribute('aria-label',filename);content.append(player);
      const help=document.createElement('p');help.className='doc-empty';help.textContent='If this format is not supported by your browser, download the file to play it.';content.append(help);
      const save=document.createElement('a');save.className='btn btn-outline btn-sm';save.href=url;save.download=filename;save.textContent='Download recording';content.append(save);
    }else{
      const frame=document.createElement('iframe');frame.src=url;frame.title=filename;content.append(frame);
    }
    const close=()=>{overlay.querySelectorAll('audio,video').forEach(player=>{player.pause();player.removeAttribute('src');player.load();});overlay.remove();URL.revokeObjectURL(url);document.removeEventListener('keydown',onKey);window.removeEventListener('hashchange',close);window.removeEventListener('pagehide',close)};
    const onKey=e=>{if(e.key==='Escape')close()};
    overlay.querySelector('#close-doc-modal').addEventListener('click',close);
    overlay.addEventListener('click',e=>{if(e.target===overlay)close()});
    document.addEventListener('keydown',onKey);
    window.addEventListener('hashchange',close);
    window.addEventListener('pagehide',close);
    document.body.append(overlay);
    overlay.querySelector('#close-doc-modal').focus();
  }
  async function downloadBinary(id,entryId,mode,beneficiaryToken=null){
    let response;
    if(beneficiaryToken){
      response=await fetch('/api/documents/beneficiary/content',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({accessToken:beneficiaryToken,documentId:id,mode})
      });
    }else response=await fetch(routes.content(id,entryId,mode),{headers:{Authorization:'Bearer '+API.token}});
    if(!response.ok){ const error=await response.json().catch(()=>({})); throw new Error(error.error||'Unable to open document'); }
    return response.blob();
  }
  async function openFile(doc,entryId,mode='preview',beneficiaryToken=null){
    const blob=await downloadBinary(doc.id,entryId,mode,beneficiaryToken);
    if(mode==='preview' && previewable(doc.mime_type)) return viewModal(blob,doc.display_name,doc.mime_type);
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=doc.display_name;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function mount(entryId,adapter={}){
    const panelEl=document.querySelector('.doc-section');
    if(!panelEl) throw new Error('Document panel missing from record form');
    const input=panelEl.querySelector('#doc-file-input');
    const drop=panelEl.querySelector('#doc-drop');
    const queued=[];
    let documents=[];
    let busy=false;
    const queueEl=panelEl.querySelector('#doc-queue');
    const listEl=panelEl.querySelector('#doc-list');
    const progressEl=panelEl.querySelector('#doc-upload-progress');
    function drawQueue(){
      queueEl.innerHTML=queued.length?`<h4>Selected for copying (${queued.length})</h4>`+
        queued.map((f,i)=>`<div class="doc-row"><span>📄 ${escape(f.name)} <small>${size(f.size)}</small></span><button type="button" class="btn btn-outline btn-sm" data-remove-queued="${i}">Remove</button></div>`).join(''):'';
      queueEl.querySelectorAll('[data-remove-queued]').forEach(b=>b.addEventListener('click',()=>{queued.splice(Number(b.dataset.removeQueued),1);drawQueue()}));
    }
    function receive(files){
      if(busy)return;
      for(const f of files){
        if(queued.length>=8){alert('Maximum 8 files per save. Add more after saving.');break;}
        const maxBytes=adapter.maxBytes || 25*1024*1024;
        if(f.size>maxBytes){alert(f.name+' is larger than '+size(maxBytes));continue;}
        queued.push(f);
      }
      input.value='';drawQueue();
    }
    panelEl.querySelector('#doc-choose').addEventListener('click',()=>input.click());
    input.addEventListener('change',()=>receive(input.files));
    drop.addEventListener('click',e=>{if(e.target.closest('button'))return;input.click()});
    drop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();input.click()}});
    ['dragenter','dragover'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.add('is-dragging')}));
    ['dragleave','drop'].forEach(t=>drop.addEventListener(t,e=>{e.preventDefault();drop.classList.remove('is-dragging')}));
    drop.addEventListener('drop',e=>{const items=Array.from(e.dataTransfer.items||[]);if(items.some(x=>x.webkitGetAsEntry?.()?.isDirectory)){alert('Folder drop is not supported. Select individual files.');return}receive(e.dataTransfer.files)});
    async function load(savedId=entryId){
      if(!savedId)return;
      try{
        documents=adapter.list?await adapter.list(savedId):await json('GET',routes.list(savedId));
        panelEl.querySelector('#doc-count').textContent='('+documents.length+')';
        listEl.innerHTML=documents.length?documents.map(d=>`<div class="doc-row" data-document="${escape(d.id)}">
          <span class="doc-file-name">📄 ${escape(d.display_name)} <small>${size(d.size_bytes)}</small>${d.description?`<small>${escape(d.description)}</small>`:''}</span>
          <span class="doc-actions"><button type="button" class="btn btn-outline btn-sm" data-doc-view="${escape(d.id)}">${previewable(d.mime_type)?'View':'Download'}</button>
          <button type="button" class="btn btn-outline btn-sm" data-doc-download="${escape(d.id)}">Download</button>
          ${adapter.edit === false?'':`<button type="button" class="btn btn-outline btn-sm" data-doc-edit="${escape(d.id)}">Edit label</button>`}
          <button type="button" class="btn btn-outline btn-sm" data-doc-unlink="${escape(d.id)}">Unlink</button></span></div>`).join(''):
          '<p class="doc-empty">No documents are attached to this record yet.</p>';
        listEl.querySelectorAll('[data-doc-view],[data-doc-download],[data-doc-edit],[data-doc-unlink]').forEach(b=>b.addEventListener('click',async()=>{
          const id=b.dataset.docView||b.dataset.docDownload||b.dataset.docEdit||b.dataset.docUnlink;
          const doc=documents.find(d=>d.id===id);if(!doc)return;
          try{
            if(b.dataset.docView){await (adapter.open?adapter.open(doc,savedId,'preview'):openFile(doc,savedId,'preview'))}
            else if(b.dataset.docDownload){await (adapter.open?adapter.open(doc,savedId,'download'):openFile(doc,savedId,'download'))}
            else if(b.dataset.docEdit){
              const label=prompt('Document label',doc.display_name);if(label===null)return;
              const description=prompt('Description (optional)',doc.description||'');if(description===null)return;
              await json('PATCH','/api/documents/'+encodeURIComponent(id),{display_name:label,description}); await load(savedId);
            }else if(b.dataset.docUnlink){
              if(!confirm('Remove this document from this record? Both your original and the managed copy will be preserved.'))return;
              if(adapter.unlink)await adapter.unlink(savedId,id);
              else await json('DELETE',`/api/documents/${encodeURIComponent(id)}/associations/${encodeURIComponent(savedId)}`);
              await load(savedId);
            }
          }catch(err){alert('Document: '+err.message)}
        }));
      }catch(err){listEl.textContent='Unable to load documents: '+err.message;}
    }
    async function uploadQueued(savedId){
      if(!queued.length)return {failed:[]};
      busy=true;const failed=[];
      const original=[...queued];queued.length=0;
      for(let i=0;i<original.length;i++){
        const f=original[i];progressEl.textContent=`Copying ${i+1} of ${original.length}: ${f.name}`;
        try{
          if(adapter.upload)await adapter.upload(savedId,f);
          else{
            const body=new FormData();body.append('entryId',String(savedId));body.append('files',f,f.name);
            const res=await fetch('/api/documents/upload',{method:'POST',headers:{Authorization:'Bearer '+API.token},body});
            const data=await res.json();
            if(!res.ok||data.errors?.length)throw new Error(data.errors?.[0]?.error||data.error||'Upload failed');
          }
        }catch(err){failed.push({file:f,error:err.message});queued.push(f)}
      }
      busy=false;progressEl.textContent=failed.length?`${failed.length} file(s) failed. Files remain queued; save again to retry.`:'All files copied successfully.';
      drawQueue();await load(savedId);
      return {failed};
    }
    void load();
    return { hasQueued:()=>queued.length>0, uploadQueued, load };
  }
  function beneficiaryCards(docs){
    return (docs||[]).length?`<div class="doc-section doc-beneficiary"><h4>Documents (${docs.length})</h4>`+
      docs.map(d=>`<div class="doc-row"><span>📄 ${escape(d.display_name)}</span><button type="button" class="btn btn-outline btn-sm" data-ben-doc="${escape(d.id)}">${previewable(d.mime_type)?'View':'Download'}</button></div>`).join('')+'</div>':'';
  }
  function bindBeneficiary(data,token){
    const all=new Map();(data.entries||[]).forEach(e=>(e.documents||[]).forEach(d=>all.set(d.id,d)));
    document.querySelectorAll('[data-ben-doc]').forEach(b=>b.addEventListener('click',async()=>{
      const d=all.get(b.dataset.benDoc); if(!d)return;
      try{await openFile(d,null,previewable(d.mime_type)?'preview':'download',token)}catch(e){alert(e.message)}
    }));
  }
  return {panel,mount,counts,beneficiaryCards,bindBeneficiary,preview:viewModal,previewable};
})();
