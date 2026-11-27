import * as path from "node:path";
import {
	writeAccountControlsDescriptor,
	removeAccountControlsDescriptor,
} from "./account-controls-operator.js";

// Reuses the private descriptor writer in its own directory, like workflows.
export const subagentRoutingSocketPath = (pipe) => `${pipe}.subagent-routing`;
export const writeSubagentRoutingDescriptor = (base, descriptor) =>
	writeAccountControlsDescriptor(path.join(base, "subagents"), descriptor);
export const removeSubagentRoutingDescriptor = (base, agentId, epoch) =>
	removeAccountControlsDescriptor(path.join(base, "subagents"), agentId, epoch);
