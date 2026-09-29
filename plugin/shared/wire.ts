export type PermissionGateDescriptor = {
  version: 1;
  socketPath: string;
  capability: string;
  agentId: string;
  sessionId: string;
  runtimeEpoch: string;
};

export type PermissionGateWireResponse = {
  v: 1;
  type: "permission_gate_mode";
  id: string;
  success: boolean;
  data?: { agentId: string; sessionId: string; runtimeEpoch: string; enabled: boolean };
  error?: string;
};

export function validateDescriptor(value: unknown, agentId: string): value is PermissionGateDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return Object.keys(d).sort().join(",") === "agentId,capability,runtimeEpoch,sessionId,socketPath,version"
    && d.version === 1 && typeof d.socketPath === "string" && d.socketPath.startsWith("/") && d.socketPath.length <= 4096
    && typeof d.capability === "string" && /^[a-f0-9]{64}$/.test(d.capability)
    && d.agentId === agentId && typeof d.sessionId === "string" && d.sessionId.length > 0 && d.sessionId.length <= 256
    && typeof d.runtimeEpoch === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(d.runtimeEpoch);
}

export function descriptorMatchesExpectedSession(descriptor: PermissionGateDescriptor, sessionId: string, runtimeEpoch: string): boolean {
  return descriptor.sessionId === sessionId && descriptor.runtimeEpoch === runtimeEpoch;
}

export function validateWireResponse(
  value: unknown,
  requestId: string,
  descriptor: PermissionGateDescriptor,
): value is PermissionGateWireResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (response.v !== 1 || response.type !== "permission_gate_mode" || response.id !== requestId || typeof response.success !== "boolean") return false;
  if (!response.success) return Object.keys(response).sort().join(",") === "error,id,success,type,v" && typeof response.error === "string";
  if (Object.keys(response).sort().join(",") !== "data,id,success,type,v") return false;
  const data = response.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const fields = data as Record<string, unknown>;
  return Object.keys(fields).sort().join(",") === "agentId,enabled,runtimeEpoch,sessionId"
    && fields.agentId === descriptor.agentId && fields.sessionId === descriptor.sessionId
    && fields.runtimeEpoch === descriptor.runtimeEpoch && typeof fields.enabled === "boolean";
}
