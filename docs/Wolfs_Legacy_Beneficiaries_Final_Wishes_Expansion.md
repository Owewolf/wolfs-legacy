# Wolf's Legacy — Beneficiaries & Final Wishes Expansion

**Developer implementation specification · Proposed next feature**
**Repository:** `Owewolf/wolfs-legacy`
**Suggested branch:** `feature/beneficiaries-final-wishes-legacy`
**Runtime:** Fedora, Node.js, SQLite, `wolfs-legacy.service`, port `4444`
**Managed document directory:** `/srv/data/files/legacy-vault-managed-documents`
**Status:** Implemented for review on `feature/beneficiaries-final-wishes-legacy`; see [implementation evidence](beneficiaries-final-wishes-implementation.md) and [initial audit](beneficiaries-final-wishes-audit.md). Owner-authorized production deployment of `8a8be54` completed on 28 October 2026; see the [deployment record](beneficiaries-final-wishes-deployment.md).

## 1. Objective and scope

**Extend the two existing Wolf's Legacy sections, `Beneficiaries` and `Final Wishes`. Do not create a new top-level Personal Legacy section or a parallel beneficiary system.** Reuse the existing owner account, beneficiary IDs and access tokens, document uploader, encrypted records, audit log, Dead Man's Switch and email/2FA framework wherever safe.

Implement five capabilities **inside these existing sections**:

1. **Personal Letters to Beneficiaries** — Markdown letters and messages addressed to particular people.
2. **Audio and Video Messages** — uploaded recordings with in-app playback and controlled release.
3. **Family History Archive** — photographs, stories, family documents and recordings with dates and relationships.
4. **Personal Instructions Register** — property, household, vehicles, pets, digital affairs and practical handover instructions.
5. **Scheduled Information Review** — periodic reminders and records of when information was last verified.

Do not redesign ordinary owner sign-in, the separate beneficiary token-entry page or the existing email reply-with-code check-in flow. Expand the content and related management within the existing Beneficiaries and Final Wishes areas.

## 2. Mandatory initial audit

Before coding, audit the **actual current** branch; do not assume upstream `slavhate/legacy-vault` matches Wolf's Legacy. Inspect:

- `public/js/sections.js`, `public/js/app.js`, `public/js/api.js` and the current beneficiary/Final Wishes rendering.
- `server/routes/beneficiaries.js`, `server/routes/vault.js`, `server/db.js` and encryption helpers.
- `server/routes/documents.js`, managed-document storage, PDF/image preview and downloads.
- The latest email notification/outbox, two-factor check-in and Dead Man's Switch services.
- Migrations, backups, export/import, release events, rate limits and ownership checks.

The original source defines `final_wishes` with `category`, `details`, `contact_person` and `contact_phone`; preserve those fields and existing entries. Original beneficiary access returns the whole decrypted vault after a grant. **That behaviour must not expose drafts, unreleased media, new private instructions, or records intended for other beneficiaries.** Item-level access enforcement is a release-blocking requirement.

**Audit output:** findings, existing-versus-required comparison, storage/security decisions, migration risks, and explicit acceptance criteria before implementation.

## 3. How the two existing sections expand

### 3.1 Beneficiaries — recipient-specific legacy content

Keep existing beneficiary identity, relationship, phone, email, token, waiting period, grant/revoke and emergency request functions. Add recipient-specific associations to each beneficiary record:

- **Personal letters:** list letters intended for that beneficiary; create/edit draft, preview, mark ready, set release policy, and inspect delivered/released state.
- **Recordings:** list audio/video messages assigned to that beneficiary, linked to a letter or standalone.
- **Family archive:** show archive items explicitly shared with that beneficiary.
- **Instructions:** show practical tasks or directions assigned to that beneficiary or digital executor.
- **Release summary:** what is prepared, still private, released, or awaiting conditions, with dates and audit history.

Do not duplicate media or whole records when one letter or archive item is allocated to multiple beneficiaries; use a many-to-many relationship. Removing or revoking a beneficiary must remove future access without deleting the owner's master records or shared files. An expired token grants no access even if the item is marked released.

### 3.2 Final Wishes — central content authoring and organisation

Retain the existing Final Wishes records and categories (funeral, burial/cremation, organ donation, memorial, message to family, charitable wishes, pet care, other). Extend the section with the following content groupings **within Final Wishes**:

| Group | Purpose | Typical content |
|---|---|---|
| Personal Letters | Private written messages | Letter to a child, note to an executor |
| Audio & Video Messages | Personal recordings | Farewell recording, family story |
| Family History | Archive of family memories | Photographs, certificates, oral history |
| Personal Instructions | Practical responsibilities | Property maintenance, pets, vehicles, services |
| Information Reviews | Records needing verification | Insurance instructions, contacts, annual review |

Each content record must have a title, type, description/body, status, recipients (where relevant), release policy, attached files, creation/update dates and review state. Add useful links to existing Property, Vehicle, Important Contacts, Digital Accounts and other vault entries without copying their contents.

## 4. Feature requirements

### 4.1 Personal Letters

- Provide a safe **Markdown editor and preview**; sanitise rendered Markdown and reject executable HTML, scripts and unsafe links.
- Fields: title/subject, Markdown body, optional personal introduction, selected beneficiary or beneficiaries, optional related Final Wishes entry, attachments, release policy, status, dates.
- States: `draft`, `ready`, `released`, `archived`; **draft and ready are never released merely because they exist**.
- Owner may edit drafts, preview the beneficiary view, and preserve revision history when content changes.
- Assign one letter to several recipients without duplicate copies; permit separate letters to different recipients.
- Do not email the letter body or attachments automatically; emails may notify an authorised recipient that protected content is available.
- Allow owner-initiated release with an explicit confirmation step.

### 4.2 Audio and Video Messages

- Upload using the **existing file picker and drag-and-drop managed-document component**, with multiple files per item.
- Initial formats: MP3, M4A, WAV, MP4, MOV; determine exact accepted MIME types and limits in the implementation audit. Validate content on the server, not just by extension.
- Copy selected originals into managed storage under generated names. **Never move, overwrite or delete the original file.**
- Store title, file metadata, hash/checksum, recording date (optional), description, people/tags, recipients and release conditions.
- Authenticated playback within the item for formats supported by the browser; otherwise authenticated download. Support HTTP range requests securely for playback/seek.
- Secure thumbnails and transcripts if added later. Do not use public static media URLs or embed secrets in URLs.
- Owner can preview a recording before release; beneficiary access is conditional on both their access status and the item's release rules.

### 4.3 Family History Archive

- Family stories, events, photos, scans, certificates, recordings and letters all remain in **Final Wishes → Family History**.
- Fields: title, narrative (Markdown), dates including *approximate/unknown*, people, relationship, optional place, tags, item category, attachments, recipients, privacy/release setting.
- Display as searchable list and chronological timeline using the existing application styling.
- Associate records with existing Important Contacts or other vault items; allow a record to appear in more than one relationship without copying attachments.
- Never infer factual identities or precise dates from photographs; owner supplies information. Avoid publishing GPS/EXIF metadata by default.
- Default every new archive item to private (`owner_only`). Shared family archives must require explicit recipient selection.

### 4.4 Personal Instructions Register

- Include categories: properties, maintenance, vehicles, equipment, pets, household services, subscriptions, digital administration, other.
- Fields: title, instructions in Markdown, checklist steps, priority, linked vault record, responsible person(s), helpful contact(s), attachments, review date, release policy.
- Support ordered checklists and confirmation/acknowledgement by a beneficiary **only after authorised access**, without editing the owner's canonical instructions.
- Secret credentials, alarm codes and recovery keys stay in protected vault records; instructions may refer to those records but must not reproduce them in notification emails.
- Allow multiple instructions for the same property or vehicle and link one instruction to more than one relevant record.

### 4.5 Scheduled Information Review

- Per item: `last_reviewed_at`, `next_review_at`, review interval (such as 3/6/12 months), reviewer and review history.
- Flags: `current`, `due_soon`, `overdue`, `archived`.
- Owner actions: **Reviewed — No Change**, **Reviewed and Updated**, reschedule, snooze reminder, disable review.
- Send review reminders through the existing notification queue if implemented; otherwise build a durable deduplicated job, not an ephemeral in-memory timer.
- Review emails must not contain confidential document contents or personal messages.
- Review acknowledgement **must not** reset the Dead Man's Switch, count as 2FA check-in, grant beneficiary access or alter the five-day Dead Man's Switch reminder schedule.

## 5. Release and permission rules — mandatory

Define per-item release policies:

| Policy | Owner view | Beneficiary view |
|---|---|---|
| `owner_only` (default) | Always | Never |
| `manual_release` | Always | Only after owner releases it to the named recipient |
| `dead_switch_release` | Always | After a confirmed switch-trigger release and valid beneficiary authorisation |
| `emergency_access_release` | Always | After a valid emergency-access grant and only if explicitly enabled for that item |

