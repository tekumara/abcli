#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  accountName,
  buildReportTable,
  categoryName,
  filterReportTransactions,
  formatAmount,
  payeeName,
  renderCliTable,
  resolveDateRange,
  toHtml,
  toTsv,
} from "./reporting.js";

const execFile = promisify(execFileCallback);

const SERVER_URL = process.env.ACTUAL_SERVER_URL ?? "http://localhost:5007";
const DEFAULT_DATA_DIR = "/tmp/actual";
const DATA_DIR = process.env.ACTUAL_DATA_DIR ?? DEFAULT_DATA_DIR;
let actualApiModulePromise;

async function getActualApi() {
  if (!actualApiModulePromise) {
    if (!globalThis.navigator) {
      const platform =
        process.platform === "darwin"
          ? "MacIntel"
          : process.platform === "win32"
            ? "Win32"
            : process.platform;
      globalThis.navigator = {
        platform,
        userAgent: `node/${process.version}`,
      };
    }

    actualApiModulePromise = import("@actual-app/api");
  }

  return actualApiModulePromise;
}

function fail(message) {
  throw new Error(message);
}

function truthy(value) {
  return value === true || value === 1 || value === "1";
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function normalizeDateValue(value) {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    if (/^\d{8}$/.test(value)) {
      return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    }
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    const digits = String(value);
    if (digits.length === 8) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    }
  }
  fail(`Unsupported transaction date value: ${JSON.stringify(value)}`);
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

function normalizeTransaction(rawTxn) {
  return {
    id: rawTxn.id,
    accountId: rawTxn.account_id ?? rawTxn.account ?? rawTxn.acct ?? null,
    categoryId: rawTxn.category_id ?? rawTxn.category ?? null,
    payeeId: rawTxn.payee_id ?? rawTxn.payee ?? null,
    notes: rawTxn.notes ?? "",
    amount: toFiniteNumber(rawTxn.amount, 0),
    date: normalizeDateValue(rawTxn.date),
    subtransactions: Array.isArray(rawTxn.subtransactions)
      ? rawTxn.subtransactions.map(normalizeTransaction)
      : [],
  };
}

function normalizeReport(rawReport) {
  return {
    ...rawReport,
    date_static: truthy(rawReport.date_static),
    show_empty: truthy(rawReport.show_empty),
    show_offbudget: truthy(rawReport.show_offbudget),
    show_hidden: truthy(rawReport.show_hidden),
    show_uncategorized: truthy(rawReport.show_uncategorized),
    tombstone: truthy(rawReport.tombstone),
  };
}

function extractQueryData(result) {
  if (Array.isArray(result)) {
    return result;
  }
  if (Array.isArray(result?.data)) {
    return result.data;
  }
  return [];
}

function buildMetadata({ accounts, categories, categoryGroups, payees }) {
  const groupsById = new Map(
    categoryGroups
      .filter((group) => !truthy(group.tombstone))
      .map((group, index) => [
        group.id,
        {
          id: group.id,
          name: group.name ?? "?",
          hidden: truthy(group.hidden),
          sortOrder: toFiniteNumber(group.sort_order, index),
        },
      ]),
  );

  const categoriesById = new Map(
    categories
      .filter((category) => !truthy(category.tombstone))
      .map((category, index) => {
        const groupId = category.group_id ?? category.group ?? category.cat_group ?? null;
        return [
          category.id,
          {
            id: category.id,
            name: category.name ?? "?",
            hidden: truthy(category.hidden),
            groupId,
            sortOrder: toFiniteNumber(category.sort_order, index),
          },
        ];
      }),
  );

  const accountsById = new Map(
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
  );

  const payeesById = new Map(
    payees
      .filter((payee) => !truthy(payee.tombstone))
      .map((payee) => [payee.id, { id: payee.id, name: payee.name ?? "?" }]),
  );

  return { groupsById, categoriesById, accountsById, payeesById };
}


async function copyRtf(html) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "actual-trans-"));
  const htmlPath = path.join(tempDir, "report.html");
  const rtfPath = path.join(tempDir, "report.rtf");

  try {
    await writeFile(htmlPath, html, "utf8");
    await execFile("textutil", ["-convert", "rtf", htmlPath, "-output", rtfPath]);
    await execFile("osascript", [
      "-e",
      `set the clipboard to (read POSIX file "${rtfPath}" as «class RTF »)`,
    ]);
  } finally {
    for (const file of [htmlPath, rtfPath]) {
      if (existsSync(file)) {
        await unlink(file);
      }
    }
  }
}

