# Branchline 0.11.1

This patch fixes updates when Branchline is installed in an administrator-protected Applications folder.

- Allow the native macOS updater to request administrator credentials after your review work has been saved.
- Keep the downloaded update and your feedback when authorization is cancelled, with a working Retry update action.
- Restore the review window if installation fails after it closes, so you can continue working or retry.
- Show clearer guidance for administrator authorization, cancellation and denied permission.

**Upgrading from 0.10.0 or 0.11.0:** If your installation is in a protected folder, download the DMG below and replace Branchline manually once, using administrator approval if requested. Those versions stop before the administrator prompt and cannot install this fix themselves. Your existing reviews and settings are retained.

The universal macOS build supports Intel and Apple Silicon. Your organization's device policy may still require IT to install or allow updates.

Validation covers unit tests and simulated desktop authorization, cancellation and retry. Actual administrator authorization during a signed upgrade still needs verification on a managed Mac.

**Full changelog:** https://github.com/EthanBarlo/branchline/compare/v0.11.0...v0.11.1
