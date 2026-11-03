const API = {
  token: localStorage.getItem('lv_token'),

  async request(method, path, body, headers = {}) {
    const opts = { method, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers } };
    if (this.token) opts.headers['Authorization'] = 'Bearer ' + this.token;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    const contentType = (res.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(contentType)) {
      throw new Error(/^\/notifications(?:\/|\?|$)/.test(path)
        ? 'Email setup is not available on this server yet.'
        : 'The server returned an unexpected response. Refresh the page and try again.');
    }
    let data;
    try { data = await res.json(); }
    catch { throw new Error('The server returned an unreadable response. Refresh the page and try again.'); }
    if (!res.ok) {
      if (res.status === 403 && data?.code === 'SMS_VERIFICATION_REQUIRED') {
        this.setToken(null);
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sms-verification-required'));
      } else if ((res.status === 403 && data?.code === 'ACCOUNT_BLOCKED') || (res.status === 401 && data?.code === 'SESSION_REVOKED')) {
        this.setToken(null);
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('authentication-invalidated', { detail: { message: data.error } }));
      }
      const err = new Error(typeof data?.error === 'string' && data.error ? data.error : 'Request failed');
      err.data = data;
      throw err;
    }
    return data;
  },

  setToken(t) {
    this.token = t;
    if (t) localStorage.setItem('lv_token', t);
    else localStorage.removeItem('lv_token');
  },

  register: (d) => API.request('POST', '/auth/register', d),
  requestRegistration: (d) => API.request('POST', '/auth/registration-requests', d),
  getRegistrationStatus: (id, secret) => API.request('GET', '/auth/registration-requests/status?request_id=' + encodeURIComponent(id), undefined, { 'X-Registration-Secret': secret }),
  getRegistrationInvitation: (token) => API.request('POST', '/auth/registration-invitation', { invitation_token: token }),
  getRegistrationRequests: (status) => API.request('GET', '/auth/admin/registration-requests' + (status ? '?status=' + encodeURIComponent(status) : '')),
  decideRegistration: (id, action, reason) => API.request('POST', '/auth/admin/registration-requests/' + encodeURIComponent(id) + '/' + action, { confirmed: true, ...(reason ? { reason } : {}) }),
  login: (d) => API.request('POST', '/auth/login', d),
  setupLoginPhone: (d) => API.request('POST', '/auth/login/phone', d),
  verifyLoginChallenge: (d) => API.request('POST', '/auth/login/challenge/verify', d),
  resendLoginChallenge: (d) => API.request('POST', '/auth/login/challenge/resend', d),
  getMe: () => API.request('GET', '/auth/me'),
  changePassword: (d) => API.request('PUT', '/auth/password', d),
  get2faStatus: () => API.request('GET', '/auth/2fa/status'),
  start2faEnrollment: (d) => API.request('POST', '/auth/2fa/enroll/start', d),
  verify2faEnrollment: (d) => API.request('POST', '/auth/2fa/enroll/verify', d),
  resend2faEnrollment: (d) => API.request('POST', '/auth/2fa/enroll/resend', d),
  regenerateRecoveryCodes: (d) => API.request('POST', '/auth/2fa/recovery/regenerate', d),
  disable2fa: (d) => API.request('POST', '/auth/2fa/disable', d),

  getEntries: (s, page) => API.request('GET', '/vault/entries' + (s ? '?section=' + s : '') + (page ? (s ? '&' : '?') + 'page=' + page : '')),
  getEntry: (id) => API.request('GET', '/vault/entries/' + id),
  createEntry: (d) => API.request('POST', '/vault/entries', d),
  updateEntry: (id, d) => API.request('PUT', '/vault/entries/' + id, d),
  deleteEntry: (id) => API.request('DELETE', '/vault/entries/' + id),
  getSummary: () => API.request('GET', '/vault/summary'),
  search: (q) => API.request('GET', '/vault/search?q=' + encodeURIComponent(q)),
  exportVault: () => API.request('GET', '/vault/export'),
  backupVault: () => API.request('GET', '/vault/backup'),
  restoreVault: (entries, mode) => API.request('POST', '/vault/restore', { entries, mode }),

  getBeneficiaries: () => API.request('GET', '/beneficiaries'),
  addBeneficiary: (d) => API.request('POST', '/beneficiaries', d),
  updateBeneficiary: (id, d) => API.request('PUT', '/beneficiaries/' + id, d),
  removeBeneficiary: (id) => API.request('DELETE', '/beneficiaries/' + id),
  denyEmergency: (id) => API.request('POST', '/beneficiaries/' + id + '/deny-emergency'),
  grantAccess: (id) => API.request('POST', '/beneficiaries/' + id + '/grant'),
  revokeAccess: (id) => API.request('POST', '/beneficiaries/' + id + '/revoke'),
  restorePersonalWishAccess: (id) => API.request('POST', '/beneficiaries/' + id + '/restore-personal-wish-access', { confirmed: true }),
  regenerateToken: (id) => API.request('POST', '/beneficiaries/' + id + '/regenerate-token'),

  getSwitchStatus: () => API.request('GET', '/deadswitch/status'),
  updateSwitch: (d) => API.request('PUT', '/deadswitch/config', d),
  checkIn: () => API.request('POST', '/deadswitch/checkin'),

  getAuditLog: (page) => API.request('GET', '/audit?page=' + (page || 1)),

  requestEmergency: (t) => API.request('POST', '/beneficiaries/emergency-access', { accessToken: t }),
  accessVault: (t) => API.request('POST', '/beneficiaries/access', { accessToken: t })
};
