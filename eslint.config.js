import { builtinModules } from 'node:module';
import parser from '@typescript-eslint/parser';
import stylex from '@stylexjs/eslint-plugin';

const nodeModules = [...new Set(builtinModules.map((name) => name.replace(/^node:/, '')))];
const platformImports = {
  paths: nodeModules.map((name) => ({ name, message: 'Node APIs belong in the Electron process.' })),
  patterns: [
    {
      group: ['node:*', 'electron', 'electron/*', 'electron-*', '**/electron/**'],
      message: 'Renderer and shared code communicate with Electron through the preload contract.',
    },
  ],
};
const featureImports = {
  group: ['**/features/**', '**/routes/**', '**/router'],
  message: 'Shared UI and theme modules must not depend on application features or routing.',
};

export default [
  { ignores: ['src/routeTree.gen.ts'] },
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.ts', 'shared/**/*.ts'],
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { '@stylexjs': stylex },
    rules: {
      '@stylexjs/valid-styles': 'error',
      '@stylexjs/valid-shorthands': 'error',
      'no-restricted-imports': ['error', platformImports],
      'no-restricted-globals': ['error', 'process', 'Buffer', '__dirname', 'require'],
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}', 'src/theme/**/*.ts', 'src/lib/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { ...platformImports, patterns: [...platformImports.patterns, featureImports] },
      ],
    },
  },
  {
    files: ['shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...platformImports,
          patterns: [
            ...platformImports.patterns,
            {
              group: ['**/src/**', 'react', 'react/*', 'react-dom', 'react-dom/*', '@stylexjs/*', '@pierre/*'],
              message: 'Shared contracts must be independent of the renderer and platform implementations.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'process', 'Buffer', '__dirname', 'require'],
    },
  },
  {
    files: ['electron/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/src/**'], message: 'Electron must depend on shared contracts, not renderer code.' }] },
      ],
    },
  },
];
