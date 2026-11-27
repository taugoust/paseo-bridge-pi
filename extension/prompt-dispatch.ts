type PromptContent = string | Array<Record<string, unknown>>;
type Delivery = "steer" | "followUp";
type PromptOptions = { deliverAs?: Delivery; expandPromptTemplates?: boolean };
type NotificationType = "info" | "warning" | "error";
type CommandResult =
  | { status: "completed"; notifications: unknown[] }
  | { status: "failed"; error: { message: string }; notifications: unknown[] }
  | { status: "not_found"; notifications: unknown[] };
export class PromptAdmissionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PromptAdmissionError";
  }
}

type PromptApi = {
  getCommands(): Array<{ name: string; source: string }>;
  sendUserMessage(content: PromptContent, options?: PromptOptions): void | Promise<void>;
  submitUserMessage?(content: PromptContent, options?: PromptOptions): Promise<{ disposition: "handled" | "queued" | "started" }>;
  dispatchExtensionCommand?(name: string, args?: string, options?: {
    onNotify?: (message: string, type: NotificationType) => void;
    allowDialogs?: boolean;
  }): Promise<CommandResult>;
};

function commandParts(message: string): { name: string; args: string } | null {
  if (!message.startsWith("/")) return null;
  // Match Pi's command parser, including literal argument whitespace.
  const space = message.indexOf(" ");
  const name = space < 0 ? message.slice(1) : message.slice(1, space);
  return name ? { name, args: space < 0 ? "" : message.slice(space + 1) } : null;
}

export function isExtensionCommand(pi: PromptApi, message: string): boolean {
  const parts = commandParts(message);
  return parts !== null && pi.getCommands().some(command => command.source === "extension" && command.name === parts.name);
}

function commandOutcome<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => { cleanup(); reject(new Error("Command wait aborted; its work may still be running in the terminal.")); };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
  });
}

export async function dispatchPaseoPrompt(
  pi: PromptApi,
  content: PromptContent,
  message: string,
  streaming: boolean,
  onAsyncError: (error: unknown) => void = () => {},
  onNotify: (message: string, type: NotificationType) => void = () => {},
  delivery?: Delivery,
  signal?: AbortSignal,
): Promise<{ agentInvoked?: boolean }> {
  if (isExtensionCommand(pi, message)) {
    if (Array.isArray(content) && content.some(block => block.type === "image")) {
      throw new Error("Extension commands do not accept image attachments. Send images as an ordinary prompt.");
    }
    if (typeof pi.dispatchExtensionCommand !== "function") {
      throw new Error("This Pi runtime cannot report extension command outcomes. This command has no explicit remote route; use the terminal.");
    }
    signal?.throwIfAborted();
    const parts = commandParts(message)!;
    let observing = true;
    try {
      const result = await commandOutcome(pi.dispatchExtensionCommand(parts.name, parts.args, {
        onNotify: (text, type) => { if (observing) onNotify(text, type); }, allowDialogs: false,
      }), signal);
      if (result.status === "failed") throw new Error(result.error.message);
      if (result.status !== "completed") throw new Error(`Extension command is no longer available: /${parts.name}`);
      return { agentInvoked: false };
    } finally { observing = false; }
  }

  const options: PromptOptions = delivery ? { deliverAs: delivery } : {
    ...(streaming ? { deliverAs: "followUp" as const } : {}), expandPromptTemplates: true,
  };
  if (typeof pi.submitUserMessage === "function") {
    let submission: Promise<{ disposition: "handled" | "queued" | "started" }>;
    try {
      submission = pi.submitUserMessage(content, options);
    } catch (error) {
      throw new PromptAdmissionError("Pi rejected the prompt before admission", error);
    }
    let receipt: { disposition: "handled" | "queued" | "started" };
    try {
      receipt = await submission;
    } catch (error) {
      throw new PromptAdmissionError("Pi rejected the prompt before admission", error);
    }
    if (!receipt || !["handled", "queued", "started"].includes(receipt.disposition)) {
      throw new PromptAdmissionError("Pi returned an invalid prompt admission receipt");
    }
    return { agentInvoked: receipt.disposition !== "handled" };
  }
  // Older peers offer only fire-and-forget submission. Keep that compatibility
  // path, but omit the unknown agent-invocation claim rather than inventing it.
  let submission: void | Promise<void>;
  try {
    submission = pi.sendUserMessage(content, options);
  } catch (error) {
    throw new PromptAdmissionError("Pi rejected the prompt before submission", error);
  }
  if (submission && typeof submission.catch === "function") void submission.catch(onAsyncError);
  return {};
}
