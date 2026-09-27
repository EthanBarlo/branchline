import parser from '@typescript-eslint/parser';
import stylex from '@stylexjs/eslint-plugin';

export default [
  { ignores: ['src/routeTree.gen.ts'] },
  {
    files: ['src/**/*.{ts,tsx}', 'electron/jira-browser-chrome.ts'],
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { '@stylexjs': stylex },
    rules: {
      '@stylexjs/valid-styles': 'error',
      '@stylexjs/valid-shorthands': 'error',
    },
  },
];
