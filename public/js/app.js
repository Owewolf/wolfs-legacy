/* global API, SECTIONS, Docs, HomeBank, Legacy, Mobile */

const $ = (s) => document.querySelector(s);
const app = $('#app');
let state = { user: null, section: null, entries: [], counts: {}, beneficiaries: [], switchStatus: null, newToken: null };
let editingHomebankEntry = null;
let displayedSearchResults = [];
let liveVaultRefreshBusy = false;

// ── Helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function ago(d) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

// Shared presentation for owner, search, recipient and personal-content records.
// Data mapping and action handlers stay with their existing views.
const RecordCards = (() => {
  const text = value => esc(String(value ?? ''));
  const attr = value => text(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const categories = {
    personal: ['person', 'blue'], bank_accounts: ['bank', 'teal'],
    investments: ['bar-chart-fill', 'violet'], retirement: ['bank', 'teal'],
    insurance: ['shield-check', 'blue'], real_estate: ['house', 'teal'],
    debts: ['credit-card', 'orange'], digital: ['laptop', 'blue'],
    vehicles: ['car-front', 'teal'], valuables: ['gem', 'violet'],
    contacts: ['telephone', 'teal'], legal: ['file-earmark-text', 'blue'],
    final_wishes: ['chat-heart', 'violet'], secure_notes: ['lock', 'blue'],
    pet_care: ['heart', 'orange'], beneficiaries: ['people', 'teal']
  };
  function icon(name) {
    return `<svg class="record-icon" aria-hidden="true" focusable="false"><use href="/icons/record-icons.svg#${attr(name)}"></use></svg>`;
  }
  function heading({ title, section, category, iconName, tone, badges = '' }) {
    const defaults = categories[section] || ['journal-text', 'blue'];
    return `<header class="record-card-header">
      <span class="record-category-icon record-tone-${attr(tone || defaults[1])}">${icon(iconName || defaults[0])}</span>
      <div class="record-title"><h3>${text(title)}</h3>${category ? `<span class="record-category-chip">${text(category)}</span>` : ''}${badges}</div>
    </header>`;
  }
  function action({ label, iconName, attributes = '', danger = false }) {
    return `<button type="button" class="btn btn-outline record-action${danger ? ' record-action-danger' : ''}" ${attributes}>${iconName ? icon(iconName) : ''}<span>${text(label)}</span></button>`;
  }
  function footer({ primary = '', secondary = '' }) {
    if (!primary && !secondary) return '';
    return `<footer class="record-card-footer"><div class="record-card-actions">${primary}</div>${secondary ? `<div class="record-card-secondary">${secondary}</div>` : ''}</footer>`;
  }
  function render({ title, section, category, iconName, tone, badges, body = '', footer: actions = '', id, className = '' }) {
    return `<article class="card record-card ${attr(className)}"${id ? ` id="${attr(id)}"` : ''}>${heading({ title, section, category, iconName, tone, badges })}${body}${actions}</article>`;
  }
  function fieldsHTML(fields, conceal = true) {
    if (!fields.length) return '';
    return `<dl class="field-grid record-details">${fields.map(field => `<div class="field-item"><dt>${text(field.label)}</dt><dd class="value${conceal && field.sensitive ? ' sensitive' : ''}"${conceal && field.sensitive ? ` role="button" tabindex="0" aria-pressed="false" aria-label="Reveal ${attr(field.label)}" data-sensitive-label="${attr(field.label)}"` : ''}>${text(field.value)}</dd></div>`).join('')}</dl>`;
  }
  function entry(entry, { section = entry.section, documentCount = 0, readonly = false, search = false, attachments = '' } = {}) {
    const schema = SECTIONS[section];
    const values = entry.fields || {};
    const fields = search ? Object.entries(values).slice(0, 4).map(([key, value]) => ({
      label: key, value: String(value).substring(0, 80),
      sensitive: schema?.fields.find(field => field.key === key)?.sensitive
    })) : (schema?.fields || []).filter(field => values[field.key]).map(field => ({ ...field, value: values[field.key] }));
    let [iconName, tone] = categories[section] || ['journal-text', 'blue'];
    if (/cryptocurrency|crypto exchange/i.test([values.type, values.investment_type].join(' '))) {
      iconName = 'currency-bitcoin'; tone = 'orange';
    } else if (section === 'retirement' && values.investment_type) {
      iconName = 'bar-chart-fill'; tone = 'violet';
    }
    const category = search ? (schema?.name || section) : (values.account_type || values.type || values.category || values.species || values.role);
    const body = fieldsHTML(fields, !readonly) + (entry.notes ? `<div class="record-notes"><h4>Notes</h4><div>${text(entry.notes)}</div></div>` : '') + attachments;
    const editAttributes = search ? `data-nav="edit/${attr(section)}/${attr(entry.id)}"` : `data-edit="${attr(entry.id)}"`;
    return render({ title: entry.title, section, category, iconName, tone, body,
      id: readonly ? `beneficiary-vault-entry-${entry.id}` : undefined,
      footer: readonly ? '' : footer({
        primary: action({ label: 'Edit', iconName: 'pencil', attributes: editAttributes }) + (search ? '' : action({ label: `Documents (${documentCount})`, iconName: 'file-earmark-text', attributes: editAttributes })),
        secondary: search ? '' : action({ label: 'Delete', iconName: 'trash', attributes: `data-delete="${attr(entry.id)}"`, danger: true })
      })
    });
  }
  function bindSensitive(root = app) {
    root.querySelectorAll('.value.sensitive').forEach(el => {
      const toggle = () => {
        const revealed = el.classList.toggle('revealed');
        el.setAttribute('aria-pressed', String(revealed));
        el.setAttribute('aria-label', revealed ? `${el.dataset.sensitiveLabel}: ${el.textContent}. Activate to conceal.` : `Reveal ${el.dataset.sensitiveLabel}`);
      };
      el.onclick = toggle;
      el.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } };
    });
  }
  return { icon, heading, action, footer, render, entry, bindSensitive };
})();

// ── Theme toggle ──
function getTheme() { return localStorage.getItem('lv_theme') || 'dark'; }
function setTheme(t) { document.documentElement.setAttribute('data-theme', t); localStorage.setItem('lv_theme', t); }
setTheme(getTheme());

