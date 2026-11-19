import type { DesktopContext } from '../../../application';
import { registration } from '../../surface.ts';
import translations from '../../translations.json';

const ok = <T>(value: T) => ({ ok: true as const, value });
const workspaces = [
  { workspaceId: 'ws-1', name: 'fix-login', branch: 'frontier/fix-login', workerId: 'w1', slotDirectory: '/home/me/.frontier-worktrees/app/slot-1', repository: '/home/me/app', workspaceProvisionerId: 'p', mountedAt: 2 },
  { workspaceId: 'ws-2', name: 'docs', branch: 'frontier/docs', workerId: 'w1', slotDirectory: '/home/me/.frontier-worktrees/app/slot-2', repository: '/home/me/app', workspaceProvisionerId: 'p', mountedAt: 1 },
];
let files = [
  { path: 'src/login.ts', originalPath: null, kind: 'modified', staged: false },
  { path: 'test/login.test.ts', originalPath: null, kind: 'untracked', staged: false },
];
const calls: { method: string; input: Record<string, unknown> }[] = [];
const commits = [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'Claude', at: Date.parse('2026-11-17T10:00:00Z'), subject: 'Wait for the redirect before checking the user' }];
let confirmAnswer = true;

const context = {
  applicationId: 'github.com/frontierengineer/application-git-worktrees',
  translate: (token: string) => (translations.en as Record<string, string>)[token] ?? token,
  currentSurface: { id: 's', title: () => 'Laptop', type: 'workstation', language: () => 'en-US', display: () => null },
  surfacePreferences: { get: (_key: string, fallback?: unknown) => fallback ?? null, set: () => undefined, delete: () => undefined },
  store: { watch: () => ({ unsubscribe() {} }) },
  workers: { list: async () => ok([{ id: 'w1', title: () => 'Laptop', isConnected: () => true }]) },
  lifecycle: { onFocus: () => ({ unsubscribe() {} }), onBlur: () => ({ unsubscribe() {} }), isFocused: () => false, onUnmount: () => ({ unsubscribe() {} }) },
  modals: { confirm: async () => ok(confirmAnswer) },
  methods: {
    call: async (_application: string, method: string, input: Record<string, unknown>) => {
      calls.push({ method, input });
      switch (method) {
        case 'list-workspaces': return ok({ workspaces });
        case 'workspace-status': return ok({ workspace: workspaces.find((entry) => entry.workspaceId === input.workspaceId), branch: input.workspaceId === 'ws-1' ? 'frontier/fix-login' : 'frontier/docs', upstream: input.workspaceId === 'ws-1' ? 'origin/frontier/fix-login' : null, ahead: 1, behind: 0, files: input.workspaceId === 'ws-1' ? files : [], lastCommit: null });
        case 'workspace-log': return ok({ commits });
        case 'workspace-diff': return ok({ diff: 'diff --git a/src/login.ts b/src/login.ts\n--- a/src/login.ts\n+++ b/src/login.ts\n@@ -1,2 +1,3 @@\n await page.click(login);\n+await page.waitForURL("/home");\n expect(user).toBe(1);\n', truncated: false });
        case 'discard-changes': {
          files = files.filter((file) => !(input.paths as string[]).includes(file.path));
          return ok({ discarded: 1 });
        }
        default: return { ok: false, unavailable: true, message: 'No such method.' };
      }
    },
    subscribe: async (_application: string, method: string, input: Record<string, unknown>, handler: (message: unknown) => void) => {
      calls.push({ method, input });
      if (method !== 'commit-workspace') return { ok: false, unavailable: true, message: 'No such method.' };
      setTimeout(() => {
        handler({ state: 'started' });
        handler({ state: 'step', step: 'Committing the changes' });
        setTimeout(() => {
          if (input.message === 'fail') {
            handler({ state: 'failed', message: 'Git refused: the pre-commit hook failed.' });
            return;
          }
          const count = files.length;
          files = [];
          handler({ state: 'committed', commit: 'b'.repeat(40), files: count });
        }, 50);
      }, 10);
      return ok({ unsubscribe() {} });
    },
  },
} as unknown as DesktopContext;

Object.assign(window, {
  calls,
  mountView: () => registration.desktop.mount(context),
  mountPanel: () => registration.panel.mount(context),
  setConfirm: (value: boolean) => (confirmAnswer = value),
});
