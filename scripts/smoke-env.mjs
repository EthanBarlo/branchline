// Keep local desktop smoke runs from taking focus. CI still exercises visible windows.
export const smokeHidden = !process.env.CI && process.env.BRANCHLINE_SMOKE_VISIBLE !== '1';

export function smokeEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (smokeHidden) env.BRANCHLINE_SMOKE_HIDDEN = '1';
  else delete env.BRANCHLINE_SMOKE_HIDDEN;
  return env;
}
