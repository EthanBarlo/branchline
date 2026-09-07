import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJiraTicketKey, jiraTicketUrl, normalizeJiraBaseUrl } from '../shared/jira';

test('extracts Jira keys from common branch naming conventions and normalizes case', () => {
  const examples: [string, string][] = [
    ['APP-123', 'APP-123'],
    ['feature/APP-123-add-comments', 'APP-123'],
    ['feature/app-123-add-comments', 'APP-123'],
    ['bugfix_APP-123_save-review', 'APP-123'],
    ['feature-APP-123-save-review', 'APP-123'],
    ['refs/heads/team/api2-42-review', 'API2-42'],
    ['release/APP-123/implementation', 'APP-123'],
  ];
  for (const [branch, expected] of examples) {
    assert.equal(extractJiraTicketKey(branch), expected, branch);
  }
});

test('selects the first complete Jira key and skips invalid partial matches', () => {
  assert.equal(extractJiraTicketKey('feature/app-123-related-OPS-456'), 'APP-123');
  assert.equal(extractJiraTicketKey('feature/7APP-123/APP-456x/OPS-789-fix'), 'OPS-789');
  for (const branch of ['', 'main', 'feature/no-ticket', 'feature/123-456', 'feature/7APP-123', 'feature/APP-123x', 'feature/APP-', 'feature/APP-12x34', 'feature/APP-0', 'feature/APP-0123', 'APP-123\n', 'APP-123\u2028', 'feature/APP-123\t-other']) {
    assert.equal(extractJiraTicketKey(branch), null, branch);
  }
});

test('normalizes blank and explicit HTTP(S) Jira base URLs while retaining context paths', () => {
  const examples: [string, string][] = [
    ['', ''],
    ['   ', ''],
    ['https://jira.example.com', 'https://jira.example.com'],
    [' https://jira.example.com/// ', 'https://jira.example.com'],
    ['https://jira.example.com/jira/', 'https://jira.example.com/jira'],
    ['http://jira.example.com:8080/jira///', 'http://jira.example.com:8080/jira'],
    ['http://localhost:8080/jira/', 'http://localhost:8080/jira'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080/jira/', 'http://[::1]:8080/jira'],
  ];
  for (const [input, expected] of examples) {
    assert.equal(normalizeJiraBaseUrl(input), expected, input);
  }
});

test('rejects non-URL input, unsupported protocols, invalid hosts, and credentials', () => {
  const invalid: unknown[] = [
    undefined, null, 42, true, {}, ['https://jira.example.com'],
    'jira.example.com', '//jira.example.com', 'https://',
    'https://exa mple.com', 'https://.example.com', 'https://bad-.example.com',
    'https://-bad.example.com', 'https://bad_host.example.com', 'https://jira..example.com',
    'ftp://jira.example.com', 'file:///tmp/jira', 'javascript:alert(1)',
    'https://alice@jira.example.com', 'https://alice:secret@jira.example.com',
  ];
  for (const input of invalid) {
    assert.throws(() => normalizeJiraBaseUrl(input), /Enter a valid Jira base URL/, String(input));
  }
});

test('rejects query strings, fragments, and control characters before URL normalization', () => {
  const invalid = [
    'https://jira.example.com?project=APP',
    'https://jira.example.com/jira#settings',
    'https://jira.example.com?',
    'https://jira.example.com#',
    '\nhttps://jira.example.com',
    'https://jira.example.com\r',
    'https://ji\tra.example.com',
    'https://jira.example.com/\u0000path',
    'https://jira.example.com/\u007fpath',
  ];
  for (const input of invalid) {
    assert.throws(() => normalizeJiraBaseUrl(input), /Enter a valid Jira base URL/, JSON.stringify(input));
  }
});

test('builds ticket links using the configured context path and a normalized whole key', () => {
  assert.equal(jiraTicketUrl('https://jira.example.com/', 'APP-123'), 'https://jira.example.com/browse/APP-123');
  assert.equal(jiraTicketUrl('https://jira.example.com/jira///', 'api2-42'), 'https://jira.example.com/jira/browse/API2-42');
  assert.equal(jiraTicketUrl('http://jira.example.com:8080/jira', 'OPS-789'), 'http://jira.example.com:8080/jira/browse/OPS-789');
});

test('does not turn malformed keys or unsafe base URLs into outgoing ticket links', () => {
  for (const key of ['', 'feature/APP-123', 'APP-123/more', '../APP-123', 'APP-123?redirect=elsewhere', 'APP-123#fragment', 'APP-123x', '7APP-123', 'APP-0', 'APP-0123', 'APP-123\n']) {
    assert.throws(() => jiraTicketUrl('https://jira.example.com', key), /valid Jira ticket key/, JSON.stringify(key));
  }
  for (const base of ['', '   ', 'jira.example.com', 'javascript:alert(1)', 'https://alice@jira.example.com', 'https://jira.example.com?redirect=elsewhere']) {
    assert.throws(() => jiraTicketUrl(base, 'APP-123'), /Jira base URL/, base);
  }
});
