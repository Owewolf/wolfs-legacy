/* global API */
'use strict';
(() => {
  const banner = document.createElement('section');
  banner.setAttribute('aria-label', 'Isolated email acceptance');
  banner.style.cssText = 'position:relative;z-index:10;padding:16px;background:#073c4c;color:#fff;border-bottom:3px solid #50c6b7';
  banner.innerHTML = '<strong>Temporary email reply test</strong><p>Verify your email address once in <a href="#settings" style="color:#fff;text-decoration:underline">Settings</a>, then send a test reminder below.</p><form><label>Vault test-account password <input type="password" autocomplete="current-password" required maxlength="128"></label> <button type="submit">Send test reminder</button></form><button type="button" data-refresh>Check test result</button><p role="status" aria-live="polite" data-result></p>';
  document.body.prepend(banner);
  const result = banner.querySelector('[data-result]');
  const password = banner.querySelector('input');
  const send = banner.querySelector('button[type="submit"]');
  banner.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (send.disabled) return;
    const value = password.value;
    password.value = '';
    send.disabled = true;
    try {
      if (typeof API === 'undefined' || !API.token) throw new Error('Register or sign in to the test vault first.');
      await API.request('POST', '/notifications/acceptance/reminder', { password: value });
      result.textContent = 'Test reminder queued. Open the newest [ACCEPTANCE TEST] Check-in required email, click “Confirm I’m here”, then send the prefilled reply.';
    } catch (error) {
      result.textContent = error.message || 'Test reminder could not be queued.';
    } finally {
      send.disabled = false;
    }
  });
  banner.querySelector('[data-refresh]').addEventListener('click', async () => {
    try {
      const state = await API.request('GET', '/notifications/acceptance/status');
      result.textContent = !state.started ? 'The test reminder has not been sent yet.'
        : `Accepted replies: ${state.accepted_replies}. Confirmation email: ${state.acknowledgement_status || 'not queued'}.`;
    } catch (error) {
      result.textContent = error.message || 'Test result could not be loaded.';
    }
  });
})();
