import type { BtwIdentity } from "./btw-operator.js";
export function subagentRoutingSocketPath(pipe: string): string;
export function writeSubagentRoutingDescriptor(
	base: string,
	descriptor: BtwIdentity & { version: 1; socketPath: string },
): string;
export function removeSubagentRoutingDescriptor(
	base: string,
	agentId: string,
	epoch: string,
): void;