// ── Toast notifications ──
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  let container = $('#toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  container.appendChild(el);
  setTimeout(() => { el.classList.add('toast-fade'); setTimeout(() => el.remove(), 300); }, 3000);
}

function showError(msg) { toast(msg, 'error'); }
function showSuccess(msg) { toast(msg, 'success'); }

// ── Loading overlay ──
function showLoading(target) {
  const el = target || $('.main-content') || app;
  let loader = el.querySelector('.loading-overlay');
  if (!loader) {
    loader = document.createElement('div');
    loader.className = 'loading-overlay';
    loader.innerHTML = '<div class="spinner"></div>';
    el.style.position = 'relative';
    el.appendChild(loader);
  }
}
function hideLoading(target) {
  const el = target || $('.main-content') || app;
  const loader = el.querySelector('.loading-overlay');
  if (loader) loader.remove();
}

// ── Router ──
async function navigate(route) { window.location.hash = route; }

async function handleRoute() {
  if (typeof Mobile !== 'undefined') Mobile.reset();
  editingHomebankEntry = null;
  const hash = window.location.hash.slice(1) || 'login';
  const [route, p1, p2] = hash.split('/');

  if (route === 'access') return renderAccessPortal();
  if (route === 'login') return renderLogin();
  if (route === 'register') return renderRegister();

  if (!state.user) {
    if (API.token) {
      try { state.user = await API.getMe(); } catch { API.setToken(null); return navigate('login'); }
    } else return navigate('login');
  }

  switch (route) {
    case 'vault': return renderDashboard();
    case 'section': return renderSection(p1);
    case 'add': return renderEntryForm(p1);
    case 'edit': return renderEntryForm(p1, p2);
    case 'beneficiaries': return renderBeneficiaries();
    case 'deadswitch': return renderDeadSwitch();
    case 'settings': return renderSettings();
    case 'homebank': return HomeBank.render();
    case 'audit': return renderAuditLog();
    case 'search': return renderSearchResults(p1);
    default: return renderDashboard();
  }
}

window.addEventListener('hashchange', handleRoute);

// ── Auth ──
function renderLogin() {
  app.innerHTML = `
    <div class="auth-container"><div class="auth-box">
      <h1>\u{1F512} Wolf's Vault</h1>
      <p class="subtitle">Secure data vault for your family's future</p>
      <form id="login-form">
        <div class="form-group"><label for="login-email">Email</label><input id="login-email" type="email" name="email" autocomplete="username" inputmode="email" autocapitalize="none" required></div>
        <div class="form-group"><label for="login-password">Password</label><input id="login-password" type="password" name="password" autocomplete="current-password" required></div>
        <button type="submit" class="btn btn-primary btn-block">Sign In</button>
      </form>
      <div class="link-row">
        No account? <a href="#register">Create one</a> &middot; <a href="#access">Beneficiary access</a>
      </div>
    </div></div>`;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = new FormData(e.target);
      const res = await API.login({ email: f.get('email'), password: f.get('password') });
      API.setToken(res.token);
      state.user = res.user;
      navigate('vault');
    } catch (err) { showError(err.message); }
  };
}

function renderRegister() {
  app.innerHTML = `
    <div class="auth-container"><div class="auth-box">
      <h1>Create Account</h1>
      <p class="subtitle">Start securing your legacy data</p>
      <form id="reg-form">
        <div class="form-group"><label for="register-name">Full Name</label><input id="register-name" type="text" name="name" autocomplete="name" required></div>
        <div class="form-group"><label for="register-email">Email</label><input id="register-email" type="email" name="email" autocomplete="username" inputmode="email" autocapitalize="none" required></div>
        <div class="form-group"><label for="register-password">Password (min 8 chars)</label><input id="register-password" type="password" name="password" autocomplete="new-password" required minlength="8"></div>
        <button type="submit" class="btn btn-primary btn-block">Create Vault</button>
      </form>
      <div class="link-row">Already have an account? <a href="#login">Sign in</a></div>
    </div></div>`;
  $('#reg-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = new FormData(e.target);
      const res = await API.register({ name: f.get('name'), email: f.get('email'), password: f.get('password') });
      API.setToken(res.token);
      state.user = res.user;
      navigate('vault');
    } catch (err) { showError(err.message); }
  };
}

// ── Sidebar ──
function sidebarHTML(activeKey) {
  const sectionItems = Object.entries(SECTIONS).map(([k, s]) => {
    const cnt = state.counts[k] || 0;
    return `<button class="nav-item ${activeKey === k ? 'active' : ''}" data-nav="section/${k}">
      <span class="icon">${s.icon}</span>${esc(s.name)}${cnt ? `<span class="count">${cnt}</span>` : ''}
    </button>`;
  }).join('');

  return `
    <div class="sidebar" id="mobile-navigation">
      <button type="button" id="mobile-navigation-close" class="mobile-navigation-close" aria-label="Close navigation" hidden>Close <span aria-hidden="true">×</span></button>
      <div class="sidebar-header">
        <h2 class="sidebar-brand">\u{1F512} Wolf's Vault</h2>
        <div class="sidebar-owner">${esc(state.user?.name)}</div>
        <div class="sidebar-actions">
          <button class="header-action-btn" id="home-btn" title="Home" data-nav="vault"><span class="action-icon">\u{2302}</span> Home</button>
          <span class="header-action-sep"></span>
          <button class="header-action-btn" id="theme-btn" title="Toggle theme"><span class="action-icon">${getTheme() === 'dark' ? '\u{263E}' : '\u{2600}'}</span> ${getTheme() === 'dark' ? 'Dark' : 'Light'}</button>
        </div>
        <div class="search-box">
          <input type="text" id="global-search" placeholder="Search vault..." />
        </div>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-section-label">Vault Sections</div>
        ${sectionItems}
        <div class="nav-section-label" style="margin-top:12px">Financial Overview</div>
        <button class="nav-item ${activeKey === 'homebank' ? 'active' : ''}" data-nav="homebank">
          <span class="icon">🏦</span>HomeBank (read only)
        </button>
        <div class="nav-section-label" style="margin-top:12px">Settings</div>
        <button class="nav-item ${activeKey === 'beneficiaries' ? 'active' : ''}" data-nav="beneficiaries">
          <span class="icon">\u{1F465}</span>Beneficiaries
        </button>
        <button class="nav-item ${activeKey === 'deadswitch' ? 'active' : ''}" data-nav="deadswitch">
          <span class="icon">\u{23F0}</span>Dead Man's Switch
        </button>
        <button class="nav-item ${activeKey === 'audit' ? 'active' : ''}" data-nav="audit">
          <span class="icon">\u{1F4CB}</span>Audit Log
        </button>
        <button class="nav-item ${activeKey === 'settings' ? 'active' : ''}" data-nav="settings">
          <span class="icon">\u{2699}</span>Account Settings
        </button>
      </nav>
      <div class="sidebar-footer">
        <button class="btn btn-outline btn-sm" id="logout-btn">Sign out</button>
      </div>
    </div>`;
}

