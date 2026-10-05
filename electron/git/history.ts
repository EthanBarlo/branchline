import type { GitCommit, GitCommitRef } from '../../shared/git-workflow';

export const historyFormat = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00%cI';

/** NUL-delimited fields preserve punctuation and multiline commit messages. */
export function parseHistory(log: string, refs: string, head: string): GitCommit[] {
  const decorations = new Map<string, GitCommitRef[]>();
  const add = (hash: string, ref: GitCommitRef) => {
    if (!hash) return;
    const values = decorations.get(hash) ?? [];
    values.push(ref);
    decorations.set(hash, values);
  };
  for (const line of refs.split('\n')) {
    const [ref, hash, peeled] = line.split('\0');
    if (ref.startsWith('refs/heads/')) add(hash, { name: ref.slice(11), kind: 'local' });
    if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD'))
      add(hash, { name: ref.slice(13), kind: 'remote' });
    if (ref.startsWith('refs/tags/')) add(peeled || hash, { name: ref.slice(10), kind: 'tag' });
  }
  add(head, { name: 'HEAD', kind: 'head' });
  const fields = log.split('\0');
  const commits: GitCommit[] = [];
  for (let index = 0; index + 7 < fields.length; index += 8) {
    const [hash, parents, author, email, date, subject, body, committedAt] = fields.slice(index, index + 8);
    if (!hash) continue;
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date,
      subject,
      body: body.trimEnd(),
      refs: decorations.get(hash) ?? [],
      committedAt,
    });
  }
  return commits;
}
