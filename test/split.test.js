import assert from "node:assert/strict";
import test from "node:test";
import { Command, InvalidArgumentError } from "commander";

import {
  addSplitCommand,
  buildSplitBatchUpdate,
  buildSplitUpdateFields,
  commandSplit,
  findGroupedTransaction,
  parseSplitEntries,
  resolveSplitTarget,
  validateSplitSelector,
} from "../src/split.js";

test("parseSplitEntries parses repeated notes, category, amount triplets", () => {
  assert.deepEqual(
    parseSplitEntries([
      "Groceries run",
      "Food",
      "-45.60",
      "Petrol",
      "Transport",
      "-30",
    ]),
    [
      { notes: "Groceries run", categoryName: "Food", amount: -4560 },
      { notes: "Petrol", categoryName: "Transport", amount: -3000 },
    ],
  );
});

test("parseSplitEntries rejects incomplete triplets", () => {
  assert.throws(
    () => parseSplitEntries(["Groceries run", "Food"]),
    (error) =>
      error instanceof InvalidArgumentError &&
      error.message === "Split entries must be provided as repeated triplets: <notes> <category> <amount>.",
  );
});

test("validateSplitSelector enforces exactly one selector mode", () => {
  assert.throws(
    () => validateSplitSelector({ transactionId: null, payee: null, txnDate: null }),
    /Provide --transaction-id or both --payee and --txn-date\./,
  );
  assert.throws(
    () => validateSplitSelector({ transactionId: "txn-1", payee: "Store", txnDate: "2026-04-05" }),
    /Use either --transaction-id or --payee\/--txn-date, not both\./,
  );
  assert.doesNotThrow(() =>
    validateSplitSelector({ transactionId: "txn-1", payee: null, txnDate: null }),
  );
});

test("findGroupedTransaction returns parent context for matching child ids", () => {
  const parent = {
    id: "parent-1",
    subtransactions: [{ id: "child-1" }],
  };

  assert.deepEqual(findGroupedTransaction([parent], "parent-1"), {
    transaction: parent,
    parent: null,
  });
  assert.deepEqual(findGroupedTransaction([parent], "child-1"), {
    transaction: parent.subtransactions[0],
    parent,
  });
});

test("resolveSplitTarget refuses sub-transaction ids", async () => {
  await assert.rejects(
    () =>
      resolveSplitTarget(
        { transactionId: "child-1", payee: null, txnDate: null },
        {},
        {
          fetchTransactions: async () => [
            {
              id: "parent-1",
              subtransactions: [{ id: "child-1" }],
            },
          ],
        },
      ),
    /Cannot split a sub-transaction directly. Use the parent transaction id instead\./,
  );
});

test("commandSplit updates the matching transaction with mapped subtransactions", async () => {
  const calls = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(" "));
  };

  try {
    await commandSplit(
      {
        transactionId: "txn-1",
        payee: null,
        txnDate: null,
        splitEntries: [
          { notes: "Groceries run", categoryName: "Food", amount: -4560 },
          { notes: "Petrol", categoryName: "Transport", amount: -3000 },
        ],
      },
      {
        fetchMetadata: async () => ({
          categoriesById: new Map([
            ["cat-1", { id: "cat-1", name: "Food" }],
            ["cat-2", { id: "cat-2", name: "Transport" }],
          ]),
          payeesById: new Map(),
          accountsById: new Map(),
        }),
        fetchPreferenceValue: async () => "DD/MM/YYYY",
        fetchTransactions: async () => [
          {
            id: "txn-1",
            accountId: "acct-1",
            payeeId: "payee-1",
            notes: "Original note",
            amount: -7560,
            date: "2026-04-05",
            subtransactions: [],
          },
        ],
        printTransaction: (transaction) => {
          logs.push(`print:${transaction.id}`);
        },
        withActual: async (fn) =>
          fn({
            actualApi: {
              internal: {
                send: async (name, payload) => {
                  calls.push({ name, payload });
                },
              },
              sync: async () => {
                calls.push({ type: "sync" });
              },
            },
          }),
      },
    );
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(calls, [
    {
      name: "transactions-batch-update",
      payload: {
        added: [
          {
            account: "acct-1",
            amount: -4560,
            category: "cat-1",
            date: "2026-04-05",
            error: null,
            id: calls[0].payload.added[0].id,
            is_child: true,
            notes: "Groceries run",
            parent_id: "txn-1",
            payee: "payee-1",
            sort_order: 0,
          },
          {
            account: "acct-1",
            amount: -3000,
            category: "cat-2",
            date: "2026-04-05",
            error: null,
            id: calls[0].payload.added[1].id,
            is_child: true,
            notes: "Petrol",
            parent_id: "txn-1",
            payee: "payee-1",
            sort_order: -1,
          },
        ],
        deleted: [],
        runTransfers: false,
        updated: [
          {
            account: "acct-1",
            amount: -7560,
            category: null,
            date: "2026-04-05",
            error: null,
            id: "txn-1",
            is_parent: true,
            notes: "Original note",
            payee: "payee-1",
          },
        ],
      },
    },
    { type: "sync" },
  ]);
  assert.ok(logs.includes("Splitting transaction:"));
  assert.ok(logs.includes("print:txn-1"));
  assert.ok(logs.includes("  + Groceries run, Food, -45.60"));
  assert.ok(logs.includes("Done."));
});

