import type { WorkerRegistration } from '../application';
import { createGitWorktreeProvisioner } from './src/provisioner.ts';

export const registration = {
  workspaceProvisioner: {
    mount(context) {
      return createGitWorktreeProvisioner(context);
    },
  },
} satisfies WorkerRegistration;
