import assert from "node:assert/strict";
import test from "node:test";

import { buildTransferCandidatesTable, findTransferCandidates } from "../src/transfer.js";

function makeMetadata() {
  return {
    accountsById: new Map([
      ["checking", { id: "checking", name: "Checking" }],
      ["savings", { id: "savings", name: "Savings" }],
    ]),
  };
}

test("findTransferCandidates matches a unique uncategorized pair", () => {
  const result = findTransferCandidates([
    {
      account: "checking",
      amount: -7800,
      category: null,
      date: "2026-04-05",
      id: "outflow",
    },
    {
      account: "savings",
      amount: 7800,
      category: null,
      date: "2026-04-05",
      id: "inflow",
    },
    {
      account: "checking",
      amount: -1250,
      category: null,
      date: "2026-04-06",
      id: "expense",
    },
  ]);

  assert.equal(result.matches.length, 1);
  assert.equal(result.ambiguousGroups.length, 0);
  assert.equal(result.matches[0].from.id, "outflow");
  assert.equal(result.matches[0].to.id, "inflow");
});

test("findTransferCandidates skips ambiguous date and amount groups", () => {
  const result = findTransferCandidates([
    {
      account: "checking",
      amount: -7800,
      category: null,
      date: "2026-04-05",
      id: "outflow-a",
    },
    {
      account: "cash",
      amount: -7800,
      category: null,
      date: "2026-04-05",
      id: "outflow-b",
    },
    {
      account: "savings",
      amount: 7800,
      category: null,
      date: "2026-04-05",
      id: "inflow",
    },
  ]);

  assert.equal(result.matches.length, 0);
  assert.equal(result.ambiguousGroups.length, 1);
  assert.deepEqual(
    result.ambiguousGroups[0].map((transaction) => transaction.id),
    ["inflow", "outflow-a", "outflow-b"],
  );
});

test("buildTransferCandidatesTable uses budget date format for display", () => {
  const table = buildTransferCandidatesTable(
    [
      {
        from: {
          accountId: "checking",
          amount: -7800,
          date: "2026-04-05",
          id: "outflow",
        },
        to: {
          accountId: "savings",
          amount: 7800,
          date: "2026-04-05",
          id: "inflow",
        },
      },
    ],
    makeMetadata(),
    { dateFormat: "DD/MM/YYYY" },
  );

  assert.equal(table.rows[0].cells[0], "05/04/2026");
  assert.deepEqual(
    table.columns.map((column) => column.label),
    ["Date", "Amount", "From Account", "To Account"],
  );
  assert.deepEqual(
    table.rows[0].cells,
    ["05/04/2026", "78.00", "Checking", "Savings"],
  );
});
