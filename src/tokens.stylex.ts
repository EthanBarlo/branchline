import * as stylex from '@stylexjs/stylex';

// Shared visual roles. Light values are the defaults; appThemes.ts supplies dark values.
const lightColors = {
  canvas: '#ffffff',
  jiraChromeBackground: '#ffffff',
  panel: '#f7f7f6',
  inset: '#f5f5f4',
  surface: '#f1f1f0',
  raised: '#e9e9e7',
  interactive: '#dededb',
  hover: '#d1d1ce',
  highlight: '#c7c7c2',

  border: '#cdcdc9',
  borderSelected: '#b0b0ab',

  textStrong: '#161614',
  textPrimary: '#1d1d1b',
  textDefault: '#252522',
  textSecondary: '#353532',
  textEmphasis: '#43433f',
  textTertiary: '#494945',
  textSubtle: '#51514d',
  textMuted: '#62625d',
  textQuiet: '#6b6b66',
  textFaint: '#74746f',
  accent: '#292927',
  focus: '#5d5d58',

  selection: '#85858566',
  shadowSoft: '#1d1d1b1f',
  shadowMedium: '#1d1d1b26',
  shadow: '#1d1d1b30',
  insetHighlight: '#1d1d1b0d',
  translucentHover: '#1d1d1b0a',
  translucentSelected: '#1d1d1b12',
  countBadge: '#85858525',
  overlay: '#ffffffed',

  successSurface: '#f0f3ef',
  successRaised: '#d3ded5',
  successBorder: '#d6ded4',
  successText: '#45663d',
  successStrong: '#56742f',
  diffAdded: '#51742f',

  warningSurface: '#f4f3ee',
  warningRaised: '#e4dece',
  warningBorder: '#cfc1b9',
  warningText: '#725031',
  warningStrong: '#7c6327',

  dangerSurface: '#f4efee',
  dangerButton: '#e5d0cd',
  dangerButtonHover: '#d7b7b1',
  dangerBorder: '#d5b7b4',
  dangerText: '#833c21',
  dangerStrong: '#833421',
  diffRemoved: '#743e2f',
} as const;

type ColorName =
  | keyof typeof lightColors
  | 'borderSubtle'
  | 'borderStrong'
  | 'textInverse'
  | '--branchline-canvas'
  | '--branchline-panel'
  | '--branchline-raised'
  | '--branchline-text'
  | '--branchline-text-default'
  | '--branchline-muted'
  | '--branchline-text-emphasis'
  | '--branchline-text-quiet'
  | '--branchline-success-text'
  | '--branchline-warning-strong'
  | '--branchline-accent'
  | '--branchline-focus'
  | '--branchline-border'
  | '--branchline-selection'
  | '--branchline-scrollbar'
  | '--branchline-scrollbar-hover'
  | '--branchline-resizer';

export const colors: stylex.VarGroup<Record<ColorName, string>> = stylex.defineVars({
  ...lightColors,
  borderSubtle: () => colors.interactive,
  borderStrong: () => colors.highlight,
  textInverse: () => colors.inset,

  // Stable names are used only by the small set of global browser rules in styles.css.
  '--branchline-canvas': () => colors.canvas,
  '--branchline-panel': () => colors.panel,
  '--branchline-raised': () => colors.raised,
  '--branchline-text': () => colors.textPrimary,
  '--branchline-text-default': () => colors.textDefault,
  '--branchline-muted': () => colors.textMuted,
  '--branchline-text-emphasis': () => colors.textEmphasis,
  '--branchline-text-quiet': () => colors.textQuiet,
  '--branchline-success-text': () => colors.successText,
  '--branchline-warning-strong': () => colors.warningStrong,
  '--branchline-accent': () => colors.accent,
  '--branchline-focus': () => colors.focus,
  '--branchline-border': () => colors.borderSubtle,
  '--branchline-selection': () => colors.selection,
  '--branchline-scrollbar': () => colors.borderStrong,
  '--branchline-scrollbar-hover': () => colors.borderSelected,
  '--branchline-resizer': () => colors.highlight,
});

export const fonts: stylex.VarGroup<{
  body: string;
  code: string;
  '--branchline-body-font': string;
  '--branchline-code-font': string;
}> = stylex.defineVars({
  body: 'Avenir Next, Avenir, -apple-system, BlinkMacSystemFont, sans-serif',
  code: 'Menlo, Monaco, Consolas, monospace',
  '--branchline-body-font': (): string => fonts.body,
  '--branchline-code-font': (): string => fonts.code,
});

export const spacing = stylex.defineConsts({
  xxs: '2px',
  xs: '4px',
  sm: '6px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  xxl: '24px',
});

export const radii = stylex.defineConsts({
  sm: '3px',
  md: '4px',
  lg: '6px',
});

export const typeScale = stylex.defineConsts({
  micro: '8px',
  caption: '9px',
  small: '10px',
  compact: '11px',
  body: '12px',
  base: '13px',
});
