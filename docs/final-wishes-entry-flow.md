# Final Wishes entries with recipients and content

Updated 31 October 2026.

The Final Wishes page has one **Add Final Wishes Entry** action. Its form combines
the wish title, category, details, contact person/phone and notes with recipients,
content type, written content, protected attachments, release policy and optional
information reviews. The former outer Add Content heading/action is removed.

Existing arrangements and protected entries appear in the same list. The page
has no All Final Wishes, Personal Letters, Audio & Video, Family History,
Personal Instructions or Information Reviews category buttons. Choose content
types inside Add Final Wishes Entry instead. Existing text/status search and
Edit/Documents/Delete handlers remain available; lifecycle status filters apply
to protected entries. Family dates remain on their cards. Dashboard and
navigation counts include active protected wishes.

## Privacy and compatibility

New recipient-specific entries use the existing protected Final Wishes API and
restricted document upload flow. They do not create a general vault entry or
ordinary document association, which could otherwise disclose a selected
person's wish to every beneficiary with general vault access.

Conventional wish fields are stored under encrypted `metadata.final_wishes`,
alongside the existing encrypted title, message and other metadata. Selected
beneficiaries, private draft defaults, ready/release confirmation, revocation,
revisions and review rules retain their existing behaviour. Editing released
content returns it to draft and clears its previous release as before.

Existing ordinary wishes, protected content, unknown metadata and optional parent
relationships are retained without migration. Their existing Edit/Open routes
still work. Older `section/final_wishes/new?type=…` links redirect to the unified
`add/final_wishes` form, and beneficiary shortcuts preselect the intended person.
Failed uploads retain the saved protected entry ID; retrying does not create a
second entry. Archiving from a detail view returns to the complete Final Wishes
list and refreshes its counts.

Use the Final Wishes page's search for protected wish content. General vault
search and ordinary entry JSON/print exports retain their existing scope and do
not include protected content. Recipient-specific wishes and their files require
the [complete recovery snapshot](legacy-recovery.md); Settings names this scope
explicitly. The original combined-entry change introduced no storage, backend,
permission or release migration.

## Beneficiary drafts and searchable recipients

The current change creates a private Final Wish draft automatically when an owner
adds a beneficiary. The draft title is exactly the **beneficiary name**, with
that beneficiary already selected as recipient and **Beneficiary Instructions**
selected as the wish category. That category appears on the card. Written content
and optional content type start blank. It uses the normal Final Wishes card
and form, with no Information Review section or schedule.
It uses the protected content store with `draft` status and the `owner_only`
release policy. Creating it grants no access, releases no content and sends no
message. At startup, existing beneficiaries without an assigned protected wish
receive the same draft. Existing wishes, including edited, released and archived
items, are retained; repeated startups do not create duplicates. The check runs
before the server accepts requests and shares the new-beneficiary creation
logic. Creating all missing drafts is transactional.

The beneficiary, encrypted wish, recipient mapping and creation audits are saved
in one transaction. A failure rolls the whole addition back, so retrying a failed
addition does not leave an orphaned beneficiary or wish. The existing beneficiary
response is retained with an added `final_wish_id` and `final_wish.id`.

The Final Wishes form now uses **Find a recipient** in place of the full
beneficiary checklist. Search matches names, roles or relationships, email
addresses and phone numbers across the owner's beneficiaries and saved contacts.
All saved, unselected beneficiaries and contacts are offered immediately,
including before any search text is entered. Typing filters that list; clearing
the search restores every available choice. Selected people appear as removable
entries. Keyboard navigation, live result
announcements and touch controls are supported.

Beneficiaries remain the authorised recipients for the existing release flow.
Contacts are named on the wish and explicitly labelled as having no vault access;
selecting a contact creates no beneficiary, token or access permission. Contact
names and IDs are stored within encrypted
`metadata.final_wishes.contact_recipients`. The server validates contact ownership
and type and uses the saved contact's name. Existing named-contact snapshots
remain when a contact is later removed, until the owner removes that recipient
from the wish.

**Related vault records** is removed from the Save Final Wish form. New wishes
start without these links; editing an existing wish preserves its saved links
and other unknown metadata. Existing linked-record displays and authorised
recipient access to those records retain their behaviour. No schema or release
policy migration is required.

### Plain wish form and saved recipient choices

