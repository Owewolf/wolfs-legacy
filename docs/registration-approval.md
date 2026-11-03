# Owner-controlled registration

New accounts are limited to family beneficiaries and require owner approval before account creation. An explicitly configured existing account starts an immutable family tree. Only a beneficiary saved under that root or an enrolled family descendant may request registration, using both the saved email and mobile number. Existing legitimate accounts keep their sign-in access, passwords, enrolled SMS numbers, vault records and beneficiary access. Clickatell remains the outbound SMS transport.

Public access requests collect a name, email and mobile number. Both normalized contact values must match the same saved beneficiary of an active family member. Outsiders, missing or partial matches, contacts split across different beneficiaries, existing accounts, denied contacts and duplicate open requests return a neutral response with decoy status credentials and send no owner or applicant SMS. Ineligible requests create no application and consume no eligible-family request quota. An eligible pending request creates no user, password hash, vault, session or applicant OTP. Private status credentials belong only to the original request; retain that browser link until a decision arrives.

Only an existing active, SMS-enrolled account configured as the owner can review requests. Its enrolled phone must match the private notification destination. The SMS opens a review page; a signed-in owner must explicitly confirm a decision. A link visit never approves or rejects anything. An approval creates a single invitation that expires after 48 hours and is bound to the approved email and phone. The invitation and account are consumed/inserted within the same SQLite write transaction. The new account remains `registered_unverified` until the existing SMS OTP process succeeds.

A rejection persists in `registration_denials` and matches either normalized email or mobile number. Only a separate confirmed owner action can lift it. A visitor's claimed contact details never revoke a legitimate existing account. Separately blocking a verified account increments `auth_version`, revokes outstanding OTP/recovery credentials and denies current sessions on their next request. The configured approving owner cannot block their own account.

## Family eligibility and sponsorship

`ACCOUNT_FAMILY_ROOT_USER_ID` identifies the existing account that starts this family. It is independent of the account configured to approve applications. The first verified initialization persists that root; subsequent environment changes cannot replace it or enroll a different family. Missing, inconsistent or unavailable root configuration fails closed for new applications while preserving existing account sign-in.

Eligibility follows immutable membership links recursively: the root may sponsor its saved beneficiaries; a beneficiary who completes approved registration becomes a family member and may then sponsor their own saved beneficiaries. A relationship label, display name, phone-only match, email-only match or another existing user’s beneficiary list does not establish membership. Existing accounts are not automatically added to the family merely because their contact details later match a beneficiary.

Each real application is permanently bound to its sponsoring family member, the exact beneficiary ID and its approved email/mobile pair. Eligibility is checked again before an owner notification or retry, approval, invitation lookup and registration. Editing or deleting that saved beneficiary can make an uncompleted request or invitation `unavailable`; it produces no new SMS and creates no permanent contact denial. The status screen asks the applicant to have their family member correct both saved contact details and submit a fresh request. The owner cannot approve or retry notifications for an unavailable request.

Completed membership survives later changes to the original beneficiary record. It remains attached to its recorded family parent rather than being reassigned through mutable contact details. Existing legitimate users retain normal sign-in independently of the new-registration family gate. New accounts still complete the existing required initial SMS activation after approval.

## Private configuration

Set the following values in the private environment after identifying the owner's existing verified account. Never put the real phone, credentials or invitation/status secrets in tracked files.

```dotenv
ACCOUNT_APPROVAL_REQUIRED=true
ACCOUNT_APPROVAL_OWNER_USER_ID=<verified-existing-account-id>
ACCOUNT_APPROVAL_OWNER_SMS_E164=<that-account-enrolled-E164-mobile>
ACCOUNT_FAMILY_ROOT_USER_ID=<verified-existing-family-root-account-id>
APP_BASE_URL=https://your-private-app.example
AUTH_SMS_REQUIRED=true
```

The approval gate is always enforced; `ACCOUNT_APPROVAL_REQUIRED=false` does not reopen public registration. The approval HMAC key uses `ACCOUNT_APPROVAL_HASH_KEY` when provided, otherwise the existing persisted `OTP_HASH_KEY`, otherwise `JWT_SECRET`. A usable key must contain at least 32 characters and cannot be the unresolved value `auto`. Preserve the selected secret across restarts. Existing Clickatell settings stay in place.

Access requests fail closed if the configured family root, owner, enrolled phone, application origin, secret or SMS transport is unavailable. A provider delivery exception preserves the pending request with notification state `failed`; visitor retries do not send again. The owner can explicitly retry at most twice after the initial attempt, with five minutes between attempts. A stale `sending` attempt can also be retried after that interval, accommodating process restarts without visitor-triggered SMS floods.

The approval link uses the configured application origin, which must be HTTPS (HTTP is allowed only for a localhost development origin). No SMS reply processor is introduced.

## API

