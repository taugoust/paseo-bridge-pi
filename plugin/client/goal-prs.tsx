import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon, copyText } from "@getpaseo/plugin/client/react-native";
import type { DelegatedGoal } from "./delegated-goals";
import { Metadata, NativeRow, type PresentationColors } from "./presentation";
import { useGoalText } from "./goal-language";
import { goalWorkingColor } from "./goal-ticket-ui";
import { HarnessChecks, type HarnessCheck } from "./harness-checks";

type GoalPr = NonNullable<DelegatedGoal["prs"]>[number];
type GoalCheck = NonNullable<DelegatedGoal["checks"]>[number];

const TONE: Record<GoalCheck["verdict"], HarnessCheck["tone"]> = { ok: "passed", pending: "running", failed: "failed", closed: "failed" };
const ICON: Record<HarnessCheck["tone"], string> = { passed: "CircleCheck", running: "Clock", failed: "CircleX", idle: "Circle" };

/** The completion condition that checks this PR: a forge-pr command naming its repository and number. */
function checkFor(pr: GoalPr, checks: readonly GoalCheck[]): GoalCheck | undefined {
  const [repository, number] = pr.ref.split("#");
  if (!repository || !number) return undefined;
  return checks.find(check => check.command.includes(repository) && new RegExp(`\\bcheck\\s+${number}\\b`).test(check.command));
}

/** What a PR is waiting for, in plain words. */
function prState(pr: GoalPr, check: GoalCheck | undefined, t: (text: string) => string): string {
  if (pr.state === "merged") return t("Merged");
  if (pr.state === "closed") return t("Closed without merging");
  if (pr.ci === "failed") return t("Open · CI failed");
  if (pr.ci === "pending") return t("Open · CI running");
  if (pr.ci === "green") return check?.verdict === "ok" ? t("Open · CI passed") : t("Open · CI passed · waiting to merge");
  return t("Open");
}

function toneColor(tone: HarnessCheck["tone"], colors: PresentationColors) {
  return tone === "passed" ? colors.statusSuccess : tone === "failed" ? colors.statusDanger : tone === "running" ? goalWorkingColor : colors.foregroundMuted;
}

/** Copies the exact command the harness runs for a PR. */
function CopyCommand({ command, colors }: { command: string; colors: PresentationColors }) {
  const [copied, setCopied] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={copied ? "Copied" : `Copy command: ${command}`} hitSlop={8}
    onPress={() => void copyText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}>
    <Icon name={copied ? "Check" : "Copy"} size={14} color={colors.foregroundMuted} />
  </Pressable>;
}

/** The pull or merge requests a goal produced, each with the condition the goal waits on.
 * Conditions that don't belong to a PR are listed under their own heading. */
export function GoalPullRequests({ goal, colors }: { goal: Pick<DelegatedGoal, "prs" | "checks">; colors: PresentationColors }) {
  const { t, time } = useGoalText();
  const [error, setError] = useState<string>();
  const prs = goal.prs ?? [], checks = goal.checks ?? [];
  const matched = new Set<GoalCheck>();
  const rows = prs.map(pr => { const check = checkFor(pr, checks); if (check) matched.add(check); return { pr, check }; });
  const others = checks.filter(check => !matched.has(check)).map(check => ({ command: check.command, tone: TONE[check.verdict], status: "" }));
  if (!rows.length && !others.length) return null;

  const open = (url: string) => {
    setError(undefined);
    openExternalUrl(url).catch(() => setError("Link could not open. Copy its address instead."));
  };

  return <View style={{ gap: 16 }}>
    {rows.length ? <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14 }}>{t("Pull requests")}</Text>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1, overflow: "hidden" }}>
        {rows.map(({ pr, check }, index) => {
          const tone: HarnessCheck["tone"] = check ? TONE[check.verdict] : pr.state === "merged" ? "passed" : pr.state === "closed" ? "failed" : "idle";
          return <View key={pr.ref} style={index ? { borderTopWidth: 1, borderTopColor: colors.border } : undefined}>
            <NativeRow colors={colors} title={pr.title ?? pr.ref} accessibilityLabel={`${pr.title ?? pr.ref}, ${prState(pr, check, t)}`}
              detail={`${pr.ref.split("/").slice(-1)[0]} · ${prState(pr, check, t)} · ${time(pr.checkedAt)}`}
              leading={<Icon name={ICON[tone]} size={14} color={toneColor(tone, colors)} />}
              trailing={<View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
                {check ? <CopyCommand command={check.command} colors={colors} /> : null}
                <Icon name="ExternalLink" size={14} color={colors.foregroundMuted} />
              </View>}
              onPress={() => open(pr.url)} />
          </View>;
        })}
      </View>
    </View> : null}
    {others.length ? <HarnessChecks checks={others} colors={colors} title={t("Completion conditions")} open /> : null}
    {error ? <Metadata colors={colors} alert>{t(error)}</Metadata> : null}
  </View>;
}

