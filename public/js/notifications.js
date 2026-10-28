/* global API */
'use strict';

(() => {
  let previousCleanup;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const date = value => {
    if (!value) return 'Not scheduled';
    const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime())
      ? new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }).format(parsed) + ' SAST'
      : 'Unavailable';
  };
  const eventNames = {
    reminder: 'Check-in reminder', verify_address: 'Address verification', checkin_confirmed: 'Check-in confirmed',
    checkin_failed: 'Check-in warning', emergency_requested: 'Emergency access requested', emergency_denied: 'Emergency request denied',
    access_granted: 'Access granted', access_revoked: 'Access revoked', emergency_granted: 'Emergency access granted',
    deadswitch_released: 'Automatic access release', email_test: 'Configuration test', transport_health: 'Email health notice'
  };
  const statusNames = {
    queued: 'Queued', sending: 'Submitting', sent_to_server: 'Sent to server', delivered: 'Delivery confirmed',
    failed: 'Failed; retry pending', retried: 'Retry queued', dead_letter: 'Failed permanently',
    cancelled: 'Cancelled', uncertain: 'Submission uncertain'
  };
  const tone = status => ['sent_to_server', 'delivered', 'ready'].includes(status) ? 'success'
    : ['dead_letter', 'degraded', 'uncertain'].includes(status) ? 'danger' : 'warning';
  const password = (id, label = 'Current password') => `<div class="form-group"><label for="${id}">${label}</label><input id="${id}" name="password" type="password" autocomplete="current-password" maxlength="128" required></div>`;

  async function mount(root) {
    previousCleanup?.();
    if (!root || !root.isConnected) return;
    let disposed = false;
    let busy = false;
    let loading = false;
    let codes = [];
    let blobUrl;
    let state;
    let feedback;
    const alive = () => !disposed && root.isConnected;

    function clearCodes() {
      codes.fill('');
      codes = [];
      const panel = root.querySelector('[data-offline-codes]');
      if (panel) { panel.textContent = ''; panel.hidden = true; }
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = undefined; }
    }

    function cleanup() {
      if (disposed) return;
      clearCodes();
      root.querySelectorAll('input[type="password"], input[name="code"]').forEach(input => { input.value = ''; });
      disposed = true;
      observer.disconnect();
      window.removeEventListener('hashchange', cleanup);
      window.removeEventListener('pagehide', cleanup);
      root.removeEventListener('submit', submit);
      root.removeEventListener('click', click);
    }

    const observer = new MutationObserver(() => { if (!root.isConnected) cleanup(); });
    observer.observe(document.body, { childList: true, subtree: true });
    previousCleanup = cleanup;
    window.addEventListener('hashchange', cleanup);
    window.addEventListener('pagehide', cleanup);

    function message(text, error = false) {
      feedback = { text, error };
      const target = root.querySelector('[data-notification-feedback]');
      if (!target || !alive()) return;
      target.className = `alert ${error ? 'alert-error' : 'alert-success'} notification-feedback`;
      target.textContent = text;
      target.hidden = false;
      target.setAttribute('role', error ? 'alert' : 'status');
    }

    function renderCodes() {
      if (!alive() || !codes.length) return;
      const panel = root.querySelector('[data-offline-codes]');
      if (!panel) return;
      panel.hidden = false;
      panel.innerHTML = `<h4 id="offline-codes-title" tabindex="-1">Save your new offline codes now</h4>
        <p>These codes are shown once. Print them or store them in a separate password vault. Keep them outside this email account and its synced files.</p>
        <p>Each code can be used once, together with the newest reminder challenge. Previous unused codes are now invalid, and reply check-ins are off until you enable them below.</p>
        <ol class="notification-code-list"></ol>
        <div class="notification-actions"><button type="button" class="btn btn-outline" data-action="download-codes">Download offline codes</button>
        <button type="button" class="btn btn-primary" data-action="clear-codes">Done — hide codes</button></div>
        <p class="notification-help">The download contains secrets. Move it into independent secure storage, then remove any insecure or email-synced copy.</p>`;
      const list = panel.querySelector('ol');
      for (const value of codes) {
        const item = document.createElement('li');
        const secret = document.createElement('code');
        secret.textContent = value;
        item.append(secret);
        list.append(item);
      }
      panel.querySelector('h4').focus();
    }

    function render() {
      if (!alive()) return;
      const settings = state.settings || {};
      const verified = !!settings.verified_at;
      const remaining = Number(state.remaining_codes) || 0;
      const configured = !!state.transport_configured;
      const ready = verified && remaining > 0 && !!state.reply_transport_configured;
      const cycle = state.cycle;
      const health = Array.isArray(state.health) ? state.health : [];
      const outbox = Array.isArray(state.outbox) ? state.outbox : [];
      root.classList.add('notification-settings');
      root.innerHTML = `<section class="card notification-card" aria-labelledby="notification-title">
        <div class="notification-heading"><h2 id="notification-title">Email notifications &amp; reply check-in</h2>
          <button type="button" class="btn btn-outline btn-sm" data-action="refresh">Refresh status</button></div>
        <p>Receive access alerts and one check-in reminder on each of the five days before final access release. Confirm activity by replying with the email challenge and one independently stored offline code.</p>
        <div data-notification-feedback class="notification-feedback" hidden aria-live="polite"></div>
        ${!configured ? '<div class="alert alert-warning">Email is not configured or enabled on this server. Complete server email setup before verifying an address.</div>' : ''}
        <dl class="notification-summary">
          <div><dt>Notification address</dt><dd>${escape(settings.recipient || 'Not set')} <span class="badge badge-${verified ? 'success' : 'warning'}">${verified ? 'Verified' : 'Not verified'}</span></dd></div>
          <div><dt>Reply check-in</dt><dd>${settings.reply_enabled ? 'Enabled' : 'Off'}</dd></div>
          <div><dt>Unused offline codes</dt><dd>${remaining}</dd></div>
          <div><dt>Final release deadline</dt><dd>${escape(cycle ? date(cycle.expiry_at) : 'Enable the Dead Man’s Switch to start a cycle')}${cycle?.status === 'released' ? ' — access already released' : ''}</dd></div>
        </dl>
        <p class="notification-help">A successful reply starts a new cycle and keeps the Dead Man’s Switch enabled. Independent beneficiary emergency requests remain separate. A late reply cannot undo released access.</p>
      </section>

      <section class="card notification-card" aria-labelledby="notification-address-title">
        <h3 id="notification-address-title">1. Verify your notification address</h3>
        <p>${verified ? 'Sending a new verification disables reply check-ins and invalidates pending email challenges until setup is completed again.' : 'A verification code will be sent to this address. Enter it here while signed in.'}</p>
        <form data-notification-form="verify-start">
          <div class="form-group"><label for="notification-recipient">Notification email address</label><input id="notification-recipient" name="recipient" type="email" autocomplete="email" maxlength="254" value="${escape(settings.recipient || '')}" required></div>
          ${password('notification-verify-password')}
          <button type="submit" class="btn btn-primary" ${configured ? '' : 'disabled'}>Send verification code</button>
        </form>
        ${settings.recipient && !verified ? `<form data-notification-form="verify-complete" class="notification-subform">
          <div class="form-group"><label for="notification-verification-code">Code from the verification email</label><input id="notification-verification-code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="100" required aria-describedby="notification-verification-help"></div>
          <p id="notification-verification-help" class="notification-help">This verifies your address. It does not confirm activity or replace an offline check-in code.</p>
          <button type="submit" class="btn btn-primary">Verify address</button></form>` : ''}
      </section>

      <section class="card notification-card" aria-labelledby="notification-offline-title">
        <h3 id="notification-offline-title">2. Store independent offline codes</h3>
        <p>Generate ten single-use codes and keep them outside the notification inbox. They will never be emailed. You will see each new set once.</p>
        <p class="notification-help">Replacing the set invalidates unused older codes and turns reply check-ins off. Your release deadline and beneficiary access do not change.</p>
        <form data-notification-form="recovery-codes">${password('notification-recovery-password')}
          <button type="submit" class="btn btn-outline" ${verified ? '' : 'disabled'}>${remaining ? 'Replace offline code set' : 'Generate offline codes'}</button>
        </form>
        <div data-offline-codes class="notification-offline-panel" role="region" aria-labelledby="offline-codes-title" hidden></div>
      </section>

      <section class="card notification-card" aria-labelledby="notification-policy-title">
        <h3 id="notification-policy-title">3. Enable reply check-ins</h3>
        <p>Reminders are sent only at T−5, T−4, T−3, T−2 and T−1 before final release. All dates and times use Africa/Johannesburg (South Africa time).</p>
        ${!ready ? '<p class="notification-help">To enable replies, verify your address, save an unused offline code set, and configure outgoing and incoming email.</p>' : ''}
        <form data-notification-form="settings">
          <label class="notification-check"><input name="reply_enabled" type="checkbox" ${settings.reply_enabled ? 'checked' : ''} ${ready || settings.reply_enabled ? '' : 'disabled'}><span>Enable two-factor reply check-ins</span></label>
          <label class="notification-check"><input name="offline_stored_separately" type="checkbox"><span>I have saved my unused offline codes independently of this email account.</span></label>
          <div class="form-group"><label for="notification-reminder-clock">Daily reminder time (optional)</label><input id="notification-reminder-clock" name="reminder_clock" type="time" value="${escape(settings.reminder_clock || '')}" aria-describedby="notification-clock-help"></div>
          <p id="notification-clock-help" class="notification-help">Leave blank to use the final release deadline’s local clock time for all five dates. Changing this setting does not reset your check-in clock.</p>
          ${password('notification-settings-password')}
          <button type="submit" class="btn btn-primary">Save reply settings</button>
        </form>
      </section>

      <section class="card notification-card" aria-labelledby="notification-delivery-title">
        <h3 id="notification-delivery-title">Email delivery status</h3>
        <p>“Sent to server” means your email provider accepted a message. It does not confirm inbox delivery. “Submission uncertain” needs operator review before any resend.</p>
        <form data-notification-form="test">${password('notification-test-password')}
          <button type="submit" class="btn btn-outline" ${verified && configured ? '' : 'disabled'}>Queue test email</button>
        </form>
        <dl class="notification-summary notification-health">${health.length ? health.map(item => `<div><dt>${escape(item.channel === 'smtp' ? 'Outgoing email' : item.channel === 'imap' ? 'Incoming replies' : 'Alternate alert channel')}</dt>
          <dd><span class="badge badge-${tone(item.status)}">${escape(item.status === 'ready' ? 'Ready' : 'Degraded')}</span>${item.last_failure_at && item.status !== 'ready' ? ` Last failure: ${escape(date(item.last_failure_at))}` : ''}${item.failures ? ` (${Number(item.failures) || 0} failures)` : ''}</dd></div>`).join('') : '<div><dt>Email processing</dt><dd>No processing status recorded yet</dd></div>'}</dl>
        <div class="notification-table-wrap" tabindex="0" role="region" aria-label="Recent notification activity">
          <table class="audit-table notification-table"><caption>Recent notifications</caption>
            <thead><tr><th scope="col">Event</th><th scope="col">Scheduled (SAST)</th><th scope="col">State</th><th scope="col">Attempts</th></tr></thead>
            <tbody>${outbox.length ? outbox.map(item => `<tr><td>${escape(eventNames[item.event_type] || 'Security notification')}${item.reminder_number ? ` (${Number(item.reminder_number)} of 5)` : ''}</td>
              <td>${escape(date(item.schedule_at))}</td><td><span class="badge badge-${tone(item.status)}" title="${escape(item.status)}">${escape(statusNames[item.status] || 'Unknown')}</span>${item.last_error ? `<small class="notification-error-code">${escape(item.last_error)}</small>` : ''}</td><td>${Number(item.attempts) || 0}</td></tr>`).join('')
              : '<tr><td colspan="4">No notifications queued yet.</td></tr>'}</tbody>
          </table>
        </div>
      </section>`;
      if (feedback) message(feedback.text, feedback.error);
      renderCodes();
    }

    async function load() {
      if (!alive() || loading) return;
      loading = true;
      root.setAttribute('aria-busy', 'true');
      try {
        const result = await API.request('GET', '/notifications');
        if (!alive()) return;
        state = result;
        render();
      } catch (error) {
        if (!alive()) return;
        if (!state) root.innerHTML = '<section class="card notification-card"><h2>Email notifications</h2><p data-notification-feedback class="alert alert-error" role="alert"></p><button type="button" class="btn btn-outline" data-action="refresh">Try again</button></section>';
        message(error.message || 'Notification settings could not be loaded.', true);
      } finally { loading = false; if (alive()) root.removeAttribute('aria-busy'); }
    }

    async function submit(event) {
      const form = event.target.closest('[data-notification-form]');
      if (!form || !root.contains(form)) return;
      event.preventDefault();
      if (busy || !alive()) return;
      const values = new FormData(form);
      const operation = form.dataset.notificationForm;
      const currentPassword = values.get('password');
      form.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
      if (operation === 'settings' && values.has('reply_enabled') && !values.has('offline_stored_separately')) {
        message('Confirm that your unused offline codes are stored separately before enabling replies.', true);
        form.querySelector('[name="offline_stored_separately"]').focus();
        return;
      }
      busy = true;
      const button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      root.setAttribute('aria-busy', 'true');
      try {
        let result;
        let success;
        if (operation === 'verify-start') {
          clearCodes();
          result = await API.request('POST', '/notifications/verify/start', { recipient: String(values.get('recipient')).trim(), password: currentPassword });
          success = 'Verification email queued. Enter its code here after it arrives.';
        } else if (operation === 'verify-complete') {
          await API.request('POST', '/notifications/verify/complete', { code: String(values.get('code')).trim() });
          success = 'Notification address verified.';
        } else if (operation === 'recovery-codes') {
          clearCodes();
          result = await API.request('POST', '/notifications/recovery-codes', { password: currentPassword });
          if (!alive()) { if (Array.isArray(result.codes)) result.codes.fill(''); return; }
          codes = Array.isArray(result.codes) ? result.codes : [];
          success = 'New offline code set created. Save it now; reply check-ins are off until you enable them.';
        } else if (operation === 'settings') {
          await API.request('PUT', '/notifications/settings', { password: currentPassword,
            reply_enabled: values.has('reply_enabled'), offline_stored_separately: values.has('offline_stored_separately'),
            timezone: 'Africa/Johannesburg', reminder_clock: values.get('reminder_clock') || null });
          success = 'Reply check-in settings saved. Your release deadline has not changed.';
        } else if (operation === 'test') {
          await API.request('POST', '/notifications/test', { password: currentPassword });
          success = 'Test email queued. Check its submission status below and confirm receipt in your inbox.';
        } else return;
        if (!alive()) return;
        feedback = { text: success, error: false };
        await load();
        if (alive() && codes.length) renderCodes();
      } catch (error) {
        if (alive()) {
          message(error.message || 'Notification settings could not be updated.', true);
          if (operation === 'recovery-codes' && codes.length) renderCodes();
        }
      } finally {
        values.delete('password');
        values.delete('code');
        busy = false;
        if (alive()) { root.removeAttribute('aria-busy'); if (button?.isConnected) button.disabled = false; }
      }
    }

    async function click(event) {
      const target = event.target.closest('[data-action]');
      if (!target || !root.contains(target) || !alive()) return;
      if (target.dataset.action === 'clear-codes') {
        clearCodes();
        message('Offline codes hidden. Enable reply check-ins after saving them independently.');
        root.querySelector('[name="offline_stored_separately"]')?.focus();
      } else if (target.dataset.action === 'download-codes' && codes.length) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        const content = ["Wolf's Legacy — independent single-use check-in codes", '',
          'Keep these codes outside your notification inbox and its synced files.',
          'Each code is valid once, together with the newest emailed challenge.', '', ...codes, ''].join('\n');
        blobUrl = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = `wolfs-legacy-offline-checkin-codes-${new Date().toISOString().slice(0, 10)}.txt`;
        anchor.click();
      } else if (target.dataset.action === 'refresh' && !busy) {
        feedback = null;
        clearCodes();
        await load();
      }
    }

    root.addEventListener('submit', submit);
    root.addEventListener('click', click);
    root.innerHTML = '<section class="card notification-card" role="status">Loading email notification settings…</section>';
    await load();
  }

  window.Notifications = { mount };
})();
