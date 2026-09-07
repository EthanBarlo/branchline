# macOS releases and updates

Branchline uses public GitHub Releases from `EthanBarlo/branchline`. One universal build runs natively on Intel and Apple Silicon. The DMG is for first-time installation; the ZIP and `latest-mac.yml` power in-app updates. Keep the repository name, app ID (`dev.branchline.desktop`), product name and signing team stable across releases.

## Set up your Apple credentials on GitHub

Open [Settings → Secrets and variables → Actions](https://github.com/EthanBarlo/branchline/settings/secrets/actions), then choose **New repository secret** for each entry:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded `.p12` containing your **Developer ID Application** certificate and its private key. |
| `CSC_KEY_PASSWORD` | The password you chose when exporting that `.p12`. |
| `APPLE_API_KEY_CONTENT` | The complete text of your App Store Connect team API key `.p8` file, including its BEGIN/END lines. |
| `APPLE_API_KEY_ID` | The key's ID from App Store Connect. |
| `APPLE_API_ISSUER` | Your App Store Connect team's Issuer ID. |

GitHub supplies the workflow's GitHub token automatically. No GitHub token or Apple credentials are bundled into Branchline or required on users' machines. You do not need to add an Apple ID or your Apple account password to this workflow.

### Developer ID certificate

In [Apple Developer → Certificates](https://developer.apple.com/account/resources/certificates/list), create or locate a **Developer ID Application** certificate, for distributing a Mac app outside the App Store. A development certificate or Developer ID Installer certificate is not the right type.

Install it on the Mac that holds its matching private key. In **Keychain Access → My Certificates**, expand the certificate to confirm the private key is present, then export the certificate and private key together as a password-protected `.p12`. Use a nonempty export password.

To copy the exported file as base64 without printing it into a terminal log, run this locally with your actual file path, then paste into `CSC_LINK`:

```sh
base64 -i /path/to/DeveloperID.p12 | pbcopy
```

Put the export password into `CSC_KEY_PASSWORD`. Keep the original certificate/private key secure so future releases can use the same identity.

### Notarization API key

In [App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api), create a **team API key** with App Manager access for notarization, following the notarization library's setup instructions. Download its `.p8` file and record its Key ID and Issuer ID. Apple only lets you download the key once. Store the file's full text in `APPLE_API_KEY_CONTENT`, and the two identifiers in the corresponding secrets.

The workflow writes the key into a temporary file with restricted permissions, supplies its path to Apple's notarization tooling, and deletes the file in an always-run cleanup step. Signing, notarization, stapling and Gatekeeper validation must succeed before uploading a release.

## Create a release

The source repository must be public for updates without user authentication. Commit and push the application changes and workflow before creating a release tag.

1. Update the version with `npm version minor --no-git-tag-version` or `npm version patch --no-git-tag-version`, then commit both manifests with the release's code. The initial updater version is **0.10.0**.
2. Push the commit, create a stable tag matching the package version, and push that tag. For the initial updater release:

   ```sh
   git tag v0.10.0
   git push origin v0.10.0
   ```

3. Open [Actions](https://github.com/EthanBarlo/branchline/actions). **Build macOS release draft** validates the tag and credentials, runs unit and desktop tests, builds the universal app, signs/notarizes it, and verifies the ZIP contents, feed and checksums.
4. Open the resulting [draft release](https://github.com/EthanBarlo/branchline/releases). Confirm it contains the universal DMG, universal ZIP, and `latest-mac.yml`. Edit the generated release notes and complete release testing.
5. Publish the draft as a normal stable release. Drafts and prereleases are not offered to users. Never publish while the build is still running.

Rerunning the workflow may replace assets on a draft. It refuses to change an already published version. To fix a published release, ship a higher version; Branchline never automatically downgrades.

Existing unsigned installations cannot bootstrap this updater. Users must manually install 0.10.0 or a later signed build once, opening it from Applications rather than from the mounted DMG. Their reviews and preferences remain in place.

## Checks before publishing

```sh
npm test
npm run build
npm run test:desktop
npm run test:desktop:jira
npm run test:desktop:updates
```

The update smoke test uses an inert simulator available only to unpackaged test launches. It tests manual downloads, progress, retries, postponement, native-menu access, window recreation and immediate comment persistence before quitting. It does not replace an installed application or prove notarization works.

Run `npm run release:verify` after a signed universal build to verify both update artifacts, SHA-512 hashes, architecture, bundle version, public feed configuration, code signature, notarization ticket and Gatekeeper assessment. CI does this automatically.

Before the first public update, test two signed versions (N and N+1) on both an Intel Mac and an Apple Silicon Mac using a separate test feed and isolated user data:

1. In a disposable checkout, set the build's publish configuration to a `generic` provider with an isolated local HTTP feed. Build/sign/notarize N with the same Developer ID certificate, then install it into a writable Applications location. This override is a build-time test configuration, never a renderer option or runtime environment override in shipped builds.
2. Build/sign/notarize N+1 with the same feed configuration. Serve its generated `latest-mac.yml` and ZIP from the configured local feed. Keep these artifacts out of public releases.
3. In N, create reviews, approvals and comments; change a preference. Check, download, choose Later, quit normally and confirm N remains installed. Reopen, download using the updater cache, and explicitly restart to update while a comment has just been edited.
4. Confirm N+1 launches with all review data and settings intact, no further update is offered, and the app passes Gatekeeper. Repeat on the other architecture. Test an interrupted download, saving failure and launch from a mounted DMG too.
5. Rebuild final production artifacts with the public GitHub provider. The release verifier rejects artifacts containing the test feed.

Real signed update testing requires your credentials and both Mac architectures; it cannot be completed with the unpackaged simulator alone.

## Troubleshooting

- **Missing credentials:** add the exact secret names above, then rerun the failed tag workflow.
- **No signing identity:** export the Developer ID Application certificate together with its private key; check the `.p12` password.
- **Notarization rejected:** inspect the Apple submission error in Actions. Confirm the team API key and identifiers match and the key has permission to notarize.
- **Update cannot be verified:** retry the download. If the release itself is incorrectly signed, publish a corrected higher version using the established signing identity.
- **Cannot replace the app:** move it out of the DMG/translocated location into a writable Applications folder and reopen it.
- **Saving failed:** the app stays open with the downloaded update ready. Resolve the review-save error, then retry.
- **No updates in development:** expected. Real network checks run only in packaged macOS builds.

On macOS, local updater state logs are written to `~/Library/Logs/Branchline/updates.log` and rotate at 1 MiB. They are not uploaded. Release checks contact GitHub; repository contents and review feedback stay local.

References: [electron-builder v26 macOS configuration](https://www.electron.build/v26/docs/mac/), [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets), [Apple notarization tooling](https://github.com/electron/notarize).
