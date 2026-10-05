# Branchline 0.14.0

This release brings project-wide Git management, a combined commit graph, and faster reviews and background checks.

- **Manage Git across your project**

  Browse local and remote branches across the root repository and its nested submodules in one sidebar. Favourites, checkout indicators, and incoming/outgoing counts help you find the branch you need. Create, rename, check out, pull, and push from the branch's right-click menu, with a repository preview before changes begin.

- **Follow every repository in one commit graph**

  View branch history, commit messages, authors, dates, and repository labels together. The graph loads more history as you scroll and renders only the visible rows. Consecutive merges of the same source branch into the same target are grouped together, while ordinary branch commits remain visible.

- **Delete local and remote branches together**

  Delete a branch across every repository where it exists. When deleting a local branch, choose whether to also delete its remote counterpart. The dialog opens immediately and shows checks in progress; checked-out branches are protected, unmerged local branches require an explicit choice, and remote deletion checks protect commits pushed since the preview.

- **Review large changes more smoothly**

  Diffs appear in a continuous stack with collapsible file headers. Offscreen files load when needed, visible code rows are virtualised, and parsing runs away from the interface. Comments, reviewed markers, and file navigation stay available throughout.

- **Keep Git refreshes responsive**

  Cached branches appear on restart while fresh repository results arrive in the background. Unchanged checks keep the tree, selection, scroll position, and open menus stable. Repository scans and independent operations share work where possible.

- **Close without waiting for disposable background work**

  History loading, previews, fetches, and other background reads no longer hold the window open. Pending comment saves and accepted writes still finish before closing, and a save failure keeps the workspace available.

The universal macOS build supports Intel and Apple Silicon. Existing reviews, connections, and settings are retained.

**Full changelog:** https://github.com/EthanBarlo/branchline/compare/v0.13.0...v0.14.0
