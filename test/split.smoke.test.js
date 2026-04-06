import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { commandSplit } from "../src/split.js";
import { extractQueryData, normalizeTransaction } from "../src/transaction-data.js";

const RUN_SMOKE = process.env.ABCTL_RUN_SMOKE_TEST === "1";
const RUN_WRITE = process.env.ABCTL_SMOKE_WRITE === "1";
const KEEP_DATA_DIR = process.env.ABCTL_SMOKE_KEEP_DATA_DIR === "1";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when running the split smoke test.`);
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

function buildMetadata(accounts, categories, payees) {
  return {
    groupsById: new Map(),
    categoriesById: new Map(
      categories
        .filter((category) => !truthy(category.tombstone))
        .map((category, index) => [
          category.id,
          {
            id: category.id,
            name: category.name ?? "?",
            hidden: truthy(category.hidden),
            sortOrder: toFiniteNumber(category.sort_order, index),
          },
        ]),
    ),
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

function createFetchTransactions(actualApi) {
  return async function fetchTransactions({ start = null, end = null, splitMode = "inline" } = {}) {
    const query = actualApi
      .q("transactions")
      .filter({ tombstone: false })
      .select("*")
      .options({ splits: splitMode });
    const transactions = extractQueryData(await actualApi.runQuery(query)).map(normalizeTransaction);
    return transactions.filter((transaction) => {
      if (start && transaction.date < start) {
        return false;
      }
      if (end && transaction.date > end) {
        return false;
      }
      return true;
    });
  };
}

async function runSmokeCase(t) {
  const budgetPrefix = process.env.ABCTL_SPLIT_SMOKE_BUDGET_PREFIX ?? "abctl-split-smoke";
  const accountName = process.env.ABCTL_SPLIT_SMOKE_ACCOUNT_NAME ?? "Split Smoke Account";
  const payeeName = process.env.ABCTL_SPLIT_SMOKE_PAYEE ?? "Crystal Realty Limit";
  const serverURL = process.env.ACTUAL_SERVER_URL ?? "http://localhost:5007";
  const password = requiredEnv("ACTUAL_PASSWORD");
  const budgetName = `${budgetPrefix}-${Date.now()}`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "abctl-split-"));

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
  const expenseGroupId = await actualApi.createCategoryGroup({
    name: "Split Smoke Expenses",
    isIncome: false,
  });
  const incomeGroupId = await actualApi.createCategoryGroup({
    name: "Split Smoke Income",
    isIncome: true,
  });
  const agentFeesId = await actualApi.createCategory({
    name: "Agent fees",
    group_id: expenseGroupId,
    is_income: false,
  });
  const rentalIncomeId = await actualApi.createCategory({
    name: "Rental income",
    group_id: incomeGroupId,
    is_income: true,
  });
  const payeeId = await actualApi.createPayee({ name: payeeName });

  await actualApi.addTransactions(accountId, [
    {
      amount: 165000,
      date: "2025-04-15",
      payee: payeeId,
      notes: "Harcourts 25 Akarana Rent",
    },
  ]);

  const fetchTransactions = createFetchTransactions(actualApi);

  await commandSplit(
    {
      transactionId: null,
      payee: payeeName,
      txnDate: "2025-04-15",
      splitEntries: [
        { notes: "62", categoryName: "Agent fees", amount: -9000 },
        { notes: "", categoryName: "Rental income", amount: 174000 },
      ],
    },
    {
      fetchMetadata: async () =>
        buildMetadata(
          await actualApi.getAccounts(),
          await actualApi.getCategories(),
          await actualApi.getPayees(),
        ),
      fetchPreferenceValue: async (preferenceId) => {
        if (preferenceId !== "dateFormat") {
          return null;
        }
        return "DD/MM/YYYY";
      },
      fetchTransactions,
      printTransaction: () => {},
      withActual: async (fn) =>
        fn({
          actualApi: {
            internal: {
              send: (...innerArgs) => actualApi.internal.send(...innerArgs),
            },
            sync: async () => {},
          },
        }),
    },
  );

  const transactions = await fetchTransactions({
    start: "2025-04-15",
    end: "2025-04-15",
    splitMode: "grouped",
  });
  assert.equal(transactions.length, 1);

  const [transaction] = transactions;
  assert.equal(transaction.accountId, accountId);
  assert.equal(transaction.payeeId, payeeId);
  assert.equal(transaction.amount, 165000);
  assert.equal(transaction.date, "2025-04-15");
  assert.equal(transaction.notes, "Harcourts 25 Akarana Rent");
  assert.equal(transaction.categoryId, null);
  assert.equal(transaction.subtransactions.length, 2);

  const splitSummary = transaction.subtransactions
    .map((split) => ({
      accountId: split.accountId,
      amount: split.amount,
      categoryId: split.categoryId,
      date: split.date,
      notes: split.notes,
      payeeId: split.payeeId,
    }))
    .sort((left, right) => left.amount - right.amount);

  assert.deepEqual(splitSummary, [
    {
      accountId,
      amount: -9000,
      categoryId: agentFeesId,
      date: "2025-04-15",
      notes: "62",
      payeeId,
    },
    {
      accountId,
      amount: 174000,
      categoryId: rentalIncomeId,
      date: "2025-04-15",
      notes: "",
      payeeId,
    },
  ]);

  t.diagnostic(
    JSON.stringify(
      {
        dataDir,
        budget: {
          id: budget.id,
          name: budget.name,
        },
        accountId,
        payeeId,
        splitCount: transaction.subtransactions.length,
        keptDataDir: KEEP_DATA_DIR,
      },
      null,
      2,
    ),
  );
}

test(
  "split smoke test writes a split transaction in a disposable budget",
  {
    concurrency: false,
    skip:
      RUN_SMOKE && RUN_WRITE
        ? false
        : "Set ABCTL_RUN_SMOKE_TEST=1 and ABCTL_SMOKE_WRITE=1 to run the split smoke test.",
  },
  async (t) => {
    await runSmokeCase(t);
  },
);
