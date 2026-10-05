import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyTheme, readBootTheme, resolveTheme } from './theme/theme';
import { DiffWorkers } from './features/reviews/diff/DiffWorkers';

applyTheme(resolveTheme(readBootTheme(), window.matchMedia('(prefers-color-scheme: dark)').matches));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DiffWorkers>
      <App />
    </DiffWorkers>
  </React.StrictMode>,
);
