export function subagentRoutingSocketPath(bridgeSocket: string): string;
export function subagentRoutingDescriptorPath(baseDir: string, agentId: string): string;
export function writeSubagentRoutingDescriptor(baseDir: string, descriptor: any): string;
export function removeSubagentRoutingDescriptor(baseDir: string, agentId: string, runtimeEpoch: string): void;
export function validateSubagentRoutingEnvelope(value: unknown, identity: any): boolean;
export function subagentRoutingCapability(): string;
