import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseApplicationContext, Failure, SubscriptionContext } from '../../application';
import { registration } from '../host.ts';
import { type CommitMessage, parseStatus, readTrace } from '../src/review.ts';
import { mountedKey } from '../src/records.ts';
import { fakeContext, makeRepository, sh } from './context.ts';

const translations = JSON.parse(readFileSync(new URL('../translations.json', import.meta.url), 'utf8')) as { en: Record<string, string> };

function setup() {
  const { base } = fakeContext();
  const repository = makeRepository(base);
  const store = new Map<string, unknown>();
  store.set(mountedKey('ws-1'), { workspaceId: 'ws-1', name: 'task', branch: 'main', workerId: 'w1', slotDirectory: repository, repository, workspaceProvisionerId: 'p', mountedAt: 5 });
  store.set(mountedKey('ws-gone'), { workspaceId: 'ws-gone', name: 'gone', branch: 'x', workerId: 'w1', slotDirectory: join(base, 'missing'), repository, workspaceProvisionerId: 'p', mountedAt: 9 });
  const executed: { workerId: string; args: string[]; spawned: boolean }[] = [];
  let identity: Record<string, string> = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
  // A worker whose git has no name or email anywhere.
  const forgetIdentity = () => { identity = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }; };
  type Options = { command: string; args: string[]; cwd: string; environment: Record<string, string> };
  const missing = (cwd: string) => ({ ok: false, message: `${cwd} does not exist on this worker.`, retriable: false });
  const context = {
    translate: (token: string) => translations.en[token] ?? token,
    logger: { warn: async () => undefined },
    store: {
      getJson: async (key: string) => ({ ok: true, value: store.get(key) ?? null }),
      putJson: async (options: { key: string; value: unknown }) => {
        store.set(options.key, options.value);
        return { ok: true, value: undefined };
      },
      list: async (prefix: string) => ({ ok: true, value: [...store.keys()].filter((key) => key.startsWith(prefix)).sort() }),
    },
    workers: {
      execute: async (workerId: string, options: Options) => {
        executed.push({ workerId, args: options.args, spawned: false });
        if (!existsSync(options.cwd)) return missing(options.cwd);
        const ran = spawnSync(options.command, options.args, { cwd: options.cwd, env: { ...process.env, ...options.environment, ...identity }, encoding: 'utf8' });
        return { ok: true, value: { stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status ?? -1 } };
      },
      spawn: async (workerId: string, options: Options) => {
        executed.push({ workerId, args: options.args, spawned: true });
        if (!existsSync(options.cwd)) return missing(options.cwd);
        const child = spawn(options.command, options.args, { cwd: options.cwd, env: { ...process.env, ...options.environment, ...identity }, stdio: ['ignore', 'pipe', 'pipe'] });
        const exited = new Promise((done) => child.on('close', (exitCode, signal) => done({ ok: true, value: { exitCode, signal } })));
        return { ok: true, value: { id: String(child.pid), stdout: child.stdout, stderr: child.stderr, exited } };
      },
    },
  } as unknown as BaseApplicationContext;
  const call = async <T>(method: keyof typeof registration.methods, input: Record<string, unknown> = {}): Promise<T> =>
    (await (registration.methods[method] as { call: (context: BaseApplicationContext, input: Record<string, unknown>) => Promise<unknown> }).call(context, input)) as T;
  // Subscribes to commit-workspace and answers the refusal, or every message
  // it published once it ended.
  const commit = async (input: Record<string, unknown>): Promise<Failure | CommitMessage[]> => {
    const messages: CommitMessage[] = [];
    let ended: () => void = () => undefined;
    const end = new Promise<void>((done) => (ended = done));
    const subscription = {
      ...context,
      sessionId: null,
      subscription: {
        publish: async (message: CommitMessage) => {
          messages.push(message);
          return { ok: true, value: undefined };
        },
        end: () => ended(),
        onEnd: () => ({ unsubscribe() {} }),
      },
    } as unknown as SubscriptionContext<CommitMessage>;
    const method = registration.methods['commit-workspace'] as { subscribe: (context: SubscriptionContext<CommitMessage>, input: Record<string, unknown>) => Promise<void | Failure> };
    const refused = await method.subscribe(subscription, input);
    if (refused) return refused;
    await end;
    return messages;
  };
  return { repository, call, commit, executed, store, forgetIdentity };
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
  const modified = await call<{ diff: string; truncated: boolean; binary: boolean }>('workspace-diff', { workspaceId: 'ws-1', path: 'a.txt' });
  assert.match(modified.diff, /^@@ -1 \+1,2 @@\n one\n\+two$/m);
  assert.equal(modified.truncated, false);
  const untracked = await call<{ diff: string }>('workspace-diff', { workspaceId: 'ws-1', path: 'new.txt' });
  assert.match(untracked.diff, /\+brand new/);
  assert.equal(modified.binary, false);
  writeFileSync(join(repository, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]));
  const binary = await call<{ binary: boolean }>('workspace-diff', { workspaceId: 'ws-1', path: 'logo.bin' });
  assert.equal(binary.binary, true);
});

