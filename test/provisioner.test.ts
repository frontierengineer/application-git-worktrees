import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Failure, PoolSlot, Slot, WorkspaceProvisionerImplementation } from '../../application';
import { registration } from '../worker.ts';
import { branchFor } from '../src/provisioner.ts';
import { fakeContext, instance, makeRepository, sh } from './context.ts';

function provisioner(): { impl: WorkspaceProvisionerImplementation; base: string; repository: string; logs: { level: string; message: string }[]; stored: (key: string) => unknown } {
  const { context, base, logs } = fakeContext();
  const impl = registration.workspaceProvisioner.mount(context);
  assert.ok(!('ok' in impl));
  const stored = (key: string) => (context.store as unknown as { peek(key: string): unknown }).peek(key);
  return { impl: impl as WorkspaceProvisionerImplementation, base, repository: makeRepository(base), logs, stored };
}

function failureOf(answer: unknown): Failure {
  assert.ok(answer && typeof answer === 'object' && 'ok' in answer && answer.ok === false && !('unavailable' in answer && answer.unavailable), `expected a failure, got ${JSON.stringify(answer)}`);
  return answer as Failure;
}

function slotOf(answer: unknown): Slot {
  assert.ok(answer && typeof answer === 'object' && 'slotDirectory' in answer, `expected a slot, got ${JSON.stringify(answer)}`);
  return answer as Slot;
}

const mountInput = (repository: string, name: string, extra: Partial<{ activeSlotDirectories: string[]; base: string | null; configuration: Record<string, string> }> = {}) => ({
  workspaceId: `ws-${name}`,
  workspaceProvisioner: instance({ repository, ...extra.configuration }),
  name,
  activeSlotDirectories: extra.activeSlotDirectories ?? [],
  base: extra.base ?? null,
});

test('mount gives a new name its own branch in a worktree beside the repository, and records it for review until unmount', async () => {
  const { impl, base, repository, stored } = provisioner();
  const slot = slotOf(await impl.mount(mountInput(repository, 'feature-x')));
  assert.deepEqual({ ...(stored('mounted/ws-feature-x') as Record<string, unknown>), mountedAt: 0 }, {
    workspaceId: 'ws-feature-x',
    name: 'feature-x',
    branch: 'frontier/feature-x',
    workerId: 'worker-1',
    slotDirectory: slot.slotDirectory,
    repository,
    workspaceProvisionerId: 'instance-1',
    mountedAt: 0,
  });
  assert.equal(slot.slotDirectory, join(base, '.frontier-worktrees', 'project', 'slot-1'));
  assert.equal(sh(slot.slotDirectory, 'git', 'symbolic-ref', '--short', 'HEAD').trim(), 'frontier/feature-x');
  assert.deepEqual(slot.display.map((entry) => entry.label), ['Branch', 'Commit']);
  assert.equal(slot.display[0]?.value, 'frontier/feature-x');
  assert.equal(readFileSync(join(slot.slotDirectory, 'a.txt'), 'utf8'), 'one\n');
  await impl.unmount({ workspaceId: 'ws-feature-x', workspaceProvisioner: instance({ repository }), slot });
  assert.equal(stored('mounted/ws-feature-x'), undefined);
});

