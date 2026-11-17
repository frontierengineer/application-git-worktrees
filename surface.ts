import type { ActionContext, SurfaceRegistration } from '../application';
import { mountChanges } from './src/view/changes.ts';

async function reviewChanges(context: ActionContext) {
  const desktop = await context.desktop.focus();
  if (desktop.ok || !desktop.unavailable) return desktop.ok ? undefined : desktop;
  const panel = await context.panel.open();
  return panel.ok ? undefined : panel;
}

export const registration = {
  desktop: { mount: (context) => mountChanges(context, 'desktop') },
  panel: { mount: (context) => mountChanges(context, 'panel') },
  actions: { 'review-changes': { run: (context) => reviewChanges(context) } },
} satisfies SurfaceRegistration;
