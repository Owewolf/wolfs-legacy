/* global API */
'use strict';
(()=>{
  const banner=document.createElement('section');
  banner.setAttribute('aria-label','Isolated email acceptance');
  banner.style.cssText='position:relative;z-index:10;padding:16px;background:#073c4c;color:#fff;border-bottom:3px solid #50c6b7';
  banner.innerHTML='<strong>Isolated email acceptance — synthetic vault</strong><p>This local test uses real email and stops automatically within two hours. Register a new test identity with a test-only password. In Settings, verify your real notification mailbox, generate and independently save offline codes, then enable reply check-ins.</p><details><summary>Send the real acceptance reminder</summary><p>This starts a disposable 30+7-day test cycle with its first reminder due now. Existing vaults and production services are not involved. Reply in your mail app using the challenge and one independently stored code.</p><form><label>Current test-owner password <input type="password" autocomplete="current-password" required maxlength="128"></label> <button type="submit">Send acceptance reminder</button></form><button type="button" data-refresh>Check acceptance result</button><p role="status" aria-live="polite" data-result></p></details>';
  document.body.prepend(banner);
  const result=banner.querySelector('[data-result]');
  const password=banner.querySelector('input');
  banner.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault();const value=password.value;password.value='';
    try {
      if(typeof API==='undefined'||!API.token)throw new Error('Register or sign in to the synthetic test vault first');
      await API.request('POST','/notifications/acceptance/reminder',{password:value});
      result.textContent='Acceptance reminder queued. Allow up to 30 seconds, then reply from the verified mailbox with its challenge and one independent offline code. Do not paste either code here.';
    }catch(error){result.textContent=error.message||'Acceptance reminder could not be queued';}
  });
  banner.querySelector('[data-refresh]').addEventListener('click',async()=>{
    try {
      const state=await API.request('GET','/notifications/acceptance/status');
      result.textContent=!state.started?'Acceptance reminder has not been started.':
        `Accepted replies: ${state.accepted_replies}. Consumed offline codes: ${state.consumed_codes}. Acknowledgement: ${state.acknowledgement_status||'not queued'}.`;
    }catch(error){result.textContent=error.message||'Acceptance status could not be loaded';}
  });
})();
