import type { AppSettings } from '../shared/types';

type ThemePreference = AppSettings['theme'];
export type ResolvedTheme = 'light' | 'dark';

const storageKey = 'branchline.theme';

export function readBootTheme(): ThemePreference {
  const saved = localStorage.getItem(storageKey);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? systemDark ? 'dark' : 'light' : preference;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function rememberTheme(preference: ThemePreference): void {
  localStorage.setItem(storageKey, preference);
}
