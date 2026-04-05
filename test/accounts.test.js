import assert from "node:assert/strict";
import test from "node:test";

import { buildLatestTransactionDateByAccount } from "../src/accounts.js";

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
