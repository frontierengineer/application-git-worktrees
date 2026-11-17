import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WorkspaceProvisionerContext, WorkspaceProvisionerInstance } from '../../application';

const translations = JSON.parse(readFileSync(new URL('../translations.json', import.meta.url), 'utf8')) as Record<string, Record<string, string>>;

export interface LogLine { level: string; message: string; fields?: Record<string, unknown> }

export function fakeContext(): { context: WorkspaceProvisionerContext; logs: LogLine[]; base: string } {
  const base = mkdtempSync(join(tmpdir(), 'git-worktrees-test-'));
  const logs: LogLine[] = [];
  const log = (level: string) => async (message: string, fields?: Record<string, unknown>) => {
    logs.push(fields === undefined ? { level, message } : { level, message, fields });
  };
  mkdirSync(join(base, 'private'));
  mkdirSync(join(base, 'scratch'));
  const context = {
    applicationId: 'github.com/frontierengineer/git-worktrees',
    directories: { private: join(base, 'private'), scratch: join(base, 'scratch') },
    translate: (token: string) => translations.en?.[token] ?? token,
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
  } as unknown as WorkspaceProvisionerContext;
  return { context, logs, base };
}

export function sh(cwd: string, command: string, ...args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
}

export function makeRepository(base: string, name = 'project'): string {
  const repository = join(base, name);
  mkdirSync(repository);
  sh(repository, 'git', 'init', '-q', '-b', 'main');
  sh(repository, 'git', 'config', 'user.name', 'Test');
  sh(repository, 'git', 'config', 'user.email', 't@example.com');
  execFileSync('sh', ['-c', 'printf "one\\n" > a.txt && printf "keep\\n" > b.txt && printf "node_modules/\\n" > .gitignore'], { cwd: repository });
  sh(repository, 'git', 'add', '-A');
  sh(repository, 'git', 'commit', '-q', '-m', 'first');
  return repository;
}

export function instance(configuration: Record<string, string>): WorkspaceProvisionerInstance {
  return { id: 'instance-1', configuration };
}
