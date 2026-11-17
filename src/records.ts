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
  return `mounted/${workspaceId.replace(/[^A-Za-z0-9._-]/g, (character) => `_${character.charCodeAt(0).toString(16)}`)}`;
}
