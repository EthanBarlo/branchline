import { createHash } from 'node:crypto';

export interface JiraBrowserTarget {
  connectionId: string;
  siteUrl: string;
  url: string;
  key: string;
  accountLabel: string;
}

export function jiraBrowserURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('The Jira browser only opens HTTPS addresses without embedded credentials.');
  }
  return url;
}

export function isJiraBrowserURL(value: string): boolean {
  try { jiraBrowserURL(value); return true; } catch { return false; }
}

export function jiraBrowserPartition(connectionId: string): string {
  if (typeof connectionId !== 'string' || !connectionId.trim() || connectionId.length > 512) {
    throw new Error('Choose a saved Jira connection before opening the Jira browser.');
  }
  return `persist:branchline-jira-${createHash('sha256').update(connectionId).digest('hex')}`;
}

export function validateJiraBrowserTarget(target: JiraBrowserTarget): void {
  jiraBrowserPartition(target.connectionId);
  const site = jiraBrowserURL(target.siteUrl);
  const ticket = jiraBrowserURL(target.url);
  if (site.origin !== ticket.origin || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(target.key)) {
    throw new Error('The ticket must belong to the configured Jira site.');
  }
  const path = site.pathname.replace(/\/+$/, '');
  if (ticket.pathname !== `${path}/browse/${target.key}` || ticket.search || ticket.hash) {
    throw new Error('The Jira browser requires the ticket link from the saved connection.');
  }
}
