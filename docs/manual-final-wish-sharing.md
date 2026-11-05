# Share a manual Final Wish

Updated 5 November 2026.

Selecting beneficiaries assigns a manual wish to them. Saving the wish or marking it **Ready** keeps it private until an explicit sharing or release action occurs. Named contacts are informational recipients and have no token access.

Open the saved manual wish and choose **Share now…**. Select its assigned beneficiaries, review the saved content and confirm sharing. The confirmation explains that those beneficiaries can read this wish and its attachments using their own valid tokens. It grants no access to the rest of the vault.

The confirmed action changes the wish to manual release and records the separate `manual_token_share` permission only for the selected beneficiaries. The older **Release…** action and existing `manual_release` permissions still require general vault access; they do not receive the new standalone token permission. It also works for a saved private draft or a Ready wish with an owner-only policy. Opening or canceling the dialog, selecting recipients and ordinary saves do not publish anything. Archived wishes and dedicated automatic wishes do not offer this manual sharing action.

The owner request is `POST /api/final-wishes/legacy/:id/share` with `confirm: true`, the reviewed `expected_revision`, and selected `beneficiary_ids`. A changed revision must be reopened and reviewed before sharing; the server rejects a stale confirmation. Content, recipient and attachment authorization continue to be checked on every token retrieval.

**Revoke release…** withdraws selected recipients’ access to this wish. Editing released content returns it to a private draft and clears its previous releases; review and share the new saved revision explicitly. Sharing a wish does not alter any beneficiary’s general vault grant.

Dedicated automatic beneficiary wishes retain their separate, immutable recipient and personal-token rules described in [Automatic beneficiary Final Wishes](beneficiary-auto-wish-access.md).

## Local acceptance

The complete suite passed on 5 November 2026: 523 JavaScript tests and 17 Python tests, with no failures or skips. This includes 16 atomic sharing/owner-route tests, 15 independent token-sharing security tests and real Firefox workflows at 1440px and 390px. An isolated copy of the affected production wish confirmed access for its three assigned beneficiaries and its one attachment, with its authored content, other wishes, general vault grants and source database unchanged. No SMS or email was sent by this trial.

## Production verification — 5 November 2026

Revision `31c1e5849ed0f2eefc781ee68ead793362bb72b7` is deployed through FTPS and pushed to `main`; all 73 runtime files match their checksums. The hosted application is healthy and its background jobs are running. Hosted and local port-4444 browser assets match this revision. Private environment settings, Clickatell, SMS policy and the local login gateway were preserved.

After explicit owner authorization, the reviewed existing wish and its one attachment were shared with its three assigned beneficiaries. All three have a current `manual_token_share` permission and can read the wish and attachment. Each beneficiary's visible list contains that shared wish and only their own dedicated personal wish. All general vault grants and existing token hashes remain unchanged, as do other wishes and their permissions. Fourteen protected tables were verified unchanged during the sharing transaction; prior revision history was retained. No SMS or email was sent by sharing or verification.

Verified database snapshots, matching keys, managed attachments and previous runtime files are retained only in the private local deployment cache. Temporary hosted database snapshots and maintenance helpers were removed.
