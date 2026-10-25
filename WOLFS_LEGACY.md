# Wolf's Legacy

An independent private development repository based on [slavhate/legacy-vault](https://github.com/slavhate/legacy-vault) (MIT License), maintained for Owen Wolf. Base commit: `dca6f305c534207155b772734d47a6b1288fd3a1`.

## Development branch

`feature/homebank-managed-documents`

## Added features

1. **Managed documents:** on each vault record, drag in files or choose multiple files, save a *copy* to `/srv/data/files/legacy-vault-managed-documents`, preview PDFs/images and download documents. Original source files are never moved or deleted. Shared document associations and read-only beneficiary file access are supported through authenticated endpoints.
2. **HomeBank (read-only):** monitor `/home/wolf/Documents/Money` for saved `.xhb` files; change directory/file from the HomeBank page within `/home/wolf/Documents`. A new snapshot is read after save changes, without modifying HomeBank. Default dashboard displays open accounts included in HomeBank's summary, grouped by the original HomeBank account type. Open accounts excluded from HomeBank's summary may be toggled on; closed accounts stay hidden.
3. **Safety:** paths and filenames never exposed as unauthenticated static files; HomeBank snapshots are encrypted in SQLite. Do not add `.xhb` or private user documents to Git. Keep `.env`, `data/` and managed document folders outside Git.

## Deployment assumptions

- Ubuntu/Fedora/Ultramarine; Node.js 20+ and Python 3 required.
- Service name: `legacy-vault.service`, port `4444`.
- Runtime checkout: `/home/wolf/Projects/legacy-vault`.
- Managed files: `/srv/data/files/legacy-vault-managed-documents`.
- HomeBank reads only, from `/home/wolf/Documents/Money` (configurable in the UI).
- The financial numbers are based on HomeBank XML and HomeBank's transaction-status rules; **they are not independently verified bank balances**.
- A source file must be fully saved before reflected in Legacy Vault. Source monitor polls every 20 seconds and retains the last valid snapshot on parse errors.

## Initial reference file checks (performed 25 October 2026)

The supplied sample contained 38 accounts, 21,541 transactions, 4 closed accounts and 9 open accounts excluded from HomeBank summary. The default dashboard therefore displays 25 accounts; choosing "Include excluded" displays 34 open accounts. The actual sample `.xhb` and derived data are **not** part of this repository.

## Build from GitHub

```bash
git clone --branch feature/homebank-managed-documents https://github.com/Owewolf/wolfs-legacy.git /home/wolf/Projects/legacy-vault
cd /home/wolf/Projects/legacy-vault
cp .env.example .env
# edit .env and confirm the storage path and secrets before launching
npm install
python3 -m unittest discover -s tests -p test_homebank_parser.py
node tests/document-store.test.js
bash scripts/setup-systemd.sh
```

For an existing installation, **stop the service, back up `data/` and `.env` and any managed documents externally, then rename the old app directory before cloning**. Do not delete old data or rely on renaming as a backup. The existing systemd setup script will point to the checkout above.

## Limitations / further development

- HomeBank account totals use status, reminder, date, and pending-transaction rules parsed from `.xhb`; independently compare reconciled/cleared/today/future amounts to HomeBank before relying on reports.
- The recent transaction view shows up to **100 transactions per account**, not a complete searchable ledger. The full source file remains authoritative.
- HomeBank API is restricted to the account named in `HOMEBANK_OWNER_EMAIL` in `.env` (mandatory). HomeBank snapshots do not grant beneficiaries access automatically; this requires an explicit permissions design later.
- Do not serve this app openly over HTTP on the internet: provide HTTPS and authentication over a trusted network/VPN.
- Full security audit and end-to-end tests with actual local HomeBank/Node environment are still required.
