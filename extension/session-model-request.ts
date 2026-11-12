type Model = { provider: string; id: string; api?: string };
type Context = {
  model?: Model;
  modelRegistry: {
    find(provider: string, id: string): Model | undefined;
    streamSimple(model: any, context: any, options?: any): { result(): Promise<any> };
  };
};
type RoutingApi = {
  protocol: 1;
  prepareRequest(ctx: Context): Promise<unknown>;
  physicalModelReference(ctx: Context, profile?: unknown): { provider: string; id: string };
  bindModelRequest(model: Model, profile: unknown): Model;
};

/** Use the owning session's request/account gate, including physical guard roles. */
export async function completeWithSessionModel(ctx: Context, context: any, options?: any): Promise<any> {
  const value = (globalThis as typeof globalThis & { __paeSessionRoutingV1?: RoutingApi }).__paeSessionRoutingV1;
  let model = ctx.model;
  if (value !== undefined) {
    if (value.protocol !== 1 || typeof value.prepareRequest !== "function" || typeof value.physicalModelReference !== "function" || typeof value.bindModelRequest !== "function") {
      throw new Error("Session routing integration is incompatible; refusing provider/account fallback");
    }
    const profile = await value.prepareRequest(ctx);
    const reference = value.physicalModelReference(ctx, profile);
    if (!reference || typeof reference.provider !== "string" || typeof reference.id !== "string") throw new Error("Invalid physical session model reference");
    model = ctx.modelRegistry.find(reference.provider, reference.id);
    if (!model) throw new Error(`Unavailable session model: ${reference.provider}/${reference.id}`);
    if (profile) model = value.bindModelRequest(model, profile);
  }
  if (!model || model.api === "pi-virtual" || model.provider === "session-follow") {
    throw new Error("A physical session model is required; refusing title-model fallback");
  }
  return ctx.modelRegistry.streamSimple(model, context, options).result();
}
