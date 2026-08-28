declare module "@earendil-works/pi-ai" {
  /**
   * Pi's extension runtime exports this compatibility helper. The published
   * type package moved completion onto Models before removing this declaration.
   */
  export function completeSimple(
    model: unknown,
    context: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ content?: Array<{ type?: string; text?: string }> }>;
}
