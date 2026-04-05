import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeParsedQifTransactions } from "../src/qif.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_PATH = path.join(
  __dirname,
  "fixtures",
  "qif",
  "synthetic-input.qif",
);

const RUN_SMOKE = process.env.ABCTL_RUN_SMOKE_TEST === "1";
const RUN_WRITE = process.env.ABCTL_SMOKE_WRITE === "1";
const KEEP_DATA_DIR = process.env.ABCTL_SMOKE_KEEP_DATA_DIR === "1";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when running the QIF smoke test.`);
  }
  return value;
}

function installNavigatorShim() {
  if (globalThis.navigator) {
    return;
  }
  globalThis.navigator = {
    platform: process.platform === "darwin" ? "MacIntel" : process.platform,
    userAgent: `node/${process.version}`,
  };
}

function canonicalPayeeName(value) {
  return value == null ? null : String(value).toLowerCase();
}

function sortTransactions(transactions) {
  return [...transactions].sort((left, right) =>
    `${left.date}|${left.imported_payee}|${left.amount}`.localeCompare(
      `${right.date}|${right.imported_payee}|${right.amount}`,
    ),
  );
}

async function runSmokeCase(t, { write }) {
  const fixturePath = process.env.ABCTL_QIF_SMOKE_FIXTURE ?? DEFAULT_FIXTURE_PATH;
  const budgetPrefix = process.env.ABCTL_QIF_SMOKE_BUDGET_PREFIX ?? "abctl-qif-smoke";
  const accountName = process.env.ABCTL_QIF_SMOKE_ACCOUNT_NAME ?? "QIF Smoke Test";
  const budgetName = `${budgetPrefix}-${write ? "write" : "dry"}-${Date.now()}`;
  const serverURL = process.env.ACTUAL_SERVER_URL ?? "http://localhost:5007";
  const password = requiredEnv("ACTUAL_PASSWORD");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "abctl-qif-"));

  installNavigatorShim();
  const actualApi = await import("@actual-app/api");

  t.after(async () => {
    try {
      await actualApi.shutdown();
    } finally {
      if (!KEEP_DATA_DIR) {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  });

  await actualApi.init({
    dataDir,
    serverURL,
    password,
    verbose: false,
  });

  const createResult = await actualApi.internal.send("create-budget", {
    budgetName,
    avoidUpload: true,
    testMode: true,
    testBudgetId: budgetName,
  });
  if (createResult?.error) {
    throw new Error(`Failed to create smoke-test budget: ${createResult.error}.`);
  }

  const budgets = await actualApi.getBudgets();
  const budget = budgets.find((entry) => entry.name === budgetName);
  if (!budget?.id) {
    throw new Error("Created smoke-test budget was not found in getBudgets().");
  }

  await actualApi.loadBudget(budget.id);
  await actualApi.internal.send("preferences/save", {
    id: "dateFormat",
    value: "DD/MM/YYYY",
  });

  const accountId = await actualApi.createAccount(
    { name: accountName, offbudget: false },
    0,
  );

  const parseResult = await actualApi.internal.send("transactions-parse-file", {
    filepath: fixturePath,
    options: { importNotes: true },
  });
  assert.deepEqual(parseResult.errors, []);

  const transactions = normalizeParsedQifTransactions(
    parseResult.transactions ?? [],
    {
      dateFormat: "DD/MM/YYYY",
      amountToInteger: actualApi.internal.amountToInteger,
    },
  );

  const result = await actualApi.internal.send("transactions-import", {
    accountId,
    transactions,
    isPreview: !write,
    opts: { reimportDeleted: false },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.added.length, transactions.length);
  assert.equal(result.updated.length, 0);
  assert.equal(result.updatedPreview.length, 0);

  if (write) {
    const [payees, persisted] = await Promise.all([
      actualApi.getPayees(),
      actualApi.getTransactions(
        accountId,
        transactions[0].date,
        transactions[transactions.length - 1].date,
      ),
    ]);

    const payeesById = new Map(payees.map((payee) => [payee.id, payee.name]));
    const actualView = sortTransactions(
      persisted.map((transaction) => ({
        account: transaction.account,
        date: transaction.date,
        amount: transaction.amount,
        payee_name: transaction.payee
          ? payeesById.get(transaction.payee) ?? null
          : null,
        imported_payee: transaction.imported_payee,
        notes: transaction.notes,
      })),
    );
    const expectedView = sortTransactions(
      transactions.map((transaction) => ({
        date: transaction.date,
        amount: transaction.amount,
        payee_name: transaction.payee_name ?? null,
        imported_payee: transaction.imported_payee,
        notes: transaction.notes,
      })),
    );

    assert.equal(actualView.length, expectedView.length);
    for (let index = 0; index < actualView.length; index += 1) {
      const actualTransaction = actualView[index];
      const expectedTransaction = expectedView[index];

      assert.equal(actualTransaction.account, accountId);
      assert.equal(actualTransaction.date, expectedTransaction.date);
      assert.equal(actualTransaction.amount, expectedTransaction.amount);
      assert.equal(actualTransaction.imported_payee, expectedTransaction.imported_payee);
      assert.equal(actualTransaction.notes ?? undefined, expectedTransaction.notes);
      assert.equal(
        canonicalPayeeName(actualTransaction.payee_name),
        canonicalPayeeName(expectedTransaction.payee_name),
      );
    }
  }

  t.diagnostic(
    JSON.stringify(
      {
        fixturePath,
        dataDir,
        budget: {
          id: budget.id,
          name: budget.name,
        },
        accountId,
        mapped: transactions.length,
        dryRun: !write,
        added: result.added.length,
        updated: result.updated.length,
        previewed: result.updatedPreview.length,
        keptDataDir: KEEP_DATA_DIR,
      },
      null,
      2,
    ),
  );
}

test(
  "QIF smoke import dry run",
  {
    concurrency: false,
    skip: RUN_SMOKE ? false : "Set ABCTL_RUN_SMOKE_TEST=1 to run smoke tests.",
  },
  async (t) => {
    await runSmokeCase(t, { write: false });
  },
);

test(
  "QIF smoke import write",
  {
    concurrency: false,
    skip:
      RUN_SMOKE && RUN_WRITE
        ? false
        : "Set ABCTL_RUN_SMOKE_TEST=1 and ABCTL_SMOKE_WRITE=1 to run the write smoke test.",
  },
  async (t) => {
    await runSmokeCase(t, { write: true });
  },
);
