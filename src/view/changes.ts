import type { DesktopContext, PanelContext, Result } from '../../../application';
import type { MountedWorkspace } from '../records.ts';
import type { ChangedFile, Commit, WorkspaceStatus } from '../review.ts';
import { text } from '../text.ts';
import { fill, h, icon, style } from './dom.ts';
import { css, fallbackCss, shared } from './styles.ts';

const applicationId = 'github.com/frontierengineer/git-worktrees';
const branchIcon = 'M6 4v12M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8c0 5-6 4-11.5 8';
const kindLetters: Record<ChangedFile['kind'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!', 'type-changed': 'T' };

export function parseDiff(diff: string): { sign: '+' | '-' | '@' | 'h' | ' '; line: string }[] {
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const start = lines.findIndex((line) => line.startsWith('@@'));
  return lines.slice(start === -1 ? 0 : start).map((line) => {
    if (line.startsWith('@@')) return { sign: '@' as const, line };
    if (line.startsWith('\\')) return { sign: 'h' as const, line };
    const first = line[0];
    return { sign: first === '+' || first === '-' ? first : ' ', line };
  });
}

export class ChangesApp {
  private readonly context: DesktopContext | PanelContext;
  private readonly layout: 'desktop' | 'panel';
  private workspaces: MountedWorkspace[] = [];
  private statuses = new Map<string, WorkspaceStatus>();
  private workerTitles = new Map<string, string>();
  private selected: string | null;
  private log: Commit[] = [];
  private problem = '';
  private loadProblem = '';
  private notice = '';
  private busy = false;
  private readonly root: HTMLElement;
  private readonly list = h('ul', { role: 'list' });
  private readonly aside: HTMLElement;
  private readonly detail = h('section', { class: 'detail' });
  private readonly message = h('textarea', { name: 'message' });
  private readonly openDiffs = new Set<string>();
  private loading = false;

  constructor(context: DesktopContext | PanelContext, layout: 'desktop' | 'panel') {
    this.context = context;
    this.layout = layout;
    this.selected = context.surfacePreferences.get<string | null>('selected', null);
    this.aside = h('aside', { 'aria-label': this.t('changes.workspaces') },
      h('header', {}, h('h1', {}, this.t('changes.heading')), h('button', { type: 'button', 'data-variant': 'ghost', onclick: () => void this.reload() }, this.t('changes.refresh'))),
      this.list,
    );
    this.message.setAttribute('aria-label', this.t('changes.message'));
    this.message.placeholder = this.t('changes.message_placeholder');
    this.root = h('div', { class: `changes ${layout}` });
  }

  private readonly t = (token: string, values: Record<string, string | number> = {}): string => text(this.context, token, values);

  private call<T>(methodId: string, input: Record<string, unknown> = {}): Promise<Result<T>> {
    return this.context.methods.call<T>(applicationId, methodId, input);
  }

  async start(): Promise<void> {
    const designSystem = getComputedStyle(document.documentElement).getPropertyValue('--frontier-color-text').trim() !== '';
    document.body.append(style(css + shared), ...(designSystem ? [] : [style(fallbackCss)]), this.root);
    this.context.store.watch('mounted/', () => void this.reload());
    this.context.lifecycle.onFocus(() => void this.reload());
    const timer = window.setInterval(() => {
      if (this.context.lifecycle.isFocused() && !this.busy) void this.reload();
    }, 10_000);
    this.context.lifecycle.onUnmount(() => window.clearInterval(timer));
    await this.reload();
  }

  async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const listed = await this.call<{ workspaces: MountedWorkspace[] }>('list-workspaces');
      if (!listed.ok) {
        this.loadProblem = listed.message;
        this.draw();
        return;
      }
      this.workspaces = listed.value.workspaces;
      const workers = await this.context.workers.list();
      if (workers.ok) for (const worker of workers.value) this.workerTitles.set(worker.id, worker.title());
      this.loadProblem = '';
      const statuses = await Promise.all(this.workspaces.map(async (workspace) => [workspace.workspaceId, await this.call<WorkspaceStatus>('workspace-status', { workspaceId: workspace.workspaceId })] as const));
      this.statuses.clear();
      for (const [id, status] of statuses) if (status.ok) this.statuses.set(id, status.value);
      if (this.selected !== null && !this.workspaces.some((workspace) => workspace.workspaceId === this.selected)) this.selected = null;
      if (this.selected === null && this.layout === 'desktop') this.selected = this.workspaces[0]?.workspaceId ?? null;
      if (this.selected) {
        const log = await this.call<{ commits: Commit[] }>('workspace-log', { workspaceId: this.selected, limit: 15 });
        this.log = log.ok ? log.value.commits : [];
        const status = statuses.find(([id]) => id === this.selected)?.[1];
        this.loadProblem = status && !status.ok ? status.message : '';
      }
      this.draw();
    } finally {
      this.loading = false;
    }
  }

  private select(workspaceId: string | null): void {
    this.selected = workspaceId;
    this.context.surfacePreferences.set('selected', workspaceId);
    this.notice = '';
    this.problem = '';
    this.openDiffs.clear();
    this.message.value = '';
    this.draw();
    void this.reload();
  }

  private draw(): void {
    const t = this.t;
    fill(this.list, ...this.workspaces.map((workspace) => {
      const status = this.statuses.get(workspace.workspaceId);
      const count = status?.files.length ?? 0;
      return h('li', {}, h('button', { type: 'button', 'aria-current': workspace.workspaceId === this.selected ? 'true' : undefined, onclick: () => this.select(workspace.workspaceId) },
        h('span', { class: 'entry-title' }, workspace.name),
        h('span', { class: 'count', 'data-dirty': String(count > 0) }, status ? t(count === 1 ? 'changes.one_change' : 'changes.count', { count }) : t('changes.unknown')),
        h('span', { class: 'entry-meta' }, `${workspace.branch} · ${this.workerTitles.get(workspace.workerId) ?? t('changes.unknown_worker')}`),
      ));
    }));
    const workspace = this.workspaces.find((entry) => entry.workspaceId === this.selected) ?? null;
    if (this.workspaces.length === 0) {
      fill(this.detail, h('div', { class: 'empty' },
        icon(branchIcon),
        h('h2', {}, t('changes.empty_heading')),
        h('p', {}, t('changes.empty')),
        h('button', { type: 'button', onclick: () => void this.reload() }, t('changes.check_again')),
      ));
    } else if (!workspace) {
      fill(this.detail, h('div', { class: 'empty' }, h('h2', {}, t('changes.choose_heading')), h('p', {}, t('changes.choose'))));
    } else {
      this.drawWorkspace(workspace);
    }
    if (this.layout === 'panel') this.root.replaceChildren(workspace ? this.detail : this.aside);
    else this.root.replaceChildren(this.aside, this.detail);
  }

  private drawWorkspace(workspace: MountedWorkspace): void {
    const t = this.t;
    const status = this.statuses.get(workspace.workspaceId) ?? null;
    const files = status?.files ?? [];
    const tracking = status?.upstream ? t('changes.tracking', { upstream: status.upstream, ahead: status.ahead, behind: status.behind }) : t('changes.no_upstream');
    const commitButton = h('button', { type: 'button', 'data-variant': 'primary', disabled: this.busy || files.length === 0, 'aria-busy': String(this.busy) },
      files.length === 1 ? t('changes.commit_one') : t('changes.commit', { count: files.length }));
    commitButton.addEventListener('click', () => void this.commit(workspace));
    this.message.disabled = files.length === 0;
    fill(this.detail,
      h('header', {},
        this.layout === 'panel' ? h('button', { type: 'button', 'data-variant': 'ghost', onclick: () => this.select(null) }, t('changes.back')) : null,
        h('h2', {}, workspace.name),
        h('p', { class: 'meta' }, t('changes.meta', { branch: status?.branch ?? workspace.branch, worker: this.workerTitles.get(workspace.workerId) ?? t('changes.unknown_worker'), path: workspace.slotDirectory })),
        h('p', { class: 'meta' }, tracking),
      ),
      h('div', { class: 'message', 'data-tone': 'danger', role: 'alert' }, this.problem),
      h('div', { class: 'message', 'data-tone': 'danger', role: 'status' }, this.loadProblem),
      h('div', { class: 'message', 'data-tone': 'success', role: 'status' }, this.notice),
      status ? h('section', { class: 'commit', 'aria-label': t('changes.commit_section') },
        this.message,
        h('div', { class: 'row' }, h('p', {}, files.length === 0 ? t('changes.clean') : t('changes.commit_hint')), commitButton),
      ) : null,
      h('section', { 'aria-labelledby': 'files-heading' },
        h('h3', { id: 'files-heading' }, t('changes.files', { count: files.length })),
        ...files.map((file) => this.fileElement(workspace, file)),
      ),
      h('section', { 'aria-labelledby': 'log-heading' },
        h('h3', { id: 'log-heading' }, t('changes.log')),
        h('ol', { class: 'log' }, ...this.log.map((commit) => h('li', {},
          h('code', {}, commit.shortHash),
          h('span', {}, commit.subject),
          h('span', { class: 'when' }, `${commit.author} · ${new Intl.DateTimeFormat(this.context.currentSurface.language(), { dateStyle: 'medium', timeStyle: 'short' }).format(commit.at)}`),
        ))),
      ),
    );
  }

  private fileElement(workspace: MountedWorkspace, file: ChangedFile): HTMLElement {
    const t = this.t;
    const diff = h('div', { class: 'diff', role: 'region', 'aria-label': t('changes.diff_of', { path: file.path }) }, t('changes.loading'));
    const discard = h('button', { type: 'button', 'data-variant': 'ghost', 'data-tone': 'danger' }, t('changes.discard'));
    discard.addEventListener('click', () => void this.discard(workspace, file));
    const element = h('details', { class: 'file', open: this.openDiffs.has(file.path) },
      h('summary', {},
        h('span', { class: 'kind', 'data-kind': file.kind, title: t(`kind.${file.kind}`) }, kindLetters[file.kind]),
        h('span', { class: 'visually-hidden' }, t(`kind.${file.kind}`)),
        h('span', { class: 'path' }, file.originalPath ? `${file.originalPath} → ${file.path}` : file.path),
      ),
      h('div', { class: 'file-body' }, h('div', { class: 'file-actions' }, discard), diff),
    );
    const load = async () => {
      const answer = await this.call<{ diff: string; truncated: boolean }>('workspace-diff', { workspaceId: workspace.workspaceId, path: file.path });
      if (!answer.ok) {
        diff.textContent = answer.message;
        return;
      }
      const lines = parseDiff(answer.value.diff);
      fill(diff, ...(lines.length === 0 ? [h('div', {}, t('changes.no_diff'))] : lines.map((line) => h('div', { 'data-sign': line.sign }, line.line))),
        answer.value.truncated ? h('div', { 'data-sign': 'h' }, t('changes.truncated')) : null);
    };
    element.addEventListener('toggle', () => {
      if (element.open) {
        this.openDiffs.add(file.path);
        void load();
      } else {
        this.openDiffs.delete(file.path);
      }
    });
    if (element.open) void load();
    return element;
  }

  private async commit(workspace: MountedWorkspace): Promise<void> {
    if (this.message.value.trim() === '') {
      this.problem = this.t('changes.message_required');
      this.notice = '';
      this.draw();
      this.message.focus();
      return;
    }
    this.busy = true;
    this.draw();
    const answer = await this.call<{ commit: string; files: number }>('commit-workspace', { workspaceId: workspace.workspaceId, message: this.message.value });
    this.busy = false;
    if (answer.ok) {
      this.message.value = '';
      this.problem = '';
      this.notice = this.t('changes.committed', { hash: answer.value.commit.slice(0, 7), count: answer.value.files });
      this.openDiffs.clear();
    } else {
      this.problem = answer.message;
      this.notice = '';
    }
    await this.reload();
  }

  private async discard(workspace: MountedWorkspace, file: ChangedFile): Promise<void> {
    const confirmed = await this.context.modals.confirm({
      title: this.t('changes.discard_title'),
      message: this.t(file.kind === 'untracked' ? 'changes.discard_untracked' : 'changes.discard_message', { path: file.path }),
      confirmLabel: this.t('changes.discard'),
      danger: true,
    });
    if (!confirmed.ok || confirmed.value !== true) return;
    const answer = await this.call<{ discarded: number }>('discard-changes', { workspaceId: workspace.workspaceId, paths: [file.path] });
    this.problem = answer.ok ? '' : answer.message;
    this.notice = answer.ok ? this.t('changes.discarded', { path: file.path }) : '';
    this.openDiffs.delete(file.path);
    await this.reload();
  }
}

export function mountChanges(context: DesktopContext | PanelContext, layout: 'desktop' | 'panel'): Promise<void> {
  return new ChangesApp(context, layout).start();
}
