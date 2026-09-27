import { useEffect, useLayoutEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { applyTheme, rememberTheme, resolveTheme } from '../../theme/theme';

export function useAppearance(theme: AppSettings['theme']) {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const resolvedTheme = resolveTheme(theme, systemDark);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useLayoutEffect(() => {
    applyTheme(resolvedTheme);
    rememberTheme(theme);
  }, [resolvedTheme, theme]);

  return resolvedTheme;
}
