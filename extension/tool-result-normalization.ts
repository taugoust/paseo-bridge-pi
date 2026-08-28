type ToolExecutionEndEvent = {
  type: "tool_execution_end";
  isError?: boolean;
  result?: unknown;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNoDetails(value: unknown): boolean {
  return value === undefined || value === null || (isRecord(value) && Object.keys(value).length === 0);
}

function textOnlyFailedResult(result: unknown): string | null {
  if (!isRecord(result)) return null;
  if (Object.keys(result).some((key) => key !== "content" && key !== "details")) return null;
  if (!hasNoDetails(result.details) || !Array.isArray(result.content) || result.content.length === 0) return null;

  const text: string[] = [];
  for (const part of result.content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return null;
    text.push(part.text);
  }
  const joined = text.join("\n");
  return joined.length > 0 ? joined : null;
}

/**
 * Paseo v0.6.1 stringifies failed Pi tool results whose content uses Pi's
 * text-block array shape. Unwrap only the lossless case; preserve structured
 * or metadata-bearing failures for Paseo's normal adapter.
 */
export function normalizePiEventForPaseo(event: unknown): unknown {
  if (!isRecord(event) || event.type !== "tool_execution_end" || event.isError !== true) return event;
  const text = textOnlyFailedResult(event.result);
  if (text === null) return event;
  return { ...(event as ToolExecutionEndEvent), result: text };
}
