type IdleContext = { isIdle(): boolean; hasPendingMessages(): boolean };

export function isRuntimeReloadCommand(message: string): boolean {
  return /^\/(?:reload|paseo-reload)(?:\s|$)/.test(message.trim());
}

export function requireIdleReload(
  ctx: IdleContext | null,
  options: { reloading?: boolean; compacting?: boolean; pendingUi?: boolean; pendingRpc?: boolean } = {},
): void {
  if (options.reloading) throw new Error("Pi runtime reload is already in progress.");
  if (!ctx || !ctx.isIdle() || ctx.hasPendingMessages() || options.compacting || options.pendingUi || options.pendingRpc) {
    throw new Error("Pi must be idle before reloading. Finish or interrupt the parent's current turn first; do not cancel its background jobs.");
  }
}

export function validateReloadPrompt(message: string, images?: unknown[]): void {
  if (!/^\/(?:reload|paseo-reload)\s*$/.test(message.trim()) || images?.length) {
    throw new Error("Usage: /reload or /paseo-reload, without arguments or attachments.");
  }
}
