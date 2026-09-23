# Branchline 0.12.1

This patch brings the full Jira ticket into Branchline and makes ticket selection, branch changes and release notes easier to follow.

- **Edit Jira tickets inside Branchline**

  Open Jira directly in the review window to edit tickets, add comments and change status using Jira’s own controls. Sign in separately the first time; **Open in browser** remains available.

- **Choose your preferred ticket view**

  In **Settings → Jira → Opening tickets**, choose the full Jira page or the lightweight ticket summary. **Ticket details** also opens the summary from the full view.

- **Find and switch tickets quickly**

  Choose recent tickets from your connected Jira account or search by key or title. The selected ticket appears as a toolbar badge; its **×** clears the selection and returns to the picker.

- **Keep Current’s ticket aligned with your branch**

  Changing branches resets manual and cleared selections to the new branch’s ticket, or no ticket if no key is present. The modal closes when the change is detected; Jira’s unsaved-edit prompt lets you stay.

- **Give tickets more space**

  Ticket selection uses a compact, centred dialog with floating search results. The full Jira view keeps its controls small and leaves room for the macOS window buttons.

- **Scan release notes more easily**

  In-app release notes now show concise summaries that expand to reveal each change’s details.

The embedded Jira view is a preview. Some sign-in providers may require **Open in browser**; attachment downloads are also available through your normal browser.

The universal macOS build supports Intel and Apple Silicon. Existing reviews, connections and settings are retained.

**Full changelog:** https://github.com/EthanBarlo/branchline/compare/v0.12.0...v0.12.1