test('commit publishes that it started, then the commit, records how it ended, and the log shows it', async () => {
  const { repository, call, commit, executed } = setup();
  writeFileSync(join(repository, 'a.txt'), 'changed\n');
  writeFileSync(join(repository, 'new.txt'), 'new\n');
  const messages = await commit({ workspaceId: 'ws-1', message: 'Fix the login race' });
  assert.ok(Array.isArray(messages));
  const head = sh(repository, 'git', 'rev-parse', 'HEAD').trim();
  assert.deepEqual(messages, [{ state: 'started' }, { state: 'step', step: 'Adding the changes' }, { state: 'step', step: 'Committing the changes' }, { state: 'committed', commit: head, files: 2 }]);
  assert.ok(executed.some((run) => run.spawned && run.args[0] === 'commit'), 'the commit runs as a followed process, past a call\'s wait');
  assert.equal(sh(repository, 'git', 'status', '--porcelain').trim(), '');
  const status = await call<{ lastCommit: { state: string; commit: string; files: number; at: number } }>('workspace-status', { workspaceId: 'ws-1' });
  assert.deepEqual({ ...status.lastCommit, at: 0 }, { state: 'committed', commit: head, files: 2, at: 0 });
  const log = await call<{ commits: { subject: string; author: string; at: number }[] }>('workspace-log', { workspaceId: 'ws-1', limit: 5 });
  assert.deepEqual(log.commits.map((entry) => entry.subject), ['Fix the login race', 'first']);
  assert.equal(log.commits[0]?.author, 'Test');
  assert.ok((log.commits[0]?.at ?? 0) > Date.now() - 60_000);
  const nothing = await commit({ workspaceId: 'ws-1', message: 'again' });
  assert.deepEqual(nothing, [{ state: 'started' }, { state: 'step', step: 'Adding the changes' }, { state: 'failed', message: 'There is nothing to commit. Every change is already committed.' }]);
  const after = await call<{ lastCommit: { state: string; message: string } }>('workspace-status', { workspaceId: 'ws-1' });
  assert.equal(after.lastCommit.state, 'failed');
});

