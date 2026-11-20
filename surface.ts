import type { ActionContext, SurfaceRegistration } from '../application';
import { mountChanges } from './src/view/changes.ts';

const WIDE = 'changes';
const COMPACT = 'changes-compact';

// Shows the Changes panel the deck already holds, the wide one first; where
// it holds neither, the wide one, or the compact one where the surface
// cannot show the wide one. A surface with no deck to show it in is not a
// fault, so it answers nothing.
async function reviewChanges(context: ActionContext) {
  const held = await context.panels.inDeck();
  const placed = held.ok ? (held.value.find(({ panelId }) => panelId === WIDE) ?? held.value.find(({ panelId }) => panelId === COMPACT)) : undefined;
  if (placed !== undefined) {
    const shown = await context.panels.show(placed.panelId);
    return shown.ok || shown.unavailable ? undefined : shown;
  }
  const wide = await context.panels.show(WIDE);
  if (wide.ok || !wide.unavailable) return wide.ok ? undefined : wide;
  const compact = await context.panels.show(COMPACT);
  return compact.ok || compact.unavailable ? undefined : compact;
}

export const registration = {
  panels: {
    [WIDE]: { mount: (context) => mountChanges(context, 'wide') },
    [COMPACT]: { mount: (context) => mountChanges(context, 'compact') },
  },
  actions: { 'review-changes': { run: (context) => reviewChanges(context) } },
} satisfies SurfaceRegistration;
