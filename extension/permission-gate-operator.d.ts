export type PermissionGateOperatorDescriptorV1 = {
  version: 1;
  socketPath: string;
  capability: string;
  agentId: string;
  sessionId: string;
  runtimeEpoch: string;
};
export type PermissionGateOperatorModeV1 = { sessionId: string; enabled: boolean };
export type PermissionGateOperatorV1 = {
  status(sessionId: string): PermissionGateOperatorModeV1;
  applyMode(sessionId: string, enabled: boolean): PermissionGateOperatorModeV1;
};
export type PermissionGateOperatorIdentityV1 = {
  descriptor: PermissionGateOperatorDescriptorV1;
  authority(): PermissionGateOperatorV1 | undefined;
};
export function handlePermissionGateOperatorRequest(value: unknown, identity: PermissionGateOperatorIdentityV1): Record<string, unknown>;
export function decodePermissionGateOperatorFrame(frame: Buffer): unknown;
export function permissionGateOperatorSocketPath(bridgeSocket: string): string;
export function permissionGateOperatorDescriptorPath(baseDir: string, agentId: string): string;
export function writePermissionGateOperatorDescriptor(baseDir: string, descriptor: PermissionGateOperatorDescriptorV1): string;
export function removePermissionGateOperatorDescriptor(baseDir: string, agentId: string, runtimeEpoch: string): void;
