import { Outlet } from '@tanstack/react-router';
import { ReviewWorkspace } from '../reviews/workspace/ReviewWorkspace';

export function WorkspaceLayout() {
  return (
    <>
      <Outlet />
      <ReviewWorkspace />
    </>
  );
}
