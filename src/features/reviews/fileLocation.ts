export const fileLocation = (file: { repoRelativePath: string; path: string }) =>
  [file.repoRelativePath === '.' ? '' : file.repoRelativePath, file.path].filter(Boolean).join('/');
