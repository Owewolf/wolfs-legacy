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
  const password = (id, label = 'Vault account password') => `<div class="form-group"><label for="${id}">${label}</label><input id="${id}" name="password" type="password" autocomplete="current-password" maxlength="128" required></div>`;

  async function mount(root) {
    previousCleanup?.();
    if (!root || !root.isConnected) return;
    let disposed = false;
    let busy = false;
    let loading = false;
    let state;
    let feedback;
    const alive = () => !disposed && root.isConnected;

    function cleanup() {
      if (disposed) return;
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

    function render() {
      if (!alive()) return;
      const settings = state.settings || {};
      const verified = !!settings.verified_at;
      const configured = !!state.transport_configured;
      const ready = verified && !!state.reply_transport_configured;
      const cycle = state.cycle;
      const health = Array.isArray(state.health) ? state.health : [];
      const outbox = Array.isArray(state.outbox) ? state.outbox : [];
      root.classList.add('notification-settings');
      root.innerHTML = `<section class="card notification-card" aria-labelledby="notification-title">
        <div class="notification-heading"><h2 id="notification-title">Email notifications &amp; check-ins</h2>
          <button type="button" class="btn btn-outline btn-sm" data-action="refresh">Refresh status</button></div>
        <p>Verify your email address once. When a check-in reminder arrives, click “Confirm I’m here” and send the prefilled reply to reset your Dead Man’s Switch. This confirms activity without opening your vault.</p>
        <div data-notification-feedback class="notification-feedback" hidden aria-live="polite"></div>
        ${!configured ? '<div class="alert alert-warning">Email is not configured or enabled on this server. Complete server email setup before verifying an address.</div>' : ''}
        <dl class="notification-summary">
          <div><dt>Notification address</dt><dd>${escape(settings.recipient || 'Not set')} <span class="badge badge-${verified ? 'success' : 'warning'}">${verified ? 'Verified' : 'Not verified'}</span></dd></div>
          <div><dt>Email check-ins</dt><dd>${verified && settings.reply_enabled ? 'Email check-ins enabled' : verified ? 'Paused' : 'Verify your email address to enable check-ins'}</dd></div>
          <div><dt>Final release deadline</dt><dd>${escape(cycle ? date(cycle.expiry_at) : 'Enable the Dead Man’s Switch to start a cycle')}${cycle?.status === 'released' ? ' — access already released' : ''}</dd></div>
        </dl>
        <p class="notification-help">Sending the prefilled reply resets your check-in timer and keeps the Dead Man’s Switch enabled. A late reply cannot undo access already released.</p>
      </section>

      <section class="card notification-card" aria-labelledby="notification-address-title">
        <h3 id="notification-address-title">${verified ? 'Your verified email address' : 'Verify your email address'}</h3>
        <p>${verified ? 'Your address is verified. Future reminder replies confirm activity without another verification step.' : 'Enter the address you want to receive notifications at. We will send a one-time verification code.'}</p>
        ${verified ? '<details><summary>Change notification address</summary><p class="notification-help">Verify the new address before receiving check-in reminders there.</p>' : ''}
        <form data-notification-form="verify-start">
          <div class="form-group"><label for="notification-recipient">Notification email address</label><input id="notification-recipient" name="recipient" type="email" autocomplete="email" maxlength="254" value="${escape(settings.recipient || '')}" required></div>
          ${password('notification-verify-password')}
          <button type="submit" class="btn btn-primary" ${configured ? '' : 'disabled'}>Send verification code</button>
        </form>
        ${verified ? '</details>' : ''}
        ${settings.recipient && !verified ? `<form data-notification-form="verify-complete" class="notification-subform">
          <div class="form-group"><label for="notification-verification-code">Code from the verification email</label><input id="notification-verification-code" name="code" type="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="100" required aria-describedby="notification-verification-help"></div>
          <p id="notification-verification-help" class="notification-help">Enter this code once to verify that this email address belongs to you. Email check-ins will then be enabled automatically.</p>
          <button type="submit" class="btn btn-primary">Verify address</button></form>` : ''}
      </section>

      <section class="card notification-card" aria-labelledby="notification-policy-title">
        <details><summary id="notification-policy-title">Email check-in preferences</summary>
        <p>One reminder is sent on each of the five days before final access release. All dates and times use South Africa time.</p>
        ${verified && !state.reply_transport_configured ? '<p class="notification-help">Incoming email processing is not configured on this server. Contact the server operator to enable reply processing.</p>' : ''}
        <form data-notification-form="settings">
          <label class="notification-check"><input name="reply_enabled" type="checkbox" ${settings.reply_enabled ? 'checked' : ''} ${ready || settings.reply_enabled ? '' : 'disabled'}><span>Email check-ins enabled</span></label>
          <div class="form-group"><label for="notification-reminder-clock">Daily reminder time (optional)</label><input id="notification-reminder-clock" name="reminder_clock" type="time" value="${escape(settings.reminder_clock || '')}" aria-describedby="notification-clock-help"></div>
          <p id="notification-clock-help" class="notification-help">Leave blank to use the final release deadline’s local clock time for all five dates. Changing this setting does not reset your check-in timer.</p>
          ${password('notification-settings-password')}
          <button type="submit" class="btn btn-primary">Save preferences</button>
        </form></details>
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
      busy = true;
      const button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      root.setAttribute('aria-busy', 'true');
      try {
        let success;
        if (operation === 'verify-start') {
          await API.request('POST', '/notifications/verify/start', { recipient: String(values.get('recipient')).trim(), password: currentPassword });
          success = 'Verification email queued. Enter its code here after it arrives.';
        } else if (operation === 'verify-complete') {
          await API.request('POST', '/notifications/verify/complete', { code: String(values.get('code')).trim() });
          success = 'Email address verified. Email check-ins are enabled. When a reminder arrives, click “Confirm I’m here” and send the prefilled reply.';
        } else if (operation === 'settings') {
          await API.request('PUT', '/notifications/settings', { password: currentPassword,
            reply_enabled: values.has('reply_enabled'),
            timezone: 'Africa/Johannesburg', reminder_clock: values.get('reminder_clock') || null });
          success = 'Email check-in preferences saved. Your release deadline has not changed.';
        } else if (operation === 'test') {
          await API.request('POST', '/notifications/test', { password: currentPassword });
          success = 'Test email queued. Check its submission status below and confirm receipt in your inbox.';
        } else return;
        if (!alive()) return;
        feedback = { text: success, error: false };
        await load();
      } catch (error) {
        if (alive()) {
          message(error.message || 'Notification settings could not be updated.', true);
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
      if (target.dataset.action === 'refresh' && !busy) {
        feedback = null;
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
