export type FlowKind = "contribution" | "dividend" | "interest" | "internal";
export type ActivityBucket = "contribution" | "income" | "other";

export function classifyFlow(description: string): FlowKind {
  const d = description.toLowerCase();
  if (/dividend|cap gain rein|cg rein|income rein/.test(d)) return "dividend";
  if (d.includes("interest")) return "interest";
  if (
    /funds received|funds transferred|transfer (in|out|from)|contribution|conversion|rollover|broker to broker|journaled|rsu vest|espp purchase|shares purchased|shares redeemed|fund purchase|statement net cash flow|\beft\b|\bach\b|direct deposit/.test(d)
  ) {
    return "contribution";
  }
  return "internal";
}

export function activityBucket(t: { description: string; raw?: Record<string, unknown> }): ActivityBucket {
  const metric = typeof t.raw?.metric === "string" ? t.raw.metric : "";
  if (metric === "netCashFlow") return "contribution";
  if (metric === "dividendsInterestIncome") return "income";

  const kind = classifyFlow(t.description);
  if (kind === "contribution") return "contribution";
  if (kind === "dividend" || kind === "interest") return "income";
  return "other";
}
