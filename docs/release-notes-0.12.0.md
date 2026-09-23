# Branchline 0.12.0

This release improves Bitbucket review cleanup, merge recovery and the space available for reviewing code.

- Opening or refreshing a review now detects PRs completed outside Branchline and removes the review once every repository is confirmed finished, including cases where source or target branches have been deleted.
- Use **Workspace menu → Clean up closed Bitbucket reviews** to clear older completed reviews. Automatic cleanup preserves unpublished feedback, unfinished work and reviews whose status cannot be verified.
- Merged and closed PR files are clearly marked as historical changes. They remain accessible in partial reviews without counting as unreviewed work or appearing in Next-file navigation.
- Merge previews detect conflicts and show affected repositories and files. Merging stays blocked until the conflicts are resolved and the updated changes are reviewed.
- Source-branch cleanup waits until every required PR has merged successfully. Failed or interrupted operations preserve their progress for recovery; cleanup failures clearly show any retained branches.
- Repository progress stays on stable workflow stages while checks run, reducing flashing between states.
- Jira details, repository details and merge completion results open in dialogs, leaving more room for code.
- Right-click a folder to mark its files reviewed or unreviewed in bulk.
- Improved handling and diagnostics for stale Bitbucket PR responses and missing branches.

The universal macOS build supports Intel and Apple Silicon. Existing reviews and settings are retained.

Validation includes unit tests and desktop checks with mocked Bitbucket responses. Live Bitbucket and managed-Mac update behavior are not established by those simulated checks.

**Full changelog:** https://github.com/EthanBarlo/branchline/compare/v0.11.1...v0.12.0
