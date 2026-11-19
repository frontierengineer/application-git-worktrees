import type { ActionContext, SurfaceRegistration } from '../application';
import { mountChanges } from './src/view/changes.ts';

async function reviewChanges(context: ActionContext) {
  const wide = await context.panels.reveal('changes');
  if (wide.ok || !wide.unavailable) return wide.ok ? undefined : wide;
  const compact = await context.panels.reveal('changes-compact');
  return compact.ok || compact.unavailable ? undefined : compact;
}

export const registration = {
  panels: {
    changes: { mount: (context) => mountChanges(context, 'wide') },
    'changes-compact': { mount: (context) => mountChanges(context, 'compact') },
  },
  actions: { 'review-changes': { run: (context) => reviewChanges(context) } },
} satisfies SurfaceRegistration;
