import { formatAmount, formatBudgetDate } from "./reporting.js";
import { extractQueryData, normalizeTransaction } from "./transaction-data.js";

function fail(message) {
  throw new Error(message);
}

function truthy(value) {
  return value === true || value === 1 || value === "1";
}

function accountLabel(accountId, metadata) {
  return metadata.accountsById.get(accountId)?.name ?? "Unknown";
}

function pairSortKey(pair, metadata) {
  return [
    pair.from.date,
    formatAmount(Math.abs(pair.from.amount)),
    accountLabel(pair.from.accountId, metadata),
    accountLabel(pair.to.accountId, metadata),
    pair.from.id,
    pair.to.id,
  ].join("|");
}

function normalizeTransferTransaction(rawTransaction) {
  const normalized = normalizeTransaction(rawTransaction);
  return {
    ...normalized,
    accountId: rawTransaction.account ?? normalized.accountId,
    categoryId: rawTransaction.category ?? normalized.categoryId,
    payeeId: rawTransaction.payee ?? normalized.payeeId,
    transferId: rawTransaction.transfer_id ?? null,
    isChild: truthy(rawTransaction.is_child),
    isParent: truthy(rawTransaction.is_parent),
    raw: rawTransaction,
    startingBalance: truthy(rawTransaction.starting_balance_flag),
  };
}

function isEligibleTransferTransaction(transaction) {
  return (
    transaction.accountId &&
    transaction.amount !== 0 &&
    !transaction.isChild &&
    !transaction.isParent &&
    !transaction.startingBalance &&
    !transaction.transferId &&
    transaction.subtransactions.length === 0
  );
}

function groupTransferCandidates(transactions) {
  const groups = new Map();

  for (const transaction of transactions) {
    const key = `${transaction.date}|${Math.abs(transaction.amount)}`;
    const group = groups.get(key);
    if (group) {
      group.push(transaction);
    } else {
      groups.set(key, [transaction]);
    }
  }

  return groups;
}

export function findTransferCandidates(rawTransactions) {
  const transactions = rawTransactions
    .map(normalizeTransferTransaction)
    .filter(isEligibleTransferTransaction);
  const matches = [];
  const ambiguousGroups = [];

  for (const group of groupTransferCandidates(transactions).values()) {
    const outflows = group.filter((transaction) => transaction.amount < 0);
    const inflows = group.filter((transaction) => transaction.amount > 0);

    if (
      outflows.length === 1 &&
      inflows.length === 1 &&
      outflows[0].accountId !== inflows[0].accountId
    ) {
      matches.push({
        from: outflows[0],
        to: inflows[0],
      });
      continue;
    }

    if (outflows.length > 0 && inflows.length > 0) {
      ambiguousGroups.push(
        [...group].sort((left, right) => left.id.localeCompare(right.id)),
      );
    }
  }

  return {
    ambiguousGroups,
    matches,
    transactions,
  };
}

function validForTransfer(left, right) {
  return (
    left.id !== right.id &&
    left.account !== right.account &&
    left.amount === -right.amount &&
    !left.transfer_id &&
    !right.transfer_id &&
    !truthy(left.is_parent) &&
    !truthy(right.is_parent) &&
    !truthy(left.is_child) &&
    !truthy(right.is_child)
  );
}

function send(actualApi, name, args) {
  return actualApi.internal.send(name, args);
}

async function fetchBudgetDateFormat(actualApi) {
  const syncedPrefs = await send(actualApi, "preferences/get");
  if (syncedPrefs && typeof syncedPrefs === "object") {
    return syncedPrefs.dateFormat ?? null;
  }
  return null;
}

async function fetchUncategorizedTransactions(actualApi) {
  const query = actualApi
    .q("transactions")
    .filter({
      tombstone: false,
      "account.offbudget": false,
      category: null,
      transfer_id: null,
    })
    .select("*")
    .options({ splits: "inline" });

  return extractQueryData(await send(actualApi, "query", query.serialize()));
}

async function fetchTransactionsByIds(actualApi, transactionIds) {
  if (transactionIds.length === 0) {
    return [];
  }

  const query = actualApi
    .q("transactions")
    .filter({ id: { $oneof: transactionIds } })
    .select("*");

  const result = await send(actualApi, "query", query.serialize());
  return Array.isArray(result?.data) ? result.data : [];
}

