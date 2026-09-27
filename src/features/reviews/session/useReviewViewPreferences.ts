import { useState } from 'react';
import type { FileFilter } from '../FileSidebar';

export function useReviewViewPreferences() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FileFilter>(() => {
    const saved = localStorage.getItem('branchline.fileFilter');
    return saved === 'all' || saved === 'commented' ? saved : 'unreviewed';
  });
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  const [showFiles, setShowFiles] = useState(() => localStorage.getItem('branchline.showFiles') !== 'false');
  const [resizingFiles, setResizingFiles] = useState(false);

  function changeFilter(value: FileFilter) {
    setFilter(value);
    localStorage.setItem('branchline.fileFilter', value);
  }

  function toggleFiles() {
    setShowFiles((visible) => {
      localStorage.setItem('branchline.showFiles', String(!visible));
      return !visible;
    });
  }

  return {
    query,
    setQuery,
    filter,
    changeFilter,
    diffStyle,
    setDiffStyle,
    showFiles,
    setShowFiles,
    toggleFiles,
    resizingFiles,
    setResizingFiles,
  };
}
