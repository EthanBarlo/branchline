import * as stylex from '@stylexjs/stylex';
import type { AppSettings } from '../shared/types';
import { colorSchemeStyles, darkTheme } from './appThemes';

type ThemePreference = AppSettings['theme'];
export type ResolvedTheme = 'light' | 'dark';

const storageKey = 'branchline.theme';
const lightClasses = (stylex.props(colorSchemeStyles.light).className ?? '').split(' ').filter(Boolean);
const darkClasses = (stylex.props(darkTheme, colorSchemeStyles.dark).className ?? '')
  .split(' ')
  .filter(Boolean);

export function readBootTheme(): ThemePreference {
  const saved = localStorage.getItem(storageKey);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.remove(...lightClasses, ...darkClasses);
  root.classList.add(...(theme === 'dark' ? darkClasses : lightClasses));
  root.dataset.theme = theme;
}

export function rememberTheme(preference: ThemePreference): void {
  localStorage.setItem(storageKey, preference);
}