test('unmount keeps uncommitted work and a later mount of the name brings it back uncommitted', async () => {
  const { impl, repository } = provisioner();
  const first = slotOf(await impl.mount(mountInput(repository, 'feature-x')));
  writeFileSync(join(first.slotDirectory, 'a.txt'), 'two\n');
  writeFileSync(join(first.slotDirectory, 'new.txt'), 'brand new\n');
  rmSync(join(first.slotDirectory, 'b.txt'));
  mkdirSync(join(first.slotDirectory, 'node_modules'));
  writeFileSync(join(first.slotDirectory, 'node_modules', 'ignored.js'), 'x');
  sh(first.slotDirectory, 'git', 'commit', '-q', '-am', 'agent work', '--allow-empty');
  writeFileSync(join(first.slotDirectory, 'a.txt'), 'three\n');
  writeFileSync(join(first.slotDirectory, 'untracked.txt'), 'u\n');
  const committedTip = sh(first.slotDirectory, 'git', 'rev-parse', 'HEAD').trim();

  assert.equal(await impl.unmount({ workspaceId: 'ws-feature-x', workspaceProvisioner: instance({ repository }), slot: first }), undefined);
  assert.equal(sh(first.slotDirectory, 'git', 'status', '--porcelain').trim(), '');
  assert.equal(sh(first.slotDirectory, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
  assert.match(sh(repository, 'git', 'rev-parse', 'refs/frontier/wip/frontier/feature-x').trim(), /^[0-9a-f]{40}$/);
  assert.equal(sh(repository, 'git', 'rev-parse', 'frontier/feature-x').trim(), committedTip);

  const second = slotOf(await impl.mount(mountInput(repository, 'feature-x')));
  assert.equal(readFileSync(join(second.slotDirectory, 'a.txt'), 'utf8'), 'three\n');
  assert.equal(readFileSync(join(second.slotDirectory, 'untracked.txt'), 'utf8'), 'u\n');
  assert.equal(existsSync(join(second.slotDirectory, 'b.txt')), false);
  const status = sh(second.slotDirectory, 'git', 'status', '--porcelain').split('\n').filter(Boolean).sort();
  assert.deepEqual(status, [' M a.txt', '?? new.txt', '?? untracked.txt']);
  assert.equal(sh(second.slotDirectory, 'git', 'rev-parse', 'HEAD').trim(), committedTip);
  assert.throws(() => sh(repository, 'git', 'rev-parse', '--verify', '--quiet', 'refs/frontier/wip/frontier/feature-x'));
});

test('a mount skips the slots other mounted workspaces hold', async () => {
  const { impl, repository } = provisioner();
  const first = slotOf(await impl.mount(mountInput(repository, 'one')));
  const second = slotOf(await impl.mount(mountInput(repository, 'two', { activeSlotDirectories: [first.slotDirectory] })));
  assert.notEqual(second.slotDirectory, first.slotDirectory);
  assert.match(second.slotDirectory, /slot-2$/);
  await impl.unmount({ workspaceId: 'ws-one', workspaceProvisioner: instance({ repository }), slot: first });
  const third = slotOf(await impl.mount(mountInput(repository, 'three', { activeSlotDirectories: [second.slotDirectory] })));
  assert.equal(third.slotDirectory, first.slotDirectory);
  assert.equal(sh(third.slotDirectory, 'git', 'symbolic-ref', '--short', 'HEAD').trim(), 'frontier/three');
});

test('a new name starts from the base it names, and an existing name ignores the base', async () => {
  const { impl, repository } = provisioner();
  sh(repository, 'git', 'checkout', '-q', '-b', 'release');
  writeFileSync(join(repository, 'release.txt'), 'r\n');
  sh(repository, 'git', 'add', '-A');
  sh(repository, 'git', 'commit', '-q', '-m', 'release');
  sh(repository, 'git', 'checkout', '-q', 'main');
  const slot = slotOf(await impl.mount(mountInput(repository, 'from-release', { base: 'release' })));
  assert.equal(existsSync(join(slot.slotDirectory, 'release.txt')), true);
  await impl.unmount({ workspaceId: 'w', workspaceProvisioner: instance({ repository }), slot });
  const again = slotOf(await impl.mount(mountInput(repository, 'from-release', { base: 'main' })));
  assert.equal(existsSync(join(again.slotDirectory, 'release.txt')), true);

  const unknown = await impl.mount(mountInput(repository, 'other', { base: 'no-such-branch' }));
  assert.deepEqual(unknown, {
    ok: false,
    message: `There is no branch or commit named no-such-branch in ${repository}. Name one that exists.`,
    retriable: false,
    field: 'base',
  });
});

test('a new name starts from the remote default branch when there is one', async () => {
  const { impl, base, repository } = provisioner();
  const origin = join(base, 'origin.git');
  sh(base, 'git', 'clone', '-q', '--bare', repository, origin);
  const clone = join(base, 'clone');
  sh(base, 'git', 'clone', '-q', origin, clone);
  sh(clone, 'git', 'checkout', '-q', '-b', 'local-only');
  writeFileSync(join(clone, 'local.txt'), 'l\n');
  sh(clone, 'git', 'add', '-A');
  sh(clone, 'git', 'commit', '-q', '-m', 'local');
  const slot = slotOf(await impl.mount(mountInput(clone, 'task')));
  assert.equal(existsSync(join(slot.slotDirectory, 'local.txt')), false);
});

test('a branch checked out in the repository itself is refused', async () => {
  const { impl, repository } = provisioner();
  sh(repository, 'git', 'checkout', '-q', '-b', 'frontier/busy');
  const answer = await impl.mount(mountInput(repository, 'busy'));
  assert.equal(answer && 'ok' in answer && answer.ok, false);
  assert.match((answer as { message: string }).message, /^The branch frontier\/busy is checked out at /);
});

test('a repository that is not there is cloned from the configured remote, and otherwise refused', async () => {
  const { impl, base, repository } = provisioner();
  const missing = join(base, 'nowhere');
  const refused = await impl.mount(mountInput(missing, 'x'));
  assert.deepEqual(refused, {
    ok: false,
    message: `${missing} is not a git repository. Set the repository to a git checkout, or set a URL to clone from.`,
    retriable: false,
    field: 'repository',
  });
  const cloned = slotOf(await impl.mount(mountInput(join(base, 'cloned'), 'x', { configuration: { remote: repository } })));
  assert.equal(readFileSync(join(cloned.slotDirectory, 'a.txt'), 'utf8'), 'one\n');
  const badRemote = await impl.mount(mountInput(join(base, 'cloned-bad'), 'x', { configuration: { remote: join(base, 'no-such-remote') } }));
  assert.equal(failureOf(badRemote).retriable, true);
  assert.equal(await impl.mount({ ...mountInput('', 'x'), workspaceProvisioner: instance({}) }).then((answer) => (answer as { field?: string }).field), 'repository');
});

test('remove deletes the branch and the saved work', async () => {
  const { impl, repository } = provisioner();
  const slot = slotOf(await impl.mount(mountInput(repository, 'gone')));
  writeFileSync(join(slot.slotDirectory, 'dirty.txt'), 'd\n');
  await impl.unmount({ workspaceId: 'ws-gone', workspaceProvisioner: instance({ repository }), slot });
  assert.ok(sh(repository, 'git', 'rev-parse', 'refs/frontier/wip/frontier/gone'));
  assert.equal(await impl.remove!({ workspaceId: 'ws-gone', workspaceProvisioner: instance({ repository }), name: 'gone' }), undefined);
  assert.throws(() => sh(repository, 'git', 'rev-parse', '--verify', '--quiet', 'refs/heads/frontier/gone'));
  assert.throws(() => sh(repository, 'git', 'rev-parse', '--verify', '--quiet', 'refs/frontier/wip/frontier/gone'));
});

test('remove deletes the branch of a workspace whose worktree directory is gone', async () => {
  const { impl, repository } = provisioner();
  const slot = slotOf(await impl.mount(mountInput(repository, 'lost')));
  rmSync(slot.slotDirectory, { recursive: true, force: true });
  assert.equal(await impl.remove!({ workspaceId: 'ws-lost', workspaceProvisioner: instance({ repository }), name: 'lost' }), undefined);
  assert.throws(() => sh(repository, 'git', 'rev-parse', '--verify', '--quiet', 'refs/heads/frontier/lost'));
  assert.ok(!sh(repository, 'git', 'worktree', 'list', '--porcelain').includes(slot.slotDirectory), 'the lost worktree is no longer registered');
});

test('checkSlot says present, gone only when the repository is healthy, and fails when it cannot tell', async () => {
  const { impl, base, repository } = provisioner();
  const slot = slotOf(await impl.mount(mountInput(repository, 'check')));
  const check = (configuration: Record<string, string>, which: Slot) =>
    impl.checkSlot!({ workspaceId: 'w', workspaceProvisioner: instance(configuration), name: 'check', slot: which });
  assert.deepEqual(await check({ repository }, slot), { present: true });
  rmSync(slot.slotDirectory, { recursive: true, force: true });
  assert.deepEqual(await check({ repository }, slot), { present: false });
  const unknown = await check({ repository: join(base, 'missing-repo') }, slot);
  assert.equal(failureOf(unknown).retriable, true);
  assert.deepEqual(await check({ repository }, { slotDirectory: '', display: [] }), { present: true });
});

test('provision fills the pool to its cap with free worktrees, and does it once', async () => {
  const { impl, repository } = provisioner();
  const input = { workspaceProvisioner: instance({ repository }), cap: 3, activeSlotDirectories: [] };
  assert.equal(await impl.provision!(input), undefined);
  assert.equal(await impl.provision!(input), undefined);
  const slots = (await impl.listSlots!({ workspaceProvisioner: instance({ repository }) })) as PoolSlot[];
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((slot) => slot.display[0]?.value), ['Free', 'Free', 'Free']);
  assert.ok(slots.every((slot) => typeof slot.sizeBytes === 'number' && slot.sizeBytes > 0));
  const mounted = slotOf(await impl.mount(mountInput(repository, 'uses-pool')));
  assert.equal(mounted.slotDirectory, slots[0]?.slotDirectory);
  const after = (await impl.listSlots!({ workspaceProvisioner: instance({ repository }) })) as PoolSlot[];
  assert.equal(after[0]?.display[0]?.value, 'frontier/uses-pool');
});

test('measure reports size and last use, mounted and unmounted', async () => {
  const { impl, repository } = provisioner();
  const slot = slotOf(await impl.mount(mountInput(repository, 'sized')));
  writeFileSync(join(slot.slotDirectory, 'big.txt'), 'x'.repeat(5000));
  const mounted = await impl.measure!({ workspaceId: 'w', workspaceProvisioner: instance({ repository }), name: 'sized', slot });
  assert.ok(mounted && 'sizeBytes' in mounted && (mounted.sizeBytes ?? 0) > 5000);
  assert.ok(mounted && 'lastUsedAt' in mounted && (mounted.lastUsedAt ?? 0) > Date.now() - 60_000);
  await impl.unmount({ workspaceId: 'w', workspaceProvisioner: instance({ repository }), slot });
  const unmounted = await impl.measure!({ workspaceId: 'w', workspaceProvisioner: instance({ repository }), name: 'sized', slot: null });
  assert.ok(unmounted && 'sizeBytes' in unmounted && unmounted.sizeBytes === 5000);
  assert.ok(unmounted && 'lastUsedAt' in unmounted && (unmounted.lastUsedAt ?? 0) > 0);
  assert.deepEqual(await impl.measure!({ workspaceId: 'w', workspaceProvisioner: instance({ repository }), name: 'never', slot: null }), { sizeBytes: null, lastUsedAt: null });
});

test('teardown removes the free worktrees, keeps the held ones and every branch, and refuses an overlapping pool', async () => {
  const { impl, base, repository } = provisioner();
  await impl.provision!({ workspaceProvisioner: instance({ repository }), cap: 2, activeSlotDirectories: [] });
  const held = slotOf(await impl.mount(mountInput(repository, 'held')));
  const free = slotOf(await impl.mount(mountInput(repository, 'free', { activeSlotDirectories: [held.slotDirectory] })));
  writeFileSync(join(free.slotDirectory, 'left.txt'), 'left behind\n');
  assert.equal(await impl.teardown!({ workspaceProvisioner: instance({ repository }), activeSlotDirectories: [held.slotDirectory] }), undefined);
  assert.equal(existsSync(held.slotDirectory), true);
  assert.equal(existsSync(free.slotDirectory), false);
  assert.ok(sh(repository, 'git', 'rev-parse', 'refs/heads/frontier/free'));
  assert.ok(sh(repository, 'git', 'rev-parse', 'refs/frontier/wip/frontier/free'));
  const overlap = await impl.teardown!({ workspaceProvisioner: instance({ repository, poolDirectory: join(repository, 'pool') }), activeSlotDirectories: [] });
  assert.equal(failureOf(overlap).field, 'poolDirectory');
  assert.equal(existsSync(join(base, '.frontier-worktrees', 'project')), true);
  await impl.teardown!({ workspaceProvisioner: instance({ repository }), activeSlotDirectories: [] });
  assert.equal(existsSync(join(base, '.frontier-worktrees')), false);
});

test('a stale lock left by a killed git is cleared, and a fresh one is reported as retriable', async () => {
  const { impl, repository } = provisioner();
  const first = slotOf(await impl.mount(mountInput(repository, 'locked')));
  const lock = join(repository, '.git', 'refs', 'heads', 'frontier', 'blocked.lock');
  writeFileSync(lock, '');
  const blocked = await impl.mount(mountInput(repository, 'blocked', { activeSlotDirectories: [first.slotDirectory] }));
  assert.equal(failureOf(blocked).retriable, true);
  assert.match((blocked as { message: string }).message, /^Preparing a worktree for blocked in /);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(lock, old, old);
  const unblocked = slotOf(await impl.mount(mountInput(repository, 'blocked', { activeSlotDirectories: [first.slotDirectory] })));
  assert.equal(sh(unblocked.slotDirectory, 'git', 'symbolic-ref', '--short', 'HEAD').trim(), 'frontier/blocked');
  assert.equal(existsSync(lock), false);
});

test('uncommitted work left in a free worktree is kept before the worktree is reused', async () => {
  const { impl, repository, logs } = provisioner();
  const slot = slotOf(await impl.mount(mountInput(repository, 'crashed')));
  writeFileSync(join(slot.slotDirectory, 'precious.txt'), 'do not lose\n');
  const reused = slotOf(await impl.mount(mountInput(repository, 'next')));
  assert.equal(reused.slotDirectory, slot.slotDirectory);
  assert.equal(sh(repository, 'git', 'show', 'refs/frontier/wip/frontier/crashed:precious.txt'), 'do not lose\n');
  assert.ok(logs.some((line) => line.message === 'Kept uncommitted work left in a free worktree'));
  await impl.unmount({ workspaceId: 'ws-next', workspaceProvisioner: instance({ repository }), slot: reused });
  const back = slotOf(await impl.mount(mountInput(repository, 'crashed')));
  assert.equal(readFileSync(join(back.slotDirectory, 'precious.txt'), 'utf8'), 'do not lose\n');

  sh(back.slotDirectory, 'git', 'checkout', '-q', '--detach');
  writeFileSync(join(back.slotDirectory, 'other.txt'), 'detached work\n');
  const fourth = slotOf(await impl.mount(mountInput(repository, 'fourth')));
  assert.equal(fourth.slotDirectory, back.slotDirectory);
  const kept = sh(repository, 'git', 'for-each-ref', '--format=%(refname)', 'refs/frontier/leftover').trim();
  assert.match(kept, /^refs\/frontier\/leftover\/slot-1-\d+$/);
  assert.equal(sh(repository, 'git', 'show', `${kept}:other.txt`), 'detached work\n');
});

test('a workspace name is cleaned into a valid branch name', () => {
  assert.equal(branchFor('frontier/', 'Fix login bug'), 'frontier/Fix-login-bug');
  assert.equal(branchFor('frontier/', 'team/.hidden..x.lock'), 'frontier/team/hidden.x-lock');
  assert.match(branchFor('frontier/', '...'), /^frontier\/workspace-[0-9a-f]{10}$/);
  assert.equal(branchFor('', 'plain'), 'plain');
});