| Endpoint under `/api/auth` | Authorization | Body or parameters |
| --- | --- | --- |
| `POST /registration-requests` | Public, persistent IP/contact/global limits | `{name,email,phone}` |
| `GET /registration-requests/status` | Private request secret in `X-Registration-Secret` | `?request_id=<id>` |
| `POST /registration-invitation` | Unused invitation | `{invitation_token}` |
| `POST /register` | Unused approved invitation | `{invitation_token,password}`; optional identity fields must match |
| `GET /admin/registration-requests` | Current SMS-verified owner | Optional `?status=pending` |
| `POST /admin/registration-requests/:id/approve` | Current SMS-verified owner | `{confirmed:true}` |
| `POST /admin/registration-requests/:id/reject` | Current SMS-verified owner | `{confirmed:true,reason?}` |
| `POST /admin/registration-requests/:id/notification/retry` | Current SMS-verified owner | `{confirmed:true}` |
| `GET /admin/registration-denials` | Current SMS-verified owner | None |
| `POST /admin/registration-denials/:id/lift` | Current SMS-verified owner | `{confirmed:true,reason?}` |
| `POST /admin/users/:id/block` | Current SMS-verified owner | `{confirmed:true,reason?}` |

Status and invitation secrets are never stored in plaintext. The owner can privately share the invitation URL returned on approval; the original status link also displays it after approval. Invitation URLs keep the token in the browser fragment; metadata lookup sends it in a POST body so HTTP access-log URLs contain no invitation token. Private responses use `Cache-Control: no-store`. Audit records store action, request reference, actor and bounded metadata, excluding invitation/status secrets, password hashes and provider responses.

Registration request limits persist in SQLite: five attempts per IP over 15 minutes, three per normalized contact pair per hour and 30 total per hour. Contact duplicate/denial checks suppress SMS independently of those limits. Every distinct eligible family contact pair still requires owner review. Changing contact details does not create family eligibility; both values must match one beneficiary belonging to an enrolled family sponsor.

## Local acceptance

Use disposable SQLite databases, synthetic identities and a capturing SMS provider. Never run automated acceptance against `data/vault.db` or a live Clickatell sender.

1. Seed an explicit synthetic family root and a beneficiary with both email and mobile. Request access on desktop and mobile; verify that no password is collected and only one mocked owner message appears. Outsiders, partial matches and different beneficiaries’ mixed contacts must create no real application or SMS.
2. Keep the private status link. Confirm pending status cannot create a user or obtain a vault session.
3. Sign in as the synthetic owner with SMS OTP. Open the notification review link. Confirm an ordinary account and an anonymous visitor cannot decide.
4. Approve with confirmation. Follow the invitation, set a password and check that the OTP goes only to the approved synthetic applicant. Verify vault access starts only after a correct code.
5. Try an altered, expired and already used invitation. Try editing the approved contact fields. Each attempt must fail without creating another account.
6. Reject another request. Repeat it using local/international phone formatting and change just one contact field at a time. Verify there are no additional messages and the private rejection reason is hidden.
7. Attempt an existing user's and the owner's phone as a new visitor. Their original authentication and vault access must still work.
8. Separately block a synthetic member. Its current session, issued OTP and recovery credentials must fail; the owner must remain active.
9. Simulate provider failure. Confirm the request stays pending, visitor retries send nothing and confirmed owner retries obey the five-minute/three-attempt limits.
10. Verify recursive enrollment through a newly activated member; confirm an unrelated existing account cannot sponsor signup. Edit/delete a pending sponsor beneficiary and confirm the request becomes unavailable without a denial; a corrected eligible request must be fresh. Confirm completed memberships survive beneficiary changes and the persisted family root cannot change.
11. Run `npm test` and start the local application on port `4444` using only disposable data and simulated SMS. Confirm the complete suite passes before the authorized production deployment.

## Acceptance results — 3 November 2026

Implemented directly on the existing `main` branch without a feature branch. During initial local acceptance no deployment was performed, no live SMS was sent and no production migration was run. The supplied implementation brief remains an untouched local handover file; its personal contact details were not copied into implementation source or configuration examples.

The release preparation checks below include the subsequent invitation metadata lookup and access-log hardening: invitation secrets travel in POST bodies, and the former token-bearing GET lookup is unavailable. A regression using real default profile decryption also verifies that every saved legacy profile phone remains protected when an account has ambiguous profiles.

