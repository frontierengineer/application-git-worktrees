import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseApplicationContext, Failure } from '../../application';
import { registration } from '../host.ts';
import { parseStatus } from '../src/review.ts';
import { mountedKey } from '../src/records.ts';
import { fakeContext, makeRepository, sh } from './context.ts';

const translations = JSON.parse(readFileSync(new URL('../translations.json', import.meta.url), 'utf8')) as { en: Record<string, string> };

function setup() {
  const { base } = fakeContext();
  const repository = makeRepository(base);
  const store = new Map<string, unknown>();
  store.set(mountedKey('ws-1'), { workspaceId: 'ws-1', name: 'task', branch: 'main', workerId: 'w1', slotDirectory: repository, repository, workspaceProvisionerId: 'p', mountedAt: 5 });
  store.set(mountedKey('ws-gone'), { workspaceId: 'ws-gone', name: 'gone', branch: 'x', workerId: 'w1', slotDirectory: join(base, 'missing'), repository, workspaceProvisionerId: 'p', mountedAt: 9 });
  const executed: { workerId: string; args: string[] }[] = [];
  const context = {
    translate: (token: string) => translations.en[token] ?? token,
    store: {
      getJson: async (key: string) => ({ ok: true, value: store.get(key) ?? null }),
      list: async (prefix: string) => ({ ok: true, value: [...store.keys()].filter((key) => key.startsWith(prefix)).sort() }),
    },
    workers: {
      execute: async (workerId: string, options: { command: string; args: string[]; cwd: string; environment: Record<string, string> }) => {
        executed.push({ workerId, args: options.args });
        if (!existsSync(options.cwd)) return { ok: false, message: `${options.cwd} does not exist on this worker.`, retriable: false };
        const ran = spawnSync(options.command, options.args, { cwd: options.cwd, env: { ...process.env, ...options.environment, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }, encoding: 'utf8' });
        return { ok: true, value: { stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status ?? -1 } };
      },
    },
  } as unknown as BaseApplicationContext;
  const call = async <T>(method: keyof typeof registration.methods, input: Record<string, unknown> = {}): Promise<T> =>
    (await (registration.methods[method] as { call: (context: BaseApplicationContext, input: Record<string, unknown>) => Promise<unknown> }).call(context, input)) as T;
  return { repository, call, executed };
}