function layoutHTML(activeKey, content) {
  return `<header class="mobile-header" hidden>
    <button type="button" id="mobile-menu-toggle" class="mobile-menu-toggle" aria-controls="mobile-navigation" aria-expanded="false"><span class="mobile-menu-icon" aria-hidden="true">☰</span><span>Menu</span></button>
    <span class="mobile-brand">Wolf’s Vault</span>
    <button type="button" id="mobile-search-toggle" class="mobile-search-toggle" aria-label="Search vault"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button>
  </header><div class="mobile-nav-backdrop" aria-hidden="true" hidden></div>
  <div class="app-layout">${sidebarHTML(activeKey)}<div class="main-content" id="main-content">${content}</div></div>`;
}

function bindSidebar() {
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.onclick = () => navigate(el.dataset.nav);
  });
  const lb = $('#logout-btn');
  if (lb) lb.onclick = () => { API.setToken(null); state.user = null; navigate('login'); };
  const tb = $('#theme-btn');
  if (tb) tb.onclick = () => {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    tb.innerHTML = next === 'dark' ? '<span class="action-icon">\u{263E}</span> Dark' : '<span class="action-icon">\u{2600}</span> Light';
  };

  const searchInput = $('#global-search');
  if (searchInput) {
    let debounce;
    searchInput.onkeydown = (e) => {
      if (e.key === 'Enter' && searchInput.value.trim().length >= 2) {
        navigate('search/' + encodeURIComponent(searchInput.value.trim()));
      }
    };
  }
  if (typeof Mobile !== 'undefined') Mobile.mount();
}

// ── Dashboard ──
async function renderDashboard(refreshedSummary, shouldRender = () => true) {
  const expectedHash = window.location.hash;
  let counts = {};
  try {
    const summary = refreshedSummary || await API.getSummary();
    summary.forEach(s => counts[s.section] = s.count);
  } catch { counts = {}; }
  if (window.location.hash !== expectedHash || !shouldRender()) return;
  state.counts = counts;

  const totalEntries = Object.values(state.counts).reduce((a, b) => a + b, 0);

  // Onboarding for new users
  const isNew = totalEntries === 0;
  const onboardingHTML = isNew ? `
    <div class="card" style="border-color:var(--primary);margin-bottom:24px">
      <h3 style="margin-bottom:12px">Welcome to Wolf's Vault</h3>
      <p style="color:var(--text-muted);margin-bottom:16px">
        This vault stores your personal and financial information so your family can access it when needed.
        Here's how to get started:
      </p>
      <div class="onboarding-steps">
        <div class="step"><span class="step-num">1</span><div><strong>Add your data</strong><br>Start with Bank Accounts and Insurance -- the most critical for your family.</div></div>
        <div class="step"><span class="step-num">2</span><div><strong>Add beneficiaries</strong><br>Add your spouse, children, or lawyer. Each gets a unique access token.</div></div>
        <div class="step"><span class="step-num">3</span><div><strong>Activate the Dead Man's Switch</strong><br>Set a check-in interval. If you miss it, your beneficiaries get automatic access.</div></div>
        <div class="step"><span class="step-num">4</span><div><strong>Share access tokens securely</strong><br>Print them, seal in an envelope, or give to a lawyer.</div></div>
      </div>
    </div>` : '';

  const cards = Object.entries(SECTIONS).map(([k, s]) => {
    const cnt = state.counts[k] || 0;
    return `<div class="card vault-card" data-nav="section/${k}">
      <div class="vault-card-icon">${s.icon}</div>
      <div class="vault-card-name">${esc(s.name)}</div>
      <div class="vault-card-count">${cnt} ${cnt === 1 ? 'entry' : 'entries'}</div>
    </div>`;
  }).join('');

  app.innerHTML = layoutHTML('dashboard', `
    <div class="page-header">
      <h1>Your Vault</h1>
      <div class="actions">
        <button class="btn btn-outline btn-sm" id="export-btn">\u{1F4E5} Export</button>
      </div>
    </div>
    ${onboardingHTML}
    ${totalEntries > 0 ? `<div class="alert alert-info" style="margin-bottom:24px">
      ${totalEntries} total entries across ${Object.keys(state.counts).length} sections. Vault text fields are encrypted; managed document copies remain ordinary files with private filesystem permissions.
    </div>` : ''}
    <div class="vault-grid">${cards}</div>
  `);
  bindSidebar();

  const exportBtn = $('#export-btn');
  if (exportBtn) exportBtn.onclick = async () => {
    try {
      const data = await API.exportVault();
      showExportView(data);
    } catch (err) { showError(err.message); }
  };
}

