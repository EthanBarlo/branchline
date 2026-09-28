import { app } from 'electron';

/** Keep desktop smoke renderers active without presenting native windows locally. */
export const isHiddenSmokeRun = !app.isPackaged && process.env.BRANCHLINE_SMOKE_HIDDEN === '1';
