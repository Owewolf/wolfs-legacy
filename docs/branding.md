# Wolf's Vault branding

The application name is **Wolf's Vault**. This includes the browser title, login and sidebar, mobile header, onboarding, beneficiary portal, printable exports, downloaded backup/export filenames, notification sender and templates, package metadata, container labels, documentation and synthetic example screenshots. The mobile header uses a typographic apostrophe for the same name.

New prepared-email check-ins use the current name in their fixed subject. The exact previous subject remains accepted for already-sent reminders, with the same verified sender, reply mailbox, bound unused challenge and expiry checks. New email content uses only the current name.

The repository and service names, configured document directories, storage exclusion rules, database/API identifiers and existing browser session/theme keys retain their working values. Renaming the application does not relocate personal files, change credentials or alter access/release rules. Provenance links and the original MIT copyright notice remain intact.

Verification on 29 October 2026: **202 Node tests and 4 Python tests pass**, including the existing phone/tablet Firefox workflows and new previous-subject compatibility checks. CSS and the database/storage/cryptography implementations are unchanged. The updated screenshots use synthetic records rather than the live vault. Historical mobile-layout reports retain their original measurements; their sample PNGs are refreshed separately to display the current name.

## Browser bookmarks and home-screen icons

Browser tabs and bookmarks use `/favicon.png`, copied unchanged from `Wolfs-Legacy-Icon-Package/brand/favicon.png` (256 × 256). iPhone/iPad home-screen bookmarks and Android shortcuts use `/apple-touch-icon.png`, copied unchanged from the full square `brand/app-icon-primary-1024.png` (1024 × 1024). Both assets are served from `public/`; the source brand folder is not exposed by the server. Keep these public copies in sync when changing the supplied artwork.

The page links the favicon, Apple touch icon, and `/site.webmanifest`. The manifest uses the name **Wolf's Vault**, opens `/`, and keeps the normal browser display. The icon has purpose `any`, allowing the platform to fit the complete artwork into its shortcut shape. The supplied artwork is not marked `maskable`, which could crop its outer details. [Apple's touch-icon guidance](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html) allows larger icons to be scaled down; [Google's manifest guidance](https://web.dev/learn/pwa/web-app-manifest) describes icon sizes and purposes.

Open `http://asus.local:4444` and refresh before saving a bookmark or choosing **Add to Home Screen**. Existing bookmarks or shortcuts may retain a cached icon; remove and recreate them to pick up the new artwork. This adds bookmark/shortcut metadata and does not enable offline vault storage.

Verified on **30 October 2026**: both public PNGs match their supplied originals byte for byte; loopback and hostname requests serve the images and manifest with the correct content types. Chromium desktop, Android emulation and iPhone viewport checks decode both images, parse the manifest without errors, and render the page without script errors or horizontal overflow. These checks do not replace testing a saved shortcut on a physical phone. The static assets are live without a service restart; the app body, scripts and styles are unchanged.

## Applied deployment

The running app at `http://asus.local:4444` was updated on **29 October 2026 at 15:16 SAST** from `edf23cbfcd3c24656bfc57bff2992ce34555796f` to `a47de78185d4af3333d1f7b6da52f4ffc0122c19`. The service was stopped through Fedora administrator authentication, a fresh complete snapshot verified database integrity/decryption and managed-file hashes, and the service restarted successfully with PID `3015476`. No database restore or migration was performed.

Loopback and hostname health checks pass. Served HTML, app/mobile JavaScript and existing desktop/mobile CSS match the new source byte for byte. Configuration and matching secret-file fingerprints are unchanged, and the runtime checkout is clean. Clients should refresh to load the updated branding.

Private rollback source, the complete stopped snapshot, effective unit and verification record are at `/home/wolf/backups/wolfs-legacy/pre-vault-brand-20261029T131535Z/`. Keep these outside Git; do not restore an older database solely to revert branding. Subsequent documentation commits do not change the runtime source revision above. [PR #4](https://github.com/Owewolf/wolfs-legacy/pull/4) contains the changes.