| Verification | Result |
| --- | --- |
| `npm test` | 394 JavaScript tests and 17 Python tests passed; zero failures or skips |
| Approval service | 11 tests: additive migration, preserved records, duplicate suppression, persistent limits, notification failures/retries, confirmation, invitation hashes/expiry, canonical denials, account blocks and real default decryption of ambiguous saved legacy profiles |
| Complete authentication routes | 16 security integration tests: anonymous/non-owner/forged-token denials, real owner password/SMS sign-in, invitation identity binding and competing redemption, POST-only invitation metadata lookup, required initial SMS even with optional legacy policy, rejection persistence, existing-user protection, blocked JWT/challenge/recovery/setup, competing decisions and dependent-write rollback |
| Browser acceptance | Six Firefox tests, including the approval workflow at 390px and 1100px, existing mobile workflows at 390px/820px, and retained OTP/enrollment/recovery checks; approval screens include focus, error, rejection, expiry, notification retry and invitation recovery checks |
| Actual startup | A disposable SQLite backup and private copy of the application started at `http://[::1]:4444`; health and frontend returned 200, unapproved registration returned 403, unconfigured approval requests returned 503 |
| Copied-data preservation | Compared original columns/values before and after startup for `users`, `vault_entries`, `beneficiaries`, `managed_documents` and `document_associations`; unchanged. Existing accounts gained `active` status and authentication version zero |
| Repository checks | `git diff --check` passed; no supplied personal owner number in implementation files |

The IPv4 service already occupied port 4444, so the isolated startup used IPv6 loopback at that same port. Its SMS and email transports and background jobs were disabled. The running IPv4 process was not restarted, and the original SQLite database was not migrated. The temporary database, application copy and copied secrets were removed after verification.

The local database is stale and is not authoritative: the installed local frontend proxies the production API. Subsequent read-only production verification confirmed the requested owner's existing account ID is `2`, with its enrolled, SMS-verified phone matching the requested notification destination. The private local and production environments now contain the approval owner configuration, production application origin and required SMS setting. Existing Clickatell configuration and unrelated private settings were preserved. Automated tests use a synthetic verified owner and captured SMS; they do not establish live handset delivery.

Changed implementation areas:

- `server/registration-approval.js`, `server/routes/registration-approval.js` and `server/db.js`: application lifecycle, additive migration, authenticated decisions, denials, invitations, notifications and explicit account revocation.
- `server/routes/auth.js`, `server/middleware/auth.js` and `server/sms-otp.js`: transactional approved registration, SMS-only initial activation, current account status and session version checks, and guarded OTP/recovery/enrollment paths.
- `public/js/app.js`, `public/js/api.js` and `public/css/style.css`: access requests, private status, authenticated owner review, invitation completion and revoked-session handling.
- `.env.example`, this report and `docs/sms-otp-2fa.md`: private configuration and operating/acceptance instructions.
- `tests/registration-approval.test.js`, `tests/owner-approval-integration.test.js`, `tests/registration-approval-ui.test.js` and existing auth/UI/startup tests: regression coverage. The isolated email acceptance harness now seeds a disposable synthetic existing owner with private random credentials instead of relying on public registration.

The owner has explicitly authorized deployment to production and saving the changes on Git `main`. Release preparation includes a private, WAL-consistent SQLite online backup made with `better-sqlite3`; its integrity check passed and its foreign-key check returned zero violations. The rollback backup also preserves the prior 67 runtime files, private environment and matching `data/.secrets`. Production managed files remain in their existing storage location.

A rollback must restore a matching database/application snapshot; preserve any writes made after the backup before restoring it. A controlled live SMS smoke test is separate from the synthetic local acceptance.

## Authorized production release — 3 November 2026

Application revision `02d0c63d782720f5b53b2e7c20f5ee7cc4cf592d` is deployed to `wolfspack.co.za` through FTPS and pushed to `main`. All 69 runtime files were verified by checksum, Passenger restarted successfully, and both hosted and local frontend assets match the release.

Live checks confirm unapproved account creation and tampered invitations fail with 403, anonymous owner administration fails with 401, invitation metadata uses a non-cached POST body, and existing-contact application requests are suppressed. A post-release SQLite backup passed integrity and foreign-key checks. Both existing accounts, their credentials/enrolled phones and protected vault, document and beneficiary records were preserved; the configured owner and real Clickatell transport validate. No live SMS was sent by these checks. The previous runtime, WAL-consistent database backup, private environment and matching secrets remain available in the private rollback set. Deployment details are in [production-hosting.md](production-hosting.md).

## Family registration acceptance — 3 November 2026

The family restriction passed the complete local suite: 491 JavaScript tests and 17 Python tests, with no failures or skips. This includes 14 family-model tests, 22 independent registration security tests and desktop/mobile Firefox approval flows. A disposable copy of the real application entrypoint verified startup, persisted root configuration and outsider suppression with zero SMS, request, throttle or user records created.

Security acceptance covers recursive membership after actual OTP activation, exact same-beneficiary contact matching, unrelated existing accounts, immutable sponsorship, duplicate saved family contacts, stale invitations, beneficiary replacement, safe fresh requests, transactional rollback during password hashing and membership insertion, interrupted index recovery and temporary configuration outages. Completed members and legitimate existing account sign-in remain protected. A read-only production snapshot trial preserved all existing rows and verified all 90 encrypted fields without modifying its source or sending SMS.
