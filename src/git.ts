import { spawn } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string;
}

const quiet = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  LC_ALL: 'C',
  GIT_OPTIONAL_LOCKS: '0',
};

export function runGit(args: readonly string[], options: GitOptions): Promise<GitRun> {
  return new Promise((done) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: { ...process.env, ...quiet, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const settle = (run: GitRun) => {
      if (settled) return;
      settled = true;
      done(run);
    };
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => settle({ code: null, stdout: '', stderr: error.message }));
    child.on('close', (code) => settle({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly run: GitRun;
  constructor(args: readonly string[], run: GitRun) {
    super(firstLine(run));
    this.args = args;
    this.run = run;
  }
}

export function firstLine(run: GitRun): string {
  if (run.code === null) return run.stderr.includes('ENOENT') ? 'git is not installed on this worker' : run.stderr.trim();
  const line = run.stderr.split('\n').map((text) => text.trim()).find((text) => text.length > 0)
    ?? run.stdout.split('\n').map((text) => text.trim()).find((text) => text.length > 0)
    ?? `git exited with code ${run.code}`;
  return line.replace(/^(fatal|error):\s*/i, '');
}

export function isLockError(run: GitRun): boolean {
  return /\.lock'?: File exists|Another git process seems to be running|Unable to create '.*\.lock'/i.test(run.stderr);
}

const lockNames = new Set(['index.lock', 'HEAD.lock', 'config.lock', 'shallow.lock', 'packed-refs.lock', 'ORIG_HEAD.lock']);
const staleAfterMilliseconds = 2 * 60 * 1000;

async function staleLocks(directory: string, now: number, skipWorktrees: boolean, depth = 0): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth === 0 && skipWorktrees && entry.name === 'worktrees') continue;
      if (depth === 0 && (entry.name === 'objects' || entry.name === 'logs' || entry.name === 'hooks')) continue;
      if (depth > 6) continue;
      found.push(...await staleLocks(path, now, skipWorktrees, depth + 1));
    } else if (entry.name.endsWith('.lock') && (lockNames.has(entry.name) || path.includes('/refs/'))) {
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > staleAfterMilliseconds) found.push(path);
      } catch {
        continue;
      }
    }
  }
  return found;
}

export async function clearStaleLocks(gitDirectories: readonly string[], now = Date.now()): Promise<number> {
  let cleared = 0;
  for (const [index, directory] of gitDirectories.entries()) {
    for (const lock of await staleLocks(directory, now, index === 0)) {
      await rm(lock, { force: true });
      cleared += 1;
    }
  }
  return cleared;
}

export async function gitDirectoriesOf(cwd: string): Promise<string[]> {
  const run = await runGit(['rev-parse', '--git-common-dir', '--git-dir'], { cwd });
  if (run.code !== 0) return [];
  const [common, own] = run.stdout.trim().split('\n');
  const absolute = (path: string | undefined) => (path ? (isAbsolute(path) ? path : resolve(cwd, path)) : '');
  const directories = [absolute(common)];
  const ownDirectory = absolute(own);
  if (ownDirectory && ownDirectory !== directories[0]) directories.push(ownDirectory);
  return directories.filter((path) => path.length > 0);
}

export async function git(args: readonly string[], options: GitOptions): Promise<string> {
  let run = await runGit(args, options);
  if (run.code !== 0 && isLockError(run)) {
    const cleared = await clearStaleLocks(await gitDirectoriesOf(options.cwd));
    if (cleared > 0) run = await runGit(args, options);
  }
  if (run.code !== 0) throw new GitError(args, run);
  return run.stdout;
}

export async function gitOk(args: readonly string[], options: GitOptions): Promise<boolean> {
  return (await runGit(args, options)).code === 0;
}
