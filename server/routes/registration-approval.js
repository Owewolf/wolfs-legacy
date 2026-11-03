'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { createRegistrationApprovalService } = require('../registration-approval');

function createRegistrationApprovalRouter({ dbGetter, auditWriter, env = process.env, now = Date.now, smsProvider, decryptFields, authenticate = authenticateToken } = {}) {
  const router = express.Router();
  const service = () => createRegistrationApprovalService({ db: dbGetter(), auditWriter, env, now, smsSender: smsProvider, decryptFields });
  function failure(res, result) {
    const statuses = { invalid_request: 400, confirmation_required: 400, owner_required: 403, owner_protected: 403, not_found: 404,
      rate_limited: 429, approval_unavailable: 503, family_unavailable: 503, family_eligibility_required: 403, notification_failed: 503, invitation_expired: 410, invitation_used: 409,
      not_pending: 409, notification_limited: 429, identity_unavailable: 409, already_blocked: 409 };
    const messages = {
      invalid_request: 'Enter a full name, valid email address and mobile number.',
      confirmation_required: 'Explicit confirmation is required.',
      owner_required: 'An authenticated, SMS-verified owner session is required.',
      owner_protected: 'The approving owner account is protected.',
      rate_limited: 'Too many access requests. Please try again later.',
      approval_unavailable: 'Registration approval is temporarily unavailable. Please try again later.',
      family_unavailable: 'Family registration is temporarily unavailable. Please contact the owner.',
      family_eligibility_required: 'This request is no longer eligible. Ask your family member to check your beneficiary details before requesting access again.',
      invitation_expired: 'This invitation has expired. Contact the owner.',
      invitation_used: 'This invitation has already been used.',
      not_pending: 'This request is no longer awaiting a decision.',
      notification_limited: 'This notification cannot be retried yet.',
      notification_failed: 'The owner notification could not be sent.',
      identity_unavailable: 'These contact details are no longer available for registration.'
    };
    return res.status(statuses[result.reason] || 403).json({ error: messages[result.reason] || 'This request cannot be completed.', code: String(result.reason || 'approval_required').toUpperCase() });
  }
  function sendResult(res, result, status = 200) {
    if (!result.ok) return failure(res, result);
    const { ok, ...body } = result;
    return res.status(status).json(body);
  }
  function requireOwner(req, res, next) {
    try {
      if (!service().isOwner(req.user)) return failure(res, { reason: 'owner_required' });
      next();
    } catch { return res.status(503).json({ error: 'Owner administration is temporarily unavailable', code: 'APPROVAL_UNAVAILABLE' }); }
  }
  function handle(callback) {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { await callback(req, res, service()); }
      catch { res.status(503).json({ error: 'Registration approval is temporarily unavailable', code: 'APPROVAL_UNAVAILABLE' }); }
    };
  }
  router.post('/registration-requests', handle(async (req, res, approvals) => {
    const { name, email, phone } = req.body || {};
    return sendResult(res, await approvals.requestAccess({ name, email, phone, ipAddress: req.ip }), 202);
  }));
  router.get('/registration-requests/status', handle((req, res, approvals) => {
    const statusSecret = req.get('X-Registration-Secret') || '';
    return sendResult(res, approvals.requestStatus({ requestId: req.query.request_id, statusSecret }));
  }));
  router.post('/registration-invitation', handle((req, res, approvals) => {
    const result = approvals.validateInvitation({ invitationToken: req.body?.invitation_token });
    if (!result.ok) return failure(res, result);
    return res.json(approvals.invitationView(result.request));
  }));
  router.use('/admin', authenticate, requireOwner);
  router.get('/admin/registration-requests', handle((req, res, approvals) => {
    const status = req.query.status;
    if (status && !['pending', 'approved', 'rejected', 'registered'].includes(status)) return failure(res, { reason: 'invalid_request' });
    return res.json({ requests: approvals.listRequests({ status }) });
  }));
  for (const decision of ['approve', 'reject']) {
    router.post(`/admin/registration-requests/:id/${decision}`, handle((req, res, approvals) => sendResult(res, approvals.decide({
      requestId: req.params.id, actor: req.user, decision, confirmed: req.body?.confirmed, reason: req.body?.reason, ipAddress: req.ip
    }))));
  }
  router.post('/admin/registration-requests/:id/notification/retry', handle(async (req, res, approvals) => {
    if (req.body?.confirmed !== true) return failure(res, { reason: 'confirmation_required' });
    return sendResult(res, await approvals.notifyOwner(req.params.id, { retry: true, actorId: req.user.id, ipAddress: req.ip }));
  }));
  router.get('/admin/registration-denials', handle((req, res, approvals) => res.json({ denials: approvals.listDenials() })));
  router.post('/admin/registration-denials/:id/lift', handle((req, res, approvals) => sendResult(res, approvals.liftDenial({
    denialId: req.params.id, actor: req.user, confirmed: req.body?.confirmed, reason: req.body?.reason, ipAddress: req.ip
  }))));
  router.post('/admin/users/:id/block', handle((req, res, approvals) => sendResult(res, approvals.blockUser({
    userId: req.params.id, actor: req.user, confirmed: req.body?.confirmed, reason: req.body?.reason, ipAddress: req.ip
  }))));
  return router;
}

module.exports = { createRegistrationApprovalRouter };
