import { createRootRoute } from '@tanstack/react-router';
import { AppShell, UnknownRoute } from '../features/workspace/AppShell';

export const Route = createRootRoute({ component: AppShell, notFoundComponent: UnknownRoute });
