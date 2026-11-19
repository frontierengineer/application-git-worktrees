# Git worktrees

A Frontier Workspace Provisioner that gives each workspace its own git worktree
and branch beside a repository on a worker. It is one of Frontier's Initial
Applications, written against Frontier's Application Interface
(`interfaces/application.d.ts`) like any other Application.

Its id is `github.com/frontierengineer/application-git-worktrees`, the repository it
is published from.

## What it does

A person sets the provisioner up once for each repository on each worker, with
a number of slots. Each slot is a git worktree in a pool beside the repository.

- **Mount** gives the workspace the branch named from its name, `frontier/<name>`
  by default. A new name starts from the base it is given, else the configured
  base, else the remote's default branch, else the checkout's current commit. An
  existing name carries on from where its branch is, whatever base is given. A
  free worktree is reused before a new one is made.
- **Unmount** keeps everything uncommitted, untracked files included, as a
  commit under `refs/frontier/wip/<branch>`. It then cleans and detaches the
  worktree and returns it to the pool. The next mount of the name puts that work
  back as uncommitted changes. If saving fails, the workspace stays mounted.
- **Remove** deletes the workspace's branch and its saved work.
- **Check slot** says a worktree is gone only when the repository is readable
  and the worktree is not. When it cannot tell, it answers a failure.
- **Provision** fills the pool up to its slot count with free, detached worktrees.
- **List slots** and **measure** report each worktree's branch, commit, size and
  last change, within a call's wait: what cannot be read in 10 seconds is
  reported as unknown.
- **Teardown** removes every free worktree. It never touches the repository
  itself or any branch.

Every git run has a deadline, so a git that hangs never holds the repository:
an hour for a clone, 10 minutes for anything else.

Nothing is ever thrown away silently. Uncommitted work found in a free worktree
is kept under `refs/frontier/wip/<branch>`, or `refs/frontier/leftover/` when it
was on no branch, before the worktree is reused. Git locks left behind by a
killed git process are cleared once they are two minutes old.

## Reviewing changes

The Application also contributes **Changes**, two panels a person places in a
deck that list every workspace mounted in a git worktree, with what changed in each. For the
chosen workspace it shows the branch and where it tracks, each changed file
with its diff, and the latest commits. A person commits every change with a
message, or discards one file's changes after confirming, since that cannot be
undone. Each mount is recorded in the Application's store under `mounted/`, and
removed on unmount, so the views and methods know where each workspace is.
Changes is plain HTML and `frontier-*` elements, drawn by Frontier's Design
System in the person's own appearance. The wide panel needs a pointer and at
least 640 by 360 pixels, and shows the list beside the chosen workspace; the
one-at-a-time panel fits 320 by 320 and works by touch, showing the list, then
one workspace.

The work is done by host methods that agents and other Applications call too,
running git on the workspace's worker through the context. A read is cut at 20
seconds, inside the 30 seconds a call waits: the git is killed, and the answer
says what did not finish and whether trying again can help. A commit runs the repository's
hooks, which can take longer, so `commit-workspace` is a publication: it says
it started at once, then each step (adding, committing, and each hook as git
starts it, read from git's trace2 events), then how it ended, and runs to its end if its subscriber
leaves; `workspace-status` reports how the last one ended.

| Method | What it does |
| --- | --- |
| `list-workspaces` | Every workspace mounted in a git worktree. |
| `workspace-status` | A workspace's branch, upstream, and every changed file with its kind. |
| `workspace-diff` | One file's changes against its last commit, untracked files included. |
| `workspace-log` | The branch's latest commits. |
| `commit-workspace` | A subscription: commits every change, or the given files, with a message, publishing `started`, each `step`, then `committed` or `failed`. |
| `discard-changes` | Returns the given files to their last commit. |

## Configuration

| Field | Meaning |
| --- | --- |
| Repository | The git checkout on the worker, absolute or starting with `~/`. Required. |
| Clone from | A URL cloned into the repository path when nothing is there yet. |
| Base | The branch or commit new workspaces start from. |
| Branch prefix | Put before each workspace's name to make its branch. Default `frontier/`. |
| Worktree directory | Where the worktrees live. Default `.frontier-worktrees/<repository name>` beside the repository. |

## Layout

| Path | What |
| --- | --- |
| `contributions.json` | The Application as data: its provisioner, configuration fields and slots. |
| `worker.ts` | The worker bundle's registration. |
| `src/provisioner.ts` | The provisioner's hooks. |
| `host.ts`, `src/review.ts` | The review methods. |
| `surface.ts`, `src/view/` | The two Changes panels. |
| `src/git.ts` | Running git, with stale lock recovery. |
| `translations.json` | Every message a person reads, by token. |
| `test/` | Unit tests against real git repositories in temporary directories, and a browser test of Changes. |

## Developing

The Application is checked the way it ships, against a Frontier checkout:

```sh
npm test            # or: node scripts/check.mjs
```

It type-checks every bundle against the checkout's Application Interface
(`interfaces/application.d.ts`), runs the tests with Node's test runner, and
bundles each entry file the way the Host does. It finds the checkout at
`../../frontier` (a `frontier` beside the directory holding this repository), or
at `FRONTIER_REPO`, and borrows TypeScript, esbuild, Playwright and Node's types from it,
so that checkout's dependencies must be installed. It needs Node.js 22.6 or
later and git. No test reaches the network; the tests work on real git repositories in a temporary directory.

The browser test draws both Changes panels inside the Design
System the checkout provides, in the dark and the light scheme; with
`VIEW_SHOTS=<directory>` it keeps a screenshot of each.

To try it in Frontier itself, put this repository in the `applications`
directory beside a Frontier checkout, as `git-worktrees`; a Source Build of that
checkout carries every Application there as an Initial Application, so a new
install starts with it. From the checkout, `bash modcon/scripts/tool.sh ui
--remake --applications <that directory>` makes the Electron app with them and
photographs it.

## License

MIT, as `LICENSE` states.
