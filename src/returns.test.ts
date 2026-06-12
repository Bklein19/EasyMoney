import { expect, test } from "bun:test";
import { calculateTimeWeightedReturn, calculateXirr, summarizeReturns } from "./returns";

test("xirr matches a simple annual doubling", () => {
  const irr = calculateXirr([
    { date: "2025-01-01", amount_cents: -10_000_00 },
    { date: "2026-01-01", amount_cents: 20_000_00 },
  ]);

  expect(irr).not.toBeNull();
  expect(irr!).toBeGreaterThan(0.99);
  expect(irr!).toBeLessThan(1.01);
});

test("time weighted return ignores late contribution timing", () => {
  const summary = summarizeReturns({
    account_id: 1,
    balances: [
      { date: "2025-01-01", balance_cents: 1_000_00 },
      { date: "2025-07-01", balance_cents: 2_000_00 },
      { date: "2026-01-01", balance_cents: 11_000_00 },
    ],
    contribution_flows: [{ date: "2025-07-02", amount_cents: 9_000_00 }],
  });

  expect(summary).not.toBeNull();
  expect(summary!.time_weighted_return!).toBeGreaterThan(0.99);
  expect(summary!.time_weighted_return!).toBeLessThan(1.01);
  expect(summary!.irr!).toBeLessThan(summary!.time_weighted_return!);
});

test("time weighted return neutralizes withdrawals", () => {
  const twr = calculateTimeWeightedReturn(
    [
      { date: "2025-01-01", balance_cents: 10_000_00 },
      { date: "2026-01-01", balance_cents: 8_000_00 },
    ],
    [{ date: "2025-07-01", amount_cents: -3_000_00 }],
  );

  expect(twr).not.toBeNull();
  expect(twr!).toBeGreaterThan(0);
});

test("zero starting balance can still produce account returns", () => {
  const summary = summarizeReturns({
    account_id: 1,
    balances: [
      { date: "2025-01-01", balance_cents: 0 },
      { date: "2026-01-01", balance_cents: 11_000_00 },
    ],
    contribution_flows: [{ date: "2025-07-01", amount_cents: 10_000_00 }],
  });

  expect(summary).not.toBeNull();
  expect(summary!.initial_balance_cents).toBe(0);
  expect(summary!.irr).not.toBeNull();
  expect(summary!.time_weighted_return).not.toBeNull();
  expect(summary!.irr!).toBeGreaterThan(0);
  expect(summary!.time_weighted_return!).toBeGreaterThan(0);
});

test("time weighted return ignores empty zero balance periods before funding", () => {
  const twr = calculateTimeWeightedReturn(
    [
      { date: "2025-01-01", balance_cents: 0 },
      { date: "2025-02-01", balance_cents: 0 },
      { date: "2025-03-01", balance_cents: 10_000_00 },
      { date: "2026-03-01", balance_cents: 11_000_00 },
    ],
    [{ date: "2025-03-01", amount_cents: 10_000_00 }],
  );

  expect(twr).not.toBeNull();
  expect(twr!).toBeGreaterThan(0.09);
  expect(twr!).toBeLessThan(0.11);
});

test("time weighted return starts after an unmeasurable opening funded interval", () => {
  const twr = calculateTimeWeightedReturn(
    [
      { date: "2025-01-01", balance_cents: 0 },
      { date: "2025-02-01", balance_cents: 10_500_00 },
      { date: "2026-02-01", balance_cents: 11_550_00 },
    ],
    [{ date: "2025-02-01", amount_cents: 10_000_00 }],
  );

  expect(twr).not.toBeNull();
  expect(twr!).toBeGreaterThan(0.09);
  expect(twr!).toBeLessThan(0.11);
});
