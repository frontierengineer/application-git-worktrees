import type { BaseApplicationContext, Failure, Unavailable } from '../../application';
import { type MountedWorkspace, mountedKey } from './records.ts';
import { failure, text } from './text.ts';

type Answer<T> = T | Failure | Unavailable;

export type FileKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'type-changed';

export type ChangedFile = { path: string; originalPath: string | null; kind: FileKind; staged: boolean };

export type WorkspaceStatus = {
  workspace: MountedWorkspace;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
};

export type Commit = { hash: string; shortHash: string; author: string; at: number; subject: string };

const quiet = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
const maxDiffBytes = 400_000;

function t(context: BaseApplicationContext, token: string, values: Record<string, string | number> = {}): string {
  return text(context, token, values);
}

function firstLine(output: string): string {
  return (output.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '').replace(/^(fatal|error):\s*/i, '');
}

async function workspaceOf(context: BaseApplicationContext, workspaceId: unknown): Promise<Answer<MountedWorkspace>> {
  if (typeof workspaceId !== 'string' || workspaceId === '') return failure(t(context, 'review.workspace_required'), false, 'workspaceId');
  const record = await context.store.getJson<MountedWorkspace>(mountedKey(workspaceId));
  if (!record.ok) return record;
  if (record.value === null) return failure(t(context, 'review.not_mounted'), false, 'workspaceId');
  return record.value;
}

async function git(context: BaseApplicationContext, workspace: MountedWorkspace, args: string[], okCodes: readonly number[] = [0]): Promise<Answer<string>> {
  const ran = await context.workers.execute(workspace.workerId, { command: 'git', args, cwd: workspace.slotDirectory, environment: quiet, timeoutMilliseconds: 120_000 });
  if (!ran.ok) return ran;
  if (!okCodes.includes(ran.value.exitCode)) {
    return failure(t(context, 'review.git_failed', { reason: firstLine(ran.value.stderr) || firstLine(ran.value.stdout) || `exit code ${ran.value.exitCode}` }), false);
  }
  return ran.value.stdout;
}

const kinds: Record<string, FileKind> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-changed', U: 'conflicted' };

export function parseStatus(output: string): Pick<WorkspaceStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'files'> {
  const entries = output.split('\0');
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: ChangedFile[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry === '') continue;
    if (entry.startsWith('## ')) {
      const header = entry.slice(3);
      const match = /^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(header);
      const name = match?.[1] ?? header;
      branch = name.startsWith('HEAD (no branch)') || name === 'HEAD' ? null : name.replace(/^No commits yet on /, '');
      upstream = match?.[2] ?? null;
      ahead = Number(/ahead (\d+)/.exec(match?.[3] ?? '')?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(match?.[3] ?? '')?.[1] ?? 0);
      continue;
    }
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    const path = entry.slice(3);
    let originalPath: string | null = null;
    if (x === 'R' || x === 'C') {
      originalPath = entries[index + 1] ?? null;
      index += 1;
    }
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    const kind: FileKind = x === '?' ? 'untracked' : conflicted ? 'conflicted' : kinds[x !== ' ' ? x : y] ?? 'modified';
    files.push({ path, originalPath, kind, staged: x !== ' ' && x !== '?' });
  }
  return { branch, upstream, ahead, behind, files };
}

export async function listWorkspaces(context: BaseApplicationContext): Promise<Answer<{ workspaces: MountedWorkspace[] }>> {
  const keys = await context.store.list('mounted/');
  if (!keys.ok) return keys;
  const workspaces: MountedWorkspace[] = [];
  for (const key of keys.value) {
    const record = await context.store.getJson<MountedWorkspace>(key);
    if (!record.ok) return record;
    if (record.value) workspaces.push(record.value);
  }
  workspaces.sort((a, b) => b.mountedAt - a.mountedAt);
  return { workspaces };
}

