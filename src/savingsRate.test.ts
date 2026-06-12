import { expect, test } from "bun:test";
import { isExternalIncome, isInternalMoneyMove, isMarketIncome, periodAllocation } from "./savingsRate";

test("savings rate treats payroll and retirement contributions as income", () => {
  expect(isExternalIncome({
    amount_cents: 1_000_00,
    description: "Example Payroll-OSV DES:0000680295 ID:55OSV005VPf INDN:Test User CO ID:00002238 PPD",
  })).toBe(true);
  expect(isExternalIncome({
    amount_cents: 1_000_00,
    description: "401(k) contributions (employee + employer)",
  })).toBe(true);
});

test("savings rate excludes internal money moves from income", () => {
  const description = "Online Banking transfer from CHK 0729 Confirmation# 1359473211";
  expect(isInternalMoneyMove(description)).toBe(true);
  expect(isExternalIncome({ amount_cents: 70_000_00, description })).toBe(false);
  expect(isExternalIncome({
    amount_cents: 500_00,
    description: "OVERDRAFT PROTECTION FROM 00004667342644",
  })).toBe(false);
});

test("savings rate can separate market income from external income", () => {
  expect(isExternalIncome({ amount_cents: 12_34, description: "Interest Paid" })).toBe(true);
  expect(isMarketIncome("Interest Paid")).toBe(true);
  expect(isMarketIncome("Example Payroll payroll")).toBe(false);
});

test("period allocation offsets cash drawdown against investment retention", () => {
  expect(periodAllocation({
    income_cents: 10_000_00,
    investment_delta_cents: 8_000_00,
    cash_delta_cents: -3_000_00,
  })).toEqual({
    retained_investment_cents: 5_000_00,
    retained_cash_cents: 0,
    net_retained_cents: 5_000_00,
    poof_cents: 5_000_00,
  });
});

test("poof does not go negative when retained exceeds income", () => {
  expect(periodAllocation({
    income_cents: 10_000_00,
    investment_delta_cents: 12_000_00,
    cash_delta_cents: 0,
  }).poof_cents).toBe(0);
});
