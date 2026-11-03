# HomeBank classifications and vault forms

The saved HomeBank account **group** and **type** now drive existing linked vault records and their source-managed form fields. Saving a HomeBank file refreshes classifications through the normal watcher/read path. Snapshot version 3 includes each account's group ID/name and reparses older snapshots even when the source file has not changed.

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

Unlinked manual records and other owners are unaffected. Closed/excluded/removed source accounts retain the existing visibility rules; missing or deleted vault records are never recreated by refresh. Missing or corrupt snapshots cannot justify clearing owner-entered loan/mortgage details. The source `.xhb` files are read only.

Obsolete edit links open the current form. If classification changes while an owner is typing, the draft and queued files remain in place with an explanatory notice; saving maps the draft into the current category. Older form submissions and backups also use the canonical classification, preventing a stale page or restore from putting the record back in an outdated section.

Verification on 29 October 2026: **238 Node tests and 7 Python tests pass**, with **139 synthetic browser checks** in Chromium at 390/820/1440px and WebKit at 390px. [Screenshots and browser evidence](screenshots/homebank-alignment/README.md) contain no real financial records. A private disposable copy of the current vault also passed source-to-form alignment, unchanged identity/document/manual-record checks, and a second reconciliation with zero changes. Personal files, account names, numbers, balances, keys and private audit reports are excluded from Git. Physical device testing remains pending.

## Applied deployment

Deployment completed on **30 October 2026 at 09:37 SAST** after Fedora administrator authentication. Runtime revision `b54dcc91d8b07c90df84664fbfec8d3806f56735` passes loopback/hostname health checks and authenticated vault API verification. The live source snapshot uses version 3 and all visible linked records have matching form controls. A repeat reconciliation produces zero changes.

Live checks confirm preservation of record identity, titles, timestamps, document associations and manual records. Configuration and key fingerprints are unchanged, and the source HomeBank file is byte-for-byte unchanged across cutover. No database restore or schema migration was performed. A complete stopped snapshot, source archive and private verification records are at `/home/wolf/backups/wolfs-legacy/pre-homebank-alignment-20261029T162452Z/`. Later documentation or asset-only commits preserve the deployed application code.
