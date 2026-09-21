export function selectAccountIds(order: number[], selected: Set<number>, anchor: number | null, id: number, modifiers: { shift: boolean; additive: boolean }): Set<number> {
  if (modifiers.shift && anchor !== null && order.includes(anchor) && order.includes(id)) {
    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    return new Set(modifiers.additive ? [...selected, ...range] : range);
  }
  if (modifiers.additive) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }
  return new Set([id]);
}
