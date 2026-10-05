import { useState } from 'react';

export function useGitBranchFavourites(projectId: string) {
  const storageKey = `branchline.git.favourites.${projectId}`;
  const [favourites, setFavourites] = useState<ReadonlySet<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return new Set(Array.isArray(saved) ? saved.filter((key) => typeof key === 'string') : []);
    } catch {
      return new Set();
    }
  });
  function toggleFavourite(key: string) {
    setFavourites((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(storageKey, JSON.stringify([...next]));
      return next;
    });
  }
  return { favourites, toggleFavourite };
}
