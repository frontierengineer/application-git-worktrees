# Git worktrees

A Frontier Workspace Provisioner that gives each workspace its own git worktree
and branch beside a repository on a worker. It is one of Frontier's Initial
Applications, written against Frontier's Application Interface
(`interfaces/application.d.ts`) like any other Application.

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
  last change.
- **Teardown** removes every free worktree. It never touches the repository
  itself or any branch.

Nothing is ever thrown away silently. Uncommitted work found in a free worktree
is kept under `refs/frontier/wip/<branch>`, or `refs/frontier/leftover/` when it
was on no branch, before the worktree is reused. Git locks left behind by a
killed git process are cleared once they are two minutes old.

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
| `src/git.ts` | Running git, with stale lock recovery. |
| `translations.json` | Every message a person reads, by token. |
| `test/` | Unit tests against real git repositories in temporary directories. |

## Checking it

```sh
node scripts/check.mjs
```

It type-checks the sources against a Frontier checkout's Application Interface,
runs the tests with Node's test runner, and bundles `worker.ts` the way the Host
does. It looks for the checkout at `../../frontier`, or at `FRONTIER_REPO`. It
needs git and Node.js 22.6 or later.

## License

MIT
