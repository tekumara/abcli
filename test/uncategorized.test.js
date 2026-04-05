import assert from "node:assert/strict";
import test from "node:test";

import { buildUncategorizedTransactionsTable } from "../src/uncategorized.js";

function makeActualApi(transactions) {
  return {
    q() {
      return {
        filter() {
          return this;
        },
        select() {
          return this;
        },
        options() {
          return this;
        },
      };
    },
    async runQuery() {
      return { data: transactions };
    },
  };
}

function makeMetadata() {
  return {
    accountsById: new Map([["checking", { id: "checking", name: "Checking" }]]),
    payeesById: new Map([["payee-1", { id: "payee-1", name: "Grocer" }]]),
  };
}

test("buildUncategorizedTransactionsTable formats dates using the budget date format", async () => {
  const table = await buildUncategorizedTransactionsTable(
    makeActualApi([
      {
        id: "txn-1",
        account: "checking",
        payee: "payee-1",
        amount: -1250,
        category: null,
        date: "2026-04-05",
        notes: "milk",
      },
    ]),
    makeMetadata(),
    { dateFormat: "dd/MM/yyyy" },
  );

  assert.deepEqual(
    table.rows[0].cells,
    ["05/04/2026", "Checking", "Grocer", "milk", "-12.50", "txn-1"],
  );
});