New entries and beneficiary-created drafts open the normal wish form with no
optional content type selected. Beneficiary drafts use only that person's name
as the title, preselect their recipient and use **Beneficiary Instructions** as
the wish category. This choice is available in the normal wish category list,
and cards display the selected wish category. No instruction category, priority,
checklist or Information Review schedule is prefilled. Choose an optional content
type inside the form when needed. Existing explicit content types and existing
review schedules on authored entries retain their controls and saved values.

Startup updates only the original blank generated drafts with their old default
title and no authored content, files or record links. It retains each wish ID,
recipients, unknown metadata and historical records, changes the title to the
beneficiary name and disables review scheduling on these plain drafts. It does
not replace edited content, owner-written titles, archived or released wishes.
The empty optional selection lives in encrypted `metadata.final_wishes.content_type`;
no database schema change is needed. Repeated checks do not add copies or revisions.

The recipient picker offers every saved, unselected beneficiary and contact
before typing, on focus and after clearing a search. Names, roles/relationships,
email addresses and phone numbers filter those choices. Selected people remain
visible and removable, and named contacts receive no access permission.

Verification: 263 JavaScript and 7 Python tests pass. Firefox covers 61 editor
checks and 71 mobile workflow checks at each of 390px and 820px. Chromium covers
30 screens at 390/820/1440px and 72 workflow checks at each mobile/tablet width; WebKitGTK covers ten screens
and 71 workflow checks at 390px. Tests include in-place upgrades, review-history
preservation, schedule removal, unchanged authored content, idempotency, rollback,
blank normal forms, preselected recipients and all saved search choices.

### Existing-beneficiary repair

Startup now uses the same draft-creation helper as Add Beneficiary. It creates a
wish only when the beneficiary has no assigned protected content belonging to
that owner. Existing wishes of every status count, so edited, released and
archived items are never replaced. Immediate SQLite transactions serialize
concurrent checks and roll back every new draft/event/audit if any creation fails.
Normal list requests remain read-only. No schema change is required.

Verification: 258 JavaScript and 7 Python tests pass. The production-entrypoint
integration starts with an existing beneficiary without a wish, confirms the
automatic draft appears in the owner API, adds a new beneficiary, edits both
wishes and restarts again. IDs, edits and revisions persist without duplicates.
Separate tests cover concurrent checks, owner isolation, encryption, and rollback.
Synthetic Chromium checks at 390px and 1440px confirm both kinds of draft appear
in Final Wishes and can be opened and saved on their existing IDs.

### Existing-beneficiary deployment

Verified on **31 October 2026 at 15:33:08 SAST** at
`http://asus.local:4444`. Runtime revision
`9a49dabfa8e847f7a519c4ccf88b55c127b8152d` follows
`db138b931f13f4c98b432542d908522d7acad6a0`.

The stopped complete snapshot passed integrity, foreign-key, encryption and
managed-file checks. After restart, all **three existing beneficiaries** have a
private, owner-editable Final Wish, with no beneficiary left without one. The
owner API projection can read all three, each with the intended person selected,
empty content, draft status and owner-only release policy. The original
beneficiaries and tokens were retained. Existing database rows, keys and
configuration match their earlier fingerprints; only the new wishes, recipient
mappings and creation events/audits were added by the repair.

Service `wolfs-legacy.service` is active/running with PID `412144`, started at
15:32:38 SAST. Loopback and hostname health, served asset bytes and unauthenticated
API denial checks pass. No test beneficiaries, releases or notifications were
created during live verification. New-beneficiary creation and repeated startup
behaviour were verified through the isolated production-entrypoint test.

The previous source archive, complete snapshot and private verification records
are retained at
`/home/wolf/backups/wolfs-legacy/pre-existing-beneficiary-wishes-20261031T133101Z/`.
Refresh the Final Wishes page to see the new drafts. Later documentation commits
do not change runtime sources.

### Recipient picker verification

- Full suite: 250 JavaScript and 7 Python tests passed.
- Firefox: 51 desktop checks passed, plus 66 workflow checks at each of 390px
  and 820px.
- Chromium: 30 screen captures at 390/820/1440px, plus 67 workflow checks
  at each mobile/tablet width. WebKitGTK: ten captures and 66 workflow checks
  at 390px. Recipient search and selection fit the phone and desktop; remove
  buttons meet 44px touch targets.