test("buildSplitUpdateFields includes the parent account on split children", () => {
  const payload = buildSplitUpdateFields(
    {
      id: "txn-1",
      accountId: "acct-1",
      payeeId: "payee-1",
      notes: "Original note",
      amount: 165000,
      date: "2025-04-15",
    },
    [
      { notes: "62", categoryName: "Agent fees", amount: -9000 },
      { notes: "", categoryName: "Rental income", amount: 174000 },
    ],
    {
      categoryNameToId: new Map([
        ["Agent fees", "cat-agent"],
        ["Rental income", "cat-rent"],
      ]),
    },
  );

  assert.equal(payload.account, "acct-1");
  assert.equal(payload.is_parent, true);
  assert.equal(payload.subtransactions.length, 2);
  assert.deepEqual(
    payload.subtransactions.map((split) => ({
      account: split.account,
      category: split.category,
      date: split.date,
      is_child: split.is_child,
      notes: split.notes,
      parent_id: split.parent_id,
      payee: split.payee,
      sort_order: split.sort_order,
    })),
    [
      {
        account: "acct-1",
        category: "cat-agent",
        date: "2025-04-15",
        is_child: true,
        notes: "62",
        parent_id: "txn-1",
        payee: "payee-1",
        sort_order: 0,
      },
      {
        account: "acct-1",
        category: "cat-rent",
        date: "2025-04-15",
        is_child: true,
        notes: "",
        parent_id: "txn-1",
        payee: "payee-1",
        sort_order: -1,
      },
    ],
  );
  assert.match(payload.subtransactions[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(payload.error, null);
});

test("buildSplitBatchUpdate disables transfer handling for split edits", () => {
  const fields = buildSplitUpdateFields(
    {
      id: "txn-1",
      accountId: "acct-1",
      payeeId: "payee-1",
      notes: "Original note",
      amount: 165000,
      date: "2025-04-15",
      subtransactions: [{ id: "old-child-1" }],
    },
    [{ notes: "62", categoryName: "Agent fees", amount: -9000 }],
    {
      categoryNameToId: new Map([["Agent fees", "cat-agent"]]),
    },
  );

  const batch = buildSplitBatchUpdate(
    {
      id: "txn-1",
      subtransactions: [{ id: "old-child-1" }],
    },
    fields,
  );

  assert.equal(batch.runTransfers, false);
  assert.deepEqual(batch.deleted, [{ id: "old-child-1" }]);
  assert.equal(batch.updated[0].id, "txn-1");
  assert.equal(batch.added.length, 1);
});

test("addSplitCommand documents how entries are expressed", () => {
  const program = new Command();
  addSplitCommand(program, {
    fetchMetadata: async () => ({}),
    fetchPreferenceValue: async () => null,
    fetchTransactions: async () => [],
    printTransaction: () => {},
    withActual: async () => {},
  });

  const splitCommand = program.commands.find((command) => command.name() === "split");
  assert.ok(splitCommand);
  let help = "";
  splitCommand.configureOutput({
    writeOut: (text) => {
      help += text;
    },
    writeErr: (text) => {
      help += text;
    },
  });
  splitCommand.outputHelp();
  assert.match(help, /Entry format:/);
  assert.match(help, /<notes> <category> <amount>/);
});
