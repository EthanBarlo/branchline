const ticketKey = /^[A-Z][A-Z0-9]*-[1-9][0-9]*(?![\s\S])/i;

/** Read a whole issue key from the separators commonly used in branch names. */
export function extractJiraTicketKey(branch: string): string | null {
  if (typeof branch !== 'string' || /[\u0000-\u0020\u007f]/.test(branch)) return null;
  return /(?:^|[\/_-])([A-Z][A-Z0-9]*-[1-9][0-9]*)(?=[\/_-]|(?![\s\S]))/i.exec(branch)?.[1].toUpperCase() ?? null;
}

/** Persist only an explicit web origin and optional Jira context path. */
export function normalizeJiraBaseUrl(value: unknown): string {
  const invalid = () => new Error('Enter a valid Jira base URL starting with http:// or https://, without credentials, a query, or a fragment.');
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw invalid();
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^https?:\/\/[^/\\]+/i.test(trimmed) || /[\\?#]/.test(trimmed)) throw invalid();
  let url: URL;
  try { url = new URL(trimmed); } catch { throw invalid(); }
  const authority = trimmed.slice(trimmed.indexOf('://') + 3).split('/')[0];
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || authority.includes('@') || !url.hostname) throw invalid();
  // URL validates bracketed IPv6 addresses itself. Other hosts must have
  // ordinary DNS labels; single-label intranet hosts are supported too.
  const hostname = url.hostname.replace(/\.$/, '');
  if (!hostname.startsWith('[') && (hostname.length > 253 || !hostname.split('.').every(label =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)))) throw invalid();
  return url.href.replace(/\/+$/, '');
}

export function jiraTicketUrl(baseUrl: string, key: string): string {
  const base = normalizeJiraBaseUrl(baseUrl);
  if (!base) throw new Error('Set your Jira base URL in Settings before opening a ticket.');
  if (typeof key !== 'string' || !ticketKey.test(key)) throw new Error('Choose a valid Jira ticket key.');
  return new URL(`${base}/browse/${key.toUpperCase()}`).href;
}
