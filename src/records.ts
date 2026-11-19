export interface MountedWorkspace {
  workspaceId: string;
  name: string;
  branch: string;
  workerId: string;
  slotDirectory: string;
  repository: string;
  workspaceProvisionerId: string;
  mountedAt: number;
}

export function mountedKey(workspaceId: string): string {
  return `mounted/${keyPart(workspaceId)}`;
}

// How the last commit in a workspace ended, kept so a view that lost the
// commit's publication still reads its outcome.
export type CommitOutcome =
  | { state: 'committing'; at: number }
  | { state: 'committed'; at: number; commit: string; files: number }
  | { state: 'failed'; at: number; message: string };

function keyPart(workspaceId: string): string {
  return workspaceId.replace(/[^A-Za-z0-9._-]/g, (character) => `_${character.charCodeAt(0).toString(16)}`);
}

export function commitKey(workspaceId: string): string {
  return `commits/${keyPart(workspaceId)}`;
}
