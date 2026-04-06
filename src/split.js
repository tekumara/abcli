import { InvalidArgumentError } from "commander";

import { formatAmount, payeeName } from "./reporting.js";

function fail(message) {
  throw new Error(message);
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`Invalid date ${JSON.stringify(value)}. Expected YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    fail(`Invalid date ${JSON.stringify(value)}.`);
  }
  return parsed;
}

function parseAmountInput(value) {
  const raw = String(value).trim();
  const match = raw.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    fail(`Invalid amount ${JSON.stringify(value)}.`);
  }
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign ? -cents : cents;
}

export function parseSplitEntries(entries) {
  if (entries.length === 0 || entries.length % 3 !== 0) {
    throw new InvalidArgumentError(
      "Split entries must be provided as repeated triplets: <notes> <category> <amount>.",
    );
  }

  const splitEntries = [];
  for (let index = 0; index < entries.length; index += 3) {
    splitEntries.push({
      notes: entries[index],
      categoryName: entries[index + 1],
      amount: parseAmountInput(entries[index + 2]),
    });
  }
  return splitEntries;
}

export function validateSplitSelector(options) {
  if (!options.transactionId && !(options.payee && options.txnDate)) {
    fail("Provide --transaction-id or both --payee and --txn-date.");
  }
  if (options.transactionId && (options.payee || options.txnDate)) {
    fail("Use either --transaction-id or --payee/--txn-date, not both.");
  }
}

export function findGroupedTransaction(transactions, transactionId) {
  for (const transaction of transactions) {
    if (transaction.id === transactionId) {
      return { transaction, parent: null };
    }
    const child = transaction.subtransactions.find(
      (subtransaction) => subtransaction.id === transactionId,
    );
    if (child) {
      return { transaction: child, parent: transaction };
    }
  }
  return null;
}

export async function resolveSplitTarget(args, metadata, { fetchTransactions }) {
  if (args.transactionId) {
    const transactions = await fetchTransactions({ splitMode: "grouped" });
    const match = findGroupedTransaction(transactions, args.transactionId);
    if (!match) {
      fail(`Transaction ${JSON.stringify(args.transactionId)} not found.`);
    }
    if (match.parent) {
      fail("Cannot split a sub-transaction directly. Use the parent transaction id instead.");
    }
    return match.transaction;
  }

  parseIsoDate(args.txnDate);
  const transactions = await fetchTransactions({
    start: args.txnDate,
    end: args.txnDate,
    splitMode: "inline",
  });
  const matches = transactions.filter(
    (transaction) => transaction.date === args.txnDate && payeeName(transaction, metadata) === args.payee,
  );

  if (matches.length === 0) {
    fail(`No transaction found for payee=${JSON.stringify(args.payee)} on ${args.txnDate}.`);
  }
  if (matches.length > 1) {
    fail(
      `Found ${matches.length} transactions for payee=${JSON.stringify(args.payee)} on ${args.txnDate}, use --transaction-id instead.`,
    );
  }
  return matches[0];
}

export async function commandSplit(
  args,
  {
    fetchMetadata,
    fetchPreferenceValue,
    fetchTransactions,
    printTransaction,
    withActual,
  },
) {
  if (args.txnDate) {
    parseIsoDate(args.txnDate);
  }

  await withActual(async ({ actualApi }) => {
    const [metadata, dateFormat] = await Promise.all([
      fetchMetadata(),
      fetchPreferenceValue("dateFormat"),
    ]);
    const transaction = await resolveSplitTarget(args, metadata, { fetchTransactions });

    console.log("Splitting transaction:");
    printTransaction(transaction, metadata, { dateFormat });

    const splitTotal = args.splitEntries.reduce((sum, split) => sum + split.amount, 0);
    if (splitTotal !== transaction.amount) {
      console.log(
        `\n  WARNING: split total (${formatAmount(splitTotal)}) != transaction amount (${formatAmount(transaction.amount)})`,
      );
    }

    const categoryNameToId = new Map(
      [...metadata.categoriesById.values()].map((category) => [category.name, category.id]),
    );

    for (const split of args.splitEntries) {
      if (!categoryNameToId.has(split.categoryName)) {
        fail(`Category ${JSON.stringify(split.categoryName)} not found.`);
      }
    }

    await actualApi.updateTransaction(transaction.id, {
      category: null,
      subtransactions: args.splitEntries.map((split) => ({
        notes: split.notes,
        category: categoryNameToId.get(split.categoryName),
        amount: split.amount,
      })),
    });
    await actualApi.sync();

    for (const split of args.splitEntries) {
      console.log(`  + ${split.notes}, ${split.categoryName}, ${formatAmount(split.amount)}`);
    }
    console.log("Done.");
  });
}

export function addSplitCommand(program, deps) {
  program
    .command("split")
    .description("Split a transaction into sub-transactions.")
    .option("--transaction-id <id>")
    .option("--payee <payee>")
    .option("--txn-date <date>")
    .argument("<entries...>")
    .addHelpText(
      "after",
      [
        "",
        "Entry format:",
        "  Express entries as repeated triplets: <notes> <category> <amount>",
        '  Example: abctl split --transaction-id abc123 "Groceries run" "Food" -45.60 "Petrol" "Transport" -30',
      ].join("\n"),
    )
    .action(async (entries, options) => {
      validateSplitSelector(options);
      await commandSplit(
        {
          transactionId: options.transactionId ?? null,
          payee: options.payee ?? null,
          txnDate: options.txnDate ?? null,
          splitEntries: parseSplitEntries(entries),
        },
        deps,
      );
    });
}
