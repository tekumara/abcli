import { formatAmount } from "./reporting.js";
import { extractQueryData, normalizeDateValue } from "./transaction-data.js";

function truthy(value) {
  return value === true || value === 1 || value === "1";
}

export function buildLatestTransactionDateByAccount(transactions) {
  const latestByAccount = new Map();

  for (const transaction of transactions) {
    const accountId = transaction.account_id ?? transaction.account ?? transaction.acct ?? null;
    if (!accountId) {
      continue;
    }

    const normalized = normalizeDateValue(transaction.date);
    const current = latestByAccount.get(accountId);
    if (!current || normalized > current) {
      latestByAccount.set(accountId, normalized);
    }
  }

  return latestByAccount;
}

export function buildAccountsTable(accounts, latestDates = new Map()) {
  const rows = accounts.map((account) => {
    const suffixes = [];
    if (truthy(account.offbudget)) {
      suffixes.push("off budget");
    }
    if (truthy(account.closed)) {
      suffixes.push("closed");
    }

    return {
      ...account,
      displayName:
        suffixes.length > 0
          ? `${account.name} (${suffixes.join(", ")})`
          : account.name,
      latestDate: latestDates.get(account.id) ?? "",
    };
  });

  rows.sort((left, right) => {
    const leftRank = Number(truthy(left.closed)) * 2 + Number(truthy(left.offbudget));
    const rightRank = Number(truthy(right.closed)) * 2 + Number(truthy(right.offbudget));
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.displayName.localeCompare(right.displayName);
  });

  const total = rows.reduce((sum, account) => sum + account.balance, 0);

  return {
    title: "Accounts",
    subtitle: "Current balances",
    columns: [
      { label: "Account", align: "left" },
      { label: "Balance", align: "right" },
      { label: "Last Transaction", align: "left" },
    ],
    rows: [
      ...rows.map((account) => ({
        cells: [account.displayName, formatAmount(account.balance), account.latestDate],
      })),
      {
        bold: true,
        cells: ["Total", formatAmount(total), ""],
      },
    ],
  };
}

async function fetchLatestTransactionDateByAccount(actualApi) {
  return buildLatestTransactionDateByAccount(
    extractQueryData(
      await actualApi.runQuery(
        actualApi.q("transactions").filter({ tombstone: false }).select(["account", "date"]),
      ),
    ),
  );
}

export async function commandAccounts({ renderCliTable, withActual }) {
  await withActual(async ({ actualApi }) => {
    const accounts = await actualApi.getAccounts();
    if (accounts.length === 0) {
      console.log("No accounts found.");
      return;
    }

    const [rows, latestDates] = await Promise.all([
      Promise.all(
        accounts.map(async (account) => ({
          ...account,
          balance: await actualApi.getAccountBalance(account.id),
        })),
      ),
      fetchLatestTransactionDateByAccount(actualApi),
    ]);

    console.log(renderCliTable(buildAccountsTable(rows, latestDates)));
  });
}