function showExportView(data) {
  const grouped = {};
  data.entries.forEach(e => {
    if (!grouped[e.section]) grouped[e.section] = [];
    grouped[e.section].push(e);
  });

  let html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Wolf's Vault Export - ${esc(data.owner.name)}</title>
    <style>body{font-family:sans-serif;max-width:800px;margin:40px auto;color:#222;line-height:1.5}
    h1{border-bottom:2px solid #333;padding-bottom:8px}h2{margin-top:32px;color:#444;border-bottom:1px solid #ccc;padding-bottom:4px}
    .entry{margin:16px 0;padding:12px;border:1px solid #ddd;border-radius:6px}
    .entry h3{margin:0 0 8px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .field label{font-size:11px;text-transform:uppercase;color:#888}.field .val{font-size:14px}
    .notes{margin-top:8px;padding-top:8px;border-top:1px solid #eee;font-size:13px;color:#555}
    @media(max-width:700px){body{margin:20px 16px;overflow-wrap:anywhere}.fields{grid-template-columns:1fr}}
    @media print{body{margin:20px}}</style></head><body>
    <h1>Wolf's Vault - ${esc(data.owner.name)}</h1>
    <p>Exported: ${new Date(data.exported_at).toLocaleString()}</p>
    <p><strong>CONFIDENTIAL</strong> - This document contains sensitive personal and financial information.</p>`;

  for (const [sectionKey, entries] of Object.entries(grouped)) {
    const sec = SECTIONS[sectionKey];
    if (!sec) continue;
    html += `<h2>${esc(sec.name)}</h2>`;
    for (const e of entries) {
      html += `<div class="entry"><h3>${esc(e.title)}</h3><div class="fields">`;
      for (const f of (sec.fields || [])) {
        if (e.fields[f.key]) html += `<div class="field"><label>${esc(f.label)}</label><div class="val">${esc(e.fields[f.key])}</div></div>`;
      }
      html += '</div>';
      if (e.notes) html += `<div class="notes"><strong>Notes:</strong> ${esc(e.notes)}</div>`;
      html += '</div>';
    }
  }
  html += '</body></html>';

  const blob = new Blob([html], { type: 'text/html' });
  if (typeof Mobile !== 'undefined' && Mobile.isCompact()) return Mobile.showExport(blob);
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (win) { showSuccess('Export opened in new tab. Use Ctrl+P to print/save as PDF.'); }
  else { showError('Pop-up blocked. Please allow pop-ups for this site.'); }
}

// ── Search results ──
async function renderSearchResults(query, refreshedResults, shouldRender = () => true) {
  const expectedHash = window.location.hash;
  const q = decodeURIComponent(query || '');
  if (q.length < 2) return navigate('vault');

  let results;
  try { results = refreshedResults || await API.search(q); } catch (err) { return showError(err.message); }
  if (window.location.hash !== expectedHash || !shouldRender()) return;
  displayedSearchResults = results;

  const resultsHTML = results.length ? results.map(e => RecordCards.entry(e, { search: true })).join('') : `<div class="empty-state"><h3>No results</h3><p>Nothing matched "${esc(q)}" in your vault.</p></div>`;

  app.innerHTML = layoutHTML('search', `
    <div class="page-header"><h1>Search: "${esc(q)}"</h1><span style="color:var(--text-muted)">${results.length} results</span></div>
    ${resultsHTML}
  `);
  bindSidebar();
  RecordCards.bindSensitive();
  const si = $('#global-search');
  if (si) si.value = q;
  return true;
}

// ── Section view ──
async function renderSection(key, refreshedData, shouldRender = () => true) {
  const expectedHash = window.location.hash;
  const sec = SECTIONS[key];
  if (!sec) return navigate('vault');

  let data;
  let counts = {};
  try {
    data = refreshedData || await API.getEntries(key);
    const summary = await API.getSummary();
    summary.forEach(s => counts[s.section] = s.count);
  } catch (err) { return showError(err.message); }

  const entries = Array.isArray(data.entries || data) ? (data.entries || data) : [];
  let docCounts = {};
  try { docCounts = await Docs.counts(key); } catch (err) { console.warn('Document counts unavailable', err); }
  if (window.location.hash !== expectedHash || !shouldRender()) return;
  state.entries = entries;
  state.counts = counts;
  const entriesHTML = entries.length ? entries.map(e => RecordCards.entry(e, { section: key, documentCount: docCounts[e.id] || 0 })).join('') : `<div class="empty-state">
    <div class="icon">${sec.icon}</div>
    <h3>No ${sec.name} entries yet</h3>
    <p>Add your first entry to start building your Wolf's Vault.</p>
    <button class="btn btn-primary" data-nav="add/${key}">Add Entry</button>
  </div>`;

  app.innerHTML = layoutHTML(key, `
    <div class="page-header">
      <h1>${sec.icon} ${esc(sec.name)}</h1>
      <div class="actions"><button class="btn btn-primary" data-nav="add/${key}">+ Add ${key==='final_wishes'?'Final Wishes Entry':'Entry'}</button></div>
    </div>
    ${key==='final_wishes'?'<div id="legacy-workspace" class="legacy-workspace"></div><details class="legacy-existing-wishes" open><summary>Final Wishes entries and arrangements</summary>':''}
    ${entriesHTML}
    ${key==='final_wishes'?'</details>':''}
  `);

  bindSidebar();
  RecordCards.bindSensitive();
  document.querySelectorAll('[data-edit]').forEach(el => { el.onclick = () => navigate('edit/' + key + '/' + el.dataset.edit); });
  document.querySelectorAll('[data-delete]').forEach(el => {
    el.onclick = async () => {
      if (!confirm('Delete this entry? This cannot be undone.')) return;
      const card = el.closest('.record-card');
      const controls = [...card.querySelectorAll('button')];
      card.setAttribute('aria-busy', 'true');
      controls.forEach(control => { control.disabled = true; });
      try { await API.deleteEntry(el.dataset.delete); showSuccess('Entry deleted'); await renderSection(key); } catch (err) {
        showError(err.message);
      } finally {
        card.removeAttribute('aria-busy');
        controls.forEach(control => { control.disabled = false; });
      }
    };
  });
  if(key==='final_wishes')void Legacy.mountOwner($('#legacy-workspace'),entries);
  return true;
}

// ── Entry form (add/edit) ──
async function renderEntryForm(sectionKey, entryId) {
  const expectedHash = window.location.hash;
  const sec = SECTIONS[sectionKey];
  if (!sec) return navigate('vault');

  let existing = null;
  if (entryId) {
    try { existing = await API.getEntry(entryId); } catch { return navigate('section/' + sectionKey); }
    if (existing.section !== sectionKey && SECTIONS[existing.section]) return navigate('edit/' + existing.section + '/' + entryId);
  }
  if (window.location.hash !== expectedHash) return;
  editingHomebankEntry = existing?.homebank_account_id != null ? existing : null;
  const managedFields = new Set(existing?.homebank_managed_fields || []);

  const fieldsHTML = sec.fields.map(f => {
    const val = existing ? (existing.fields[f.key] || '') : '';
    let input;
    if (managedFields.has(f.key)) {
      input = `<input type="text" name="${f.key}" value="${esc(val)}" readonly aria-readonly="true">`;
    } else if (f.type === 'textarea') {
      input = `<textarea name="${f.key}">${esc(val)}</textarea>`;
    } else if (f.type === 'select') {
      const opts = f.options.map(o => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
      input = `<select name="${f.key}"><option value="">-- Select --</option>${opts}</select>`;
    } else if (f.type === 'password') {
      input = `<div class="password-wrapper"><input type="password" name="${f.key}" value="${esc(val)}"><button type="button" class="password-toggle" data-toggle="${f.key}">show</button></div>`;
    } else {
      input = `<input type="${f.type || 'text'}" name="${f.key}" value="${esc(val)}">`;
    }
    return `<div class="form-group"><label>${esc(f.label)}</label>${input}</div>`;
  }).join('');

  app.innerHTML = layoutHTML(sectionKey, `
    <div class="page-header">
      <h1>${existing ? 'Edit' : 'Add'} ${esc(sec.name)}</h1>
      <div class="actions"><button class="btn btn-outline" data-nav="section/${sectionKey}">Cancel</button></div>
    </div>
    <div class="card">
      <form id="entry-form">
        <div class="form-group"><label>Title / Label</label><input type="text" name="title" value="${esc(existing?.title || '')}" required placeholder="e.g. HDFC Savings, Main Gmail..."></div>
        ${editingHomebankEntry ? '<p style="color:var(--text-muted);margin-bottom:16px">HomeBank fields update automatically.</p>' : ''}
        ${fieldsHTML}
        ${editingHomebankEntry ? '' : `<div class="form-group"><label>Notes</label><textarea name="notes" placeholder="Any additional notes...">${esc(existing?.notes || '')}</textarea></div>`}
        ${Docs.panel()}
        <button type="submit" class="btn btn-primary">${existing ? 'Save Changes' : 'Add Entry & Copy Documents'}</button>
      </form>
    </div>
  `);

  bindSidebar();
  const documentWidget = Docs.mount(entryId);
  document.querySelectorAll('.password-toggle').forEach(btn => {
    btn.onclick = () => {
      const inp = btn.parentElement.querySelector('input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      btn.textContent = inp.type === 'password' ? 'show' : 'hide';
    };
  });

  $('#entry-form').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button[type=submit]');
    button.disabled = true;
    const f = new FormData(e.target);
    const knownFields = new Set(sec.fields.map(fd => fd.key));
    const fields = Object.fromEntries(Object.entries(existing?.fields || {}).filter(([key]) =>
      !knownFields.has(key) && !managedFields.has(key)));
    sec.fields.forEach(fd => {
      if (editingHomebankEntry?.homebank_managed_fields?.includes(fd.key)) return;
      const v = f.get(fd.key); if (v) fields[fd.key] = v;
    });
    try {
      const payload = { section: sectionKey, title: f.get('title'), fields, notes: f.get('notes') };
      let savedSection = sectionKey;
      if (existing) {
        const saved = await API.updateEntry(entryId, payload);
        if (SECTIONS[saved?.section]) savedSection = saved.section;
      } else {
        const created = await API.createEntry(payload);
        if (SECTIONS[created.section]) savedSection = created.section;
        entryId = created.id;
        existing = await API.getEntry(entryId);
      }
      const result = await documentWidget.uploadQueued(entryId);
      if (result.failed.length) {
        showError('Record saved, but '+result.failed.length+' file(s) could not be copied. Correct the error and press Save again.');
        button.textContent = 'Save Changes / Retry Files';
        return;
      }
      showSuccess('Record and documents saved');
      navigate('section/' + savedSection);
    } catch (err) { showError(err.message); }
    finally { button.disabled = false; }
  };
}

// ── Beneficiaries ──
async function renderBeneficiaries() {
  try { state.beneficiaries = await API.getBeneficiaries(); } catch { state.beneficiaries = []; }

  const listHTML = state.beneficiaries.length ? state.beneficiaries.map(b => {
    let statusBadge = '';
    if (b.access_granted) statusBadge = '<span class="badge badge-success">Access Granted</span>';
    else if (b.emergency_access_requested) statusBadge = '<span class="badge badge-warning">Emergency Requested</span>';

    const expired = b.token_expires_at && new Date() > new Date(b.token_expires_at);
    if (expired) statusBadge += ' <span class="badge badge-danger">Token Expired</span>';

    return RecordCards.render({ title: b.name, section: 'beneficiaries', category: b.relationship, badges: statusBadge,
      body: `<div class="beneficiary-info record-card-body">
        <div class="meta">${esc(b.relationship || '')} ${b.email ? '&middot; ' + esc(b.email) : ''} ${b.phone ? '&middot; ' + esc(b.phone) : ''}</div>
        <div class="meta">Wait: ${b.emergency_waiting_days}d &middot; Token expires: ${b.token_expires_at ? fmtDate(b.token_expires_at) : 'never'} &middot; Added ${fmtDate(b.created_at)}</div>
      </div>${Legacy.beneficiaryPanel(b)}`,
      footer: RecordCards.footer({
        primary: (b.emergency_access_requested && !b.access_granted ? RecordCards.action({ label: 'Deny Emergency', attributes: `data-deny="${b.id}"`, danger: true }) : '') +
          RecordCards.action({ label: b.access_granted ? 'Revoke' : 'Grant Access', attributes: b.access_granted ? `data-revoke="${b.id}"` : `data-grant="${b.id}"` }) +
          RecordCards.action({ label: 'New Token', attributes: `data-regen="${b.id}"` }),
        secondary: RecordCards.action({ label: 'Remove', iconName: 'trash', attributes: `data-remove="${b.id}"`, danger: true })
      })
    });
  }).join('') : '<div class="empty-state"><div class="icon">\u{1F465}</div><h3>No beneficiaries</h3><p>Add someone you trust to receive your vault data.</p></div>';

  const tokenHTML = state.newToken ? `
    <div class="token-display">
      <span class="warning">\u26A0 Save this token now -- it will not be shown again!</span>
      ${esc(state.newToken)}
    </div>` : '';

  app.innerHTML = layoutHTML('beneficiaries', `
    <div class="page-header">
      <h1>\u{1F465} Beneficiaries</h1>
      <div class="actions"><button class="btn btn-primary" id="add-ben-btn">+ Add Beneficiary</button></div>
    </div>
    <div class="alert alert-info">
      Beneficiaries receive a unique access token (valid 2 years). Share it securely -- print it, seal in an envelope, or give to a lawyer.
    </div>
    ${tokenHTML}
    ${listHTML}
  `);

  state.newToken = null;
  bindSidebar();
  Legacy.bindBeneficiaries(app);

  $('#add-ben-btn').onclick = () => showAddBeneficiaryModal();
  document.querySelectorAll('[data-grant]').forEach(el => {
    el.onclick = async () => { try { await API.grantAccess(el.dataset.grant); showSuccess('Access granted'); renderBeneficiaries(); } catch (e) { showError(e.message); } };
  });
  document.querySelectorAll('[data-revoke]').forEach(el => {
    el.onclick = async () => { try { await API.revokeAccess(el.dataset.revoke); showSuccess('Access revoked'); renderBeneficiaries(); } catch (e) { showError(e.message); } };
  });
  document.querySelectorAll('[data-deny]').forEach(el => {
    el.onclick = async () => { try { await API.denyEmergency(el.dataset.deny); showSuccess('Emergency access denied'); renderBeneficiaries(); } catch (e) { showError(e.message); } };
  });
  document.querySelectorAll('[data-remove]').forEach(el => {
    el.onclick = async () => {
      if (!confirm('Remove this beneficiary?')) return;
      try { await API.removeBeneficiary(el.dataset.remove); showSuccess('Beneficiary removed'); renderBeneficiaries(); } catch (e) { showError(e.message); }
    };
  });
  document.querySelectorAll('[data-regen]').forEach(el => {
    el.onclick = async () => {
      if (!confirm('Regenerate token? The old token will stop working.')) return;
      try { const r = await API.regenerateToken(el.dataset.regen); state.newToken = r.accessToken; renderBeneficiaries(); } catch (e) { showError(e.message); }
    };
  });
}

function showAddBeneficiaryModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">
    <h2>Add Beneficiary</h2>
    <form id="add-ben-form">
      <div class="form-group"><label>Name *</label><input type="text" name="name" required></div>
      <div class="form-group"><label>Email</label><input type="email" name="email"></div>
      <div class="form-group"><label>Phone</label><input type="text" name="phone"></div>
      <div class="form-group"><label>Relationship</label>
        <select name="relationship"><option value="">-- Select --</option>
          <option>Spouse</option><option>Child</option><option>Parent</option><option>Sibling</option>
          <option>Lawyer</option><option>Trusted Friend</option><option>Other</option>
        </select></div>
      <div class="form-group"><label>Emergency wait period (days)</label><input type="number" name="waiting" value="7" min="1" max="90"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="close-modal">Cancel</button>
        <button type="submit" class="btn btn-primary">Add</button>
      </div>
    </form>
  </div>`;

  document.body.appendChild(overlay);
  overlay.querySelector('#close-modal').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.querySelector('#add-ben-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const res = await API.addBeneficiary({
        name: f.get('name'), email: f.get('email'), phone: f.get('phone'),
        relationship: f.get('relationship'), emergency_waiting_days: parseInt(f.get('waiting')) || 7
      });
      state.newToken = res.accessToken;
      overlay.remove();
      showSuccess('Beneficiary added');
      renderBeneficiaries();
    } catch (err) { showError(err.message); }
  };
}

// ── Dead Man's Switch ──
async function renderDeadSwitch() {
  let status;
  try { status = await API.getSwitchStatus(); } catch { return showError('Failed to load switch status'); }

  let statusClass = 'inactive', dotClass = 'gray', statusText = 'Inactive';
  if (status.is_active) {
    if (status.switch_triggered) { statusClass = 'triggered'; dotClass = 'red'; statusText = 'TRIGGERED -- Beneficiaries have been granted access'; }
    else if (status.is_overdue) { statusClass = 'overdue'; dotClass = 'yellow'; statusText = 'Overdue -- check in now to prevent triggering'; }
    else { statusClass = 'active'; dotClass = 'green'; statusText = 'Active -- next check-in by ' + fmtDate(status.next_check_in); }
  }

  app.innerHTML = layoutHTML('deadswitch', `
    <div class="page-header"><h1>\u{23F0} Dead Man's Switch</h1></div>
    <div class="alert alert-info" style="margin-bottom:20px">
      When active, you must periodically confirm you are alive. If you fail to check in within the interval plus grace period,
      all beneficiaries are automatically granted access to your vault.
    </div>
    <div class="switch-status ${statusClass}">
      <span class="status-dot ${dotClass}"></span>
      <span>${statusText}</span>
    </div>
    ${status.is_active ? `
      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
          <div><div style="font-size:13px;color:var(--text-muted)">Last check-in</div><div>${fmtDate(status.last_check_in)} (${ago(status.last_check_in)})</div></div>
          <div><div style="font-size:13px;color:var(--text-muted)">Next due</div><div>${fmtDate(status.next_check_in)}</div></div>
          <div><div style="font-size:13px;color:var(--text-muted)">Grace deadline</div><div>${fmtDate(status.grace_deadline)}</div></div>
          <button class="btn btn-success" id="checkin-btn">\u2714 I'm Alive -- Check In</button>
        </div>
      </div>` : ''}
    <div class="card">
      <h3 style="margin-bottom:16px">Configuration</h3>
      <form id="switch-form">
        <div class="form-group"><label>Check-in interval (days)</label><input type="number" name="interval" value="${status.check_in_interval_days}" min="1" max="365"></div>
        <div class="form-group"><label>Grace period (days)</label><input type="number" name="grace" value="${status.grace_period_days}" min="1" max="90"></div>
        <div style="display:flex;gap:8px">
          ${status.is_active
            ? '<button type="submit" class="btn btn-primary" name="action" value="update">Update</button><button type="submit" class="btn btn-danger" name="action" value="deactivate">Deactivate</button>'
            : '<button type="submit" class="btn btn-success" name="action" value="activate">Activate Switch</button>'}
        </div>
      </form>
    </div>
  `);

  bindSidebar();
  const checkinBtn = $('#checkin-btn');
  if (checkinBtn) checkinBtn.onclick = async () => { try { await API.checkIn(); showSuccess('Check-in successful!'); renderDeadSwitch(); } catch (e) { showError(e.message); } };

  $('#switch-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const action = e.submitter?.value;
    try {
      await API.updateSwitch({ check_in_interval_days: parseInt(f.get('interval')) || 30, grace_period_days: parseInt(f.get('grace')) || 7, is_active: action !== 'deactivate' });
      showSuccess(action === 'deactivate' ? 'Switch deactivated' : 'Switch updated');
      renderDeadSwitch();
    } catch (err) { showError(err.message); }
  };
}

// ── Account Settings ──
async function renderSettings() {
  app.innerHTML = layoutHTML('settings', `
    <div class="page-header"><h1>\u{2699} Account Settings</h1></div>
    <div class="card">
      <h3 style="margin-bottom:16px">Change Password</h3>
      <form id="pw-form">
        <div class="form-group"><label>Current Password</label><input type="password" name="current" required></div>
        <div class="form-group"><label>New Password (min 8 chars)</label><input type="password" name="new_password" required minlength="8"></div>
        <div class="form-group"><label>Confirm New Password</label><input type="password" name="confirm" required minlength="8"></div>
        <button type="submit" class="btn btn-primary">Change Password</button>
      </form>
    </div>
    <div class="card" style="margin-top:16px">
      <h3 style="margin-bottom:12px">Backup &amp; Restore</h3>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
        Download or restore ordinary vault entries as JSON. Personal messages, managed files, recipient mappings and release history require a complete recovery backup on an independent disk.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <button class="btn btn-primary" id="backup-btn">Download vault entries (JSON)</button>
        <button class="btn btn-outline" id="restore-btn">Restore vault entries (JSON)</button>
      </div>
      <input type="file" id="restore-file" accept=".json" style="display:none">
      <div id="restore-result"></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3 style="margin-bottom:8px">Account Info</h3>
      <div class="field-grid">
        <div class="field-item"><label>Name</label><div class="value">${esc(state.user?.name)}</div></div>
        <div class="field-item"><label>Email</label><div class="value">${esc(state.user?.email)}</div></div>
      </div>
    </div>
    <div id="notification-settings" style="margin-top:16px"></div>
  `);
  bindSidebar();
  if (window.Notifications) {
    const notificationRoot = $('#notification-settings');
    window.Notifications.mount(notificationRoot);
  }

  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (f.get('new_password') !== f.get('confirm')) return showError('Passwords do not match');
    try {
      await API.changePassword({ current_password: f.get('current'), new_password: f.get('new_password') });
      showSuccess('Password changed successfully');
      e.target.reset();
    } catch (err) { showError(err.message); }
  };

  $('#backup-btn').onclick = async () => {
    try {
      const data = await API.backupVault();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wolfs-vault-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      showSuccess('Vault entries downloaded');
    } catch (err) { showError(err.message); }
  };

  const restoreFile = $('#restore-file');
  $('#restore-btn').onclick = () => restoreFile.click();
  restoreFile.onchange = async () => {
    const file = restoreFile.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.entries || !Array.isArray(data.entries)) throw new Error('Invalid backup file: no entries found');
      const mode = confirm(
        `Found ${data.entries.length} entries in backup.\n\nClick OK to skip existing entries (safe merge).\nClick Cancel to overwrite entries with same title.`
      ) ? 'skip' : 'overwrite';
      const result = await API.restoreVault(data.entries, mode);
      const msg = `Vault entry restore complete: ${result.added} added, ${result.skipped} skipped`;
      showSuccess(msg);
      $('#restore-result').innerHTML = `<div class="alert alert-success" style="margin-top:12px">${esc(msg)}</div>`;
    } catch (err) { showError(err.message); }
    restoreFile.value = '';
  };
}

