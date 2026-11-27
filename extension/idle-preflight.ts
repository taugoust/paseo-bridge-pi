export const IDLE_PREFLIGHT_KEY = "__piIdleContextPreflightV1";
// Paseo classifies native prompt failures containing "aborted" as cancellation.
export const IDLE_PROMPT_CANCELLED = "Request was aborted: prompt cancelled.";

export type IdlePreflightPayload = {
  text: string;
  images?: unknown[];
  streamingBehavior?: "steer" | "followUp";
};
export type IdlePreflightCapability = {
  ready: boolean;
  check(signal?: AbortSignal): Promise<"continue" | "cancel">;
  retainPrompt?(payload: IdlePreflightPayload, reason: string): boolean | Promise<boolean>;
};
export type IdlePreflightResult = "unavailable" | "continue" | "cancel" | "error";
export type IdlePreflightCheck = { outcome: IdlePreflightResult; error?: unknown };

export function safePromptError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown failure");
  const requestSafe = message.replace(/\brequest was aborted\b/gi, "request was interrupted");
  const safe = requestSafe.replace(/\babort(ed)?\b/gi, "interrupted");
  return safe.replace(/[\r\n\x00-\x1f\x7f]+/g, " ").slice(0, 500) || "Unknown failure";
}

/** Missing optional extension is a no-op; failed or aborted checks never send a prompt. */
export async function checkIdlePreflight(
  capability: unknown,
  signal: AbortSignal,
): Promise<IdlePreflightCheck> {
  if (signal.aborted) return { outcome: "cancel" };
  if (capability == null) return { outcome: "unavailable" };
  if (typeof capability !== "object" || !("ready" in capability) || !("check" in capability)) {
    return { outcome: "error", error: new Error("Invalid idle preflight capability") };
  }
  const candidate = capability as IdlePreflightCapability;
  if (candidate.ready !== true || typeof candidate.check !== "function") {
    return { outcome: "error", error: new Error("Idle preflight capability is not ready") };
  }
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<"cancel">((resolve) => {
    abortListener = () => resolve("cancel");
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const decision = await Promise.race([candidate.check(signal), aborted]);
    if (signal.aborted) return { outcome: "cancel" };
    return { outcome: decision === "continue" ? "continue" : "cancel" };
  } catch (error) {
    if (signal.aborted) return { outcome: "cancel" };
    return { outcome: "error", error };
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

/** Apply the bridge handshake and invoke dispatch only when safe. */
export async function dispatchAfterIdlePreflight<T>(
  capability: unknown,
  signal: AbortSignal,
  dispatch: () => Promise<T>,
): Promise<{ outcome: IdlePreflightResult; dispatched: boolean; value?: T; error?: unknown }> {
  const check = await checkIdlePreflight(capability, signal);
  if (signal.aborted) return { outcome: "cancel", dispatched: false };
  if (check.outcome === "cancel" || check.outcome === "error") {
    return {
      outcome: check.outcome,
      dispatched: false,
      ...(check.error !== undefined ? { error: check.error } : {}),
    };
  }
  return { outcome: check.outcome, dispatched: true, value: await dispatch() };
}
