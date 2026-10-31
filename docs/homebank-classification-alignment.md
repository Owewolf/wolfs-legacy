# HomeBank classifications and vault forms

The saved HomeBank account **group** and **type** drive linked vault records and their source-managed form fields. Once a source is connected, sync also creates missing active account cards and checks for newly added source accounts. Saving a HomeBank file refreshes classifications through the normal watcher/read path. Snapshot version 3 includes each account's group ID/name and reparses older snapshots even when the source file has not changed.

| Source classification | Vault allocation / field |
| --- | --- |
| Explicit Retirement Annuity group | Retirement Accounts; Account Type = Annuity |
| Explicit Pension / Provident Fund group | Retirement Accounts; matching product type |
| Checking / Savings / Bank / Cash | Corresponding bank account type; existing purposeful investment/retirement allocations are retained for generic Bank/Savings without a recognized purpose group |
| Credit card / Liability | Debts & Liabilities; credit cards use the Credit Card subtype |
| Asset in Vehicles / Real Estate | Current Value; owner-entered loan/mortgage values stay separate |
| Explicit finance on a historical vehicle/property placement | Loan Balance / Outstanding Mortgage, with the normal reconciliation moving credit/liability records into Debts |
| Other ownership/personal groups | Display the exact group without inferring legal ownership or a new investment purpose |

Source institution, account number and website populate the corresponding bank, investment, retirement or debt controls where supported. Custodian metadata does not establish a vehicle or property lender. Values keep their source currency/sign. Transaction expense categories and balance signs never decide which asset or account form to use. These distinctions follow the official [account properties](https://www.gethomebank.org/help/dlg-acco.html) and [account types](https://www.gethomebank.org/help/00-lexicon.html#acctype).

Reallocation updates existing linked records transactionally, retaining record IDs, titles, timestamps, attachments and owner details. Bank/investment institution and website fields move to their retirement equivalents; nominees move to the retirement beneficiary control. The previous product subtype is retained as Underlying Account / Investment Type. Conflicting owner values and otherwise undisplayed fields are preserved. Current source classifications and generated ledger values remain read-time fields rather than duplicated saved amounts.

Unlinked manual records and other owners are unaffected. Closed/excluded/removed source accounts retain the existing visibility rules; missing cards for active, included source accounts are created once and reused on later syncs. A deleted linked card can return on sync while its source account remains active; closing or excluding it in HomeBank hides it from the vault. Missing or corrupt snapshots cannot justify clearing owner-entered loan/mortgage details. The source `.xhb` files are read only.

Obsolete edit links open the current form. If classification changes while an owner is typing, the draft and queued files remain in place with an explanatory notice; saving maps the draft into the current category. Older form submissions and backups also use the canonical classification, preventing a stale page or restore from putting the record back in an outdated section.

Verification on 29 October 2026: **238 Node tests and 7 Python tests pass**, with **139 synthetic browser checks** in Chromium at 390/820/1440px and WebKit at 390px. [Screenshots and browser evidence](screenshots/homebank-alignment/README.md) contain no real financial records. A private disposable copy of the current vault also passed source-to-form alignment, unchanged identity/document/manual-record checks, and a second reconciliation with zero changes. Personal files, account names, numbers, balances, keys and private audit reports are excluded from Git. Physical device testing remains pending.

## Applied deployment

Deployment completed on **30 October 2026 at 09:37 SAST** after Fedora administrator authentication. Runtime revision `b54dcc91d8b07c90df84664fbfec8d3806f56735` passes loopback/hostname health checks and authenticated vault API verification. The live source snapshot uses version 3 and all visible linked records have matching form controls. A repeat reconciliation produces zero changes.

Live checks confirm preservation of record identity, titles, timestamps, document associations and manual records. Configuration and key fingerprints are unchanged, and the source HomeBank file is byte-for-byte unchanged across cutover. No database restore or schema migration was performed. A complete stopped snapshot, source archive and private verification records are at `/home/wolf/backups/wolfs-legacy/pre-homebank-alignment-20261029T162452Z/`. Later documentation or asset-only commits preserve the deployed application code.

## Connected-file account sync

Use HomeBank source settings to connect the saved file/folder with **Save and
sync**. A fresh default-folder discovery does not create cards until that source
is connected. Existing saved source configurations remain connected for
compatibility. After connection, Refresh now, background sync and ordinary vault
reads create any missing open, included accounts and update existing links,
including when the saved file has not changed. Accounts are keyed by source ID
within the configured owner, so repeated or overlapping syncs do not add copies.

Recognized purpose groups select the corresponding vault section; credit and
liability accounts remain debts. New ungrouped Assets use the generic investment
asset form, and otherwise unclassified ledgers use Bank Accounts. Account names,
transaction categories and balance signs do not infer ownership, property type
or a lender. Existing purposeful placements and owner-entered information remain
preserved under the classification rules above.

New cards store their title, durable source ID and encrypted empty owner fields.
Balances, account numbers, institutions and source classifications stay projected
from the validated snapshot. Snapshot storage, existing-record alignment and new
card creation succeed together or roll back together. Invalid snapshots do not
partially create accounts. Closed and excluded accounts are skipped. HomeBank
source files are opened read-only.

The HomeBank page refreshes navigation counts after sync and ignores responses
that arrive after navigating away. No new import button or separate workflow is
required.

Current sync verification (31 October 2026): **291 JavaScript and 7 Python tests
pass**. Synthetic tests cover first connection, legacy saved connections,
unconnected default discovery across repeated reads, new accounts on later sync,
unchanged-file reconciliation, owner isolation, closed/excluded accounts,
transaction rollback and concurrent/repeated sync. Frontend tests cover counts
and navigation during pending responses. Chromium checks pass for 30 screens at
390/820/1440px and mobile workflows at 390px and 820px. All fixtures use invented
financial records; no external source file is modified by the tests.

## Connected-source deployment and allocation verification

The connected-file sync fix was activated on **31 October 2026 at 18:26 SAST**,
running revision `5107087e8f8daf1c7eff452fcdb9764891df0287`. Health checks and
authenticated live verification passed, with final page checks at 18:38 SAST.
All 23 active, included source accounts have unique linked vault cards. Repeated
syncs preserve those links and project the current source balances without
creating duplicates.

Six generic Asset accounts were restored to Vehicles and four to Real Estate
using their previous owner allocations. These source accounts have no recognized
purpose group, so their corrected existing sections remain authoritative on later
syncs. The correction changed only their section; record identities, owner fields,
notes, timestamps and document associations were retained. Source valuations use
Current Value, separately from any owner-entered loan or mortgage details.

The verified linked-card distribution is 8 Bank Accounts, 2 Debts & Liabilities,
4 Real Estate, 3 Retirement Accounts and 6 Vehicles. Manual records, beneficiaries
and other protected owner data remain intact, and the source HomeBank file is
byte-for-byte unchanged. Live Chromium checks show all six vehicle cards and four
property cards at 390px and 1440px without horizontal overflow or script errors.
The synthetic regression also checks vehicle placement through fresh and cached
syncs, preservation of owner loan details and attachments, and duplicate prevention.
Subsequent test/documentation commits do not change the deployed runtime code.
