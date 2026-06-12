import { expect, test } from "bun:test";
import { deriveTransferLinks } from "./transferLinks";

test("cash transfers carry source basis and gains into an existing destination account", () => {
  const flows = new Map([
    ["2026-03|1", { contributions: 0, dividends: 0, interest: 0 }],
    ["2026-04|1", { contributions: -10_000_00, dividends: 0, interest: 0 }],
    ["2026-04|2", { contributions: 10_000_00, dividends: 0, interest: 0 }],
  ]);
  const balances = new Map([["2026-03|1", 12_500_00]]);
  const result = deriveTransferLinks({
    accounts: [{ id: 1 }, { id: 2 }],
    sortedMonths: ["2026-03", "2026-04"],
    flows,
    balances,
    seeds: new Map([
      [1, { account_id: 1, firstMonth: "2026-03", startingAmount: 8_000_00, contributionAdjustments: new Map([["2026-03", 8_000_00]]) }],
      [2, { account_id: 2, firstMonth: "2026-03", startingAmount: 0, contributionAdjustments: new Map() }],
    ]),
    transactions: [
      {
        id: "out",
        date: "2026-04-01",
        month: "2026-04",
        account_id: 1,
        amount_cents: -10_000_00,
        description: "Transfer out",
      },
      {
        id: "in",
        date: "2026-04-03",
        month: "2026-04",
        account_id: 2,
        amount_cents: 10_000_00,
        description: "Funds Received",
      },
    ],
  });

  expect(result.links).toEqual([
    {
      id: "cash:out->in",
      reason: "cash-transfer",
      source_account_id: 1,
      destination_account_id: 2,
      source_transaction_ids: ["out"],
      destination_transaction_ids: ["in"],
      amount_cents: 10_000_00,
      basis_cents: 6_400_00,
      gains_cents: 3_600_00,
    },
  ]);
  expect(result.adjustments).toEqual([
    {
      link_id: "cash:out->in",
      reason: "cash-transfer",
      account_id: 1,
      month: "2026-04",
      contributions_cents: 3_600_00,
      gains_cents: -3_600_00,
    },
    {
      link_id: "cash:out->in",
      reason: "cash-transfer",
      account_id: 2,
      month: "2026-04",
      contributions_cents: -3_600_00,
      gains_cents: 3_600_00,
    },
  ]);
});