test('status lists every kind of change, and a diff shows a file against its last commit', async () => {
  const { repository, call, executed } = setup();
  writeFileSync(join(repository, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(repository, 'new.txt'), 'brand new\n');
  rmSync(join(repository, 'b.txt'));
  const status = await call<{ branch: string; files: { path: string; kind: string; staged: boolean }[] }>('workspace-status', { workspaceId: 'ws-1' });
  assert.equal(status.branch, 'main');
  assert.deepEqual(status.files, [
    { path: 'a.txt', originalPath: null, kind: 'modified', staged: false },
    { path: 'b.txt', originalPath: null, kind: 'deleted', staged: false },
    { path: 'new.txt', originalPath: null, kind: 'untracked', staged: false },
  ]);
  assert.equal(executed[0]?.workerId, 'w1');
  const modified = await call<{ diff: string; truncated: boolean }>('workspace-diff', { workspaceId: 'ws-1', path: 'a.txt' });
  assert.match(modified.diff, /^@@ -1 \+1,2 @@\n one\n\+two$/m);
  assert.equal(modified.truncated, false);
  const untracked = await call<{ diff: string }>('workspace-diff', { workspaceId: 'ws-1', path: 'new.txt' });
  assert.match(untracked.diff, /\+brand new/);
});

test('commit records the changes on the branch, and the log shows it', async () => {
  const { repository, call } = setup();
  writeFileSync(join(repository, 'a.txt'), 'changed\n');
  writeFileSync(join(repository, 'new.txt'), 'new\n');
  const committed = await call<{ commit: string; files: number }>('commit-workspace', { workspaceId: 'ws-1', message: 'Fix the login race' });
  assert.equal(committed.files, 2);
  assert.equal(sh(repository, 'git', 'rev-parse', 'HEAD').trim(), committed.commit);
  assert.equal(sh(repository, 'git', 'status', '--porcelain').trim(), '');
  const log = await call<{ commits: { subject: string; author: string; at: number }[] }>('workspace-log', { workspaceId: 'ws-1', limit: 5 });
  assert.deepEqual(log.commits.map((commit) => commit.subject), ['Fix the login race', 'first']);
  assert.equal(log.commits[0]?.author, 'Test');
  assert.ok((log.commits[0]?.at ?? 0) > Date.now() - 60_000);
  const nothing = await call<Failure>('commit-workspace', { workspaceId: 'ws-1', message: 'again' });
  assert.equal(nothing.message, 'There is nothing to commit. Every change is already committed.');
});

test('commit can take only some files', async () => {
  const { repository, call } = setup();
  writeFileSync(join(repository, 'a.txt'), 'changed\n');
  writeFileSync(join(repository, 'b.txt'), 'also changed\n');
  await call('commit-workspace', { workspaceId: 'ws-1', message: 'Only a', paths: ['a.txt'] });
  assert.equal(sh(repository, 'git', 'status', '--porcelain').trim(), 'M b.txt');
});

test('discard returns modified, deleted, added, renamed and untracked files to their last commit', async () => {
  const { repository, call } = setup();
  writeFileSync(join(repository, 'a.txt'), 'changed\n');
  writeFileSync(join(repository, 'untracked.txt'), 'u\n');
  writeFileSync(join(repository, 'added.txt'), 'staged new file\n');
  sh(repository, 'git', 'add', 'added.txt');
  renameSync(join(repository, 'b.txt'), join(repository, 'moved.txt'));
  sh(repository, 'git', 'add', '-A', 'b.txt', 'moved.txt');
  const status = await call<{ files: { path: string; kind: string }[] }>('workspace-status', { workspaceId: 'ws-1' });
  assert.deepEqual(status.files.map((file) => `${file.kind}:${file.path}`), ['modified:a.txt', 'added:added.txt', 'renamed:moved.txt', 'untracked:untracked.txt']);
  const discarded = await call<{ discarded: number }>('discard-changes', { workspaceId: 'ws-1', paths: ['a.txt', 'added.txt', 'moved.txt', 'untracked.txt'] });
  assert.equal(discarded.discarded, 4);
  assert.equal(sh(repository, 'git', 'status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.equal(readFileSync(join(repository, 'b.txt'), 'utf8'), 'keep\n');
  assert.equal(existsSync(join(repository, 'added.txt')), false);
});

test('bad input is refused by field, and a workspace whose directory is gone says so', async () => {
  const { call } = setup();
  assert.equal((await call<Failure>('workspace-status', {})).field, 'workspaceId');
  assert.equal((await call<Failure>('workspace-status', { workspaceId: 'unknown' })).message, 'That workspace is not mounted in a git worktree. Mount it, then try again.');
  assert.equal((await call<Failure>('workspace-diff', { workspaceId: 'ws-1' })).field, 'path');
  assert.equal((await call<Failure>('commit-workspace', { workspaceId: 'ws-1', message: ' ' })).field, 'message');
  assert.equal((await call<Failure>('commit-workspace', { workspaceId: 'ws-1', message: 'x', paths: [1] })).field, 'paths');
  assert.equal((await call<Failure>('discard-changes', { workspaceId: 'ws-1' })).field, 'paths');
  assert.match((await call<Failure>('workspace-status', { workspaceId: 'ws-gone' })).message, /does not exist on this worker/);
  const listed = await call<{ workspaces: { workspaceId: string }[] }>('list-workspaces');
  assert.deepEqual(listed.workspaces.map((workspace) => workspace.workspaceId), ['ws-gone', 'ws-1']);
});

test('status is read from git\'s porcelain output, branch, upstream and conflicts included', () => {
  const parsed = parseStatus('## frontier/task...origin/frontier/task [ahead 2, behind 1]\0UU both.txt\0R  new.ts\0old.ts\0 M lib.ts\0?? scratch.md\0');
  assert.deepEqual(parsed, {
    branch: 'frontier/task',
    upstream: 'origin/frontier/task',
    ahead: 2,
    behind: 1,
    files: [
      { path: 'both.txt', originalPath: null, kind: 'conflicted', staged: true },
      { path: 'new.ts', originalPath: 'old.ts', kind: 'renamed', staged: true },
      { path: 'lib.ts', originalPath: null, kind: 'modified', staged: false },
      { path: 'scratch.md', originalPath: null, kind: 'untracked', staged: false },
    ],
  });
  assert.equal(parseStatus('## HEAD (no branch)\0').branch, null);
});
