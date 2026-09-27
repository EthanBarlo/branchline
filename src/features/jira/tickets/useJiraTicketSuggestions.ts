import { useEffect, useRef, useState } from 'react';
import type { JiraTicketSuggestions } from '../../../../shared/integrations';
import { errorMessage } from '../../../lib/errorMessage';

const emptySuggestions = (): JiraTicketSuggestions => ({ recent: [], matches: [] });

export function useJiraTicketSuggestions(reviewId: string, expanded: boolean) {
  const request = useRef(0);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<JiraTicketSuggestions>(emptySuggestions);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const generation = ++request.current;
    setSuggestions(emptySuggestions());
    setActive(-1);
    setError('');
    if (!expanded) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(
      () => {
        void window.reviewAPI
          .getJiraTicketSuggestions(reviewId, query.trim())
          .then((result) => {
            if (request.current === generation) {
              setSuggestions(result);
              const searchingByTitle = !!query.trim() && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/i.test(query.trim());
              setActive(searchingByTitle && result.recent.length + result.matches.length > 0 ? 0 : -1);
            }
          })
          .catch((reason) => {
            if (request.current === generation) setError(errorMessage(reason));
          })
          .finally(() => {
            if (request.current === generation) setLoading(false);
          });
      },
      query.trim() ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [expanded, query, reviewId]);

  function resetResults() {
    setSuggestions(emptySuggestions());
    setActive(-1);
    setError('');
  }

  return {
    query,
    suggestions,
    active,
    setActive,
    loading,
    error,
    options: [...suggestions.recent, ...suggestions.matches],
    showRecent: () => {
      setQuery('');
      resetResults();
    },
    search: (value: string) => {
      request.current++;
      setQuery(value);
      resetResults();
      setLoading(true);
    },
    cancel: () => {
      request.current++;
      setActive(-1);
    },
  };
}
