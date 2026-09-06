type Event = Record<string, any>;

function hasVisibleText(message: any): boolean {
  return Array.isArray(message?.content)
    && message.content.some((part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim());
}
function failed(message: any): boolean {
  return message?.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted');
}

/** Project Pi's internal wake-ups as background activity, not new foreground turns.
 * Tool/text updates still pass through. Only lifecycle framing is deferred;
 * permission transport and actual get_state/isStreaming remain untouched.
 */
export class TurnVisibilityProjection {
  private active = false;
  private origin: 'unknown' | 'user' | 'internal' = 'unknown';
  private exposed = false;
  private start: Event | undefined;
  private turn: Event | undefined;
  private end: Event | undefined;

  private expose(): Event[] {
    if (this.exposed) return [];
    this.exposed = true;
    return [this.start ?? { type: 'agent_start' }, this.turn ?? { type: 'turn_start' }];
  }

  project(event: Event): Event[] {
    if (!event || typeof event !== 'object') return [];
    if (event.type === 'agent_start') {
      if (!this.active) {
        this.origin = 'unknown';
        this.exposed = false;
      }
      this.active = true;
      this.start = event;
      this.end = undefined;
      return []; // The following input message identifies the run's origin.
    }
    if (event.type === 'turn_start') {
      this.turn = event;
      return this.exposed ? [event] : [];
    }
    if (event.type === 'message_start' || event.type === 'message_end') {
      const message = event.message;
      if (this.active && message?.role === 'user') {
        this.origin = 'user';
        return [...this.expose(), event];
      }
      if (this.active && this.origin === 'unknown' && message?.role === 'custom' && message.display === false) {
        this.origin = 'internal';
      }
      // Continuations/retries with no input event are conservatively visible.
      if (this.active && this.origin === 'unknown' && message?.role === 'assistant') {
        this.origin = 'user';
        return [...this.expose(), event];
      }
      if (this.active && event.type === 'message_end' && message?.role === 'assistant'
        && ['stop', 'length'].includes(message.stopReason) && hasVisibleText(message)) {
        return [...this.expose(), event];
      }
    }
    if (event.type === 'agent_end') {
      this.end = event;
      return []; // Pi may still retry or continue; wait for agent_settled.
    }
    if (event.type === 'agent_settled') {
      const output: Event[] = [];
      const terminalAssistant = Array.isArray(this.end?.messages)
        ? [...this.end.messages].reverse().find(message => message?.role === 'assistant') : undefined;
      if (failed(terminalAssistant)) output.push(...this.expose());
      if (this.end && this.exposed) {
        // Paseo accepts this legacy boundary for both client-originated and
        // autonomous turns. Sending both boundary types would double-complete.
        const { willRetry: _willRetry, ...terminal } = this.end;
        output.push(terminal);
      }
      this.active = false;
      this.origin = 'unknown';
      this.exposed = false;
      this.start = this.turn = this.end = undefined;
      return output;
    }
    return [event];
  }
}
