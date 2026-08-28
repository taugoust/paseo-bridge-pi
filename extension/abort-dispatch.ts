export type AbortContext = {
  abort(): void;
  isIdle(): boolean;
};

type AbortWaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_POLL_MS = 25;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Pi's extension ctx.abort() is intentionally fire-and-forget even though the
 * underlying AgentSession.abort() waits for the active tool and turn to settle.
 * Do not acknowledge Paseo's RPC abort until the extension context is idle.
 */
export async function abortAndWaitForIdle(
  context: AbortContext | undefined,
  options: AbortWaitOptions = {},
): Promise<void> {
  if (!context) return;

  context.abort();
  if (context.isIdle()) return;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;

  while (!context.isIdle()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Pi did not become idle after cancellation");
    }
    await sleep(Math.min(pollMs, remaining));
  }
}