**Additional requirements:**

1. A recipient must be explicitly assigned to the item. Possession of another beneficiary's token must never expose it.
2. `draft`, `archived` and unreleased records are excluded from every beneficiary API response, export, search result, media endpoint and document preview.
3. An emergency request is not an authorisation grant. The waiting period must expire (or manual grant occur) before release logic is evaluated.
4. A Dead Man's Switch **reminder** or ordinary check-in never releases content; only the configured trigger does.
5. The 5-day email reminders and the separate 2FA reply-with-code check-in continue to work exactly according to their own rules.
6. A late check-in must not silently revoke content already released. Revocation must be explicit and audited.
7. Every attachment download, media range request, search result and direct API fetch re-evaluates the recipient's current authorisation and item permissions.
8. All access decisions and releases are recorded in an audit log, including denied attempts; no sensitive content or tokens in logs.
9. Require clear server-side access control, not merely client-side hiding.

**Important compatibility choice:** Preserve existing legacy Final Wishes data and existing beneficiary semantics until an audited migration is approved. New restricted items must be stored and served in a way that cannot leak through the original full-vault beneficiary serialization. Explicitly test that endpoint.

## 6. Data model and migrations

Implement additive SQLite migrations rather than re-creating the current database. Suggested tables; adapt naming to actual branch conventions:

| Table | Contents |
|---|---|
| `legacy_contents` | Owner ID, Final Wishes parent (optional), item type, title, encrypted Markdown/metadata, lifecycle status and release policy |
| `legacy_content_beneficiaries` | Content ID + existing beneficiary ID, grant scope, released timestamp and revoked timestamp |
| `legacy_content_attachments` | Content ID + managed-document ID, display order and description |
| `legacy_content_links` | Links to existing vault entries, contacts, properties and vehicles |
| `legacy_content_versions` | Previous revisions and editor/time, with appropriate encrypted storage and retention |
| `legacy_content_reviews` | Review history, reminders, next date and completion status |
| `legacy_release_events` | Immutable/append-only logical release, notification and access-audit references |

Use foreign keys and user-scoped queries; never allow one vault user to access another's content. Use unguessable public identifiers where appropriate. Beneficiary associations reference the existing `beneficiaries.id`; do not create a second token or identity system.

Preserve the current `vault_entries` and `final_wishes` data schema. The new records are linked to the existing Final Wishes section and rendered there, while permission-sensitive payloads use the new access-controlled routes rather than the legacy unfiltered vault export.

## 7. Storage, security and backup

- Reuse `/srv/data/files/legacy-vault-managed-documents` as the managed storage root, with application-controlled storage locations, restrictive permissions and no external symlinks/bind mounts.
- Uploaded media is **copied**, not referenced in-place from `/home/wolf/Documents` or other existing directories.
- Maintain ownership and permissions for the `wolf` systemd service account; filesystem folders `0700` and files `0600` where applicable.
- Store textual personal content encrypted at rest. **Audit whether binary managed documents are presently encrypted**: ordinary files in the current design may be plaintext. Do not describe them as encrypted unless implemented and verified.
- Provide backup and restore for database, encrypted metadata, media files, encryption keys and configuration. Verify recovery using a disposable restoration environment.
- Handle abandoned uploads, orphan files, duplicate operations, quota exhaustion, corrupt media and interrupted saves safely. Unlinking does not erase the original selected file.
- Prevent ZIP/filename traversal, media XSS, arbitrary path access, upload MIME spoofing, and leaks through public thumbnails or search.
- Keep `.env`, `data/.secrets`, real personal content and backups out of GitHub.

## 8. Integration with the current application

**Existing Beneficiaries:** add recipient-linked legacy information and release-status views inside each beneficiary's record; keep their existing name, contact details, waiting period, tokens, grants, revocation and emergency access.

**Existing Final Wishes:** add the content groups and embedded managed attachments; reuse standard form styling, document viewer and Markdown renderer.

**Existing HomeBank:** leave its read-only synchronisation, accounts and reporting untouched.

**Existing email integration:** reuse SMTP/outbox for review and content-availability notifications; do not treat them as owner check-in replies. Do not send the actual letters, recordings or other confidential material by email.

**Existing Dead Man's Switch:** existing expiry logic remains authoritative; item-level release occurs only after the corresponding access event is verified. The new feature must not change the 5 daily pre-release emails or the two-factor reply confirmation rules.

