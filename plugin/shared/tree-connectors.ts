export type TreeAnchor = { x: number; y: number; radius?: number };
export type TreeSegment = { x: number; y: number; width: number; height: number };
/** Exact visible attempt edges only. Each parent trunk stops at its last child. */
export function treeConnectors(rows: { key: string; parentKey?: string }[], anchors: Map<string, TreeAnchor>): TreeSegment[] {
 const visible = new Set(rows.map(row => row.key));
 const groups = new Map<string, string[]>();
 for (const row of rows) if (row.parentKey && visible.has(row.parentKey)) {
  const children = groups.get(row.parentKey) ?? []; children.push(row.key); groups.set(row.parentKey, children);
 }
 const lines: TreeSegment[] = [];
 for (const [key, children] of groups) {
  const parent = anchors.get(key);
  if (!parent) continue;
  const points = children.map(child => anchors.get(child)).filter((point): point is TreeAnchor => !!point && point.y > parent.y && point.x > parent.x);
  if (!points.length) continue;
  const radius = parent.radius ?? 7;
  lines.push({ x: parent.x - .5, y: parent.y + radius, width: 1, height: Math.max(0, Math.max(...points.map(point => point.y)) - parent.y - radius) });
  for (const child of points) lines.push({ x: parent.x, y: child.y - .5, width: Math.max(0, child.x - parent.x - (child.radius ?? 7)), height: 1 });
 }
 return lines;
}
