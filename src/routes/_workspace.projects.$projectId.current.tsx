import { createFileRoute } from '@tanstack/react-router';

// The shared workspace layout preserves the editor while Settings is open.
export const Route = createFileRoute('/_workspace/projects/$projectId/current')({});
