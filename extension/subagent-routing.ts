/**
 * Relays Paseo's subagent provider requests to Pi's subagent routing service,
 * `__paeSubagentRoutingV1` from pi-agent-extensions. Older Pi extensions don't
 * publish it, and then Paseo hides the choice.
 */

export interface SubagentRoutingSelection {
  providerId: string;
  /** null selects the provider's default login. */
  accountId: string | null;
}

export interface SubagentRoutingService {
  protocol: 1;
  sessionId: string;
  serviceEpoch: string;
  getSnapshot(request: { sessionId: string }): Promise<unknown>;
  set(request: {
    expectedSessionId: string;
    expectedServiceEpoch: string;
    expectedRevision: number;
    selection: SubagentRoutingSelection | null;
  }): Promise<unknown>;
}

/**
 * A request from Paseo. The endpoint has already checked that sessionId and
 * serviceEpoch belong to this session.
 */
export type SubagentRoutingRequest =
  | { operation: "snapshot" | "providers"; sessionId: string; serviceEpoch: string }
  | {
      operation: "set";
      sessionId: string;
      serviceEpoch: string;
      expectedRevision: number;
      selection: SubagentRoutingSelection | null;
    };

interface ModelSource {
  modelRegistry: { getAvailable(): Array<{ provider: string; api?: string }> };
}

/** The service Pi publishes for this session, if any. */
export function subagentRoutingService(
  sessionId: string | undefined,
): SubagentRoutingService | undefined {
  const service = (globalThis as Record<string, any>).__paeSubagentRoutingV1;
  if (!service || !sessionId) return undefined;
  const usable =
    service.protocol === 1 &&
    service.sessionId === sessionId &&
    typeof service.serviceEpoch === "string" &&
    typeof service.getSnapshot === "function" &&
    typeof service.set === "function";
  return usable ? service : undefined;
}

/** Providers the user is logged in to, sorted, without Pi's virtual ones. */
export function availableProviders(ctx: ModelSource): string[] {
  const models = ctx.modelRegistry.getAvailable();
  const physical = models.filter((model) => model.api !== "pi-virtual");
  return [...new Set(physical.map((model) => model.provider))].sort();
}

export async function runSubagentRouting(
  service: SubagentRoutingService,
  ctx: ModelSource,
  request: SubagentRoutingRequest,
): Promise<unknown> {
  switch (request.operation) {
    case "snapshot":
      return service.getSnapshot({ sessionId: request.sessionId });
    case "providers":
      return availableProviders(ctx);
    case "set":
      return service.set({
        expectedSessionId: request.sessionId,
        expectedServiceEpoch: request.serviceEpoch,
        expectedRevision: request.expectedRevision,
        selection: request.selection,
      });
    default:
      throw new Error("Unknown subagent routing operation");
  }
}
