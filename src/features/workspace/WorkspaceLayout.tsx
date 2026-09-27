import { Outlet } from '@tanstack/react-router';
import { ReviewWorkspace } from '../reviews/ReviewWorkspace';

export function WorkspaceLayout() {
  return (
    <>
      <Outlet />
      <ReviewWorkspace />
    </>
  );
}