## 9. Proposed API contracts

Final endpoints should follow existing conventions, but must support the following operations:

```text
GET    /api/final-wishes/legacy?type=&status=&beneficiary_id=
POST   /api/final-wishes/legacy
GET    /api/final-wishes/legacy/:id
PATCH  /api/final-wishes/legacy/:id
DELETE /api/final-wishes/legacy/:id
POST   /api/final-wishes/legacy/:id/attachments
DELETE /api/final-wishes/legacy/:id/attachments/:attachmentId
GET    /api/final-wishes/legacy/:id/attachments/:attachmentId/content
PUT    /api/final-wishes/legacy/:id/beneficiaries
POST   /api/final-wishes/legacy/:id/release
POST   /api/final-wishes/legacy/:id/review
GET    /api/final-wishes/reviews/due
GET    /api/beneficiaries/:id/legacy          # owner-only management
GET    /api/beneficiary-access/legacy          # token-authenticated, release-filtered
```

The last route must use the existing token-authentication mechanism, including token expiration and revocation, and must not trust any recipient ID supplied by a beneficiary. Media endpoints must have a corresponding authorised beneficiary-access path; do not expose raw filesystem paths.

## 10. Implementation plan

1. Finish and commit the current email/2FA development work; branch from the tested Wolf's Legacy baseline.
2. Audit all current beneficiary access and Final Wishes code; document actual schema and potential information leaks.
3. Design item-level permissions, migration, lifecycle and content models; write negative authorisation tests first.
4. Implement new typed records within the Final Wishes domain and beneficiary associations using existing IDs.
5. Add Markdown letters, safe previews and version history.
6. Extend managed attachments for audio/video playback, range support and reliable file handling.
7. Add Family History and Personal Instructions content views within Final Wishes.
8. Add per-item reviews and scheduled reminders through the reliable email system.
9. Add recipient-specific content lists inside existing Beneficiaries, and release-filtered read-only access for token holders.
10. Verify backup/restore, data migration, permissions, audit trails, existing HomeBank, email, Dead Man's Switch and document workflows.
11. Update README with Fedora/systemd deployment, port 4444, storage expectations, settings, migration and recovery; open a PR for review before merging.

## 11. Mandatory acceptance tests

- Draft letters, private family photographs and unreleased recordings are not available using **any** beneficiary token, endpoint, search or download URL.
- Beneficiary A cannot read Beneficiary B's letter or media even when A has general vault access.
- Release conditions are distinct: manual release, emergency grant and Dead Man's Switch trigger produce correct outcomes.
- A valid but expired/revoked token cannot access already released content.
- Adding or deleting a beneficiary does not destroy the owner's personal letters or shared family archive files.
- Multiple beneficiaries can be assigned to the same record without duplicating the file.
- Uploading new media leaves the originating file unchanged; deleting or unlinking an attachment never deletes the original.
- PDF and image preview, audio/video playback and downloads enforce item-level authorisation for every request.
- Unsafe Markdown/HTML cannot execute scripts or embed remote tracking pixels.
- Family histories can contain uncertain dates and be searched by people, tags and date ranges.
- Instruction checklist acknowledgements never alter the owner's canonical instructions.
- Review reminders are correctly scheduled and deduplicated; reviewing an item does **not** check in to the Dead Man's Switch.
- Existing 5 daily expiry reminders and two-factor email reply check-in are unaffected.
- Existing `Final Wishes` category, details and contact fields retain their data after migration.
- The old full-vault beneficiary serializer never exposes unreleased new content.
- Backup and restore preserve beneficiary mappings, release history, media and revisions.
- Fedora systemd service starts, routes function on port 4444, and HomeBank remains functional.

## 12. Developer deliverables

- **Audit report** of current Beneficiaries, Final Wishes, document store and beneficiary response exposure.
- **Database migrations** with rollback/recovery instructions and sample-data tests.
- **Implemented backend/frontend** extending only the existing Beneficiaries and Final Wishes sections (no separate top-level Personal Legacy section).
- **Automated security and integration tests**, covering positive and negative access paths.
- **Updated README** for Fedora/Node.js/systemd and managed-media backup.
- **GitHub pull request** with a migration summary, screenshots, risks, testing evidence and a deployment checklist.

**Release gate:** No new letters, recordings, archive material or instructions may become visible to a beneficiary unless both the beneficiary and the item are explicitly authorised and the requested release condition has occurred.