// ── Audit Log ──
async function renderAuditLog() {
  let data;
  try { data = await API.getAuditLog(1); } catch { return showError('Failed to load audit log'); }

  const rows = data.logs.map(l => `<tr>
    <td>${fmtDate(l.created_at)}</td>
    <td><span class="badge badge-${l.action.includes('grant') || l.action === 'login' ? 'success' : l.action.includes('deny') || l.action.includes('fail') || l.action.includes('trigger') ? 'danger' : 'warning'}">${esc(l.action)}</span></td>
    <td>${esc(l.target_type || '')}</td>
    <td>${esc(l.detail || '')}</td>
    <td style="font-size:12px;color:var(--text-muted)">${esc(l.ip_address || '')}</td>
  </tr>`).join('');

  app.innerHTML = layoutHTML('audit', `
    <div class="page-header"><h1>\u{1F4CB} Audit Log</h1></div>
    <div class="alert alert-info" style="margin-bottom:16px">Track all actions on your vault -- logins, data access, beneficiary changes, and switch events.</div>
    <div class="card" style="overflow-x:auto">
      <table class="audit-table">
        <thead><tr><th>Date</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr></thead>
        <tbody>${rows.length ? rows : '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No audit entries yet</td></tr>'}</tbody>
      </table>
    </div>
    ${data.pages > 1 ? `<div style="text-align:center;margin-top:16px;color:var(--text-muted)">Page ${data.page} of ${data.pages}</div>` : ''}
  `);
  bindSidebar();
}

