import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionContext, DeckPanel } from '../../application';
import { registration } from '../surface.ts';

type Answer = { ok: true; value: undefined } | { ok: false; unavailable: true; message: string } | { ok: false; retriable: boolean; message: string };

const done: Answer = { ok: true, value: undefined };
const unavailable: Answer = { ok: false, unavailable: true, message: 'this surface places no panel by itself' };

function review(held: readonly DeckPanel[] | null, answers: Record<string, Answer>) {
  const shown: string[] = [];
  const context = {
    panels: {
      inDeck: async () => (held === null ? unavailable : { ok: true as const, value: held }),
      show: async (panelId: string, values?: unknown, options?: unknown) => {
        assert.equal(values, undefined, 'Review changes gives a panel no values');
        assert.equal(options, undefined, 'Review changes reuses what the deck holds');
        shown.push(panelId);
        return answers[panelId] ?? done;
      },
    },
  } as unknown as ActionContext;
  return { shown, run: () => registration.actions['review-changes'].run(context) };
}

const panel = (panelId: string): DeckPanel => ({ instanceId: `i-${panelId}`, panelId, values: {}, front: false });

test('Review changes brings forward the Changes panel the deck holds, the wide one before the compact one', async () => {
  const both = review([panel('changes-compact'), panel('changes')], {});
  assert.equal(await both.run(), undefined);
  assert.deepEqual(both.shown, ['changes']);
  const compact = review([panel('changes-compact')], {});
  assert.equal(await compact.run(), undefined);
  assert.deepEqual(compact.shown, ['changes-compact'], 'a deck holding only the compact panel shows it, rather than gaining a wide one');
});

test('with neither in the deck it shows the wide panel, and the compact one where the surface cannot show the wide one', async () => {
  const wide = review([], {});
  assert.equal(await wide.run(), undefined);
  assert.deepEqual(wide.shown, ['changes']);
  const narrow = review([], { changes: unavailable });
  assert.equal(await narrow.run(), undefined);
  assert.deepEqual(narrow.shown, ['changes', 'changes-compact']);
  const nowhere = review(null, { changes: unavailable, 'changes-compact': unavailable });
  assert.equal(await nowhere.run(), undefined, 'a surface with no deck to show it in is not a fault');
  assert.deepEqual(nowhere.shown, ['changes', 'changes-compact']);
});

test('a failure to show is answered, and the compact panel is not tried after one', async () => {
  const failure: Answer = { ok: false, retriable: true, message: 'the deck could not be read' };
  const failed = review([], { changes: failure });
  assert.deepEqual(await failed.run(), failure);
  assert.deepEqual(failed.shown, ['changes']);
  const placed = review([panel('changes')], { changes: failure });
  assert.deepEqual(await placed.run(), failure);
});
