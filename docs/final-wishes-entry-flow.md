# Final Wishes entries with recipients and content

Updated 31 October 2026.

The Final Wishes page has one **Add Final Wishes Entry** action. Its form combines
the wish title, category, details, contact person/phone and notes with recipients,
content type, written content, protected attachments, release policy and optional
information reviews. The former outer Add Content heading/action is removed.

Existing arrangements and protected entries appear in the same list. The type,
status and text controls filter that list; ordinary arrangements appear in All
Final Wishes and text search, while lifecycle statuses apply to protected
entries. Existing Edit/Documents/Delete handlers on arrangements remain intact.
Dashboard and navigation counts include active protected wishes.

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
explicitly. No storage, backend, permission or release migration was introduced.

## Verification

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