export async function workspaceStatus(context: BaseApplicationContext, input: Record<string, unknown>): Promise<Answer<WorkspaceStatus>> {
  const workspace = await workspaceOf(context, input.workspaceId);
  if ('ok' in workspace) return workspace;
  const status = await git(context, workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--branch']);
  if (typeof status !== 'string') return status;
  return { workspace, ...parseStatus(status) };
}

export async function workspaceDiff(context: BaseApplicationContext, input: Record<string, unknown>): Promise<Answer<{ diff: string; truncated: boolean }>> {
  const workspace = await workspaceOf(context, input.workspaceId);
  if ('ok' in workspace) return workspace;
  if (typeof input.path !== 'string' || input.path === '') return failure(t(context, 'review.path_required'), false, 'path');
  const path = input.path;
  const untracked = await git(context, workspace, ['ls-files', '--others', '--exclude-standard', '--', path]);
  if (typeof untracked !== 'string') return untracked;
  const diff = untracked.trim() !== ''
    ? await git(context, workspace, ['diff', '--no-index', '--no-color', '--', '/dev/null', path], [0, 1])
    : await git(context, workspace, ['diff', '--no-color', '--find-renames', 'HEAD', '--', path]);
  if (typeof diff !== 'string') return diff;
  return diff.length > maxDiffBytes ? { diff: diff.slice(0, maxDiffBytes), truncated: true } : { diff, truncated: false };
}

export async function workspaceLog(context: BaseApplicationContext, input: Record<string, unknown>): Promise<Answer<{ commits: Commit[] }>> {
  const workspace = await workspaceOf(context, input.workspaceId);
  if ('ok' in workspace) return workspace;
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(200, Math.floor(input.limit)) : 30;
  const log = await git(context, workspace, ['log', `-n${limit}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e']);
  if (typeof log !== 'string') return log;
  const commits = log.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [hash = '', shortHash = '', author = '', at = '0', subject = ''] = record.split('\x1f');
    return { hash, shortHash, author, at: Number(at) * 1000, subject };
  });
  return { commits };
}

function paths(input: Record<string, unknown>): string[] | null {
  if (input.paths === undefined) return [];
  if (!Array.isArray(input.paths) || !input.paths.every((path) => typeof path === 'string' && path !== '')) return null;
  return input.paths as string[];
}

export async function commitWorkspace(context: BaseApplicationContext, input: Record<string, unknown>): Promise<Answer<{ commit: string; files: number }>> {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (message === '') return failure(t(context, 'review.message_required'), false, 'message');
  const chosen = paths(input);
  if (chosen === null) return failure(t(context, 'review.paths_shape'), false, 'paths');
  const workspace = await workspaceOf(context, input.workspaceId);
  if ('ok' in workspace) return workspace;
  const added = await git(context, workspace, ['add', '-A', '--', ...(chosen.length > 0 ? chosen : ['.'])]);
  if (typeof added !== 'string') return added;
  const staged = await git(context, workspace, ['diff', '--cached', '--name-only', '-z']);
  if (typeof staged !== 'string') return staged;
  const files = staged.split('\0').filter(Boolean).length;
  if (files === 0) return failure(t(context, 'review.nothing_to_commit'), false);
  const committed = await git(context, workspace, ['commit', '--quiet', '-m', message]);
  if (typeof committed !== 'string') return committed;
  const head = await git(context, workspace, ['rev-parse', 'HEAD']);
  if (typeof head !== 'string') return head;
  return { commit: head.trim(), files };
}

export async function discardChanges(context: BaseApplicationContext, input: Record<string, unknown>): Promise<Answer<{ discarded: number }>> {
  const chosen = paths(input);
  if (chosen === null || chosen.length === 0) return failure(t(context, 'review.paths_required'), false, 'paths');
  const status = await workspaceStatus(context, input);
  if ('ok' in status) return status;
  const wanted = new Set(chosen);
  const files = status.files.filter((file) => wanted.has(file.path));
  const untracked = files.filter((file) => file.kind === 'untracked').map((file) => file.path);
  const tracked = files.filter((file) => file.kind !== 'untracked');
  if (untracked.length > 0) {
    const cleaned = await git(context, status.workspace, ['clean', '-f', '--', ...untracked]);
    if (typeof cleaned !== 'string') return cleaned;
  }
  const added = tracked.filter((file) => file.kind === 'added').map((file) => file.path);
  if (added.length > 0) {
    const removed = await git(context, status.workspace, ['rm', '-f', '--quiet', '--', ...added]);
    if (typeof removed !== 'string') return removed;
  }
  const restore = tracked.filter((file) => file.kind !== 'added').flatMap((file) => (file.originalPath ? [file.path, file.originalPath] : [file.path]));
  if (restore.length > 0) {
    const restored = await git(context, status.workspace, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore]);
    if (typeof restored !== 'string') return restored;
  }
  return { discarded: files.length };
}