async function resolveBudget() {
  const actualApi = await getActualApi();
  const budgets = await actualApi.getBudgets();
  if (budgets.length === 0) {
    fail(
      "No budgets found. Set ACTUAL_BUDGET_SYNC_ID or create a cloud file in Actual first.",
    );
  }

  const requestedBudget = process.env.ACTUAL_BUDGET_SYNC_ID?.trim();
  if (requestedBudget) {
    const directMatch = budgets.find(
      (budget) =>
        budget.groupId === requestedBudget ||
        budget.cloudFileId === requestedBudget ||
        budget.id === requestedBudget ||
        budget.name === requestedBudget,
    );
    if (directMatch) {
      return directMatch;
    }

    const foldedRequest = requestedBudget.toLowerCase();
    const nameMatches = budgets.filter(
      (budget) => budget.name?.toLowerCase() === foldedRequest,
    );
    if (nameMatches.length === 1) {
      return nameMatches[0];
    }
    if (nameMatches.length > 1) {
      fail(
        `Budget name ${JSON.stringify(requestedBudget)} is ambiguous. Matching budgets: ${nameMatches
          .map((budget) => budget.name)
          .join(", ")}`,
      );
    }

    fail(
      `Budget ${JSON.stringify(requestedBudget)} not found. Available budgets: ${budgets
        .map((budget) => budget.name)
        .join(", ")}`,
    );
  }

  return budgets[0];
}

async function withActual(fn, { loadBudget = true } = {}) {
  const actualApi = await getActualApi();
  const password = process.env.ACTUAL_PASSWORD;
  if (!password) {
    fail("ACTUAL_PASSWORD is required.");
  }

  if (DATA_DIR === DEFAULT_DATA_DIR && !existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }

  await actualApi.init({
    dataDir: DATA_DIR,
    serverURL: SERVER_URL,
    password,
    verbose: false,
  });

  try {
    if (loadBudget) {
      const budget = await resolveBudget();
      if (budget.groupId) {
        await actualApi.downloadBudget(budget.groupId, { password });
      } else if (budget.id) {
        await actualApi.loadBudget(budget.id);
      } else {
        fail(`Budget ${JSON.stringify(budget.name ?? "(unknown)")} is missing both local id and sync id.`);
      }
    }

    return await fn({ actualApi, password });
  } finally {
    try {
      await actualApi.shutdown();
    } catch {
      // Ignore shutdown failures so the original error is preserved.
    }
  }
}

async function fetchMetadata() {
  const actualApi = await getActualApi();
  const [accountsResult, categoriesResult, categoryGroupsResult, payeesResult] = await Promise.all([
    actualApi.runQuery(actualApi.q("accounts").filter({ tombstone: false }).select("*")),
    actualApi.runQuery(actualApi.q("categories").filter({ tombstone: false }).select("*")),
    actualApi.runQuery(actualApi.q("category_groups").filter({ tombstone: false }).select("*")),
    actualApi.runQuery(actualApi.q("payees").filter({ tombstone: false }).select("*")),
  ]);

  const accounts = extractQueryData(accountsResult);
  const categories = extractQueryData(categoriesResult);
  const categoryGroups = extractQueryData(categoryGroupsResult);
  const payees = extractQueryData(payeesResult);

  return buildMetadata({ accounts, categories, categoryGroups, payees });
}

async function fetchTransactions({ start = null, end = null, splitMode = "inline" } = {}) {
  const actualApi = await getActualApi();
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
}

async function fetchReports() {
  const actualApi = await getActualApi();
  const reports = extractQueryData(await actualApi.runQuery(
    actualApi.q("custom_reports").filter({ tombstone: false }).select("*"),
  ));
  return reports.map(normalizeReport);
}

function printTransaction(transaction, metadata) {
  console.log(`  id:       ${transaction.id}`);
  console.log(`  account:  ${accountName(transaction, metadata)}`);
  console.log(`  date:     ${transaction.date}`);
  console.log(`  payee:    ${payeeName(transaction, metadata)}`);
  console.log(`  notes:    ${transaction.notes ?? ""}`);
  console.log(`  category: ${categoryName(transaction, metadata)}`);
  console.log(`  amount:   ${formatAmount(transaction.amount)}`);
}

function parseMode(value) {
  if (value !== "total" && value !== "time") {
    throw new InvalidArgumentError("--mode must be either total or time.");
  }
  return value;
}

