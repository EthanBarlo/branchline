import { createFileRoute, redirect } from '@tanstack/react-router';
import { SettingsPage } from '../features/settings/SettingsPage';
import { isSettingsSection } from '../features/settings/settingsSections';

export const Route = createFileRoute('/_workspace/settings/$section')({
  params: {
    parse: ({ section }) => {
      if (!isSettingsSection(section))
        throw redirect({ to: '/settings/$section', params: { section: 'appearance' }, replace: true });
      return { section };
    },
  },
  component: SettingsPage,
});