async function buildTransferUpdates(actualApi, matches) {
  const transactionIds = [...new Set(matches.flatMap((pair) => [pair.from.id, pair.to.id]))];
  const transactions = await fetchTransactionsByIds(actualApi, transactionIds);
  const transactionsById = new Map(transactions.map((transaction) => [transaction.id, transaction]));

  if (transactionsById.size !== transactionIds.length) {
    fail("Failed to reload all transfer candidate transactions before updating.");
  }

  const payees = (await send(actualApi, "payees-get")).filter(
    (payee) => !truthy(payee.tombstone),
  );

  return matches.flatMap((pair) => {
    const fromTrans = transactionsById.get(pair.from.id);
    const toTrans = transactionsById.get(pair.to.id);

    if (!fromTrans || !toTrans) {
      fail(`Missing transaction for transfer pair ${JSON.stringify(pair.from.id)} / ${JSON.stringify(pair.to.id)}.`);
    }

    if (!validForTransfer(fromTrans, toTrans)) {
      fail(
        `Transactions ${JSON.stringify(pair.from.id)} and ${JSON.stringify(pair.to.id)} must be in different accounts, have opposite amounts, and not already be transfers.`,
      );
    }

    const fromPayee = payees.find((payee) => payee.transfer_acct === fromTrans.account);
    const toPayee = payees.find((payee) => payee.transfer_acct === toTrans.account);

    if (!fromPayee || !toPayee) {
      fail(
        `Missing transfer payee for one or both accounts in transfer pair ${JSON.stringify(pair.from.id)} / ${JSON.stringify(pair.to.id)}.`,
      );
    }

    return [
      {
        ...fromTrans,
        category: null,
        payee: toPayee.id,
        transfer_id: toTrans.id,
      },
      {
        ...toTrans,
        category: null,
        payee: fromPayee.id,
        transfer_id: fromTrans.id,
      },
    ];
  });
}

export function buildTransferCandidatesTable(matches, metadata, { dateFormat } = {}) {
  const rows = [...matches].sort((left, right) =>
    pairSortKey(left, metadata).localeCompare(pairSortKey(right, metadata)),
  );

  return {
    title: "Transfer Candidates",
    subtitle: `Across uncategorized transactions (${rows.length} pair${rows.length === 1 ? "" : "s"})`,
    columns: [
      { label: "Date", align: "left" },
      { label: "Amount", align: "right" },
      { label: "From Account", align: "left" },
      { label: "To Account", align: "left" },
    ],
    rows: rows.map((pair) => ({
      cells: [
        formatBudgetDate(pair.from.date, dateFormat),
        formatAmount(Math.abs(pair.from.amount)),
        accountLabel(pair.from.accountId, metadata),
        accountLabel(pair.to.accountId, metadata),
      ],
    })),
  };
}

export async function executeMakeTransfer(actualApi, metadata, { dryRun = false } = {}) {
  const uncategorizedTransactions = await fetchUncategorizedTransactions(actualApi);
  const { matches, ambiguousGroups } = findTransferCandidates(uncategorizedTransactions);
  const dateFormat = dryRun ? await fetchBudgetDateFormat(actualApi) : null;

  if (!dryRun && matches.length > 0) {
    const updated = await buildTransferUpdates(actualApi, matches);
    await send(actualApi, "transactions-batch-update", {
      runTransfers: false,
      updated,
    });
  }

  return {
    ambiguousGroups,
    dryRun,
    matches,
    table: buildTransferCandidatesTable(matches, metadata, { dateFormat }),
    uncategorizedCount: uncategorizedTransactions.length,
  };
}

export async function commandMakeTransfer({
  dryRun,
  fetchMetadata,
  renderCliTable,
  withActual,
}) {
  await withActual(async ({ actualApi }) => {
    const metadata = await fetchMetadata();
    const result = await executeMakeTransfer(actualApi, metadata, { dryRun });

    if (result.matches.length > 0) {
      console.log(renderCliTable(result.table));
      console.log("");
    }

    if (result.matches.length === 0) {
      console.log("No unambiguous uncategorized transfer candidates found.");
    } else if (dryRun) {
      console.log(
        `Dry run: found ${result.matches.length} transfer pair${result.matches.length === 1 ? "" : "s"} across ${result.uncategorizedCount} uncategorized transaction${result.uncategorizedCount === 1 ? "" : "s"}.`,
      );
    } else {
      console.log(
        `Linked ${result.matches.length} transfer pair${result.matches.length === 1 ? "" : "s"} across ${result.uncategorizedCount} uncategorized transaction${result.uncategorizedCount === 1 ? "" : "s"}.`,
      );
    }

    if (result.ambiguousGroups.length > 0) {
      console.log(
        `Skipped ${result.ambiguousGroups.length} ambiguous date/amount group${result.ambiguousGroups.length === 1 ? "" : "s"}.`,
      );
    }
  });
}
