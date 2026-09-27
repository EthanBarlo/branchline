import { createRouter } from '@tanstack/react-router';
import { createWorkspaceHistory } from './navigation/createWorkspaceHistory';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  history: createWorkspaceHistory({
    initialEntries: ['/'],
    onBlocked: () => {
      void router.load();
    },
  }),
  defaultPreload: false,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  interface HistoryState {
    workspace?: { projectId: string; reviewId: string };
    legacyJiraLinks?: boolean;
  }
}
