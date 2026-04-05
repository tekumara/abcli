import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildUncategorizedTransactionsTable } from "../src/uncategorized.js";

const RUN_SMOKE = process.env.ABCTL_RUN_SMOKE_TEST === "1";
const KEEP_DATA_DIR = process.env.ABCTL_SMOKE_KEEP_DATA_DIR === "1";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when running the uncategorized smoke test.`);
  }
  return value;
}

function truthy(value) {
  return value === true || value === 1 || value === "1";
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function buildMetadata(accounts, payees) {
  return {
    groupsById: new Map(),
    categoriesById: new Map(),
    accountsById: new Map(
      accounts
        .filter((account) => !truthy(account.tombstone))
        .map((account, index) => [
          account.id,
          {
            id: account.id,
            name: account.name ?? "?",
            offbudget: truthy(account.offbudget),
            sortOrder: toFiniteNumber(account.sort_order, index),
          },
        ]),
    ),
    payeesById: new Map(
      payees
        .filter((payee) => !truthy(payee.tombstone))
        .map((payee) => [payee.id, { id: payee.id, name: payee.name ?? "?" }]),
    ),
  };
}

async function runSmokeCase(t) {
  const budgetPrefix =
    process.env.ABCTL_UNCATEGORIZED_SMOKE_BUDGET_PREFIX ?? "abctl-uncategorized-smoke";
  const serverURL = process.env.ACTUAL_SERVER_URL ?? "http://localhost:5007";
  const password = requiredEnv("ACTUAL_PASSWORD");
  const budgetName = `${budgetPrefix}-${Date.now()}`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "abctl-uncategorized-"));

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

  const mainAccountId = await actualApi.createAccount(
    { name: "Uncategorized Smoke Checking", offbudget: false },
    0,
  );
  const transferAccountId = await actualApi.createAccount(
    { name: "Uncategorized Smoke Savings", offbudget: false },
    0,
  );

  const cafePayeeId = await actualApi.createPayee({ name: "Smoke Cafe" });
  const transferPayeeId = await actualApi.createPayee({ name: "Transfer to Smoke Savings" });
  await actualApi.updatePayee(transferPayeeId, { transfer_acct: transferAccountId });

  await actualApi.addTransactions(
    mainAccountId,
    [
      {
        date: "2026-04-05",
        amount: -1250,
        payee: cafePayeeId,
        notes: "smoke uncategorized",
      },
      {
        date: "2026-04-06",
        amount: -7800,
        payee: transferPayeeId,
        notes: "smoke transfer",
      },
    ],
    { runTransfers: true },
  );

  const [accounts, payees, mainTransactions, transferTransactions] = await Promise.all([
    actualApi.getAccounts(),
    actualApi.getPayees(),
    actualApi.getTransactions(mainAccountId, "2026-04-01", "2026-04-30"),
    actualApi.getTransactions(transferAccountId, "2026-04-01", "2026-04-30"),
  ]);

  assert.equal(mainTransactions.length, 2);
  assert.equal(transferTransactions.length, 1);

  const table = await buildUncategorizedTransactionsTable(
    actualApi,
    buildMetadata(accounts, payees),
  );

  const rowNotes = table.rows.map((row) => row.cells[3]);
  assert.deepEqual(rowNotes, ["smoke uncategorized"]);

  t.diagnostic(
    JSON.stringify(
      {
        dataDir,
        budget: {
          id: budget.id,
          name: budget.name,
        },
        mainAccountId,
        transferAccountId,
        rowNotes,
        keptDataDir: KEEP_DATA_DIR,
      },
      null,
      2,
    ),
  );
}

test(
  "uncategorized smoke test excludes transfer transactions",
  {
    concurrency: false,
    skip: RUN_SMOKE ? false : "Set ABCTL_RUN_SMOKE_TEST=1 to run smoke tests.",
  },
  async (t) => {
    await runSmokeCase(t);
  },
);