function summarizeBudgets(budgets) {
  const summaries = new Map();

  for (const budget of budgets) {
    const key = budget.groupId ?? budget.id ?? budget.cloudFileId ?? budget.name ?? JSON.stringify(budget);
    const existing = summaries.get(key) ?? {
      name: budget.name ?? "(no name)",
      groupId: budget.groupId ?? null,
      cloudFileId: budget.cloudFileId ?? null,
      localIds: [],
      states: new Set(),
    };

    existing.name = budget.name ?? existing.name;
    existing.groupId ??= budget.groupId ?? null;
    existing.cloudFileId ??= budget.cloudFileId ?? null;
    if (budget.id && !existing.localIds.includes(budget.id)) {
      existing.localIds.push(budget.id);
    }
    existing.states.add(budget.state === "remote" ? "remote" : "local");
    summaries.set(key, existing);
  }

  return [...summaries.values()].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    return (left.groupId ?? left.localIds[0] ?? left.cloudFileId ?? "").localeCompare(
      right.groupId ?? right.localIds[0] ?? right.cloudFileId ?? "",
    );
  });
}

function printBudgets(budgets) {
  for (const budget of budgets) {
    const locations = [...budget.states].sort().join(", ");
    console.log(budget.name);
    console.log(`  sync id:      ${budget.groupId ?? "(none)"}`);
    console.log(`  cloud file:   ${budget.cloudFileId ?? "(none)"}`);
    console.log(`  local id:     ${budget.localIds.join(", ") || "(none)"}`);
    console.log(`  available in: ${locations}`);
    console.log("");
  }
}

function buildAccountsTable(accounts) {
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
    ],
    rows: [
      ...rows.map((account) => ({
        cells: [account.displayName, formatAmount(account.balance)],
      })),
      {
        bold: true,
        cells: ["Total", formatAmount(total)],
      },
    ],
  };
}

function parseSplitTriplets(entries) {
  if (entries.length === 0 || entries.length % 3 !== 0) {
    throw new InvalidArgumentError(
      "Split entries must be provided as repeated triplets: <notes> <category> <amount>.",
    );
  }

  const splitTriplets = [];
  for (let index = 0; index < entries.length; index += 3) {
    splitTriplets.push({
      notes: entries[index],
      categoryName: entries[index + 1],
      amount: parseAmountInput(entries[index + 2]),
    });
  }
  return splitTriplets;
}

function validateSplitSelector(options) {
  if (!options.transactionId && !(options.payee && options.txnDate)) {
    fail("Provide --transaction-id or both --payee and --txn-date.");
  }
  if (options.transactionId && (options.payee || options.txnDate)) {
    fail("Use either --transaction-id or --payee/--txn-date, not both.");
  }
}

function buildProgram() {
  const program = new Command();

  program
    .name("node trans.js")
    .description("Actual budget helper commands.")
    .showHelpAfterError()
    .addHelpText(
      "after",
      [
        "",
        "Environment:",
        "  ACTUAL_PASSWORD        Required.",
        "  ACTUAL_BUDGET_SYNC_ID  Optional. Budget name, groupId, or cloudFileId. Defaults to the first available budget.",
        "  ACTUAL_SERVER_URL      Optional. Defaults to http://localhost:5007",
        "  ACTUAL_DATA_DIR        Optional. Defaults to /tmp/actual",
      ].join("\n"),
    );

  program
    .command("budgets")
    .description("List budgets and their sync ids.")
    .action(async () => {
      await commandBudgets();
    });

  program
    .command("accounts")
    .description("List accounts and their current balances.")
    .action(async () => {
      await commandAccounts();
    });

  program
    .command("find")
    .description("Find transactions by exact payee name and ISO date (YYYY-MM-DD).")
    .argument("<payee>")
    .argument("<txn-date>")
    .action(async (payee, txnDate) => {
      await commandFind({ payee, txnDate });
    });

  program
    .command("split")
    .description("Split a transaction into sub-transactions.")
    .option("--transaction-id <id>")
    .option("--payee <payee>")
    .option("--txn-date <date>")
    .argument("<entries...>")
    .action(async (entries, options) => {
      validateSplitSelector(options);
      await commandSplit({
        transactionId: options.transactionId ?? null,
        payee: options.payee ?? null,
        txnDate: options.txnDate ?? null,
        splitTriplets: parseSplitTriplets(entries),
      });
    });

  program
    .command("report")
    .description("Render a custom report by name.")
    .argument("<name>")
    .option("--mode <mode>", "report mode", parseMode)
    .option("--tsv", "output tab-separated text")
    .option("--pbcopy", "copy rich text output to the clipboard")
    .action(async (name, options) => {
      await commandReport({
        name,
        mode: options.mode ?? null,
        tsv: options.tsv ?? false,
        pbcopy: options.pbcopy ?? false,
      });
    });

  return program;
}

