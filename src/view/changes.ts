import type { DesktopContext, PanelContext, Result, Subscription } from '../../../application';
import type { CommitOutcome, MountedWorkspace } from '../records.ts';
import type { ChangedFile, Commit, CommitMessage, WorkspaceStatus } from '../review.ts';
import { text } from '../text.ts';
import { fill, h, icon, style } from './dom.ts';
import { css } from './styles.ts';

const branchIcon = ['M6 4v12', 'M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 8c0 5-6 4-11.5 8'];
const refreshIcon = ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'];
const backIcon = ['m15 18-6-6 6-6'];
const kindLetters: Record<ChangedFile['kind'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!', 'type-changed': 'T' };
const kindTones: Record<ChangedFile['kind'], string> = { modified: 'info', added: 'success', deleted: 'danger', renamed: 'info', copied: 'info', untracked: 'success', conflicted: 'danger', 'type-changed': 'info' };

export function parseDiff(diff: string): { sign: '+' | '-' | '@' | 'h' | ' '; line: string }[] {
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const start = lines.findIndex((line) => line.startsWith('@@'));
  if (start === -1) return [];
  return lines.slice(start).map((line) => {
    if (line.startsWith('@@')) return { sign: '@' as const, line };
    if (line.startsWith('\\')) return { sign: 'h' as const, line };
    const first = line[0];
    return { sign: first === '+' || first === '-' ? first : ' ', line };
  });
}

// A long path keeps its file name whole: the directory before it is muted and
// gives way first.
function pathElement(path: string): HTMLElement {
  const slash = path.lastIndexOf('/');
  return h('span', { class: 'path', title: path },
    slash === -1 ? null : h('span', { class: 'directory' }, path.slice(0, slash + 1)),
    h('span', {}, path.slice(slash + 1)),
  );
}

type Committing = { workspaceId: string; sawCommitting: boolean; subscription: Subscription | null; step: string };

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
  private committing: Committing | null = null;
  private drawn = '';
  private loading = false;
  private reloadAgain = false;
  private readonly root: HTMLElement;
  private readonly tree: HTMLElement;
  private readonly nav: HTMLElement;
  private readonly detail = h('main', {});
  private readonly message = h('textarea', { name: 'message', rows: '3' });
  private readonly openDiffs = new Set<string>();

  constructor(context: DesktopContext | PanelContext, layout: 'desktop' | 'panel') {
    this.context = context;
    this.layout = layout;
    this.selected = context.surfacePreferences.get<string | null>('selected', null);
    this.message.placeholder = this.t('changes.message_placeholder');
    this.tree = h('frontier-tree', { label: this.t('changes.workspaces') });
    this.tree.addEventListener('frontier-select', (event) => {
      const key = (event as CustomEvent<{ keys: string[] }>).detail.keys[0] ?? null;
      if (key !== null && key !== this.selected) this.select(key);
    });
    this.nav = h('nav', { class: 'workspaces', 'aria-label': this.t('changes.workspaces'), 'data-size': '300px', 'data-min': '220px', 'data-max': '480px' },
      h('frontier-stack', { fill: true, gap: '0' },
        h('frontier-row', { padding: '3' },
          h('h2', {}, this.t('changes.heading')),
          h('frontier-spacer'),
          h('button', { type: 'button', 'data-variant': 'ghost', 'data-size': 'small', 'aria-label': this.t('changes.refresh'), onclick: () => void this.reload() }, icon(...refreshIcon)),
        ),
        h('frontier-scroll', {}, h('frontier-stack', { padding: '2', gap: '2' }, this.tree)),
      ),
    );
    this.root = layout === 'desktop'
      ? h('frontier-split', { class: 'changes desktop' }, this.nav, h('hr'), this.detail)
      : h('div', { class: 'changes panel' });
  }

  private readonly t = (token: string, values: Record<string, string | number> = {}): string => text(this.context, token, values);

  private call<T>(methodId: string, input: Record<string, unknown> = {}): Promise<Result<T>> {
    return this.context.methods.call<T>(this.context.applicationId, methodId, input);
  }

  async start(): Promise<void> {
    document.body.append(style(css), this.root);
    this.context.store.watch('mounted/', () => void this.reload());
    this.context.lifecycle.onFocus(() => void this.reload());
    const timer = window.setInterval(() => {
      if (this.context.lifecycle.isFocused() || this.committing) void this.reload();
    }, 10_000);
    this.context.lifecycle.onUnmount(() => {
      window.clearInterval(timer);
      this.committing?.subscription?.unsubscribe();
    });
    await this.reload();
  }

  // A reload asked for while one runs runs again after it, so what it was
  // asked for after is always read.
  async reload(): Promise<void> {
    if (this.loading) {
      this.reloadAgain = true;
      return;
    }
    this.loading = true;
    try {
      await this.read();
    } finally {
      this.loading = false;
    }
    if (this.reloadAgain) {
      this.reloadAgain = false;
      await this.reload();
    }
  }

  private async read(): Promise<void> {
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
    this.followCommit();
    this.draw();
  }

  // A commit's publication can be lost with the connection; its outcome is
  // then read from the workspace's status, once it has been seen under way.
  private followCommit(): void {
    if (!this.committing) return;
    const last: CommitOutcome | null = this.statuses.get(this.committing.workspaceId)?.lastCommit ?? null;
    if (last?.state === 'committing') this.committing.sawCommitting = true;
    else if (last && this.committing.sawCommitting) this.finishCommit(last);
  }

  private select(workspaceId: string | null): void {
    this.selected = workspaceId;
    this.context.surfacePreferences.set('selected', workspaceId);
    this.notice = '';
    this.problem = '';
    this.openDiffs.clear();
    this.message.value = '';
    this.draw(true);
    void this.reload();
  }

  // Redraws only when what is shown changed, so a background refresh keeps
  // open diffs, their scroll and the focus where they are.
  private draw(force = false): void {
    const shown = JSON.stringify([this.workspaces, [...this.statuses], [...this.workerTitles], this.selected, this.log, this.problem, this.loadProblem, this.notice, this.committing?.step ?? null]);
    if (!force && shown === this.drawn) return;
    this.drawn = shown;
    const t = this.t;
    this.tree.setAttribute('selected', this.selected ?? '');
    fill(this.tree, h('ul', {}, ...this.workspaces.map((workspace) => {
      const status = this.statuses.get(workspace.workspaceId);
      const count = status?.files.length ?? 0;
      return h('li', { 'data-key': workspace.workspaceId },
        h('span', { class: 'entry', title: `${workspace.branch} · ${this.workerTitles.get(workspace.workerId) ?? t('changes.unknown_worker')}` },
          icon(...branchIcon),
          h('span', { class: 'entry-title' }, workspace.name),
          h('frontier-badge', { class: 'count', 'data-tone': status ? (count > 0 ? 'warning' : 'muted') : 'danger' },
            status ? t(count === 1 ? 'changes.one_change' : 'changes.count', { count }) : t('changes.unknown')),
        ),
      );
    })));
    const workspace = this.workspaces.find((entry) => entry.workspaceId === this.selected) ?? null;
    if (this.workspaces.length === 0) {
      fill(this.detail, h('frontier-empty', {},
        icon(...branchIcon),
        h('h2', {}, t('changes.empty_heading')),
        h('p', {}, t('changes.empty')),
        h('button', { type: 'button', onclick: () => void this.reload() }, t('changes.check_again')),
      ));
    } else if (workspace) {
      this.drawWorkspace(workspace);
    }
    if (this.layout === 'panel') fill(this.root, workspace || this.workspaces.length === 0 ? this.detail : this.nav);
  }

  private drawWorkspace(workspace: MountedWorkspace): void {
    const t = this.t;
    const status = this.statuses.get(workspace.workspaceId) ?? null;
    const files = status?.files ?? [];
    const busy = this.committing !== null;
    const worker = this.workerTitles.get(workspace.workerId) ?? t('changes.unknown_worker');
    const commitButton = h('button', { type: 'button', 'data-variant': 'primary', disabled: busy || files.length === 0, 'aria-busy': busy ? 'true' : undefined },
      files.length === 1 ? t('changes.commit_one') : t('changes.commit', { count: files.length }));
    commitButton.addEventListener('click', () => void this.commit(workspace));
    this.message.disabled = files.length === 0 || busy;
    fill(this.detail, h('frontier-stack', { fill: true, gap: '0' },
      h('frontier-row', { padding: '4', gap: '3' },
        this.layout === 'panel' ? h('button', { type: 'button', 'data-variant': 'ghost', 'aria-label': t('changes.back'), onclick: () => this.select(null) }, icon(...backIcon)) : null,
        h('frontier-stack', { gap: '1' },
          h('h2', {}, workspace.name),
          h('frontier-row', { wrap: true, gap: '2' },
            h('frontier-badge', { 'data-tone': files.length > 0 ? 'warning' : 'success' }, t(files.length === 1 ? 'changes.one_change' : 'changes.count', { count: files.length })),
            h('small', {}, t('changes.meta', { branch: status?.branch ?? workspace.branch, worker })),
          ),
        ),
      ),
      h('frontier-scroll', {}, h('frontier-stack', { class: 'detail', padding: '4', gap: '5' },
        this.problem ? h('div', { role: 'alert' }, this.problem) : null,
        this.loadProblem ? h('div', { role: 'status', 'data-tone': 'danger' }, this.loadProblem) : null,
        busy ? h('div', { role: 'status', 'data-tone': 'info' }, this.committing?.step ? `${this.committing.step}.` : t('changes.committing')) : null,
        !busy && this.notice ? h('div', { role: 'status', 'data-tone': 'success' }, this.notice) : null,
        h('dl', {},
          h('dt', {}, t('changes.branch')), h('dd', {}, h('code', {}, status?.branch ?? workspace.branch)),
          h('dt', {}, t('changes.upstream')), h('dd', {}, status?.upstream ? t('changes.tracking', { upstream: status.upstream, ahead: status.ahead, behind: status.behind }) : t('changes.no_upstream')),
          h('dt', {}, t('changes.directory')), h('dd', {}, h('code', {}, workspace.slotDirectory)),
        ),
        status ? h('section', { 'aria-label': t('changes.commit_section') },
          h('frontier-card', {},
            h('frontier-stack', { gap: '3' },
              h('label', {}, t('changes.message'), this.message),
              h('frontier-row', { wrap: true },
                h('small', {}, files.length === 0 ? t('changes.clean') : t('changes.commit_hint')),
                h('frontier-spacer'),
                commitButton,
              ),
            ),
          ),
        ) : null,
        h('section', { 'aria-labelledby': 'files-heading' },
          h('frontier-stack', { gap: '2' },
            h('h3', { id: 'files-heading' }, t('changes.files', { count: files.length })),
            ...files.map((file) => this.fileElement(workspace, file)),
          ),
        ),
        this.log.length > 0 ? h('section', { 'aria-labelledby': 'log-heading' },
          h('frontier-stack', { gap: '2' },
            h('h3', { id: 'log-heading' }, t('changes.log')),
            h('table', { class: 'log' },
              h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('changes.log_commit')), h('th', { scope: 'col' }, t('changes.log_subject')), h('th', { scope: 'col' }, t('changes.log_author')), h('th', { scope: 'col' }, t('changes.log_when')))),
              h('tbody', {}, ...this.log.map((commit) => h('tr', {},
                h('td', {}, h('code', {}, commit.shortHash)),
                h('td', {}, commit.subject),
                h('td', {}, commit.author),
                h('td', {}, new Intl.DateTimeFormat(this.context.currentSurface.language(), { dateStyle: 'medium', timeStyle: 'short' }).format(commit.at)),
              ))),
            ),
          ),
        ) : null,
      )),
    ));
  }

  private fileElement(workspace: MountedWorkspace, file: ChangedFile): HTMLElement {
    const t = this.t;
    const diff = h('pre', { class: 'diff', tabindex: '0', role: 'region', 'aria-label': t('changes.diff_of', { path: file.path }), 'aria-busy': 'true' }, t('changes.loading'));
    const discard = h('button', { type: 'button', 'data-variant': 'ghost', 'data-size': 'small', 'data-tone': 'danger' }, t('changes.discard'));
    discard.addEventListener('click', () => void this.discard(workspace, file));
    const element = h('details', { class: 'file', open: this.openDiffs.has(file.path) },
      h('summary', {},
        h('frontier-badge', { 'data-tone': kindTones[file.kind], title: t(`kind.${file.kind}`), 'aria-hidden': 'true' }, kindLetters[file.kind]),
        h('span', { class: 'visually-hidden' }, t(`kind.${file.kind}`)),
        file.originalPath ? pathElement(`${file.originalPath} → ${file.path}`) : pathElement(file.path),
      ),
      h('frontier-card', { 'data-variant': 'sunken' },
        h('frontier-stack', { gap: '2' },
          h('frontier-row', { justify: 'end' }, discard),
          diff,
        ),
      ),
    );
    const load = async () => {
      const answer = await this.call<{ diff: string; truncated: boolean; binary?: boolean }>('workspace-diff', { workspaceId: workspace.workspaceId, path: file.path });
      diff.removeAttribute('aria-busy');
      if (!answer.ok) {
        diff.textContent = answer.message;
        return;
      }
      const lines = parseDiff(answer.value.diff);
      const empty = answer.value.binary ? t('changes.binary') : t('changes.no_diff');
      fill(diff, ...(lines.length === 0 ? [h('span', { 'data-sign': 'h' }, empty)] : lines.map((line) => h('span', { 'data-sign': line.sign }, line.line))),
        answer.value.truncated ? h('span', { 'data-sign': 'h' }, t('changes.truncated')) : null);
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
    const committing: Committing = { workspaceId: workspace.workspaceId, sawCommitting: false, subscription: null, step: '' };
    this.committing = committing;
    this.problem = '';
    this.notice = '';
    this.draw();
    const subscribed = await this.context.methods.subscribe<CommitMessage>(this.context.applicationId, 'commit-workspace',
      { workspaceId: workspace.workspaceId, message: this.message.value },
      (message) => {
        if (message.state === 'step') this.showStep(committing, message.step);
        else if (message.state !== 'started') this.finishCommit(message);
      });
    if (!subscribed.ok) {
      this.finishCommit({ state: 'failed', message: subscribed.message });
      return;
    }
    if (this.committing === committing) committing.subscription = subscribed.value;
    else subscribed.value.unsubscribe();
  }

  private showStep(committing: Committing, step: string): void {
    if (this.committing !== committing) return;
    committing.step = step;
    this.draw();
  }

  private finishCommit(outcome: Exclude<CommitMessage, { state: 'started' | 'step' }> | Exclude<CommitOutcome, { state: 'committing' }>): void {
    if (!this.committing) return;
    this.committing.subscription?.unsubscribe();
    this.committing = null;
    if (outcome.state === 'committed') {
      this.message.value = '';
      this.problem = '';
      this.notice = this.t('changes.committed', { hash: outcome.commit.slice(0, 7), count: outcome.files });
      this.openDiffs.clear();
    } else {
      this.problem = outcome.message;
      this.notice = '';
    }
    this.draw();
    void this.reload();
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
