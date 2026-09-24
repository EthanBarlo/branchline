import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyTheme, readBootTheme, resolveTheme } from './theme';
import './theme.css';
import './styles.css';

applyTheme(resolveTheme(readBootTheme(), window.matchMedia('(prefers-color-scheme: dark)').matches));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
