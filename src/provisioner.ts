import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type {
  Failure,
  PoolSlot,
  ProvisionerListSlotsInput,
  ProvisionerMeasureInput,
  ProvisionerMountInput,
  ProvisionerProvisionInput,
  ProvisionerRemoveInput,
  ProvisionerSlotCheckInput,
  ProvisionerTeardownInput,
  ProvisionerUnmountInput,
  Slot,
  SlotCheckResult,
  SlotDisplayEntry,
  Unavailable,
  WorkspaceMeasure,
  WorkspaceProvisionerContext,
  WorkspaceProvisionerImplementation,
  WorkspaceProvisionerInstance,
} from '../../application';
import { GitError, git, gitOk, runGit } from './git.ts';
import { failure, text } from './text.ts';
import { type MountedWorkspace, commitKey, mountedKey } from './records.ts';

export interface Settings {
  repository: string;
  remote: string;
  base: string;
  branchPrefix: string;
  poolRoot: string;
}

interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
}

interface SlotRecord {
  branch: string;
  workspaceId: string;
  name: string;
}

const committer = {
  GIT_AUTHOR_NAME: 'Frontier',
  GIT_AUTHOR_EMAIL: 'frontier@localhost',
  GIT_COMMITTER_NAME: 'Frontier',
  GIT_COMMITTER_EMAIL: 'frontier@localhost',
};

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function settingsOf(instance: WorkspaceProvisionerInstance): Settings | null {
  const value = (key: string) => {
    const raw = instance.configuration[key];
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const repositoryText = value('repository');
  if (repositoryText === '') return null;
  const repository = resolve(expandHome(repositoryText));
  const pool = value('poolDirectory');
  return {
    repository,
    remote: value('remote'),
    base: value('base'),
    branchPrefix: instance.configuration.branchPrefix === undefined ? 'frontier/' : value('branchPrefix'),
    poolRoot: pool === '' ? join(dirname(repository), '.frontier-worktrees', basename(repository)) : resolve(expandHome(pool)),
  };
}

export function branchFor(prefix: string, name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .split('/')
    .map((segment) => segment.replace(/^[.-]+|[.]+$/g, '').replace(/\.lock$/i, '-lock').replace(/\.{2,}/g, '.'))
    .filter((segment) => segment.length > 0)
    .join('/')
    .replace(/-{2,}/g, '-');
  const safe = cleaned.length > 0 ? cleaned : `workspace-${createHash('sha1').update(name).digest('hex').slice(0, 10)}`;
  return `${prefix}${safe}`;
}

export async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length > 0 ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.push(basename(current));
      current = parent;
    }
  }
}

function inside(root: string, path: string): boolean {
  const between = relative(root, path);
  return between !== '' && !between.startsWith('..') && !isAbsolute(between);
}

function overlaps(a: string, b: string): boolean {
  return a === b || inside(a, b) || inside(b, a);
}

export function parseWorktrees(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, branch: null };
      worktrees.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return worktrees;
}

function slotNumber(path: string): number {
  const match = /slot-(\d+)$/.exec(path);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

// listSlots() and measure() answer within a call's wait, so a worktree too
// large to measure in this long is reported with no size.
const measureTimeoutMilliseconds = 10_000;

async function directorySizeBytes(paths: readonly string[]): Promise<number | null> {
  const existing = paths.filter((path) => existsSync(path));
  if (existing.length === 0) return 0;
  return new Promise((done) => {
    const child = spawn('du', ['-sk', ...existing], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const deadline = setTimeout(() => child.kill('SIGKILL'), measureTimeoutMilliseconds);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', () => {
      clearTimeout(deadline);
      done(null);
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      if (code === null) {
        done(null);
        return;
      }
      const sizes = out.split('\n').map((line) => Number(line.split('\t')[0])).filter((value) => Number.isFinite(value) && value >= 0);
      done(sizes.length === 0 ? null : sizes.reduce((total, kib) => total + kib * 1024, 0));
    });
  });
}

class Mutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((done) => (release = done));
    const tail = previous.then(() => next);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

type Answer<T> = T | Failure | Unavailable;

// A clone of a large repository over a slow link takes a long while.
const cloneTimeoutMilliseconds = 60 * 60 * 1000;
// checkSlot(), listSlots() and measure() answer within a call's wait.
const checkTimeoutMilliseconds = 10_000;

export function createGitWorktreeProvisioner(context: WorkspaceProvisionerContext): WorkspaceProvisionerImplementation {
  const mutex = new Mutex();
  const sizeCache = new Map<string, { at: number; size: number | null }>();
  const t = (token: string, values: Record<string, string | number> = {}) => text(context, token, values);

  const settingsOrFailure = (instance: WorkspaceProvisionerInstance): Settings | Failure =>
    settingsOf(instance) ?? failure(t('error.repository_required'), false, 'repository');

  const isRepository = async (path: string) => existsSync(path) && (await gitOk(['rev-parse', '--is-inside-work-tree'], { cwd: path, timeoutMilliseconds: checkTimeoutMilliseconds }));

  async function ensureRepository(settings: Settings): Promise<Failure | null> {
    if (await isRepository(settings.repository)) return null;
    if (settings.remote === '') {
      return failure(t('error.not_repository', { repository: settings.repository }), false, 'repository');
    }
    if (existsSync(settings.repository) && (await readdir(settings.repository)).length > 0) {
      return failure(t('error.clone_target_busy', { repository: settings.repository }), false, 'repository');
    }
    await mkdir(dirname(settings.repository), { recursive: true });
    const run = await runGit(['clone', '--quiet', settings.remote, settings.repository], { cwd: dirname(settings.repository), timeoutMilliseconds: cloneTimeoutMilliseconds });
    if (run.code !== 0) {
      return failure(t('error.clone_failed', { remote: settings.remote, repository: settings.repository, reason: new GitError([], run).message }), true, 'remote');
    }
    void context.logger.info('Cloned the repository', { remote: settings.remote, repository: settings.repository });
    return null;
  }

  async function commonDirectory(repository: string): Promise<string> {
    const path = (await git(['rev-parse', '--git-common-dir'], { cwd: repository })).trim();
    return isAbsolute(path) ? path : resolve(repository, path);
  }

  async function recordPath(repository: string, slotDirectory: string): Promise<string> {
    return join(await commonDirectory(repository), 'frontier', 'slots', `${basename(slotDirectory)}.json`);
  }

  async function writeRecord(repository: string, slotDirectory: string, record: SlotRecord): Promise<void> {
    const path = await recordPath(repository, slotDirectory);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(record));
  }

  async function readRecord(repository: string, slotDirectory: string): Promise<SlotRecord | null> {
    try {
      return JSON.parse(await readFile(await recordPath(repository, slotDirectory), 'utf8')) as SlotRecord;
    } catch {
      return null;
    }
  }

  async function forgetRecord(repository: string, slotDirectory: string): Promise<void> {
    await rm(await recordPath(repository, slotDirectory), { force: true });
  }

  async function worktreesOf(repository: string): Promise<Worktree[]> {
    const worktrees = parseWorktrees(await git(['worktree', 'list', '--porcelain'], { cwd: repository }));
    return Promise.all(worktrees.map(async (worktree) => ({ ...worktree, path: await canonical(worktree.path) })));
  }

  async function revision(repository: string, name: string): Promise<string | null> {
    const run = await runGit(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd: repository });
    return run.code === 0 ? run.stdout.trim() : null;
  }

  async function startPoint(settings: Settings, requested: string | null): Promise<string | Failure> {
    if (requested !== null && requested.trim() !== '') {
      return (await revision(settings.repository, requested.trim()))
        ?? failure(t('error.unknown_base', { base: requested.trim(), repository: settings.repository }), false, 'base');
    }
    if (settings.base !== '') {
      return (await revision(settings.repository, settings.base))
        ?? failure(t('error.unknown_base', { base: settings.base, repository: settings.repository }), false, 'base');
    }
    const remoteHead = await runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: settings.repository });
    if (remoteHead.code === 0) {
      const commit = await revision(settings.repository, remoteHead.stdout.trim());
      if (commit) return commit;
    }
    return (await revision(settings.repository, 'HEAD')) ?? failure(t('error.empty_repository', { repository: settings.repository }), false, 'repository');
  }

  async function isDirty(directory: string): Promise<boolean> {
    const status = await git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: directory });
    return status.trim().length > 0;
  }

  async function snapshot(directory: string, message: string): Promise<string> {
    const head = (await git(['rev-parse', 'HEAD'], { cwd: directory })).trim();
    const index = join(context.directories.scratch, `index-${randomUUID()}`);
    try {
      const env = { GIT_INDEX_FILE: index };
      await git(['read-tree', head], { cwd: directory, env });
      await git(['add', '-A', '.'], { cwd: directory, env });
      const tree = (await git(['write-tree'], { cwd: directory, env })).trim();
      return (await git(['commit-tree', tree, '-p', head, '-m', message], { cwd: directory, env: committer })).trim();
    } finally {
      await rm(index, { force: true });
    }
  }

  async function keep(directory: string, ref: string, message: string): Promise<void> {
    const commit = await snapshot(directory, message);
    const existing = await runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: directory });
    if (existing.code === 0 && existing.stdout.trim() !== commit) {
      await git(['update-ref', `refs/frontier/leftover/${Date.now()}`, existing.stdout.trim()], { cwd: directory });
    }
    await git(['update-ref', ref, commit], { cwd: directory });
  }

  async function cleanSlot(directory: string): Promise<void> {
    for (const step of [['rebase', '--quit'], ['cherry-pick', '--quit'], ['am', '--quit']]) await runGit(step, { cwd: directory });
    await git(['reset', '--hard', '--quiet'], { cwd: directory });
    await git(['checkout', '--detach', '--quiet'], { cwd: directory });
    await git(['clean', '-fd', '--quiet'], { cwd: directory });
  }

  async function keepLeftovers(directory: string, worktree: Worktree): Promise<void> {
    if (!(await isDirty(directory))) return;
    const ref = worktree.branch ? `refs/frontier/wip/${worktree.branch}` : `refs/frontier/leftover/${basename(directory)}-${Date.now()}`;
    await keep(directory, ref, `Uncommitted work left in ${basename(directory)}, kept by Frontier`);
    void context.logger.warn('Kept uncommitted work left in a free worktree', { directory, ref });
  }

  async function restoreSaved(directory: string, branch: string): Promise<SlotDisplayEntry | null> {
    const ref = `refs/frontier/wip/${branch}`;
    const saved = await runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: directory });
    if (saved.code !== 0) return null;
    if (await isDirty(directory)) return { label: t('display.saved_work'), value: t('display.saved_work_kept', { ref }) };
    const commit = saved.stdout.trim();
    const parent = (await git(['rev-parse', `${commit}^`], { cwd: directory })).trim();
    const head = (await git(['rev-parse', 'HEAD'], { cwd: directory })).trim();
    try {
      if (parent === head) {
        await git(['read-tree', '-m', '-u', 'HEAD', commit], { cwd: directory });
      } else {
        const patch = await git(['diff', '--binary', parent, commit], { cwd: directory });
        await git(['apply', '--3way', '--whitespace=nowarn'], { cwd: directory, input: patch });
      }
      await git(['reset', '--quiet'], { cwd: directory });
      await git(['update-ref', '-d', ref], { cwd: directory });
      return null;
    } catch (error) {
      await runGit(['reset', '--hard', '--quiet'], { cwd: directory });
      await runGit(['clean', '-fd', '--quiet'], { cwd: directory });
      void context.logger.warn('Saved work did not apply', { directory, ref, reason: String(error) });
      return { label: t('display.saved_work'), value: t('display.saved_work_kept', { ref }) };
    }
  }

  async function mint(settings: Settings, root: string, taken: ReadonlySet<string>, add: (directory: string) => string[]): Promise<string> {
    await mkdir(root, { recursive: true });
    let number = 1;
    while (taken.has(join(root, `slot-${number}`)) || existsSync(join(root, `slot-${number}`))) number += 1;
    const directory = join(root, `slot-${number}`);
    await git(['worktree', 'add', '--quiet', ...add(directory)], { cwd: settings.repository });
    const registered = (await worktreesOf(settings.repository)).some((worktree) => worktree.path === directory);
    if (!existsSync(directory) || !registered) {
      await runGit(['worktree', 'prune'], { cwd: settings.repository });
      throw new Error(t('error.phantom_slot', { directory }));
    }
    return directory;
  }

  function gitFailure(token: string, values: Record<string, string>, error: unknown): Failure {
    const reason = error instanceof Error ? error.message : String(error);
    return failure(t(token, { ...values, reason }), true);
  }

  async function display(directory: string, branch: string, extra: SlotDisplayEntry | null): Promise<SlotDisplayEntry[]> {
    const commit = (await git(['rev-parse', '--short', 'HEAD'], { cwd: directory })).trim();
    const entries = [
      { label: t('display.branch'), value: branch },
      { label: t('display.commit'), value: commit },
    ];
    return extra ? [...entries, extra] : entries;
  }

  async function mount(input: ProvisionerMountInput): Promise<Answer<Slot>> {
    const settings = settingsOrFailure(input.workspaceProvisioner);
    if ('ok' in settings) return settings;
    return mutex.run(settings.repository, async () => {
      const missing = await ensureRepository(settings);
      if (missing) return missing;
      const branch = branchFor(settings.branchPrefix, input.name);
      if (!(await gitOk(['check-ref-format', '--branch', branch], { cwd: settings.repository }))) {
        return failure(t('error.bad_branch', { branch }), false, 'name');
      }
      try {
        const root = await canonical(settings.poolRoot);
        if (overlaps(root, await canonical(settings.repository))) {
          return failure(t('error.pool_overlap', { root, repository: settings.repository }), false, 'poolDirectory');
        }
        const exists = await gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: settings.repository });
        const start = exists ? null : await startPoint(settings, input.base);
        if (start !== null && typeof start !== 'string') return start;
        await git(['worktree', 'prune'], { cwd: settings.repository });
        const worktrees = await worktreesOf(settings.repository);
        const active = new Set(await Promise.all(input.activeSlotDirectories.map((path) => canonical(path))));
        const pooled = worktrees.filter((worktree) => inside(root, worktree.path)).sort((a, b) => slotNumber(a.path) - slotNumber(b.path));
        const holder = worktrees.find((worktree) => worktree.branch === branch);
        let directory: string | null = null;
        if (holder) {
          if (!inside(root, holder.path) || active.has(holder.path)) {
            return failure(t('error.branch_elsewhere', { branch, path: holder.path }), false, 'name');
          }
          directory = holder.path;
        }
        for (const worktree of directory === null ? pooled : []) {
          if (active.has(worktree.path) || !existsSync(worktree.path)) continue;
          try {
            await keepLeftovers(worktree.path, worktree);
            await cleanSlot(worktree.path);
            await git(exists ? ['checkout', '--force', '--quiet', branch] : ['checkout', '--force', '--quiet', '-b', branch, start as string], { cwd: worktree.path });
            directory = worktree.path;
            break;
          } catch (error) {
            void context.logger.warn('A free worktree could not be reused', { directory: worktree.path, reason: String(error) });
          }
        }
        if (directory === null) {
          const taken = new Set([...worktrees.map((worktree) => worktree.path), ...active]);
          directory = await mint(settings, root, taken, (path) => (exists ? [path, branch] : ['-b', branch, path, start as string]));
        }
        const restored = await restoreSaved(directory, branch);
        await writeRecord(settings.repository, directory, { branch, workspaceId: input.workspaceId, name: input.name });
        const record: MountedWorkspace = {
          workspaceId: input.workspaceId,
          name: input.name,
          branch,
          workerId: context.currentWorker.id,
          slotDirectory: directory,
          repository: settings.repository,
          workspaceProvisionerId: input.workspaceProvisioner.id,
          mountedAt: Date.now(),
        };
        const remembered = await context.store.putJson({ key: mountedKey(input.workspaceId), value: record });
        if (!remembered.ok) void context.logger.warn('The mounted workspace was not recorded for review', { workspaceId: input.workspaceId, reason: remembered.message });
        return { slotDirectory: directory, display: await display(directory, branch, restored) };
      } catch (error) {
        return gitFailure('error.mount_failed', { name: input.name, repository: settings.repository }, error);
      }
    });
  }

  async function unmount(input: ProvisionerUnmountInput): Promise<Answer<void>> {
    if (input.slot === null || input.slot.slotDirectory === '') return;
    const directory = input.slot.slotDirectory;
    if (!existsSync(directory)) return;
    const settings = settingsOrFailure(input.workspaceProvisioner);
    if ('ok' in settings) return settings;
    return mutex.run(settings.repository, async () => {
      try {
        const record = await readRecord(settings.repository, directory);
        const current = await runGit(['symbolic-ref', '--short', '--quiet', 'HEAD'], { cwd: directory });
        const branch = current.code === 0 ? current.stdout.trim() : record?.branch ?? null;
        if (await isDirty(directory)) {
          const ref = branch ? `refs/frontier/wip/${branch}` : `refs/frontier/leftover/${basename(directory)}-${Date.now()}`;
          await keep(directory, ref, `Uncommitted work of ${record?.name ?? branch ?? basename(directory)}, kept by Frontier`);
        }
        await cleanSlot(directory);
        await forgetRecord(settings.repository, directory);
        await context.store.delete(mountedKey(input.workspaceId));
        await context.store.delete(commitKey(input.workspaceId));
      } catch (error) {
        return gitFailure('error.unmount_failed', { path: directory }, error);
      }
    });
  }

  async function remove(input: ProvisionerRemoveInput): Promise<Answer<void>> {
    const settings = settingsOrFailure(input.workspaceProvisioner);
    if ('ok' in settings) return settings;
    if (!(await isRepository(settings.repository))) return;
    const branch = branchFor(settings.branchPrefix, input.name);
    return mutex.run(settings.repository, async () => {
      try {
        const root = await canonical(settings.poolRoot);
        await git(['worktree', 'prune'], { cwd: settings.repository });
        for (const worktree of await worktreesOf(settings.repository)) {
          if (worktree.branch !== branch) continue;
          if (!inside(root, worktree.path)) return failure(t('error.branch_elsewhere', { branch, path: worktree.path }), false);
          await cleanSlot(worktree.path);
          await forgetRecord(settings.repository, worktree.path);
        }
        await runGit(['update-ref', '-d', `refs/frontier/wip/${branch}`], { cwd: settings.repository });
        if (await gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: settings.repository })) {
          await git(['branch', '-D', '--quiet', branch], { cwd: settings.repository });
        }
      } catch (error) {
        return gitFailure('error.remove_failed', { branch }, error);
      }
    });
  }

  async function checkSlot(input: ProvisionerSlotCheckInput): Promise<Answer<SlotCheckResult>> {
    const directory = input.slot.slotDirectory;
    if (directory === '') return { present: true };
    if (existsSync(directory) && (await gitOk(['rev-parse', '--is-inside-work-tree'], { cwd: directory, timeoutMilliseconds: checkTimeoutMilliseconds }))) return { present: true };
    const settings = settingsOrFailure(input.workspaceProvisioner);
    if ('ok' in settings) return settings;
    if (await isRepository(settings.repository)) return { present: false };
    return failure(t('error.check_failed', { path: directory, repository: settings.repository }), true);
  }

  async function provision(input: ProvisionerProvisionInput): Promise<Answer<void>> {
    const settings = settingsOrFailure(input.workspaceProvisioner);
    if ('ok' in settings) return settings;
    return mutex.run(settings.repository, async () => {
      const missing = await ensureRepository(settings);
      if (missing) return missing;
      try {
        const root = await canonical(settings.poolRoot);
        if (overlaps(root, await canonical(settings.repository))) {
          return failure(t('error.pool_overlap', { root, repository: settings.repository }), false, 'poolDirectory');
        }
        await git(['worktree', 'prune'], { cwd: settings.repository });
        const start = await startPoint(settings, null);
        if (typeof start !== 'string') return start;
        const active = await Promise.all(input.activeSlotDirectories.map((path) => canonical(path)));
        for (;;) {
          const worktrees = await worktreesOf(settings.repository);
          if (worktrees.filter((worktree) => inside(root, worktree.path)).length >= input.cap) return;
          await mint(settings, root, new Set([...worktrees.map((worktree) => worktree.path), ...active]), (path) => ['--detach', path, start]);
        }
      } catch (error) {
        return gitFailure('error.provision_failed', { repository: settings.repository }, error);
      }
    });
  }

  async function sizeOf(path: string): Promise<number | null> {
    const cached = sizeCache.get(path);
    if (cached && Date.now() - cached.at < 60_000) return cached.size;
    const size = await directorySizeBytes([path]);
    sizeCache.set(path, { at: Date.now(), size });
    return size;
  }

  async function listSlots(input: ProvisionerListSlotsInput): Promise<Answer<PoolSlot[]>> {
    const settings = settingsOrFailure(input.workspaceProvisioner);
    if ('ok' in settings) return settings;
    if (!(await isRepository(settings.repository))) return [];
    try {
      const root = await canonical(settings.poolRoot);
      const pooled = (await worktreesOf(settings.repository))
        .filter((worktree) => inside(root, worktree.path))
        .sort((a, b) => slotNumber(a.path) - slotNumber(b.path));
      const sizes = await Promise.all(pooled.map((worktree) => sizeOf(worktree.path)));
      return pooled.map((worktree, index) => {
        const size = sizes[index] ?? null;
        const slot: PoolSlot = {
          slotDirectory: worktree.path,
          display: [
            { label: t('display.branch'), value: worktree.branch ?? t('display.free') },
            { label: t('display.commit'), value: (worktree.head ?? '').slice(0, 7) },
          ],
        };
        if (size !== null) slot.sizeBytes = size;
        return slot;
      });
    } catch (error) {
      return gitFailure('error.list_failed', { repository: settings.repository }, error);
    }
  }

  async function commitTime(repository: string, ref: string): Promise<number | null> {
    const run = await runGit(['log', '-1', '--format=%ct', ref], { cwd: repository, timeoutMilliseconds: checkTimeoutMilliseconds });
    const seconds = Number(run.stdout.trim());
    return run.code === 0 && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  }

  async function savedBytes(repository: string, ref: string): Promise<number> {
    const run = await runGit(['diff-tree', '-r', '--no-commit-id', `${ref}^`, ref], { cwd: repository, timeoutMilliseconds: checkTimeoutMilliseconds });
    if (run.code !== 0) return 0;
    const blobs = run.stdout.split('\n').map((line) => line.split(' ')[3]).filter((blob): blob is string => !!blob && !/^0+$/.test(blob));
    if (blobs.length === 0) return 0;
    const sizes = await runGit(['cat-file', '--batch-check=%(objectsize)'], { cwd: repository, input: `${blobs.join('\n')}\n`, timeoutMilliseconds: checkTimeoutMilliseconds });
    return sizes.stdout.split('\n').map(Number).filter(Number.isFinite).reduce((total, size) => total + size, 0);
  }

  async function newestChange(directory: string): Promise<number | null> {
    const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: directory, timeoutMilliseconds: checkTimeoutMilliseconds });
    let newest: number | null = null;
    for (const entry of status.stdout.split('\0')) {
      const path = entry.slice(3);
      if (path === '') continue;
      try {
        const info = await stat(join(directory, path));
        newest = Math.max(newest ?? 0, info.mtimeMs);
      } catch {
        continue;
      }
    }
    return newest === null ? null : Math.round(newest);
  }

  async function measure(input: ProvisionerMeasureInput): Promise<Answer<WorkspaceMeasure>> {
    const settings = settingsOrFailure(input.workspaceProvisioner);
    if ('ok' in settings) return settings;
    if (!(await isRepository(settings.repository))) return { sizeBytes: null, lastUsedAt: null };
    const branch = branchFor(settings.branchPrefix, input.name);
    const tip = await commitTime(settings.repository, `refs/heads/${branch}`);
    const saved = `refs/frontier/wip/${branch}`;
    const hasSaved = await gitOk(['rev-parse', '--verify', '--quiet', saved], { cwd: settings.repository, timeoutMilliseconds: checkTimeoutMilliseconds });
    if (input.slot !== null && input.slot.slotDirectory !== '' && existsSync(input.slot.slotDirectory)) {
      const changed = await newestChange(input.slot.slotDirectory);
      const times = [tip, changed].filter((time): time is number => time !== null);
      return {
        sizeBytes: await sizeOf(input.slot.slotDirectory),
        lastUsedAt: times.length > 0 ? Math.max(...times) : null,
      };
    }
    if (tip === null) return { sizeBytes: null, lastUsedAt: null };
    const savedAt = hasSaved ? await commitTime(settings.repository, saved) : null;
    return {
      sizeBytes: hasSaved ? await savedBytes(settings.repository, saved) : 0,
      lastUsedAt: Math.max(tip, savedAt ?? 0),
    };
  }

  async function teardown(input: ProvisionerTeardownInput): Promise<Answer<void>> {
    const settings = settingsOrFailure(input.workspaceProvisioner);
    if ('ok' in settings) return settings;
    if (!(await isRepository(settings.repository))) return;
    return mutex.run(settings.repository, async () => {
      try {
        const root = await canonical(settings.poolRoot);
        if (overlaps(root, await canonical(settings.repository))) {
          return failure(t('error.pool_overlap', { root, repository: settings.repository }), false, 'poolDirectory');
        }
        const active = new Set(await Promise.all(input.activeSlotDirectories.map((path) => canonical(path))));
        await runGit(['worktree', 'prune'], { cwd: settings.repository });
        for (const worktree of await worktreesOf(settings.repository)) {
          if (!inside(root, worktree.path) || active.has(worktree.path)) continue;
          if (existsSync(worktree.path)) await keepLeftovers(worktree.path, worktree);
          const removed = await runGit(['worktree', 'remove', '--force', '--force', worktree.path], { cwd: settings.repository });
          if (removed.code !== 0) await rm(worktree.path, { recursive: true, force: true });
          await forgetRecord(settings.repository, worktree.path);
        }
        if (existsSync(root)) {
          for (const entry of await readdir(root)) {
            const path = join(root, entry);
            if (/^slot-\d+$/.test(entry) && !active.has(path)) await rm(path, { recursive: true, force: true });
          }
        }
        await runGit(['worktree', 'prune'], { cwd: settings.repository });
        if (active.size === 0 && existsSync(root) && (await readdir(root)).length === 0) {
          await rmdir(root);
          const parent = dirname(root);
          if (basename(parent) === '.frontier-worktrees' && (await readdir(parent)).length === 0) await rmdir(parent);
        }
      } catch (error) {
        return gitFailure('error.teardown_failed', { repository: settings.repository }, error);
      }
    });
  }

  return { mount, unmount, remove, checkSlot, provision, listSlots, measure, teardown };
}

