import { themeToTreeStyles } from '@pierre/trees';
const treeThemeColors = {
  'sideBar.background': 'var(--branchline-panel)',
  'sideBar.foreground': 'var(--branchline-text-default)',
  'list.hoverBackground': 'var(--branchline-raised)',
  'list.activeSelectionBackground': 'var(--branchline-border)',
  'list.activeSelectionForeground': 'var(--branchline-text)',
  'list.inactiveSelectionBackground': 'var(--branchline-raised)',
  'list.inactiveSelectionForeground': 'var(--branchline-text)',
  focusBorder: 'var(--branchline-focus)',
};

export const darkTreeTheme = themeToTreeStyles({
  type: 'dark',
  bg: 'var(--branchline-panel)',
  fg: 'var(--branchline-text-default)',
  colors: {
    ...treeThemeColors,
    'gitDecoration.addedResourceForeground': '#99d79b',
    'gitDecoration.modifiedResourceForeground': '#d5ba7f',
    'gitDecoration.deletedResourceForeground': '#df9991',
    'gitDecoration.renamedResourceForeground': '#91bed2',
  },
});

export const lightTreeTheme = themeToTreeStyles({
  type: 'light',
  bg: 'var(--branchline-panel)',
  fg: 'var(--branchline-text-default)',
  colors: {
    ...treeThemeColors,
    'gitDecoration.addedResourceForeground': '#267338',
    'gitDecoration.modifiedResourceForeground': '#966400',
    'gitDecoration.deletedResourceForeground': '#b44437',
    'gitDecoration.renamedResourceForeground': '#256d91',
  },
});

export const rowDecorationColors = {
  historical: 'var(--branchline-success-text)',
  reviewed: 'var(--branchline-text-emphasis)',
  changed: 'var(--branchline-warning-strong)',
  pending: 'var(--branchline-text-quiet)',
  count: 'var(--branchline-muted)',
};
