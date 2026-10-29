# Wolf's Vault branding

The application name is **Wolf's Vault**. This includes the browser title, login and sidebar, mobile header, onboarding, beneficiary portal, printable exports, downloaded backup/export filenames, notification sender and templates, package metadata, container labels, documentation and synthetic example screenshots. The mobile header uses a typographic apostrophe for the same name.

New prepared-email check-ins use the current name in their fixed subject. The exact previous subject remains accepted for already-sent reminders, with the same verified sender, reply mailbox, bound unused challenge and expiry checks. New email content uses only the current name.

The repository and service names, configured document directories, storage exclusion rules, database/API identifiers and existing browser session/theme keys retain their working values. Renaming the application does not relocate personal files, change credentials or alter access/release rules. Provenance links and the original MIT copyright notice remain intact.

Verification on 29 October 2026: **202 Node tests and 4 Python tests pass**, including the existing phone/tablet Firefox workflows and new previous-subject compatibility checks. CSS and the database/storage/cryptography implementations are unchanged. The updated screenshots use synthetic records rather than the live vault. Historical mobile-layout reports retain their original measurements; their sample PNGs are refreshed separately to display the current name.

## Applied deployment

The running app at `http://asus.local:4444` was updated on **29 October 2026 at 15:16 SAST** from `edf23cbfcd3c24656bfc57bff2992ce34555796f` to `a47de78185d4af3333d1f7b6da52f4ffc0122c19`. The service was stopped through Fedora administrator authentication, a fresh complete snapshot verified database integrity/decryption and managed-file hashes, and the service restarted successfully with PID `3015476`. No database restore or migration was performed.

Loopback and hostname health checks pass. Served HTML, app/mobile JavaScript and existing desktop/mobile CSS match the new source byte for byte. Configuration and matching secret-file fingerprints are unchanged, and the runtime checkout is clean. Clients should refresh to load the updated branding.

Private rollback source, the complete stopped snapshot, effective unit and verification record are at `/home/wolf/backups/wolfs-legacy/pre-vault-brand-20261029T131535Z/`. Keep these outside Git; do not restore an older database solely to revert branding. Subsequent documentation commits do not change the runtime source revision above. [PR #4](https://github.com/Owewolf/wolfs-legacy/pull/4) contains the changes.
