# Pet Care

Open **Pet Care** from the dashboard or navigation menu and select **Add Entry**. Create one entry per pet, with a recognizable title. The section stores pet identity and microchip details, vet contacts, feeding and medication needs, daily care instructions, the preferred carer's contact details and a rehoming plan. Attach existing documents or copy selected files through the normal document controls.

Entries use the existing encrypted vault fields and notes, owner authentication, search, printable export, JSON backup/restore and read-only beneficiary access. Like other ordinary vault entries, Pet Care is visible to beneficiaries only after their existing vault access is granted. It has no separate protected-content release policy.

The [upstream feature list](https://github.com/slavhate/legacy-vault#features) mentions Pet Care, but the [section definitions](https://github.com/slavhate/legacy-vault/blob/main/public/js/sections.js) and [server allowlist](https://github.com/slavhate/legacy-vault/blob/main/server/validate.js) inspected on 29 October 2026 omit a dedicated section. This implementation adds `pet_care` to those two registries and reuses Wolf's Vault's existing desktop and mobile layouts. No database schema change is required. Existing Pet Care entries filed under Final Wishes remain there and are not moved or duplicated.

Validation: **207 Node tests and 4 Python tests pass**. New isolated API checks cover saving/editing, encryption, owner isolation, search, export/backup/restore and beneficiary waiting/grant/revoke behavior. [Synthetic browser evidence](screenshots/pet-care/README.md) covers Chromium at 390px, 820px and 1440px, plus phone WebKit, with 94 checks across the workflows. Physical iOS/Android device testing remains pending.
