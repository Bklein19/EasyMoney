import { expect, test } from "bun:test";
import { getTransferAuditReport } from "./transfers";

test("transfer audit report exposes heuristic links", () => {
  const report = getTransferAuditReport();
  expect(report.links.length).toBeGreaterThan(0);
  expect(report.links.every((link) => link.source_account && link.destination_account)).toBe(true);
});

test("transfer audit candidates are large unmatched transfer-like transactions", () => {
  const report = getTransferAuditReport();
  expect(report.unmatched_candidates.every((candidate) =>
    Math.abs(candidate.transaction.amount_cents) >= 1_000_000
  )).toBe(true);
});
