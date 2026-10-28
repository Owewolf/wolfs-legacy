/* global API */
'use strict';
(()=>{
  const banner=document.createElement('section');
  banner.setAttribute('aria-label','Isolated email acceptance');
  banner.style.cssText='position:relative;z-index:10;padding:16px;background:#073c4c;color:#fff;border-bottom:3px solid #50c6b7';
  banner.innerHTML='<strong>Temporary email reply test</strong><p>This test vault sends real test emails and closes automatically within two hours.</p><p><a href="#settings/offline-codes" style="display:inline-block;padding:10px 14px;margin:8px 0;background:#fff;color:#073c4c;border-radius:6px;font-weight:bold">Open code setup</a> — after verifying your email, generate and save your offline codes here.</p><details><summary>After saving your codes: send a test reminder</summary><p>Enable reply check-ins in email settings, then send this reminder. Reply in your mail app with the email challenge and one of your saved offline codes.</p><form><label>Your test-account password <input type="password" autocomplete="current-password" required maxlength="128"></label> <button type="submit">Send test reminder</button></form><button type="button" data-refresh>Check test result</button><p role="status" aria-live="polite" data-result></p></details>';
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
