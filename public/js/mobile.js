/* global document, window */
'use strict';

// This layer only controls the compact layout. The existing desktop navigation,
// authentication, data routes and permission decisions remain in their modules.
const Mobile = (() => {
  const compact = window.matchMedia('(max-width: 1024px)');
  let active = null;
  let entry = 0;
  let pendingRoute = null;
  let exportClose = null;
  const isCompact = () => compact.matches;
  const focus = node => { if (node?.isConnected) node.focus({preventScroll:true}); };
  function viewport() {
    const root = document.documentElement;
    if (!isCompact()) {
      root.style.removeProperty('--mobile-viewport-height');
      root.style.removeProperty('--mobile-viewport-top');
      return;
    }
    const view = window.visualViewport;
    root.style.setProperty('--mobile-viewport-height', Math.round(view?.height || window.innerHeight) + 'px');
    root.style.setProperty('--mobile-viewport-top', Math.round(view?.offsetTop || 0) + 'px');
  }
  function paint(open, restoreFocus = false) {
    if (!active) return;
    const {sidebar,header,main,backdrop,toggle,close,search} = active;
    active.open = open;
    toggle.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !open;
    document.documentElement.classList.toggle('mobile-nav-open', open);
    sidebar.inert = isCompact() && !open;
    main.inert = open;
    header.inert = open;
    sidebar.setAttribute('aria-hidden', String(isCompact() && !open));
    if (open) {
      sidebar.setAttribute('role','dialog');
      sidebar.setAttribute('aria-modal','true');
      sidebar.setAttribute('aria-label','Vault navigation');
    } else {
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
      sidebar.removeAttribute('aria-label');
      if (!isCompact()) sidebar.removeAttribute('aria-hidden');
    }
    if (open) focus(active.searching ? search : close);
    else if (restoreFocus) focus(active.trigger || toggle);
  }
  function close({restoreFocus = true, route = null} = {}) {
    if (!active?.open) return;
    const ownsEntry = window.history.state?.wolfMobileNavigation === active.entry;
    paint(false, restoreFocus && !route);
    if (ownsEntry) {
      pendingRoute = route;
      window.history.back();
    } else if (route) window.location.hash = route;
  }
  function open(searching = false, trigger = active?.toggle) {
    if (!active || !isCompact() || active.open) return;
    active.searching = searching;
    active.trigger = trigger;
    active.entry = ++entry;
    window.history.pushState({...window.history.state,wolfMobileNavigation:active.entry},'',window.location.href);
    viewport();paint(true);
  }
  function sync() {
    if (!active?.sidebar.isConnected) { viewport();return; }
    if (active.open) close({restoreFocus:false});
    active.header.hidden = !isCompact();
    active.close.hidden = !isCompact();
    paint(false);viewport();
  }
  function reset() {
    if (active) {
      // Route changes normally pass through close() before navigation. For an
      // external hash change, remove any inherited drawer marker as well.
      if (window.history.state?.wolfMobileNavigation === active.entry) {
        const state = {...window.history.state};delete state.wolfMobileNavigation;
        window.history.replaceState(state,'',window.location.href);
      }
      paint(false);
      active.sidebar.removeEventListener('click',active.click,true);
      active.sidebar.removeEventListener('keydown',active.searchKey,true);
      active = null;
    }
    document.documentElement.classList.remove('mobile-nav-open');
    exportClose?.();
  }
  function mount() {
    reset();
    const sidebar=document.getElementById('mobile-navigation');
    const header=document.querySelector('.mobile-header');
    const main=document.getElementById('main-content');
    if (!sidebar || !header || !main) return;
    const toggle=document.getElementById('mobile-menu-toggle');
    const closeButton=document.getElementById('mobile-navigation-close');
    const search=document.getElementById('global-search');
    active={sidebar,header,main,toggle,close:closeButton,search,
      backdrop:document.querySelector('.mobile-nav-backdrop'),open:false};
    toggle.onclick=()=>open(false,toggle);
    const searchToggle=document.getElementById('mobile-search-toggle');
    searchToggle.onclick=()=>open(true,searchToggle);
    closeButton.onclick=()=>close();
    active.backdrop.onclick=()=>close();
    active.click=event=>{
      const destination=event.target.closest('[data-nav]');
      if (!active?.open || !destination) return;
      event.preventDefault();event.stopPropagation();
      close({restoreFocus:false,route:destination.dataset.nav});
    };
    active.searchKey=event=>{
      if(!active?.open || event.target!==search || event.key!=='Enter' || search.value.trim().length<2)return;
      event.preventDefault();event.stopPropagation();
      close({restoreFocus:false,route:'search/'+encodeURIComponent(search.value.trim())});
    };
    sidebar.addEventListener('click',active.click,true);
    sidebar.addEventListener('keydown',active.searchKey,true);
    sync();
  }
  window.addEventListener('popstate',()=>{
    if(active?.open && window.history.state?.wolfMobileNavigation!==active.entry)paint(false,true);
    if(pendingRoute) {const route=pendingRoute;pendingRoute=null;window.location.hash=route;}
  });
  document.addEventListener('keydown',event=>{
    if(!active?.open)return;
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key!=='Tab')return;
    const controls=[...active.sidebar.querySelectorAll('button,input,a[href],select,textarea,[tabindex="0"]')]
      .filter(node=>!node.disabled && node.getClientRects().length);
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey && (document.activeElement===first || !active.sidebar.contains(document.activeElement))) {event.preventDefault();focus(last);}
    else if(!event.shiftKey && document.activeElement===last) {event.preventDefault();focus(first);}
  });
  compact.addEventListener('change',sync);
  window.visualViewport?.addEventListener('resize',viewport,{passive:true});
  window.visualViewport?.addEventListener('scroll',viewport,{passive:true});
  window.addEventListener('resize',viewport,{passive:true});
  window.addEventListener('pagehide',reset);
  window.addEventListener('pageshow',event=>{
    // Safari can restore this document, including its old event handlers, from
    // the back/forward cache after opening a PDF or a downloaded export.
    if(event.persisted){mount();viewport();}
  });

  function showExport(blob) {
    exportClose?.();
    const url=URL.createObjectURL(blob),overlay=document.createElement('div');
    const previous=document.activeElement;
    overlay.className='modal-overlay mobile-export-overlay';
    overlay.innerHTML='<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mobile-export-title"><h2 id="mobile-export-title">Your export is ready</h2><p>Open a printable copy or save the HTML file using your browser. Keep it private: it contains your vault information.</p><div class="modal-actions"><a class="btn btn-primary" data-export-open target="_blank" rel="noopener">Open export</a><a class="btn btn-outline" data-export-save download="wolfs-legacy-export.html">Save file</a><button type="button" class="btn btn-outline" data-export-close>Close</button></div></div>';
    overlay.querySelectorAll('a').forEach(link=>link.href=url);
    const dispose=()=>{
      overlay.remove();document.removeEventListener('keydown',key);
      // Let a mobile browser finish handing the URL to its tab/download process.
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      exportClose=null;focus(previous);
    };
    const key=event=>{if(event.key==='Escape')dispose();};
    overlay.querySelector('[data-export-close]').onclick=dispose;
    overlay.onclick=event=>{if(event.target===overlay)dispose();};
    document.addEventListener('keydown',key);document.body.append(overlay);
    exportClose=dispose;viewport();focus(overlay.querySelector('[data-export-open]'));
  }
  return {mount,reset,isCompact,showExport};
})();
