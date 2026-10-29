# Wolf's Vault

An independent private development repository based on [slavhate/legacy-vault](https://github.com/slavhate/legacy-vault) (MIT License), maintained for Owen Wolf. Base commit: `dca6f305c534207155b772734d47a6b1288fd3a1`.

## Development branch

`feature/homebank-managed-documents`

## Added features

1. **Managed documents:** on each vault record, drag in files or choose multiple files, save a *copy* to `/srv/data/files/legacy-vault-managed-documents`, preview PDFs/images and download documents. Original source files are never moved or deleted. Shared document associations and read-only beneficiary file access are supported through authenticated endpoints.
2. **HomeBank (read-only):** monitor `/home/wolf/Documents/Money` for saved `.xhb` files; change directory/file from the HomeBank page within `/home/wolf/Documents`. A new snapshot is read after save changes, without modifying HomeBank. Default dashboard displays open accounts included in HomeBank's summary, grouped by the original HomeBank account type. Open accounts excluded from HomeBank's summary may be toggled on; closed accounts stay hidden.
3. **HomeBank-linked vault entries:** imported records retain their source account ID independently of editable titles and notes. Vault views, counts, search, exports, application backups, beneficiary views and linked documents always use the initial HomeBank filters: the account must still exist, be open, and be included in the HomeBank summary. Closing, excluding or removing an account in the next valid HomeBank snapshot hides its vault record without deleting stored details or documents. Manual vault entries are unaffected. HomeBank refreshes never recreate a deleted vault entry. Backup/restore preserves source links.
   Linked balances are derived from the current validated HomeBank snapshot on every read, rather than copied into vault records. Vehicles use Loan Balance, properties use Current Value, bank accounts use Approximate Balance, investments/retirement use Approximate Value, and debts use Outstanding Amount. Source signs and currencies are preserved. Imported notes are empty. Supported institution/account metadata populates the appropriate fields; vehicle or property lenders require explicit source details. Vault reads check for a saved source change, and open vault views refresh every 20 seconds without overwriting owner edits. Saving or restoring a record strips generated balances and notes; startup removes earlier copied values while retaining the source link and other details.
4. **Safety:** paths and filenames never exposed as unauthenticated static files; HomeBank snapshots are encrypted in SQLite. Do not add `.xhb` or private user documents to Git. Keep `.env`, `data/` and managed document folders outside Git.

## Deployment assumptions

- Ubuntu/Fedora/Ultramarine; Node.js 20+ and Python 3 required.
- Service name: `wolfs-legacy.service`, port `4444`.
- Runtime checkout: `/home/wolf/Projects/wolfs-legacy`.
- Managed files: `/srv/data/files/legacy-vault-managed-documents`.
- HomeBank reads only, from `/home/wolf/Documents/Money` (configurable in the UI).
- The financial numbers are based on HomeBank XML and HomeBank's transaction-status rules; **they are not independently verified bank balances**.
- A source file must be fully saved before reflected in Wolf's Vault. Source monitor polls every 20 seconds and retains the last valid snapshot on parse errors.

## Initial reference file checks (performed 25 October 2026)

The supplied sample contained 38 accounts, 21,541 transactions, 4 closed accounts and 9 open accounts excluded from HomeBank summary. The default dashboard therefore displays 25 accounts; choosing "Include excluded" displays 34 open accounts. The actual sample `.xhb` and derived data are **not** part of this repository.

## Build from GitHub

```bash
git clone --branch feature/homebank-managed-documents https://github.com/Owewolf/wolfs-legacy.git /home/wolf/Projects/wolfs-legacy
cd /home/wolf/Projects/wolfs-legacy
cp .env.example .env
# edit .env and confirm the storage path and secrets before launching
npm install
python3 -m unittest discover -s tests -p test_homebank_parser.py
node tests/document-store.test.js
node --test tests/homebank-vault-visibility.test.js
node --test tests/homebank-vault-cleanup.test.js tests/homebank-service.test.js tests/homebank-vault-live.test.js
bash scripts/setup-systemd.sh --check
bash scripts/setup-systemd.sh > /tmp/wolfs-legacy.service
# Review the generated unit, configuration and acceptance evidence first.
# Installation (does not enable or start the service):
sudo bash scripts/setup-systemd.sh --install --user wolf --node "$(command -v node)"
```

For an existing installation, **stop the service and back up `data/`, `.env` and managed documents externally before changing code**. Retain the previous checkout and unit until acceptance passes. If the old `legacy-vault.service` exists, stop and disable it during the reviewed cutover so two processes cannot use the same database or port. The setup script resolves the current checkout and Node executable and refuses to overwrite an existing unit. Review local unit restrictions when updating an installation.

Email deployment, owner verification, independent offline code provisioning, restore quarantine and rollback are documented in [Email operations](docs/email-operations.md). Email remains opt-in and real-provider acceptance must be recorded before enabling it for routine use.

## Limitations / further development

- HomeBank account totals use status, reminder, date, and pending-transaction rules parsed from `.xhb`; independently compare reconciled/cleared/today/future amounts to HomeBank before relying on reports.
- The recent transaction view shows up to **100 transactions per account**, not a complete searchable ledger. The full source file remains authoritative.
- HomeBank API is restricted to the account named in `HOMEBANK_OWNER_EMAIL` in `.env` (mandatory). HomeBank snapshots do not grant beneficiaries access automatically; this requires an explicit permissions design later.
- Do not serve this app openly over HTTP on the internet: provide HTTPS and authentication over a trusted network/VPN.
- Full security audit and end-to-end tests with actual local HomeBank/Node environment are still required.
