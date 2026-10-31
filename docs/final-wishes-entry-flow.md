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
adds a beneficiary. The draft is titled **Final Wishes for {beneficiary name}**,
starts with empty wish details and content, and has that beneficiary selected.
It uses the protected content store with `draft` status and the `owner_only`
release policy. Creating it grants no access, releases no content and sends no
message. Existing beneficiaries are not backfilled.

The beneficiary, encrypted wish, recipient mapping and creation audits are saved
in one transaction. A failure rolls the whole addition back, so retrying a failed
addition does not leave an orphaned beneficiary or wish. The existing beneficiary
response is retained with an added `final_wish_id` and `final_wish.id`.

The Final Wishes form now uses **Find a recipient** in place of the full
beneficiary checklist. Search matches names, roles or relationships, email
addresses and phone numbers across the owner's beneficiaries and saved contacts.
Selected people appear as removable entries. Keyboard navigation, live result
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

### Current verification

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

These checks use synthetic local fixtures. This section records the current
implementation and does not record a live deployment. The deployments below
describe the earlier combined-entry and category-button changes.

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