function findGroupedTransaction(transactions, transactionId) {
  for (const transaction of transactions) {
    if (transaction.id === transactionId) {
      return { transaction, parent: null };
    }
    const child = transaction.subtransactions.find((subtransaction) => subtransaction.id === transactionId);
    if (child) {
      return { transaction: child, parent: transaction };
    }
  }
  return null;
}

async function commandFind({ payee, txnDate }) {
  parseIsoDate(txnDate);
  await withActual(async () => {
    const metadata = await fetchMetadata();
    const transactions = await fetchTransactions({ start: txnDate, end: txnDate, splitMode: "inline" });
    const matches = transactions.filter(
      (transaction) => transaction.date === txnDate && payeeName(transaction, metadata) === payee,
    );

    if (matches.length === 0) {
      console.log(`No transactions found for payee=${JSON.stringify(payee)} on ${txnDate}`);
      return;
    }

    for (const transaction of matches) {
      printTransaction(transaction, metadata);
      console.log("");
    }
  });
}

async function commandBudgets() {
  await withActual(async ({ actualApi }) => {
    const budgets = summarizeBudgets(await actualApi.getBudgets());
    if (budgets.length === 0) {
      console.log("No budgets found.");
      return;
    }
    printBudgets(budgets);
  }, { loadBudget: false });
}

async function commandAccounts() {
  await withActual(async ({ actualApi }) => {
    const accounts = await actualApi.getAccounts();
    if (accounts.length === 0) {
      console.log("No accounts found.");
      return;
    }

    const rows = await Promise.all(
      accounts.map(async (account) => ({
        ...account,
        balance: await actualApi.getAccountBalance(account.id),
      })),
    );

    console.log(renderCliTable(buildAccountsTable(rows)));
  });
}

async function resolveSplitTarget(args, metadata) {
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
  const transactions = await fetchTransactions({ start: args.txnDate, end: args.txnDate, splitMode: "inline" });
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

async function commandSplit(args) {
  if (args.txnDate) {
    parseIsoDate(args.txnDate);
  }

  await withActual(async () => {
    const actualApi = await getActualApi();
    const metadata = await fetchMetadata();
    const transaction = await resolveSplitTarget(args, metadata);

    console.log("Splitting transaction:");
    printTransaction(transaction, metadata);

    const splitTotal = args.splitTriplets.reduce((sum, split) => sum + split.amount, 0);
    if (splitTotal !== transaction.amount) {
      console.log(
        `\n  WARNING: split total (${formatAmount(splitTotal)}) != transaction amount (${formatAmount(transaction.amount)})`,
      );
    }

    const categoryNameToId = new Map(
      [...metadata.categoriesById.values()].map((category) => [category.name, category.id]),
    );

    for (const split of args.splitTriplets) {
      if (!categoryNameToId.has(split.categoryName)) {
        fail(`Category ${JSON.stringify(split.categoryName)} not found.`);
      }
    }

    await actualApi.updateTransaction(transaction.id, {
      category: null,
      subtransactions: args.splitTriplets.map((split) => ({
        notes: split.notes,
        category: categoryNameToId.get(split.categoryName),
        amount: split.amount,
      })),
    });
    await actualApi.sync();

    for (const split of args.splitTriplets) {
      console.log(`  + ${split.notes}, ${split.categoryName}, ${formatAmount(split.amount)}`);
    }
    console.log("Done.");
  });
}

async function commandReport(args) {
  await withActual(async () => {
    const [reports, metadata] = await Promise.all([fetchReports(), fetchMetadata()]);
    const report = reports.find((entry) => entry.name === args.name && !entry.tombstone);

    if (!report) {
      const available = reports
        .filter((entry) => !entry.tombstone)
        .map((entry) => entry.name ?? "?")
        .sort((left, right) => left.localeCompare(right));
      let message = `Report ${JSON.stringify(args.name)} not found.`;
      if (available.length > 0) {
        message += ` Available: ${available.join(", ")}`;
      }
      fail(message);
    }

    const [start, end] = resolveDateRange(report);
    const transactions = filterReportTransactions(
      await fetchTransactions({ start, end, splitMode: "inline" }),
      report,
      metadata,
    );

    const reportTable = buildReportTable({
      transactions,
      report,
      metadata,
      mode: args.mode ?? report.mode,
      start,
      end,
    });

    if (args.pbcopy) {
      console.log(renderCliTable(reportTable));
      await copyRtf(toHtml(reportTable));
      console.log("Copied to clipboard.");
      return;
    }

    if (args.tsv) {
      console.log(toTsv(reportTable));
      return;
    }

    console.log(renderCliTable(reportTable));
  });
}

async function main() {
  const program = buildProgram();
  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

await main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
