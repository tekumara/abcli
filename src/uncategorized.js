import { accountName, formatAmount, payeeName } from "./reporting.js";
import { extractQueryData, normalizeTransaction } from "./transaction-data.js";

export async function buildUncategorizedTransactionsTable(actualApi, metadata) {
  const query = actualApi
    .q("transactions")
    .filter({
      "account.offbudget": false,
      category: null,
      $or: [
        {
          "payee.transfer_acct.offbudget": true,
          "payee.transfer_acct": null,
        },
      ],
    })
    .select("*")
    .options({ splits: "inline" });

  const uncategorized = extractQueryData(await actualApi.runQuery(query))
    .map(normalizeTransaction)
    .sort((left, right) => {
      if (left.date !== right.date) {
        return right.date.localeCompare(left.date);
      }

      const leftAccount = accountName(left, metadata);
      const rightAccount = accountName(right, metadata);
      const byAccount = leftAccount.localeCompare(rightAccount);
      if (byAccount !== 0) {
        return byAccount;
      }

      const leftPayee = payeeName(left, metadata);
      const rightPayee = payeeName(right, metadata);
      const byPayee = leftPayee.localeCompare(rightPayee);
      if (byPayee !== 0) {
        return byPayee;
      }

      return left.id.localeCompare(right.id);
    });

  return {
    title: "Uncategorized Transactions",
    subtitle: `Across all accounts (${uncategorized.length} transaction${uncategorized.length === 1 ? "" : "s"})`,
    columns: [
      { label: "Date", align: "left" },
      { label: "Account", align: "left" },
      { label: "Payee", align: "left" },
      { label: "Notes", align: "left" },
      { label: "Amount", align: "right" },
      { label: "ID", align: "left" },
    ],
    rows: uncategorized.map((transaction) => ({
      cells: [
        transaction.date,
        accountName(transaction, metadata),
        payeeName(transaction, metadata),
        transaction.notes ?? "",
        formatAmount(transaction.amount),
        transaction.id,
      ],
    })),
  };
}

export async function commandUncategorized({ fetchMetadata, renderCliTable, withActual }) {
  await withActual(async ({ actualApi }) => {
    const metadata = await fetchMetadata();
    const table = await buildUncategorizedTransactionsTable(actualApi, metadata);

    if (table.rows.length === 0) {
      console.log("No uncategorized transactions found.");
      return;
    }

    console.log(renderCliTable(table));
  });
}
