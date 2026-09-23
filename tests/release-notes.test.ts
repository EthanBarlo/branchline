import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseNotes, releaseNotesToText } from '../shared/release-notes';

const parseHTML = (html: string) => parseReleaseNotes(releaseNotesToText(html));

test('GitHub loose lists retain titles, descriptions and separate closing paragraphs', () => {
  const blocks = parseHTML(`<p>Review improvements.</p><ul>
    <li><p><strong>Clear completed reviews</strong></p>
      <p>Confirm each repository first.</p><p>Keep unpublished feedback.</p></li>
    <li><p><strong>Review folders</strong></p><p>Right-click a folder.</p></li>
    <li>Clearer diagnostics</li>
  </ul><p>Supports Intel and Apple Silicon.</p><p>More information below.</p>`);
  assert.deepEqual(blocks, [
    { kind: 'paragraph', text: 'Review improvements.' },
    { kind: 'list', items: [
      { title: 'Clear completed reviews', paragraphs: ['Confirm each repository first.', 'Keep unpublished feedback.'] },
      { title: 'Review folders', paragraphs: ['Right-click a folder.'] },
      { title: 'Clearer diagnostics', paragraphs: [] },
    ] },
    { kind: 'paragraph', text: 'Supports Intel and Apple Silicon.' },
    { kind: 'paragraph', text: 'More information below.' },
  ]);
});

test('tight HTML lists and line breaks produce simple bullets or descriptions as appropriate', () => {
  assert.deepEqual(parseHTML('<ul><li><strong>Faster reviews</strong><br>Files load sooner.</li><li>Smaller download</li></ul>'), [
    { kind: 'list', items: [{ title: 'Faster reviews', paragraphs: ['Files load sooner.'] }, { title: 'Smaller download', paragraphs: [] }] },
  ]);
});

test('plain and Markdown bullets use indentation to separate descriptions from standalone prose', () => {
  assert.deepEqual(parseReleaseNotes('Introduction.\n\n- **Review folders**\n\n  Right-click a folder\n  to review its files.\n\n  Works with subfolders too.\n\n• Faster checks\n\nClosing note.\n\nAnother paragraph.'), [
    { kind: 'paragraph', text: 'Introduction.' },
    { kind: 'list', items: [
      { title: '**Review folders**', paragraphs: ['Right-click a folder to review its files.', 'Works with subfolders too.'] },
      { title: 'Faster checks', paragraphs: [] },
    ] },
    { kind: 'paragraph', text: 'Closing note.' },
    { kind: 'paragraph', text: 'Another paragraph.' },
  ]);
});

test('HTML remains text and entities are decoded once without hiding literal code', () => {
  assert.deepEqual(parseHTML('<p>Use &lt;Widget&gt; &amp; &#x2192; &#8226; &amp;lt;literal&amp;gt; &#1114112;</p><script>bad()</script><style>bad{}</style><img src="https://example.invalid/tracker"><iframe src="https://example.invalid">hidden</iframe>'), [
    { kind: 'paragraph', text: 'Use <Widget> & → • &lt;literal&gt; �' },
  ]);
  assert.equal(releaseNotesToText('Before<script>unfinished'), 'Before');
  assert.deepEqual(parseHTML(''), []);
  assert.equal(releaseNotesToText('x'.repeat(40_000)).length, 30_000);
});

test('blank lines and missing descriptions never create empty accordion items', () => {
  assert.deepEqual(parseHTML('<ul><li>  </li><li><p>One line</p><p> </p></li></ul><p>Outside the list.</p>'), [
    { kind: 'list', items: [{ title: 'One line', paragraphs: [] }] },
    { kind: 'paragraph', text: 'Outside the list.' },
  ]);
});
