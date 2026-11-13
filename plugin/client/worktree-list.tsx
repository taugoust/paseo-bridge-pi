// Presentation pieces of the Worktrees section: the scope switch, group labels, the diff stat
// and the facts list of an expanded row. Actions and safety gates stay in workflows.tsx.
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, copyText } from "@getpaseo/plugin/client/react-native";
import { Metadata, secondaryText, type PresentationColors } from "./presentation";
import { worktreeViews, type WorktreeView } from "../shared/worktree-groups";
import { worktreeLinkKeyboardProps } from "../shared/worktree-link";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** "1.2k", "340". Lower case so it reads like the native Changes pill. */
export function compactCount(value: number): string {
	return compact.format(value).toLowerCase();
}

/** The small "This chat · By goal · All" switch next to the count. */
export function WorktreeScope({ colors, value, onChange }: {
	colors: PresentationColors;
	value: WorktreeView;
	onChange(next: WorktreeView): void;
}) {
	return <View accessibilityLabel="Worktree scope" style={{ flexDirection: "row", gap: 2, padding: 2, borderWidth: 1, borderColor: colors.border, borderRadius: 7 }}>
		{worktreeViews.map(view => {
			const selected = view.value === value;
			return <Pressable key={view.value} accessibilityRole="button" accessibilityState={{ selected }} hitSlop={6}
				onPress={() => onChange(view.value)}
				style={{ paddingHorizontal: 9, paddingVertical: 3, borderRadius: 5, backgroundColor: selected ? colors.surface2 : "transparent" }}>
				<Text style={{ ...secondaryText, color: selected ? colors.foreground : colors.foregroundMuted }}>{view.label}</Text>
			</Pressable>;
		})}
	</View>;
}

/** A repository or goal name above its list. A label, not a band. */
export function WorktreeGroupLabel({ colors, icon, label }: { colors: PresentationColors; icon: string; label: string }) {
	return <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, minWidth: 0 }}>
		<Icon name={icon} size={13} color={colors.foregroundMuted} />
		<Text numberOfLines={1} style={{ ...secondaryText, color: colors.foregroundMuted, flexShrink: 1 }}>{label}</Text>
	</View>;
}

/** Native line counts as plain text. It is information only and never a button. */
export function WorktreeDiffStat({ colors, diffStat }: {
	colors: PresentationColors;
	diffStat: { additions: number; deletions: number };
}) {
	return <Text accessibilityLabel={`${diffStat.additions} additions, ${diffStat.deletions} deletions`}
		style={{ ...secondaryText, fontVariant: ["tabular-nums"] }}>
		<Text style={{ color: colors.statusSuccess }}>+{compactCount(diffStat.additions)}</Text>
		{"  "}
		<Text style={{ color: colors.statusDanger }}>−{compactCount(diffStat.deletions)}</Text>
	</Text>;
}

/** One line of the expanded row. The label sits beside the value, or above it when narrow. */
export function WorktreeFact({ colors, label, narrow, children }: {
	colors: PresentationColors;
	label: string;
	narrow: boolean;
	children: ReactNode;
}) {
	return <View style={{ flexDirection: narrow ? "column" : "row", alignItems: narrow ? "stretch" : "flex-start", gap: narrow ? 0 : 12, minWidth: 0 }}>
		<Metadata colors={colors} style={narrow ? undefined : { width: 100, paddingTop: 1 }}>{label}</Metadata>
		<View style={{ flex: narrow ? undefined : 1, minWidth: 0 }}>{children}</View>
	</View>;
}

/** The value text of a fact. */
export function FactText({ colors, children, tone }: { colors: PresentationColors; children: ReactNode; tone?: "warning" }) {
	return <Text selectable style={{ fontSize: 13, lineHeight: 19, color: tone === "warning" ? colors.statusWarning : colors.foreground }}>{children}</Text>;
}

/** The checkout path. Pressing it opens the worktree's workspace. The icon copies the path. */
export function WorktreePath({ colors, path, platform, disabled, onOpen }: {
	colors: PresentationColors;
	path: string;
	platform: string;
	disabled: boolean;
	onOpen(): void;
}) {
	const [copied, setCopied] = useState(false);
	return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
		<Pressable accessibilityRole="link" accessibilityLabel={`Open workspace ${path}`}
			accessibilityHint="Opens this worktree's workspace"
			{...worktreeLinkKeyboardProps(platform, disabled, onOpen)}
			disabled={disabled}
			accessibilityState={{ disabled }}
			onPress={onOpen}
			style={{ flexShrink: 1, minWidth: 0, opacity: disabled ? 0.5 : 1 }}>
			<FactText colors={colors}>{path}</FactText>
		</Pressable>
		<Pressable accessibilityRole="button" accessibilityLabel={copied ? "Copied" : "Copy path"} hitSlop={8}
			onPress={() => void Promise.resolve()
				.then(() => copyText(path))
				.then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}, () => {})}
			style={{ paddingTop: 3 }}>
			<Icon name={copied ? "Check" : "Copy"} size={13} color={colors.foregroundMuted} />
		</Pressable>
	</View>;
}