- Integration checks cover automatic draft creation, encryption, owner isolation,
  private access, validation and rollback when wish creation or either creation
  audit fails. Contact checks cover owner/type validation, canonical names,
  named-only access and retention of existing snapshots.
- Browser checks cover searching and choosing contacts and beneficiaries,
  keyboard navigation, removing recipients, existing recipient shortcuts, and
  preserving saved links while hiding the related-record selector.

These checks use synthetic local fixtures. Production wishes were not created
or released during verification.

### Beneficiary draft deployment

Verified on **31 October 2026 at 15:25:00 SAST** at
`http://asus.local:4444`. Runtime revision
`bfadc40cee32974b5f75eb4ac999f7afd4a9dd3e` follows
`2dafe410c31f963922d2e03633497515c25829ff`. The service was stopped for a complete
snapshot and restarted to load the backend changes. It is active/running with
PID `398911`, started at 15:24:31 SAST.

The complete snapshot passed SQLite integrity/foreign-key checks, encrypted
value authentication and managed-file checksum verification. Before/after
fingerprints confirm existing users, beneficiaries/tokens, vault entries,
protected wishes, revisions, recipient mappings, saved links, managed-document
records, keys and configuration are unchanged. No existing beneficiary backfill
or schema migration was introduced.

Both loopback and the hostname return healthy status; HTML, app/legacy/section
scripts and legacy CSS match the source byte for byte. Unauthenticated vault,
wish and beneficiary endpoints return 401. Live Chromium login checks at 390px
and 1440px pass without horizontal overflow or script errors.

The previous complete source archive, stopped snapshot and private verification
records are retained at
`/home/wolf/backups/wolfs-legacy/pre-beneficiary-wish-recipients-20261031T132344Z/`.
Refresh existing browsers to load the new picker. Later documentation commits
do not change runtime assets. The records below describe earlier deployments.

## Original combined-entry verification

- Full suite: 239 JavaScript and 7 Python tests passed, with no failures/skips.
- Firefox: combined creation, recipient selection, wish metadata, existing
  arrangements, release/revoke, recipient preview, old links and protected media
  passed; mobile workflows passed at 390px and 820px.
- Chromium: ten screens fit at 320, 390, 820 and 1440px, plus phone/tablet end-to-end
  workflows. WebKitGTK: ten screens and the 390px workflow passed.
- A server integration test verifies encrypted wish metadata, draft denial,
  assigned-recipient access after confirmed release, unassigned-recipient denial,
  and exclusion from general vault/beneficiary exports.
- Screenshot data is invented. Production wishes were not created or released
  during verification. Native devices and screen-reader applications were not run.

[Screenshots](screenshots/final-wishes-entry/README.md)

## Applied deployment

Verified on **31 October 2026 at 15:00:16 SAST** at
`http://asus.local:4444`. Runtime revision `94f93f3f6aeffbd592b2460d50e7c1833f4d0dbf`
follows `5878bd70fd8834e12eacc7dd7e03f907515f1cb2`. HTML and app/legacy/section scripts
match the source byte for byte through loopback and the hostname; health returns
`ok`, unauthenticated vault access returns 401, and the service remains
active/running with PID `2005`.

Express serves these frontend files directly, so no restart, backend update,
database operation or migration was needed. Refresh existing browsers to load
the combined form. The previous public source archive and private verification
record are retained at `/home/wolf/backups/wolfs-legacy/pre-final-wishes-entry-20261031T130016Z/`. This is a source-only rollback archive,
not a database backup. Later documentation commits do not change runtime assets.

### Category button removal

Verified on **31 October 2026 at 15:11:21 SAST**: all six category
buttons are removed from the list. The Add Final Wishes Entry form retains
Personal Letters, Audio & Video Messages, Family History, Personal Instructions
and Information Reviews. Existing search, status, recipient, file and release
controls remain available.

Firefox desktop/phone/tablet interaction tests pass. Chromium covers 30 screen
captures at 390/820/1440px plus 60 workflow checks at each mobile/tablet width;
WebKitGTK covers ten screens plus 59 workflow checks at 390px. Updated list
screenshots show the category-free page. Live health and script-byte checks
pass through loopback and the hostname, with the service still active and no
restart. Private rollback source and verification: `/home/wolf/backups/wolfs-legacy/pre-final-wishes-buttons-20261031T131121Z/`.
