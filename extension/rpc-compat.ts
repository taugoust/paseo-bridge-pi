/** Match Pi's native RPC error wording so provider compatibility fallbacks work. */
export function unknownRpcCommandError(type: unknown): string {
  const command = typeof type === "string" && type.length > 0 ? type : "unknown";
  return `Unknown command: ${command}`;
}
