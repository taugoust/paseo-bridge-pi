type RecordValue = Record<string, any>;
type BackgroundSubagentResult = RecordValue & { details: RecordValue };

type ChildSpec = {
  index: number;
  task: string;
  agent?: string;
};

type ProjectedUpdateState = {
  fingerprint: string;
  structuralFingerprint: string;
  emittedAt: number;
};

type Projection = {
  parentId: string;
  specs: ChildSpec[];
  updates: Map<number, ProjectedUpdateState>;
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function childSpecs(args: unknown): ChildSpec[] {
  if (!isRecord(args) || args.action !== undefined || args.operation !== undefined || args.background === true) return [];
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

function isBackgroundSubagentResult(result: unknown): result is BackgroundSubagentResult {
  return isRecord(result) && isRecord(result.details) && result.details.background_subagent === true;
}

function projectedBackgroundResult(result: RecordValue, spec: ChildSpec): RecordValue {
  return {
    ...result,
    details: {
      ...result.details,
      task: spec.task,
    },
  };
}

const MAX_PROJECTED_LOG_BYTES = 16 * 1024;
const MAX_PROJECTED_TEXT_BYTES = 2 * 1024;

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n\n… truncated`;
}

function taskOutcome(child: RecordValue): RecordValue | undefined {
  const value = isRecord(child.task_outcome) ? child.task_outcome : undefined;
  if (!value || !["delivered","partial","blocked","checkpointed","unreported"].includes(value.state)) return undefined;
  return {state:value.state==='delivered'&&value.reported!==true?'unreported':value.state,reported:value.reported===true,summary:truncateUtf8(text(value.summary)??"",1024),...(text(value.next_action)?{next_action:truncateUtf8(value.next_action,1024)}:{})};
}

function outcomeTitle(outcome: RecordValue): string {
  return ({delivered:"Reported delivered",partial:"Needs continuation",blocked:"Blocked",checkpointed:"Checkpoint saved",unreported:"Outcome not reported"} as Record<string,string>)[outcome.state];
}

function lastVisibleAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for(let index=messages.length-1;index>=Math.max(0,messages.length-20);index--) {
    const message=messages[index];
    if(message?.role!=="assistant"||!Array.isArray(message.content))continue;
    const value=message.content.filter((part:any)=>part?.type==="text"&&typeof part.text==="string").map((part:any)=>part.text).join("");
    if(value.trim())return truncateUtf8(value,MAX_PROJECTED_LOG_BYTES);
  }
  return undefined;
}

function childLog(child: RecordValue, fallback?: unknown): string {
  const terminal = isRecord(child.terminal) ? child.terminal : undefined;
  const toolCall = isRecord(child.lastToolCall) ? child.lastToolCall : isRecord(child.activeTool) ? child.activeTool : undefined;
  const outcome=taskOutcome(child);
  const terminalResponse=finiteNumber(child.exitCode ?? child.exit_code) !== undefined && (child.exitCode ?? child.exit_code) !== -1;
  const showTool = toolCall && !(terminalResponse && toolCall.name === 'task_outcome');
  const parts = [
    outcome ? `${outcomeTitle(outcome)}${child.attempt ? ` · attempt ${child.attempt}` : ""}\n${outcome.summary}${outcome.next_action ? `\nNext: ${outcome.next_action}` : ""}` : undefined,
    text(child.lastAssistantText) ?? lastVisibleAssistantText(child.messages),
    text(child.final),
    text(child.outputPrefix),
    showTool ? `${terminalResponse ? "Last tool:" : "Running"} ${text(toolCall.name) ?? "tool"}${isRecord(toolCall.args) ? `: ${JSON.stringify(toolCall.args)}` : ""}` : undefined,
    showTool || !toolCall ? text(child.lastToolResult) : undefined,
    text(child.errorMessage) ?? text(child.error) ?? text(terminal?.message),
  ].filter((part): part is string => Boolean(part));
  if (parts.length) return truncateUtf8([...new Set(parts)].join("\n\n"), MAX_PROJECTED_LOG_BYTES);
  if (typeof fallback === "string") return truncateUtf8(fallback, MAX_PROJECTED_LOG_BYTES);
  if (isRecord(fallback) && Array.isArray(fallback.content)) {
    return truncateUtf8(
      fallback.content
        .filter((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map((part: RecordValue) => part.text)
        .join("\n"),
      MAX_PROJECTED_LOG_BYTES,
    );
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactUsage(value: unknown): RecordValue | undefined {
  if (!isRecord(value)) return undefined;
  const usage = Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "contextWindow", "turns"]
      .flatMap((key) => {
        const number = finiteNumber(value[key]);
        return number === undefined ? [] : [[key, number]];
      }),
  );
  return Object.keys(usage).length ? usage : undefined;
}

function compactTerminal(value: unknown): RecordValue | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(text(value.state) ? { state: truncateUtf8(text(value.state)!, 64) } : {}),
    ...(finiteNumber(value.exitCode ?? value.exit_code) !== undefined
      ? { exitCode: finiteNumber(value.exitCode ?? value.exit_code) }
      : {}),
    ...(text(value.message) ? { message: truncateUtf8(text(value.message)!, 512) } : {}),
  };
}

function compactChildDetails(child: RecordValue): RecordValue {
  const details: RecordValue = {
    ...(taskOutcome(child) ? {task_outcome:taskOutcome(child)} : {}),
    ...(/^subagent-task-[0-9a-f]{24}$/.test(child.task_id ?? "") ? {task_id:child.task_id} : {}),
    ...(Number.isSafeInteger(child.attempt) && child.attempt > 0 ? {attempt:child.attempt} : {}),
    ...(text(child.label) ? { label: truncateUtf8(text(child.label)!, 256) } : {}),
    ...(text(child.task) ? { task: truncateUtf8(text(child.task)!, 1024) } : {}),
    ...(text(child.model) ? { model: truncateUtf8(text(child.model)!, 256) } : {}),
    ...(text(child.stopReason ?? child.stop_reason)
      ? { stopReason: truncateUtf8(text(child.stopReason ?? child.stop_reason)!, 128) }
      : {}),
    ...(finiteNumber(child.exitCode ?? child.exit_code) !== undefined
      ? { exitCode: finiteNumber(child.exitCode ?? child.exit_code) }
      : {}),
    ...(compactUsage(child.usage) ? { usage: compactUsage(child.usage) } : {}),
    ...(compactTerminal(child.terminal) ? { terminal: compactTerminal(child.terminal) } : {}),
    ...(text(child.errorMessage ?? child.error)
      ? { errorMessage: truncateUtf8(text(child.errorMessage ?? child.error)!, 1024) }
      : {}),
    ...(text(child.lastAssistantText)
      ? { lastAssistantText: truncateUtf8(text(child.lastAssistantText)!, MAX_PROJECTED_TEXT_BYTES) }
      : {}),
    ...(text(child.final) ? { final: truncateUtf8(text(child.final)!, MAX_PROJECTED_TEXT_BYTES) } : {}),
  };
  return details;
}

function projectedResult(child: RecordValue, fallback?: unknown): RecordValue {
  return {
    content: [{ type: "text", text: childLog(child, fallback) }],
    details: compactChildDetails(child),
  };
}

function childForSpec(children: RecordValue[], spec: ChildSpec): RecordValue | undefined {
  const byOrdinal = children.find((child) => Number(child.child ?? child.step) === spec.index + 1);
  if (byOrdinal) return byOrdinal;
  return children.some(child=>child.child !== undefined || child.step !== undefined) ? undefined : children[spec.index];
}

const PROJECTED_TEXT_UPDATE_INTERVAL_MS = 500;

function updateFingerprint(child: RecordValue, fallback?: unknown): string {
  return JSON.stringify(projectedResult(child, fallback));
}

function structuralFingerprint(child: RecordValue): string {
  const terminal = compactTerminal(child.terminal);
  const activeTool = isRecord(child.activeTool)
    ? child.activeTool
    : isRecord(child.lastToolCall)
      ? child.lastToolCall
      : undefined;
  return JSON.stringify({
    terminal,
    stopReason: text(child.stopReason ?? child.stop_reason),
    exitCode: finiteNumber(child.exitCode ?? child.exit_code),
    error: text(child.errorMessage ?? child.error),
    activeTool: activeTool
      ? { name: text(activeTool.name), args: isRecord(activeTool.args) ? activeTool.args : undefined }
      : undefined,
    task_outcome: taskOutcome(child),
    completedToolCount: Array.isArray(child.completedTools) ? child.completedTools.length : undefined,
    turns: isRecord(child.usage) ? finiteNumber(child.usage.turns) : undefined,
  });
}

export class SubagentTaskProjection {
  private readonly active = new Map<string, Projection>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  project(event: unknown): RecordValue[] {
    if (!isRecord(event) || !text(event.type)) return [event as RecordValue];
    if ((event.type === 'message_start' || event.type === 'message_end') && event.message?.role === 'custom' && event.message.display === false) return [];
    if (event.type === "tool_execution_start") {
      if (event.toolName !== "subagent" || typeof event.toolCallId !== "string") return [event];
      const specs = childSpecs(event.args);
      if (!specs.length) return [event];
      const projection = { parentId: event.toolCallId, specs, updates: new Map<number, ProjectedUpdateState>() };
      this.active.set(event.toolCallId, projection);
      return specs.map((spec) => startEvent(projection, spec));
    }

    if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return [event];
    const parent = typeof event.toolCallId === "string" ? this.active.get(event.toolCallId) : undefined;
    if (!parent) return [event];
    const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
    if (event.type === "tool_execution_end" && isBackgroundSubagentResult(result)) {
      this.active.delete(parent.parentId);
      return parent.specs.map((spec) => ({
        type: "tool_execution_end",
        toolCallId: childId(parent.parentId, spec.index),
        toolName: "subagent",
        result: projectedBackgroundResult(result, spec),
        isError: event.isError === true || result.details.failed === true,
      }));
    }
    const children = resultChildren(result);
    const projected = parent.specs.flatMap<RecordValue>((spec): RecordValue[] => {
      const observedChild = childForSpec(children, spec);
      const child = observedChild ?? {
        task: spec.task,
        errorMessage: event.type === "tool_execution_end" ? "Subagent did not start" : undefined,
      };
      if (event.type === "tool_execution_update") {
        if (!observedChild) return [];
        const fingerprint = updateFingerprint(child, result);
        const structure = structuralFingerprint(child);
        const previous = parent.updates.get(spec.index);
        const now = this.now();
        if (
          previous?.fingerprint === fingerprint ||
          (previous?.structuralFingerprint === structure && now - previous.emittedAt < PROJECTED_TEXT_UPDATE_INTERVAL_MS)
        ) {
          return [];
        }
        parent.updates.set(spec.index, {
          fingerprint,
          structuralFingerprint: structure,
          emittedAt: now,
        });
        return [{
          type: "tool_execution_update",
          toolCallId: childId(parent.parentId, spec.index),
          toolName: "subagent",
          args: { task: spec.task, ...(spec.agent ? { agent: spec.agent } : {}) },
          partialResult: projectedResult(child, result),
        }];
      }
      return [{
        type: "tool_execution_end",
        toolCallId: childId(parent.parentId, spec.index),
        toolName: "subagent",
        result: projectedResult(child, result),
        isError: childFailed(child) || (children.length === 0 && event.isError === true),
      }];
    });
    if (event.type === "tool_execution_end") this.active.delete(parent.parentId);
    return projected;
  }
}

export function projectSubagentMessages(messages: unknown[]): unknown[] {
  const calls = new Map<string, Projection>();
  const output: unknown[] = [];
  for (const message of messages) {
    if (isRecord(message) && message.role === 'custom' && message.display === false) continue;
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
        const projection = { parentId: part.id, specs, updates: new Map<number, ProjectedUpdateState>() };
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
      if (isBackgroundSubagentResult(message)) {
        output.push(
          ...projection.specs.map((spec) => ({
            ...projectedBackgroundResult(message, spec),
            toolCallId: childId(projection.parentId, spec.index),
            isError: message.isError === true || message.details.failed === true,
          })),
        );
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
            details: compactChildDetails(child),
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
