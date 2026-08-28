export function selectionFromPaseoResolution(payload: any, fallback: string | undefined): string | undefined {
  const resolution = payload?.resolution;
  if (!resolution || typeof resolution !== "object") return fallback;
  if (resolution.behavior === "deny") return undefined;
  const answer = resolution.updatedInput?.answers?.Response;
  return typeof answer === "string" ? answer : fallback;
}

export async function coordinateMirroredSelect(options: {
  remoteResult: Promise<string | undefined>;
  localSelect: (signal: AbortSignal) => Promise<string | undefined>;
  resolveLocal: (value: string | undefined) => Promise<unknown>;
  finishRemote: (value: string | undefined) => void;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const localController = new AbortController();
  const abortLocal = () => localController.abort();
  if (options.signal) {
    if (options.signal.aborted) localController.abort();
    else options.signal.addEventListener("abort", abortLocal, { once: true });
  }

  try {
    const winner = await Promise.race([
      options.remoteResult.then((value) => ({ source: "remote" as const, value })),
      Promise.resolve()
        .then(() => options.localSelect(localController.signal))
        .then((value) => ({ source: "local" as const, value })),
    ]);
    if (winner.source === "remote") {
      localController.abort();
      return winner.value;
    }

    const settled = await Promise.race([
      options.resolveLocal(winner.value).then((payload) => ({ source: "daemon" as const, payload })),
      options.remoteResult.then((value) => ({ source: "remote" as const, value })),
    ]);
    if (settled.source === "remote") return settled.value;
    const authoritative = selectionFromPaseoResolution(settled.payload, winner.value);
    options.finishRemote(authoritative);
    return authoritative;
  } finally {
    options.signal?.removeEventListener("abort", abortLocal);
  }
}
