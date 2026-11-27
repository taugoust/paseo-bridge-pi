import type { IdlePreflightPayload } from "./idle-preflight.js";

export type PromptRetentionResult = "saved" | "unavailable" | "stale";

export function promptRecoveryMessage(payload: IdlePreflightPayload, saved: boolean): string {
  if (!saved) return "The original prompt may not have been saved; keep a copy.";
  const limitations = [
    ...(payload.images?.length ? ["Images"] : []),
    ...(payload.streamingBehavior ? ["delivery settings"] : []),
  ];
  const note = limitations.length
    ? ` ${limitations.join(" and ")} remain saved but are not restored.`
    : "";
  return `Run /idle-context recover to recover the saved text manually.${note}`;
}

export async function reportRejectedPrompt(input: {
  reason: string;
  cancelledMessage: string;
  capability: unknown;
  payload: IdlePreflightPayload;
  signal: AbortSignal;
  isCurrent(): boolean;
  sendFailure(message: string): void;
}): Promise<boolean> {
  if (input.signal.aborted || !input.isCurrent()) {
    input.sendFailure(input.cancelledMessage);
    return true;
  }
  const retention = await retainPromptIfCurrent({
    capability: input.capability,
    payload: input.payload,
    reason: input.reason,
    signal: input.signal,
    isCurrent: input.isCurrent,
  });
  if (retention === "stale") {
    input.sendFailure(input.cancelledMessage);
    return true;
  }
  const recovery = promptRecoveryMessage(input.payload, retention === "saved");
  input.sendFailure(`Prompt not sent: ${input.reason}. ${recovery}`);
  return true;
}

export async function retainPromptIfCurrent(input: {
  capability: unknown;
  payload: IdlePreflightPayload;
  reason: string;
  signal: AbortSignal;
  isCurrent(): boolean;
}): Promise<PromptRetentionResult> {
  if (input.signal.aborted || !input.isCurrent()) return "stale";
  if (typeof input.capability !== "object" || input.capability === null ||
    !("retainPrompt" in input.capability)) return "unavailable";
  const retainPrompt = input.capability.retainPrompt;
  if (typeof retainPrompt !== "function") return "unavailable";
  try {
    const saved = await retainPrompt.call(input.capability, input.payload, input.reason);
    if (input.signal.aborted || !input.isCurrent()) return "stale";
    return saved === true ? "saved" : "unavailable";
  } catch {
    return input.signal.aborted || !input.isCurrent() ? "stale" : "unavailable";
  }
}
