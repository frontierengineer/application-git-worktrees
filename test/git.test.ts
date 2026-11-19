import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { firstLine, runGit } from '../src/git.ts';

test('a git that runs past its deadline is killed and answered as not finished', async () => {
  const started = Date.now();
  const run = await runGit(['-c', 'alias.wait=!sleep 20', 'wait'], { cwd: tmpdir(), timeoutMilliseconds: 300 });
  assert.equal(run.code, null);
  assert.match(firstLine(run), /did not finish within/);
  assert.ok(Date.now() - started < 10_000);
});
