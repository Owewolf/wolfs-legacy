/* global API, app, state, vaultCounts, layoutHTML, bindSidebar, showError, esc */
'use strict';
const HomeBank = (() => {
  let detailsShown = false;
  let renderVersion = 0;
  function attr(v) { return esc(v).replaceAll('"','&quot;').replaceAll("'", '&#39;'); }
  function currency(v, iso) {
    try { return new Intl.NumberFormat('en-ZA',{style:'currency',currency:iso||'ZAR'}).format(v||0); }
    catch { return `${iso||'ZAR'} ${Number(v||0).toFixed(2)}`; }
  }
  function showDate(date) { return date ? new Date(date).toLocaleString('en-ZA') : 'Never'; }
  function typeMarkup(type, accounts) {
    return `<section class="hb-group"><h2>${esc(type)} <small>${accounts.length} accounts</small></h2>
      ${accounts.map(a=>`<details class="hb-account">
        <summary><strong>${esc(a.name)}</strong><span>${currency(a.today,a.currency)}</span></summary>
        <div class="hb-balances">
          <div><small>Today</small><b>${currency(a.today,a.currency)}</b></div>
          <div><small>Reconciled</small><b>${currency(a.reconciled,a.currency)}</b></div>
          <div><small>Cleared</small><b>${currency(a.cleared,a.currency)}</b></div>
          <div><small>Future</small><b>${currency(a.future,a.currency)}</b></div>
        </div><p>${a.transaction_count} transactions · Last: ${esc(a.last_transaction||'None')}</p>
        <h4>Recent transactions (up to 100)</h4><div class="hb-table-wrap"><table class="hb-table"><thead><tr><th>Date</th><th>Details</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>${a.transactions.map(t=>`<tr><td>${esc(t.date||'')}</td><td>${esc(t.memo||'')}</td><td>${currency(t.amount,a.currency)}</td><td>${esc(t.balanceable ? ['Open','Cleared','Reconciled','Void'][t.status]||'Open':'Excluded')}</td></tr>`).join('')}</tbody></table></div>
      </details>`).join('')}
    </section>`;
  }
  async function render() {
    const version = ++renderVersion;
    const expectedHash = window.location.hash;
    const isCurrent = () => version === renderVersion && window.location.hash === expectedHash;
    let info;
    try { info = await API.request('GET','/homebank/overview'); }
    catch(e) { if (isCurrent()) showError(e.message); return; }
    if (!isCurrent()) return;
    // Reading the overview may sync linked vault records, so refresh navigation
    // counts after it completes rather than reusing the previous page's totals.
    let counts = state.counts;
    try { counts = await vaultCounts(await API.getSummary()); }
    catch { /* Keep the last known counts if the summary is unavailable. */ }
    if (!isCurrent()) return;
    state.counts = counts;
    const {config, snapshot:s} = info;
    const all = s?.accounts || [];
    const accounts = all.filter(a=>!a.closed && (!a.excluded_from_summary || detailsShown));
    const types = [...new Set(accounts.map(a=>a.type))];
    const body = `
      <div class="page-header"><h1>🏦 HomeBank Financial Overview</h1>
        <div class="actions"><button id="hb-sync" class="btn btn-outline">Refresh now</button></div></div>
      <div class="hb-status ${info.stale?'hb-stale':''}">
        <p><b>Read only.</b> Displays the last successfully saved HomeBank file, not live bank balances.</p>
        <p><b>Source:</b> ${esc(info.source_file||'No file selected')} · <b>Last HomeBank save:</b> ${showDate(info.source_saved_at)} · <b>Last sync:</b> ${showDate(info.synced_at)}</p>
        ${info.last_error?`<p class="hb-error">⚠ ${esc(info.last_error)} — showing the previous valid snapshot.</p>`:''}
      </div>
      <details class="hb-settings"><summary>⚙️ HomeBank source settings</summary>
        <form id="hb-settings-form">
          <label>Folder on this Linux computer<input id="hb-dir" value="${attr(config.directory)}" required></label>
          <button type="button" class="btn btn-outline btn-sm" id="hb-browse">Browse folders</button>
          <div id="hb-folder-browser"></div>
          <label>HomeBank file<select id="hb-file"><option value="">Automatic — newest saved .xhb</option></select></label>
          <button type="submit" class="btn btn-primary">Save and sync</button>
        </form>
      </details>
      ${s?`<div class="hb-counts"><b>${accounts.length}</b> shown · ${s.counts.closed} closed hidden · ${s.counts.excluded_open} open excluded from HomeBank summary · ${s.total_transactions.toLocaleString()} transactions indexed</div>
        <label class="hb-toggle"><input type="checkbox" id="hb-extra" ${detailsShown?'checked':''}> Include open accounts excluded from the HomeBank summary</label>
        ${types.length?types.map(t=>typeMarkup(t,accounts.filter(a=>a.type===t))).join(''):'<p>No current accounts to show.</p>'}`:
        '<div class="card"><p>No validated .xhb snapshot yet. Choose a folder/file in settings and click Save and sync.</p></div>'}`;
    app.innerHTML = layoutHTML('homebank',body);
    bindSidebar();
    const dir = document.querySelector('#hb-dir');
    const file = document.querySelector('#hb-file');
    const browser = document.querySelector('#hb-folder-browser');
    async function loadFiles() {
      const data = await API.request('GET','/homebank/files?directory='+encodeURIComponent(dir.value));
      if (!isCurrent()) return;
      file.innerHTML='<option value="">Automatic — newest saved .xhb</option>' +
        data.files.map(x=>`<option value="${attr(x.name)}" ${config.selectedFile===x.name?'selected':''}>${esc(x.name)} (${new Date(x.mtime).toLocaleDateString('en-ZA')})</option>`).join('');
    }
    try { await loadFiles(); } catch(e) { if (isCurrent()) browser.textContent=e.message; }
    if (!isCurrent()) return;
    document.querySelector('#hb-sync').onclick=async()=>{
      try { await API.request('POST','/homebank/sync'); if (isCurrent()) await render(); }
      catch(e) {if (isCurrent()) showError(e.message);}
    };
    document.querySelector('#hb-settings-form').onsubmit=async e=>{
      e.preventDefault();
      try { await API.request('PUT','/homebank/settings',{directory:dir.value,selectedFile:file.value}); if (isCurrent()) await render(); }
      catch(e) {if (isCurrent()) showError(e.message);}
    };
    document.querySelector('#hb-browse').onclick=async()=>{
      const target=document.querySelector('#hb-folder-browser');
      try {
        const data=await API.request('GET','/homebank/directories?directory='+encodeURIComponent(dir.value));
        if (!isCurrent()) return;
        target.innerHTML=`<p>${esc(data.current)}</p>` +
          (data.parent?`<button type="button" class="btn btn-outline btn-sm hb-folder" data-path="${attr(data.parent)}">⬆ Parent</button>`:'')+
          data.folders.map(f=>`<button type="button" class="btn btn-outline btn-sm hb-folder" data-path="${attr(f.path)}">📁 ${esc(f.name)}</button>`).join('')+
          '<button type="button" class="btn btn-outline btn-sm" id="hb-select-folder">Use this folder</button>';
        target.querySelectorAll('.hb-folder').forEach(btn=>btn.onclick=()=>{dir.value=btn.dataset.path;document.querySelector('#hb-browse').click();});
        target.querySelector('#hb-select-folder').onclick=()=>{loadFiles().catch(e=>{if (isCurrent()) showError(e.message);});target.innerHTML='';};
      } catch(e) {if (isCurrent()) target.textContent=e.message;}
    };
    const extra=document.querySelector('#hb-extra');
    if(extra) extra.onchange=()=>{detailsShown=extra.checked;render();};
  }
  return {render};
})();
