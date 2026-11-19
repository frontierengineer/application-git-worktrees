import type { HostRegistration } from '../application';
import { commitWorkspace, discardChanges, listWorkspaces, workspaceDiff, workspaceLog, workspaceStatus } from './src/review.ts';

export const registration = {
  methods: {
    'list-workspaces': { call: (context) => listWorkspaces(context) },
    'workspace-status': { call: (context, input: Record<string, unknown>) => workspaceStatus(context, input) },
    'workspace-diff': { call: (context, input: Record<string, unknown>) => workspaceDiff(context, input) },
    'workspace-log': { call: (context, input: Record<string, unknown>) => workspaceLog(context, input) },
    'commit-workspace': { subscribe: (context, input: Record<string, unknown>) => commitWorkspace(context, input) },
    'discard-changes': { call: (context, input: Record<string, unknown>) => discardChanges(context, input) },
  },
} satisfies HostRegistration;
