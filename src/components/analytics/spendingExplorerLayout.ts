import type { SpendingNode } from '../../../server/app/spendingExplorer';

export interface SpendingSegment {
  node: SpendingNode;
  start: number;
  end: number;
  depth: number;
  familyId: string;
}

export function spendingSegments(
  root: SpendingNode,
  familyId = root.id,
  maxDepth = 3,
): SpendingSegment[] {
  const segments: SpendingSegment[] = [];
  function visit(parent: SpendingNode, start: number, end: number, depth: number, family: string) {
    if (!parent.amountCents || depth >= maxDepth) return;
    let angle = start;
    for (const node of parent.children) {
      const next = angle + ((end - start) * node.amountCents) / parent.amountCents;
      const nodeFamily = root.kind === 'root' && depth === 0 ? node.id : family;
      segments.push({ node, start: angle, end: next, depth, familyId: nodeFamily });
      // Long-tail groups are one honest segment until explicitly explored.
      if (node.kind !== 'merchant-group') visit(node, angle, next, depth + 1, nodeFamily);
      angle = next;
    }
  }
  visit(root, 0, Math.PI * 2, 0, familyId);
  return segments;
}

/** Two half arcs also support the single-child, full-circle case. */
export function spendingArc(start: number, end: number, inner: number, outer: number): string {
  const span = end - start;
  const gap = Math.min(0.006, span * 0.03);
  const from = start + gap;
  const to = end - gap;
  const mid = (from + to) / 2;
  const point = (radius: number, angle: number) =>
    `${240 + radius * Math.sin(angle)},${240 - radius * Math.cos(angle)}`;
  return `M ${point(outer, from)} A ${outer},${outer} 0 0 1 ${point(outer, mid)} A ${outer},${outer} 0 0 1 ${point(outer, to)} L ${point(inner, to)} A ${inner},${inner} 0 0 0 ${point(inner, mid)} A ${inner},${inner} 0 0 0 ${point(inner, from)} Z`;
}

export function resolveSpendingPath(root: SpendingNode, ids: string[]): SpendingNode[] {
  const path = [root];
  for (const id of ids) {
    const next = path[path.length - 1]!.children.find((node) => node.id === id);
    if (!next) break;
    path.push(next);
  }
  return path;
}

export function spendingFamilyIndex(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 8;
}
