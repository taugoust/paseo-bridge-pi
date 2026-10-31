export type CanonicalName = { displayName: string; revision: number };
export type CanonicalNameAuthority = {
  get(): CanonicalName;
  rename(name: string, revision: number, source: "paseo"): CanonicalName | Promise<CanonicalName>;
};

/** Existing-API eventual reconciliation: latest observed external rename wins.
 * Native writes are serialized; acknowledged/observed echoes never create revisions.
 * Paseo does not expose mutation origins or conditional title writes, so simultaneous
 * identical user/echo titles cannot be distinguished. This is not lossless CAS. */
export class CanonicalNameSync {
  private remoteName: string | null | undefined;
  private observedName: string | null | undefined;
  private remoteObservation = 0;
  private workspaceName: string | undefined;
  private echoes: { name: string; until: number }[] = [];
  private pendingRename: { name: string; observation: number; generation: string | undefined } | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  private dirty = false;
  private renaming = false;
  private warned = new Set<string>();
  private failureMessage: string | undefined;
  private generation: string | undefined;
  private retiredGenerations = new Set<string>();
  private sequence = 0;
  private initialRevision: number;
  private readonly options: {
    authority: CanonicalNameAuthority;
    isCurrent(): boolean;
    write(name: string, updateAgent: boolean): Promise<void>;
    warn(message: string): void;
  };
  constructor(options: CanonicalNameSync["options"]) { this.options = options; this.initialRevision = options.authority.get().revision; }
  private current(): boolean { return !this.closed && this.options.isCurrent(); }
  observe(name: string | null, order?: { generation?: string; seq?: number }): void {
    if (!this.current()) return;
    if (order?.generation && this.retiredGenerations.has(order.generation)) return;
    if (order?.generation && order.generation !== this.generation && this.generation) this.retiredGenerations.add(this.generation);
    if (order?.generation && order.generation === this.generation && order.seq !== undefined && order.seq <= this.sequence) return;
    if (order?.generation !== undefined) this.generation = order.generation;
    if (order?.seq !== undefined) this.sequence = order.seq;
    this.remoteObservation++;
    const previousName = this.observedName;
    this.observedName = name;
    this.remoteName = name;
    this.echoes = this.echoes.filter(echo => echo.until >= Date.now());
    const echo = name === null || name === previousName ? -1 : this.echoes.findIndex(echo => echo.name === name);
    if (this.pendingRename && (name === previousName || echo >= 0)) {
      this.pendingRename = { ...this.pendingRename, observation: this.remoteObservation, generation: this.generation };
    }
    if (echo >= 0) this.echoes = this.echoes.filter(echo => echo.name !== name);
    else if (name !== null && name !== previousName && (this.renaming || name !== this.options.authority.get().displayName)
      && (previousName !== undefined || this.options.authority.get().revision === this.initialRevision)) {
      this.pendingRename = { name, observation: this.remoteObservation, generation: this.generation };
    }
    this.changed();
  }
  changed(): void {
    if (!this.current() || this.remoteName === undefined) return;
    this.dirty = true;
    if (this.running) return;
    // rename/write can synchronously emit name-changed even when returning a
    // Promise. Reserve the drain before invoking either external callback.
    this.running = Promise.resolve();
    this.running = this.drain().catch(error => {
      const message = `Task name synchronization unavailable: ${String(error)}`;
      if (this.current() && message !== this.failureMessage) { this.failureMessage = message; this.options.warn(message); }
      // Preserve a rename admitted while a failed write was in flight, but do
      // not spin retrying the same unavailable transport without new work.
      this.dirty = this.pendingRename !== undefined;
    }).finally(() => { this.running = undefined; if (this.dirty) this.changed(); });
  }
  private async drain(): Promise<void> {
    while (this.current()) {
      this.dirty = false;
      const pending = this.pendingRename;
      if (pending) {
        this.pendingRename = undefined;
        // Only the newest admitted observation may start a mutation. The
        // authority's revision CAS fences concurrent local edits during await.
        if (pending.observation === this.remoteObservation && pending.generation === this.generation) {
          try {
            const name = pending.name;
            if (!name || name.length > 80 || name !== name.trim() || /[\p{Cc}\p{Cf}]/u.test(name) || name.split(/\s+/u).length > 4) {
              throw new Error("use one to four words, at most 80 characters, without control characters");
            }
            this.renaming = true;
            await this.options.authority.rename(name, this.options.authority.get().revision, "paseo");
          } catch (error) {
            if (this.current() && pending.observation === this.remoteObservation && pending.generation === this.generation && !this.warned.has(pending.name)) {
              this.warned.add(pending.name);
              if (this.warned.size > 32) this.warned.delete(this.warned.values().next().value!);
              this.options.warn(`Name not changed: ${String(error)}. Restoring the canonical task name.`);
            }
          }
          finally { this.renaming = false; }
          if (!this.current()) return;
          // Never project an old completion over a newer observation/generation.
          if (pending.observation !== this.remoteObservation || pending.generation !== this.generation) continue;
        }
      }
      const target = this.options.authority.get();
      const updateAgent = this.remoteName !== target.displayName;
      if (!updateAgent && this.workspaceName === target.displayName) return;
      const observation = this.remoteObservation;
      if (updateAgent) {
        this.echoes.push({ name: target.displayName, until: Date.now() + 30_000 });
        if (this.echoes.length > 32) this.echoes.shift();
      }
      await this.options.write(target.displayName, updateAgent);
      this.failureMessage = undefined;
      if (!this.current()) return;
      this.workspaceName = target.displayName;
      // Responses are acknowledgements, not renames. Do not overwrite a newer
      // subscribed observation with an older asynchronous write completion.
      if (updateAgent && observation === this.remoteObservation) this.remoteName = target.displayName;
    }
  }
  async settled(): Promise<void> { while (this.running) await this.running; }
  close(): void { this.closed = true; }
}
