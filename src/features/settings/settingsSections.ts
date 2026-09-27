import { ArrowDownToLine, FileText, GitPullRequest, Sun, Ticket } from 'lucide-react';

export const settingsSections = [
  { id: 'appearance', label: 'Appearance', icon: Sun },
  { id: 'jira', label: 'Jira', icon: Ticket },
  { id: 'bitbucket', label: 'Bitbucket', icon: GitPullRequest },
  { id: 'updates', label: 'Updates', icon: ArrowDownToLine },
  { id: 'diagnostics', label: 'Diagnostics', icon: FileText },
] as const;

export type SettingsSection = (typeof settingsSections)[number]['id'];

export function isSettingsSection(value: string): value is SettingsSection {
  return settingsSections.some((section) => section.id === value);
}
