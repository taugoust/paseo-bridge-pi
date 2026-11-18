import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { ACCOUNT_PROVIDER_ID, accountControlsStatusRpc } from "../shared/account-controls";
import { subagentRoutingSetRpc, subagentRoutingStatusRpc, type SubagentRoutingSelection } from "../shared/subagent-routing";
import type { Colors } from "./activity-dashboard";

const selectionKey = (selection: SubagentRoutingSelection | null) => JSON.stringify(selection);

export function SubagentRoutingSection({ agentId, workspaceId, hostId, colors }: {
  agentId: string; workspaceId: string; hostId: string; colors: Colors;
}) {
  const status = useRpc(subagentRoutingStatusRpc), change = useRpc(subagentRoutingSetRpc), accounts = useRpc(accountControlsStatusRpc);
  const [switching, setSwitching] = useState(false), [failure, setFailure] = useState<string>();
  const query = useQuery({
    queryKey: ["pi-subagent-routing", hostId, agentId, workspaceId],
    queryFn: () => status({ agentId, workspaceId }), refetchInterval: 5000, staleTime: 0,
  });
  const named = useQuery({
    queryKey: ["pi-subagent-accounts", hostId, agentId, workspaceId],
    queryFn: () => accounts({ agentId, workspaceId, providerId: ACCOUNT_PROVIDER_ID }),
    enabled: !!query.data?.available, refetchInterval: 5000, staleTime: 0,
  });
  const state = query.data;
  if (!state?.available || !state.snapshot || !state.runtimeEpoch) return null;
  const snapshot = state.snapshot, selection = snapshot.selection;
  const accountSnapshot = !named.isError && named.data?.available && named.data.sessionId === snapshot.sessionId && named.data.runtimeEpoch === state.runtimeEpoch ? named.data.snapshot : undefined;
  const options = [{ label: "Follow session", value: selectionKey(null) }, ...state.providers.flatMap(providerId => [
    { label: `${providerId} · Default login`, value: selectionKey({ providerId, accountId: null }) },
    ...(providerId === ACCOUNT_PROVIDER_ID ? (accountSnapshot?.accounts ?? []).map(account => ({ label: `${providerId} · ${account.label}`, value: selectionKey({ providerId, accountId: account.id }) })) : []),
  ])];
  const value = selectionKey(selection);
  // Retain a visible saved choice even if its provider or account was removed.
  const label = selection ? `${selection.providerId} · ${selection.accountId === null ? "Default login" : accountSnapshot?.accounts.find(a => a.id === selection.accountId)?.label ?? selection.accountId}` : "Following session";
  if (!options.some(option => option.value === value)) options.push({ label, value });
  const update = async (value: string) => {
    const choice = options.find(option => option.value === value);
    if (!choice || switching || query.isFetching || query.isError) return;
    setSwitching(true); setFailure(undefined);
    try {
      await change({ agentId, workspaceId, expectedRuntimeEpoch: state.runtimeEpoch!, request: {
        expectedSessionId: snapshot.sessionId, expectedServiceEpoch: snapshot.serviceEpoch,
        expectedRevision: snapshot.revision, selection: JSON.parse(choice.value),
      } });
    } catch { setFailure("Could not change subagents. Try again."); }
    finally { await query.refetch(); setSwitching(false); }
  };
  return <SettingsSection title="Subagents"><SettingsCard><View style={{ padding: 12, gap: 8 }}>
    <Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>
    <SettingsSelect label="Provider and account" value={value} options={options} disabled={switching || query.isFetching || query.isError} onValueChange={value => void update(value)} />
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>New subagents only. Running subagents stay unchanged.</Text>
    {failure ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning }}>{failure}</Text> : null}
  </View></SettingsCard></SettingsSection>;
}
