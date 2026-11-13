import { useState } from "react";
import { Text, View } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import type { DelegatedGoal } from "./delegated-goals";
import { Metadata, type PresentationColors } from "./presentation";
import { GoalButton, useGoalText } from "./goal-language";
import { goalWorkingColor } from "./goal-ticket-ui";
import { HarnessChecks, type HarnessCheck } from "./harness-checks";

type GoalPr = NonNullable<DelegatedGoal["prs"]>[number];

const STATE_LABEL = { open: "Open", merged: "Merged", closed: "Closed" } as const;
const CI_LABEL = { green: "CI passed", pending: "CI running", failed: "CI failed" } as const;

/** Green when merged, red when closed or failing, blue while CI runs. */
function stateColor(pr: GoalPr, colors: PresentationColors) {
  if (pr.state === "merged") return colors.statusSuccess;
  if (pr.state === "closed" || pr.ci === "failed") return colors.statusDanger;
  if (pr.ci === "pending") return goalWorkingColor;
  return colors.foregroundMuted;
}

const TONE: Record<string, HarnessCheck["tone"]> = { ok: "passed", pending: "running", failed: "failed", closed: "failed" };

/** The merge gate: the command the harness runs for each PR before the goal can complete.
 * The PR rows above already say why a check hasn't passed, so only the icon is shown. */
export function GoalMergeGate({ goal, colors }: { goal: DelegatedGoal; colors: PresentationColors }) {
  const { t } = useGoalText();
  const checks = (goal.checks ?? []).map(check => ({ command: check.command, tone: TONE[check.verdict], status: "" }));
  return <HarnessChecks checks={checks} colors={colors} title={t("Completion conditions")} open />;
}

/** The pull or merge requests a goal produced, as its coordinator last saw them. */
export function GoalPullRequests({ goal, colors }: { goal: DelegatedGoal; colors: PresentationColors }) {
  const { t, time } = useGoalText();
  const [error, setError] = useState<string>();
  const prs = goal.prs ?? [];
  if (!prs.length) return null;

  const open = (url: string) => {
    setError(undefined);
    openExternalUrl(url).catch(() => setError("Link could not open. Copy its address instead."));
  };

  return <View style={{ gap: 8 }}>
    <Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14 }}>{t("Pull requests")}</Text>
    {prs.map(pr => {
      // An open PR is described by its CI. Merged and closed say so instead.
      const state = pr.state === "open" && pr.ci ? t(CI_LABEL[pr.ci]) : t(STATE_LABEL[pr.state]);
      const status = `${state} · ${time(pr.checkedAt)}`;
      return <View key={pr.ref} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text selectable style={{ color: colors.foreground, fontSize: 13 }}>{pr.title ?? pr.ref}</Text>
          <Metadata colors={colors} style={{ color: stateColor(pr, colors) }}>{status}</Metadata>
        </View>
        <GoalButton colors={colors} label="Open PR" onPress={() => open(pr.url)} />
      </View>;
    })}
    {error ? <Metadata colors={colors} alert>{t(error)}</Metadata> : null}
  </View>;
}