test('each hook a commit runs is published as a step as it starts', async () => {
  const { repository, commit } = setup();
  writeFileSync(join(repository, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint passed" >&2\n', { mode: 0o755 });
  writeFileSync(join(repository, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(repository, 'a.txt'), 'changed\n');
  const messages = await commit({ workspaceId: 'ws-1', message: 'With hooks' });
  assert.deepEqual((messages as CommitMessage[]).filter((message) => message.state === 'step').map((message) => (message as { step: string }).step), [
    'Adding the changes',
    'Committing the changes',
    "Running the repository's pre-commit hook",
    "Running the repository's commit-msg hook",
  ]);
  assert.equal((messages as CommitMessage[]).at(-1)?.state, 'committed');
});

test('git\'s trace lines are read for hooks and kept out of its standard error', () => {
  assert.deepEqual(readTrace('{"event":"child_start","child_class":"hook","hook_name":"pre-commit"}'), { hook: 'pre-commit', trace: true });
  assert.deepEqual(readTrace('{"event":"child_start","child_class":"?","argv":["git","maintenance"]}'), { hook: null, trace: true });
  assert.deepEqual(readTrace('error: lint failed'), { hook: null, trace: false });
});

test('a commit a hook refuses is published as failed, in the hook\'s words', async () => {
  const { repository, commit } = setup();
  writeFileSync(join(repository, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed in a.txt" >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(repository, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(repository, 'a.txt'), 'changed\n');
  const messages = await commit({ workspaceId: 'ws-1', message: 'Try' });
  assert.deepEqual(messages, [
    { state: 'started' },
    { state: 'step', step: 'Adding the changes' },
    { state: 'step', step: 'Committing the changes' },
    { state: 'step', step: "Running the repository's pre-commit hook" },
    { state: 'failed', message: 'Git refused: lint failed in a.txt.' },
  ]);
});

test('a worker with no git identity is told how to set one', async () => {
  const { repository, commit, forgetIdentity } = setup();
  writeFileSync(join(repository, 'a.txt'), 'changed\n');
  forgetIdentity();
  sh(repository, 'git', 'config', 'user.useConfigOnly', 'true');
  sh(repository, 'git', 'config', '--unset', 'user.name');
  sh(repository, 'git', 'config', '--unset', 'user.email');
  const messages = await commit({ workspaceId: 'ws-1', message: 'Try' });
  assert.deepEqual((messages as CommitMessage[]).at(-1), { state: 'failed', message: translations.en['review.no_identity'] });
});

test('commit can take only some files', async () => {
  const { repository, commit } = setup();
  writeFileSync(join(repository, 'a.txt'), 'changed\n');
  writeFileSync(join(repository, 'b.txt'), 'also changed\n');
  await commit({ workspaceId: 'ws-1', message: 'Only a', paths: ['a.txt'] });
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
  const { call, commit } = setup();
  assert.equal((await call<Failure>('workspace-status', {})).field, 'workspaceId');
  assert.equal((await call<Failure>('workspace-status', { workspaceId: 'unknown' })).message, 'That workspace is not mounted in a git worktree. Mount it, then try again.');
  assert.equal((await call<Failure>('workspace-diff', { workspaceId: 'ws-1' })).field, 'path');
  assert.equal((await commit({ workspaceId: 'ws-1', message: ' ' }) as Failure).field, 'message');
  assert.equal((await commit({ workspaceId: 'ws-1', message: 'x', paths: [1] }) as Failure).field, 'paths');
  assert.equal((await commit({ workspaceId: 'unknown', message: 'x' }) as Failure).field, 'workspaceId');
  assert.equal((await call<Failure>('discard-changes', { workspaceId: 'ws-1' })).field, 'paths');
  assert.match((await call<Failure>('workspace-status', { workspaceId: 'ws-gone' })).message, /^git status could not run on that worker: .* does not exist on this worker\.$/);
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

test('a read that runs past its deadline says what did not finish, and that trying again can help', async () => {
  const record = { workspaceId: 'ws-1', name: 'task', branch: 'main', workerId: 'w1', slotDirectory: '/repo', repository: '/repo', workspaceProvisionerId: 'p', mountedAt: 5 };
  const timeouts: number[] = [];
  const context = {
    translate: (token: string) => translations.en[token] ?? token,
    store: { getJson: async (key: string) => ({ ok: true, value: key === mountedKey('ws-1') ? record : null }) },
    workers: {
      execute: async (_workerId: string, options: { timeoutMilliseconds: number }) => {
        timeouts.push(options.timeoutMilliseconds);
        return { ok: false, message: 'The command ran past 20000 ms and was killed.', retriable: true };
      },
    },
  } as unknown as BaseApplicationContext;
  const answer = await (registration.methods['workspace-status'] as { call: (context: BaseApplicationContext, input: Record<string, unknown>) => Promise<Failure> }).call(context, { workspaceId: 'ws-1' });
  assert.deepEqual(timeouts, [20_000]);
  assert.equal(answer.retriable, true);
  assert.equal(answer.message, "git status did not finish on that worker: The command ran past 20000 ms and was killed. Try again in a moment; if it keeps happening, check the worker's disk and the repository there.");
});
