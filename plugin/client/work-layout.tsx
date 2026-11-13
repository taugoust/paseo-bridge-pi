// Layout shared by the Work sections: one centred column, calm empty states and a heading for
// completed work, so Jobs, Agents, Worktrees and Goals read as one tool.
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Metadata, nativeText, type PresentationColors } from "./presentation";

/** The column every section sits in. Goals needs room for its list and details side by side. */
export function WorkColumn({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return <View style={{ width: "100%", maxWidth: wide ? 1040 : 760, alignSelf: "center", paddingHorizontal: 16 }}>
    {children}
  </View>;
}

/** What a section shows when it has nothing running. */
export function WorkEmpty({ colors, icon, title, hint, children }: {
  colors: PresentationColors; icon: string; title: string; hint: string; children?: ReactNode;
}) {
  return <View style={{ alignItems: "center", gap: 8, paddingVertical: 40, paddingHorizontal: 16 }}>
    <Icon name={icon} size={22} color={colors.foregroundMuted} />
    <Text style={{ ...nativeText, color: colors.foreground, fontWeight: "500", textAlign: "center" }}>{title}</Text>
    <Metadata colors={colors} style={{ textAlign: "center", maxWidth: 360 }}>{hint}</Metadata>
    {children ? <View style={{ marginTop: 8, alignItems: "center", gap: 12 }}>{children}</View> : null}
  </View>;
}

/** "Completed · 12", which shows or hides the finished items below it. */
export function CompletedHeading({ colors, count, open, onPress }: {
  colors: PresentationColors; count: number; open: boolean; onPress(): void;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}
    accessibilityLabel={`Completed, ${count}`} onPress={onPress}
    style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, minHeight: 32, alignSelf: "flex-start" }}>
    <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
    <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontWeight: "600" }}>Completed · {count}</Text>
  </Pressable>;
}

export function ListDivider({ colors }: { colors: PresentationColors }) {
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}

/** How a finished job or agent ended. */
export function OutcomeIcon({ colors, failed }: { colors: PresentationColors; failed: boolean }) {
  return <Icon name={failed ? "CircleX" : "CircleCheck"} size={14} color={failed ? colors.statusDanger : colors.statusSuccess} />;
}

/** A short age such as "just now", "12 min ago", "3 h ago", "yesterday" or "4 days ago". */
export function timeAgo(at: string | null | undefined, now = Date.now()): string {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** A problem that doesn't stop the section from working: one quiet line, details on request. */
export function QuietWarning({ colors, summary, detail }: { colors: PresentationColors; summary: string; detail: string }) {
  const [open, setOpen] = useState(false);
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="TriangleAlert" size={14} color={colors.foregroundMuted} />
      <Metadata colors={colors} style={{ flex: 1 }}>{summary}</Metadata>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}>
        <Metadata colors={colors} style={{ color: colors.foreground }}>{open ? "Hide" : "Show"}</Metadata>
      </Pressable>
    </View>
    {open ? <Metadata colors={colors} selectable style={{ paddingLeft: 22 }}>{detail}</Metadata> : null}
  </View>;
}
