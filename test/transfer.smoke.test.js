import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeMakeTransfer } from "../src/transfer.js";

const RUN_SMOKE = process.env.ABCTL_RUN_SMOKE_TEST === "1";
const RUN_WRITE = process.env.ABCTL_SMOKE_WRITE === "1";
const KEEP_DATA_DIR = process.env.ABCTL_SMOKE_KEEP_DATA_DIR === "1";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when running the transfer smoke test.`);
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

async function runSmokeCase(t, { write }) {
  const budgetPrefix = process.env.ABCTL_TRANSFER_SMOKE_BUDGET_PREFIX ?? "abctl-transfer-smoke";
  const serverURL = process.env.ACTUAL_SERVER_URL ?? "http://localhost:5007";
  const password = requiredEnv("ACTUAL_PASSWORD");
  const budgetName = `${budgetPrefix}-${write ? "write" : "dry"}-${Date.now()}`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "abctl-transfer-"));

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

  const checkingAccountId = await actualApi.createAccount(
    { name: "Transfer Smoke Checking", offbudget: false },
    0,
  );
  const savingsAccountId = await actualApi.createAccount(
    { name: "Transfer Smoke Savings", offbudget: false },
    0,
  );

  const checkingTransferPayeeId = await actualApi.createPayee({
    name: "Transfer to Smoke Checking",
  });
  await actualApi.updatePayee(checkingTransferPayeeId, {
    transfer_acct: checkingAccountId,
  });

  const savingsTransferPayeeId = await actualApi.createPayee({
    name: "Transfer to Smoke Savings",
  });
  await actualApi.updatePayee(savingsTransferPayeeId, {
    transfer_acct: savingsAccountId,
  });

  await actualApi.addTransactions(checkingAccountId, [
    {
      amount: -7800,
      date: "2026-04-05",
      notes: "smoke transfer out",
    },
    {
      amount: -1250,
      date: "2026-04-06",
      notes: "smoke expense",
    },
  ]);
  await actualApi.addTransactions(savingsAccountId, [
    {
      amount: 7800,
      date: "2026-04-05",
      notes: "smoke transfer in",
    },
  ]);

  const [accounts, payees] = await Promise.all([
    actualApi.getAccounts(),
    actualApi.getPayees(),
  ]);
  const metadata = buildMetadata(accounts, payees);
  const payeesById = new Map(payees.map((payee) => [payee.id, payee]));
  const result = await executeMakeTransfer(actualApi, metadata, { dryRun: !write });

  assert.equal(result.matches.length, 1);
  assert.equal(result.ambiguousGroups.length, 0);
  assert.equal(result.uncategorizedCount, 3);
  assert.equal(result.table.rows.length, 1);

  const [checkingTransactions, savingsTransactions] = await Promise.all([
    actualApi.getTransactions(checkingAccountId, "2026-04-01", "2026-04-30"),
    actualApi.getTransactions(savingsAccountId, "2026-04-01", "2026-04-30"),
  ]);

  const checkingTransfer = checkingTransactions.find(
    (transaction) => transaction.notes === "smoke transfer out",
  );
  const savingsTransfer = savingsTransactions.find(
    (transaction) => transaction.notes === "smoke transfer in",
  );
  const checkingExpense = checkingTransactions.find(
    (transaction) => transaction.notes === "smoke expense",
  );

  assert.ok(checkingTransfer);
  assert.ok(savingsTransfer);
  assert.ok(checkingExpense);

  if (write) {
    assert.equal(checkingTransfer.transfer_id, savingsTransfer.id);
    assert.equal(savingsTransfer.transfer_id, checkingTransfer.id);
    assert.equal(payeesById.get(checkingTransfer.payee)?.transfer_acct, savingsAccountId);
    assert.equal(payeesById.get(savingsTransfer.payee)?.transfer_acct, checkingAccountId);
  } else {
    assert.equal(checkingTransfer.transfer_id ?? null, null);
    assert.equal(savingsTransfer.transfer_id ?? null, null);
    assert.equal(checkingTransfer.payee ?? null, null);
    assert.equal(savingsTransfer.payee ?? null, null);
  }

  assert.equal(checkingExpense.transfer_id ?? null, null);

  t.diagnostic(
    JSON.stringify(
      {
        dataDir,
        budget: {
          id: budget.id,
          name: budget.name,
        },
        checkingAccountId,
        savingsAccountId,
        candidatePairs: result.matches.length,
        dryRun: !write,
        keptDataDir: KEEP_DATA_DIR,
      },
      null,
      2,
    ),
  );
}

test(
  "transfer smoke dry run identifies but does not link matching uncategorized transactions",
  {
    concurrency: false,
    skip: RUN_SMOKE ? false : "Set ABCTL_RUN_SMOKE_TEST=1 to run smoke tests.",
  },
  async (t) => {
    await runSmokeCase(t, { write: false });
  },
);

test(
  "transfer smoke write links matching uncategorized transactions",
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
