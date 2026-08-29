type RecordValue = Record<string, any>;

type ChildSpec = {
  index: number;
  task: string;
  agent?: string;
};

type Projection = {
  parentId: string;
  specs: ChildSpec[];
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function childSpecs(args: unknown): ChildSpec[] {
  if (!isRecord(args) || args.action !== undefined) return [];
  if (text(args.task)) {
    return [{ index: 0, task: text(args.task)!, agent: text(args.model) ?? text(args.agent) }];
  }
  const source = Array.isArray(args.tasks) ? args.tasks : Array.isArray(args.chain) ? args.chain : [];
  return source.flatMap((item, index) => {
    if (!isRecord(item) || !text(item.task)) return [];
    return [{ index, task: text(item.task)!, agent: text(item.model) ?? text(item.agent) }];
  });
}

function childId(parentId: string, index: number): string {
  return `${parentId}::paseo-child::${index}`;
}

function startEvent(parent: Projection, spec: ChildSpec): RecordValue {
  return {
    type: "tool_execution_start",
    toolCallId: childId(parent.parentId, spec.index),
    toolName: "subagent",
    args: {
      task: spec.task,
      ...(spec.agent ? { agent: spec.agent } : {}),
    },
  };
}

function resultChildren(result: unknown): RecordValue[] {
  if (!isRecord(result)) return [];
  const details = isRecord(result.details) ? result.details : undefined;
  const children = details?.results ?? result.results;
  return Array.isArray(children) ? children.filter(isRecord) : [];
}

function childLog(child: RecordValue, fallback?: unknown): string {
  const terminal = isRecord(child.terminal) ? child.terminal : undefined;
  const toolCall = isRecord(child.lastToolCall) ? child.lastToolCall : isRecord(child.activeTool) ? child.activeTool : undefined;
  const parts = [
    text(child.lastAssistantText),
    text(child.final),
    text(child.outputPrefix),
    toolCall ? `Running ${text(toolCall.name) ?? "tool"}${isRecord(toolCall.args) ? `: ${JSON.stringify(toolCall.args)}` : ""}` : undefined,
    text(child.lastToolResult),
    text(child.errorMessage) ?? text(child.error) ?? text(terminal?.message),
  ].filter((part): part is string => Boolean(part));
  if (parts.length) return [...new Set(parts)].join("\n\n");
  if (typeof fallback === "string") return fallback;
  if (isRecord(fallback) && Array.isArray(fallback.content)) {
    return fallback.content
      .filter((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part: RecordValue) => part.text)
      .join("\n");
  }
  return "";
}

function childFailed(child: RecordValue): boolean {
  const terminal = isRecord(child.terminal) ? child.terminal : undefined;
  const state = text(terminal?.state)?.toLowerCase();
  const stop = text(child.stopReason ?? child.stop_reason)?.toLowerCase();
  const exitCode = child.exitCode ?? child.exit_code ?? terminal?.exitCode ?? terminal?.exit_code;
  return Boolean(
    child.error ||
      child.errorMessage ||
      (typeof exitCode === "number" && exitCode > 0) ||
      (state && !["completed", "running"].includes(state)) ||
      (stop && ["error", "failed", "aborted", "cancelled", "canceled", "timeout", "timed_out"].includes(stop)),
  );
}

function projectedResult(child: RecordValue, fallback?: unknown): RecordValue {
  return {
    content: [{ type: "text", text: childLog(child, fallback) }],
    details: child,
  };
}

function childForSpec(children: RecordValue[], spec: ChildSpec): RecordValue | undefined {
  const byStep = children.find((child) => Number(child.step) === spec.index + 1);
  return byStep ?? children[spec.index];
}

export class SubagentTaskProjection {
  private readonly active = new Map<string, Projection>();

  project(event: unknown): RecordValue[] {
    if (!isRecord(event) || !text(event.type)) return [event as RecordValue];
    if (event.type === "tool_execution_start") {
      if (event.toolName !== "subagent" || typeof event.toolCallId !== "string") return [event];
      const specs = childSpecs(event.args);
      if (!specs.length) return [event];
      const projection = { parentId: event.toolCallId, specs };
      this.active.set(event.toolCallId, projection);
      return specs.map((spec) => startEvent(projection, spec));
    }

    if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return [event];
    const parent = typeof event.toolCallId === "string" ? this.active.get(event.toolCallId) : undefined;
    if (!parent) return [event];
    const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
    const children = resultChildren(result);
    const projected = parent.specs.map((spec) => {
      const child = childForSpec(children, spec) ?? {
        task: spec.task,
        errorMessage: event.type === "tool_execution_end" ? "Subagent did not start" : undefined,
      };
      if (event.type === "tool_execution_update") {
        return {
          type: "tool_execution_update",
          toolCallId: childId(parent.parentId, spec.index),
          toolName: "subagent",
          args: { task: spec.task, ...(spec.agent ? { agent: spec.agent } : {}) },
          partialResult: projectedResult(child, result),
        };
      }
      return {
        type: "tool_execution_end",
        toolCallId: childId(parent.parentId, spec.index),
        toolName: "subagent",
        result: projectedResult(child, result),
        isError: childFailed(child) || (children.length === 0 && event.isError === true),
      };
    });
    if (event.type === "tool_execution_end") this.active.delete(parent.parentId);
    return projected;
  }
}

export function projectSubagentMessages(messages: unknown[]): unknown[] {
  const calls = new Map<string, Projection>();
  const output: unknown[] = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      output.push(message);
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content: unknown[] = [];
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== "toolCall" || part.name !== "subagent" || typeof part.id !== "string") {
          content.push(part);
          continue;
        }
        const specs = childSpecs(part.arguments);
        if (!specs.length) {
          content.push(part);
          continue;
        }
        const projection = { parentId: part.id, specs };
        calls.set(part.id, projection);
        content.push(
          ...specs.map((spec) => ({
            ...part,
            id: childId(part.id, spec.index),
            arguments: { task: spec.task, ...(spec.agent ? { agent: spec.agent } : {}) },
          })),
        );
      }
      output.push({ ...message, content });
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const projection = calls.get(message.toolCallId);
      if (!projection) {
        output.push(message);
        continue;
      }
      const children = resultChildren(message);
      output.push(
        ...projection.specs.map((spec) => {
          const child = childForSpec(children, spec) ?? { task: spec.task, errorMessage: "Subagent did not start" };
          return {
            ...message,
            toolCallId: childId(projection.parentId, spec.index),
            content: [{ type: "text", text: childLog(child, message) }],
            details: child,
            isError: childFailed(child) || (children.length === 0 && message.isError === true),
          };
        }),
      );
      continue;
    }
    output.push(message);
  }
  return output;
}
