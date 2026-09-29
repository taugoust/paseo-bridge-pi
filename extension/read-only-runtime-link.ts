import { processStartToken, readRuntimeRecords } from "../shim/runtime-registry.js";

export type ExactChildIdentity = { taskId: string; childId: string; groupId: string; runtimeId: string; attempt: number };
export type PaseoRuntimeLink = { available: boolean; agentId: string | null; workspaceId: string | null; reason: string | null };
const unavailable = (reason: string): PaseoRuntimeLink => ({ available: false, agentId: null, workspaceId: null, reason });

/** Resolve only an exact, current, process-identity-verified child runtime. */
export function resolvePaseoChildRuntimeLink(ownerSessionId: string, identity: ExactChildIdentity,
  records: any[] = readRuntimeRecords(), tokenForPid: (pid: number) => string | null = processStartToken): PaseoRuntimeLink {
  if (!ownerSessionId || !identity || typeof identity.taskId !== "string" || typeof identity.childId !== "string"
    || typeof identity.groupId !== "string" || typeof identity.runtimeId !== "string"
    || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1) return unavailable("Incomplete exact child identity.");
  const exact = records.filter((record: any) => record.lifecycle === "active" && record.managed === true
    && record.parentSessionId === ownerSessionId && record.taskId === identity.taskId && record.childId === identity.childId
    && record.groupId === identity.groupId && record.runtimeId === identity.runtimeId && Number(record.attempt) === identity.attempt);
  const live = exact.filter((record: any) => Number.isSafeInteger(record.pid) && record.pid > 0
    && typeof record.processStartToken === "string" && tokenForPid(record.pid) === record.processStartToken
    && typeof record.agentId === "string" && record.agentId && typeof record.workspaceId === "string" && record.workspaceId);
  if (live.length !== 1) return unavailable(live.length > 1 ? "Child runtime identity is ambiguous." : "No matching live Paseo child runtime.");
  return { available: true, agentId: live[0].agentId, workspaceId: live[0].workspaceId, reason: null };
}
