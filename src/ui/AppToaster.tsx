import type { CSSProperties } from 'react';
import { Toaster } from 'sonner';
import { colors, fonts } from '../theme/tokens.stylex';
import type { ResolvedTheme } from '../theme/theme';

export function AppToaster({ theme }: { theme: ResolvedTheme }) {
  return (
    <Toaster
      position="bottom-right"
      theme={theme}
      closeButton
      duration={4500}
      visibleToasts={3}
      style={
        {
          '--normal-bg': colors.panel,
          '--normal-text': colors.textPrimary,
          '--normal-border': colors.border,
          '--border-radius': '6px',
          fontFamily: fonts.body,
        } as CSSProperties
      }
    />
  );
}