// ── Beneficiary Access Portal ──
async function renderAccessPortal() {
  app.innerHTML = `
    <div class="access-portal">
      <h1>\u{1F512} Wolf's Vault -- Beneficiary Access</h1>
      <p class="subtitle">Enter the access token you received from the vault owner.</p>
      <div class="card">
        <form id="access-form">
          <div class="form-group"><label>Access Token</label><textarea name="token" rows="3" required placeholder="Paste your access token here..."></textarea></div>
          <div style="display:flex;gap:8px">
            <button type="submit" class="btn btn-primary" name="action" value="access">View Vault</button>
            <button type="submit" class="btn btn-warning" name="action" value="emergency">Request Emergency Access</button>
          </div>
        </form>
      </div>
      <div id="access-result"></div>
      <div style="margin-top:20px;text-align:center"><a href="#login">Vault owner? Sign in here</a></div>
    </div>`;

  $('#access-form').onsubmit = async (e) => {
    e.preventDefault();
    const token = new FormData(e.target).get('token').trim();
    const action = e.submitter?.value;
    const result = $('#access-result');

    try {
      if (action === 'emergency') {
        const r = await API.requestEmergency(token);
        if (r.status === 'requested') result.innerHTML = `<div class="alert alert-success">Emergency access requested. The vault owner has ${r.waiting_days} days to deny.</div>`;
        else if (r.status === 'already_requested') result.innerHTML = `<div class="alert alert-warning">Already requested on ${fmtDate(r.requested_at)}. Wait for the period to expire.</div>`;
        else if (r.status === 'already_granted') result.innerHTML = `<div class="alert alert-success">Access already granted. Click "View Vault".</div>`;
        return;
      }
      const r = await API.accessVault(token);
      if (r.status === 'no_access') result.innerHTML = `<div class="alert alert-warning">Access not yet granted. Request emergency access above.</div>`;
      else if (r.status === 'waiting') result.innerHTML = `<div class="alert alert-warning">Pending. Access on ${fmtDate(r.waitInfo.access_at)} unless denied.</div>`;
      else if (r.status === 'granted') renderVaultReadonly(r, token);
    } catch (err) { result.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
  };
}

function renderVaultReadonly(data, token) {
  const grouped = {};
  data.entries.forEach(e => { if (!grouped[e.section]) grouped[e.section] = []; grouped[e.section].push(e); });

  let html = `<div class="access-portal vault-readonly">
    <h1>Vault of ${esc(data.owner.name)}</h1>
    <p class="subtitle">Viewing as: ${esc(data.beneficiary.name)} (${esc(data.beneficiary.relationship || 'Beneficiary')})</p>
    <div class="alert alert-info">Read-only access. Contact ${esc(data.owner.email || 'the vault owner')} for questions.</div>`;

  for (const [sectionKey, entries] of Object.entries(grouped)) {
    const sec = SECTIONS[sectionKey];
    if (!sec) continue;
    html += `<div class="section-group"><h2 class="section-title">${sec.icon} ${esc(sec.name)}</h2>`;
    for (const e of entries) {
      html += RecordCards.entry(e, { section: sectionKey, readonly: true, attachments: Docs.beneficiaryCards(e.documents) });
    }
    html += '</div>';
  }
  if (!data.entries.length) html += '<div class="empty-state"><h3>Vault is empty</h3></div>';
  html += '<div id="beneficiary-legacy-root" class="section-group"></div><div style="text-align:center;margin-top:32px"><a href="#access">&larr; Back</a></div></div>';
  app.innerHTML = html;
  Docs.bindBeneficiary(data, token);
  void Legacy.mountRecipient($('#beneficiary-legacy-root'),token,data.entries);
}

// ── Init ──
async function refreshLiveVault() {
  if (liveVaultRefreshBusy || document.hidden || !state.user || !API.token) return;
  const expectedHash = window.location.hash;
  const [route, key, entryId] = expectedHash.slice(1).split('/');
  const canRender = () => window.location.hash === expectedHash && !document.hidden &&
    !document.activeElement?.matches('input,textarea,select') && !window.getSelection()?.toString();
  if (!['vault', 'section', 'edit', 'search'].includes(route)) return;
  // Final Wishes contains its own editor and refreshes after every content action.
  if(route==='section' && key==='final_wishes')return;
  // Refresh only source-managed controls while editing. Other views can be
  // redrawn when their data changes, without interrupting typing or selection.
  if (route !== 'edit' && !canRender()) return;
  liveVaultRefreshBusy = true;
  try {
    if (route === 'edit') {
      if (!editingHomebankEntry || String(editingHomebankEntry.id) !== entryId) return;
      let fresh;
      try { fresh = await API.getEntry(entryId); }
      catch (err) {
        if (window.location.hash === expectedHash && err.message === 'Not found') navigate('section/' + key);
        return;
      }
      if (window.location.hash !== expectedHash) return;
      if (fresh.section && fresh.section !== key && SECTIONS[fresh.section]) {
        // Preserve unsaved fields and queued attachments in the current form.
        // The API maps this draft into the new source section when it saves.
        let notice = $('#homebank-reclassification');
        if (!notice) {
          notice = document.createElement('p'); notice.id = 'homebank-reclassification';
          notice.className = 'alert alert-info'; notice.setAttribute('role', 'status');
          $('#entry-form')?.prepend(notice);
        }
        notice.textContent = `HomeBank now classifies this record as ${SECTIONS[fresh.section].name}. Saving keeps your changes in that section.`;
        return;
      }
      const previous = new Set(editingHomebankEntry.homebank_managed_fields || []);
      const managed = new Set(fresh.homebank_managed_fields || []);
      for (const field of new Set([...previous, ...managed])) {
        const control = document.querySelector(`#entry-form [name="${field}"]`);
        if (!control) continue;
        control.value = fresh.fields[field] || '';
        control.readOnly = managed.has(field);
        control.setAttribute('aria-readonly', String(control.readOnly));
      }
      editingHomebankEntry = fresh;
    } else if (route === 'section') {
      const fresh = await API.getEntries(key);
      if (canRender() && JSON.stringify(fresh.entries || fresh) !== JSON.stringify(state.entries)) {
        const scroll = window.scrollY;
        const rendered = await renderSection(key, fresh, canRender);
        if (rendered && window.location.hash === expectedHash) window.scrollTo(0, scroll);
      }
    } else if (route === 'search') {
      const fresh = await API.search(decodeURIComponent(key || ''));
      if (canRender() && JSON.stringify(fresh) !== JSON.stringify(displayedSearchResults)) {
        const scroll = window.scrollY;
        const rendered = await renderSearchResults(key, fresh, canRender);
        if (rendered && window.location.hash === expectedHash) window.scrollTo(0, scroll);
      }
    } else {
      const fresh = await API.getSummary();
      const counts = Object.fromEntries(fresh.map(row => [row.section, row.count]));
      if (canRender() && JSON.stringify(counts) !== JSON.stringify(state.counts)) await renderDashboard(fresh, canRender);
    }
  } catch (err) { console.warn('HomeBank refresh unavailable', err); }
  finally { liveVaultRefreshBusy = false; }
}

setInterval(refreshLiveVault, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLiveVault(); });
handleRoute();
