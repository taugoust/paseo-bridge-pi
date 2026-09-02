export type ProviderReconnectLoopOptions = {
  shouldReconnect(): boolean;
  reload(): Promise<void>;
  onError?(error: unknown): void;
  delaysMs?: readonly number[];
};

export type ProviderReconnectLoop = {
  trigger(): void;
  connected(): void;
  stop(): void;
  runNow(): Promise<void>;
};

const DEFAULT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/**
 * Keep asking Paseo to reload an existing provider after its process disappears.
 * A successful CLI request is not proof that the provider has attached, so the
 * loop continues until shouldReconnect() observes the live RPC socket.
 */
export function createProviderReconnectLoop(
  options: ProviderReconnectLoopOptions,
): ProviderReconnectLoop {
  const delays = options.delaysMs?.length ? options.delaysMs : DEFAULT_DELAYS_MS;
  let enabled = false;
  let attempt = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (!enabled || running || timer !== undefined || !options.shouldReconnect()) return;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    timer = setTimeout(() => {
      timer = undefined;
      void runNow();
    }, delay);
    timer.unref?.();
  };

  const runNow = async () => {
    if (!enabled || running || !options.shouldReconnect()) return;
    clearTimer();
    running = true;
    try {
      await options.reload();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      if (enabled && options.shouldReconnect()) {
        attempt += 1;
        schedule();
      } else {
        attempt = 0;
      }
    }
  };

  return {
    trigger() {
      enabled = true;
      schedule();
    },
    connected() {
      clearTimer();
      attempt = 0;
    },
    stop() {
      enabled = false;
      clearTimer();
      attempt = 0;
    },
    runNow,
  };
}
