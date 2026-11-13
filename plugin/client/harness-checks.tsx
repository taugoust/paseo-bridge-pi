import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, copyText } from "@getpaseo/plugin/client/react-native";
import { Metadata, NativeRow, type PresentationColors } from "./presentation";
import { goalWorkingColor } from "./goal-ticket-ui";

/** A command the harness runs itself, with its last result. */
export type HarnessCheck = {
  command: string;
  tone: "passed" | "running" | "failed" | "idle";
  /** Why it hasn't passed, for example "CI running". Empty when the icon says it all. */
  status: string;
};

function toneColor(tone: HarnessCheck["tone"], colors: PresentationColors) {
  switch (tone) {
    case "passed": return colors.statusSuccess;
    case "failed": return colors.statusDanger;
    case "running": return goalWorkingColor;
    default: return colors.foregroundMuted;
  }
}

const ICON: Record<HarnessCheck["tone"], string> = { passed: "Check", failed: "X", running: "Clock", idle: "Circle" };

const mono = { fontFamily: "monospace", fontSize: 12, lineHeight: 17 } as const;

/** A command that wraps only between words, so flags stay whole. Each word is
 * its own text, so a copy button provides the exact command. */
function Command({ command, colors }: { command: string; colors: PresentationColors }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  return <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: colors.surface2, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
    <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", columnGap: 7 }}>
      {command.split(/\s+/).map((word, index) => <Text key={index} style={{ ...mono, color: colors.foreground }}>{word}</Text>)}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? "Copied" : "Copy command"} onPress={copy} hitSlop={8}>
      <Icon name={copied ? "Check" : "Copy"} size={14} color={colors.foregroundMuted} />
    </Pressable>
  </View>;
}

function CheckList({ checks, colors }: { checks: readonly HarnessCheck[]; colors: PresentationColors }) {
  return <View style={{ gap: 8 }}>
    {checks.map(check => <View key={check.command} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Command command={check.command} colors={colors} />
        <View accessibilityLabel={check.tone} style={{ width: 18, alignItems: "center" }}>
          <Icon name={ICON[check.tone]} size={16} color={toneColor(check.tone, colors)} />
        </View>
      </View>
      {check.status ? <Metadata colors={colors} style={{ color: toneColor(check.tone, colors) }}>{check.status}</Metadata> : null}
    </View>)}
  </View>;
}

/** The commands the harness runs to accept work. Collapsed behind a row unless `open`. */
export function HarnessChecks({ checks, colors, title, open = false }: {
  checks: readonly HarnessCheck[]; colors: PresentationColors; title: string; open?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!checks.length) return null;
  if (open) {
    return <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14 }}>{title}</Text>
      <CheckList checks={checks} colors={colors} />
    </View>;
  }
  return <View>
    <NativeRow colors={colors} title={`${title} (${checks.length})`} expanded={expanded} onPress={() => setExpanded(!expanded)}
      trailing={<Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />} />
    {expanded ? <View style={{ paddingHorizontal: 12, paddingBottom: 10 }}><CheckList checks={checks} colors={colors} /></View> : null}
  </View>;
}

// Passed and failed are shown by the icon alone.
const SUBAGENT_STATUS: Record<string, [string, HarnessCheck["tone"]]> = {
  "not-run": ["Not run yet", "idle"], checking: ["Checking", "running"], passed: ["", "passed"],
  failed: ["", "failed"], "timed-out": ["Timed out", "failed"], cancelled: ["Cancelled", "idle"],
  interrupted: ["Interrupted", "idle"], stale: ["Stale, workspace changed", "idle"], unavailable: ["Unavailable", "idle"],
};

/** A worker's verification gates, as reported in its row. */
export function subagentChecks(checks: readonly { command: string; status: string; exitCode: number | null; finishedAt: string | null }[]): HarnessCheck[] {
  return checks.map(check => {
    const [label, tone] = SUBAGENT_STATUS[check.status] ?? [check.status, "idle"];
    // A JSON gate can fail on its verdict while the command exits 0.
    const exit = check.status === "failed" && check.exitCode ? `exit ${check.exitCode}` : undefined;
    return { command: check.command, tone, status: [label, exit].filter(Boolean).join(" · ") };
  });
}
