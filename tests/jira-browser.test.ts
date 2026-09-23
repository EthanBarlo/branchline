import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJiraBrowserURL, jiraBrowserPartition, validateJiraBrowserTarget } from '../electron/jira-browser-policy';

const target = { connectionId: 'jira-account-one', siteUrl: 'https://jira.example.test', url: 'https://jira.example.test/browse/APP-123', key: 'APP-123', accountLabel: 'Work account' };

test('Jira browser accepts HTTPS authentication redirects without trusting custom protocols', () => {
  for (const url of ['https://jira.example.test/browse/APP-123', 'https://id.atlassian.com/login?continue=example', 'https://login.microsoftonline.com/']) assert.equal(isJiraBrowserURL(url), true);
  for (const url of ['http://jira.example.test', 'https://name:secret@jira.example.test', 'file:///tmp/token', 'javascript:alert(1)', 'data:text/html,<h1>test</h1>', 'custom-login:callback', 'about:blank', 'not a URL']) assert.equal(isJiraBrowserURL(url), false, url);
});

test('Jira website sessions are persistent, isolated by connection and cannot inject partition names', () => {
  assert.match(jiraBrowserPartition(target.connectionId), /^persist:branchline-jira-[0-9a-f]{64}$/);
  assert.equal(jiraBrowserPartition(target.connectionId), jiraBrowserPartition(target.connectionId));
  assert.notEqual(jiraBrowserPartition('another-account'), jiraBrowserPartition(target.connectionId));
  assert.match(jiraBrowserPartition('../../other-session'), /^persist:branchline-jira-[0-9a-f]{64}$/);
  assert.throws(() => jiraBrowserPartition(''));
});

test('Initial Jira navigation is the exact saved site ticket link, including self-hosted paths', () => {
  validateJiraBrowserTarget(target);
  validateJiraBrowserTarget({ ...target, siteUrl: 'https://jira.example.test/team/jira/', url: 'https://jira.example.test/team/jira/browse/APP-123' });
  for (const url of ['https://other.example.test/browse/APP-123', 'https://jira.example.test/login', 'https://jira.example.test/browse/APP-123?redirect=other', 'https://jira.example.test/browse/APP-124']) assert.throws(() => validateJiraBrowserTarget({ ...target, url }));
  assert.throws(() => validateJiraBrowserTarget({ ...target, key: '../APP-123' }));
});
