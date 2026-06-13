import { beforeAll, expect, test } from "bun:test";
import { seedReportFixture } from "./testFixtures";
import { getTransferAuditReport } from "./transfers";

beforeAll(() => {
  seedReportFixture();
});

test("transfer audit report exposes heuristic links", () => {
  const report = getTransferAuditReport();
  const fixtureLinks = report.links.filter((link) => link.id.startsWith("cash:fixture-transfer-out"));
  expect(fixtureLinks.length).toBeGreaterThan(0);
  expect(fixtureLinks.every((link) => link.source_account && link.destination_account)).toBe(true);
});

test("transfer audit candidates are large unmatched transfer-like transactions", () => {
  const report = getTransferAuditReport();
  expect(report.unmatched_candidates.every((candidate) =>
    Math.abs(candidate.transaction.amount_cents) >= 1_000_000
  )).toBe(true);
});
