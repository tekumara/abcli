import assert from "node:assert/strict";
import test from "node:test";

import { buildAccountsTable, buildLatestTransactionDateByAccount } from "../src/accounts.js";

test("buildLatestTransactionDateByAccount normalizes compact dates for accounts output", () => {
  const latestDates = buildLatestTransactionDateByAccount([
    { account: "checking", date: "20260401" },
    { account: "checking", date: "2026-04-05" },
    { account: "savings", date: 20260403 },
    { account: "checking", date: "20260330" },
  ]);

  assert.equal(latestDates.get("checking"), "2026-04-05");
  assert.equal(latestDates.get("savings"), "2026-04-03");
});

test("buildAccountsTable formats latest dates using the budget date format", () => {
  const table = buildAccountsTable(
    [
      { id: "checking", name: "Checking", balance: 12345, offbudget: false, closed: false },
    ],
    new Map([["checking", "2026-04-05"]]),
    { dateFormat: "dd/MM/yyyy" },
  );

  assert.deepEqual(table.rows[0].cells, ["Checking", "123.45", "05/04/2026"]);
});
