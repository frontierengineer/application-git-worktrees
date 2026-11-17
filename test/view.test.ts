import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontier = process.env.FRONTIER_REPO || join(root, '..', '..', 'frontier');
const playwrightEntry = join(frontier, 'node_modules', 'playwright', 'index.mjs');
const esbuildEntry = join(frontier, 'node_modules', 'esbuild', 'lib', 'main.js');
const available = existsSync(playwrightEntry) && existsSync(esbuildEntry);

type Locator = { textContent(): Promise<string | null>; click(): Promise<void>; fill(value: string): Promise<void>; waitFor(): Promise<void>; count(): Promise<number>; first(): Locator; isDisabled(): Promise<boolean> };
type Page = {
  setContent(html: string): Promise<void>;
  addScriptTag(options: { content: string }): Promise<unknown>;
  evaluate<T>(code: string): Promise<T>;
  locator(selector: string): Locator;
  getByRole(role: string, options?: Record<string, unknown>): Locator;
  getByText(text: string, options?: Record<string, unknown>): Locator;
  getByLabel(text: string, options?: Record<string, unknown>): Locator;
  screenshot(options: { path: string }): Promise<unknown>;
};

let browser: { newPage(options?: Record<string, unknown>): Promise<Page>; close(): Promise<void> } | null = null;
let bundle = '';

before(async () => {
  if (!available) return;
  const { buildSync } = (await import(esbuildEntry)) as { buildSync: (options: Record<string, unknown>) => { outputFiles: { text: string }[] } };
  bundle = buildSync({ entryPoints: [join(root, 'test', 'view', 'page.ts')], bundle: true, format: 'iife', platform: 'browser', write: false, absWorkingDir: root }).outputFiles[0]!.text;
  const { chromium } = (await import(playwrightEntry)) as { chromium: { launch(): Promise<typeof browser> } };
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

test('Changes lists the mounted git workspaces, shows a file\'s diff, discards after confirming, and commits', { skip: available ? false : 'Playwright or esbuild is not in the Frontier checkout' }, async () => {
  const page = await browser!.newPage({ viewport: { width: 1100, height: 760 } });
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate('window.mountView()');
  await page.getByRole('heading', { name: 'fix-login' }).waitFor();
  assert.deepEqual(await page.evaluate<string[]>("[...document.querySelectorAll('aside li .count')].map((element) => element.textContent)"), ['2 changes', '0 changes']);
  assert.equal(await page.getByText('Changed files (2)').count(), 1);
  await page.getByText('src/login.ts').click();
  await page.locator('.diff [data-sign="+"]').first().waitFor();
  assert.equal(await page.locator('.diff [data-sign="+"]').first().textContent(), '+await page.waitForURL("/home");');
  if (process.env.CHANGES_SCREENSHOT) await page.screenshot({ path: process.env.CHANGES_SCREENSHOT });

  await page.evaluate('window.setConfirm(false)');
  await page.getByRole('button', { name: 'Discard changes' }).first().click();
  assert.equal((await page.evaluate<{ method: string }[]>('window.calls')).some((call) => call.method === 'discard-changes'), false);
  await page.evaluate('window.setConfirm(true)');
  await page.getByRole('button', { name: 'Discard changes' }).first().click();
  await page.getByText('Discarded the changes to src/login.ts.').waitFor();
  assert.equal(await page.getByText('Changed files (1)').count(), 1);

  await page.getByRole('button', { name: 'Commit 1 change' }).click();
  await page.getByText('Write a commit message to commit.').waitFor();
  await page.getByLabel('Commit message').fill('fail');
  await page.getByRole('button', { name: 'Commit 1 change' }).click();
  await page.getByText('Git refused: Author identity unknown.').waitFor();
  await page.getByLabel('Commit message').fill('Add the login test');
  await page.getByRole('button', { name: 'Commit 1 change' }).click();
  await page.getByText('Committed bbbbbbb with 1 changed files.').waitFor();
  assert.equal(await page.getByText('Every change is committed.').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Commit 0 changes' }).isDisabled(), true);
  const commit = (await page.evaluate<{ method: string; input: Record<string, unknown> }[]>('window.calls')).filter((call) => call.method === 'commit-workspace').pop();
  assert.deepEqual(commit?.input, { workspaceId: 'ws-1', message: 'Add the login test' });
});
