export type GateUiState = {
  available: boolean;
  enabled: boolean | null;
  pending: boolean;
  fetching: boolean;
  stale: boolean;
  error: boolean;
};

export function gateControlsDisabled(state: GateUiState): boolean {
  return !state.available || state.enabled === null || state.pending || state.fetching || state.stale || state.error;
}

export function gateLabel(state?: Pick<GateUiState, "available" | "enabled">): string {
  if (!state) return "Prompts · …";
  if (!state.available || state.enabled === null) return "Prompts · unavailable";
  return `Prompts · ${state.enabled ? "On" : "Off"}`;
}
