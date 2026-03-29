#!/usr/bin/env node

import Table from "cli-table3";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const SERVER_URL = process.env.ACTUAL_SERVER_URL ?? "http://localhost:5007";
const DATA_DIR = process.env.ACTUAL_DATA_DIR ?? "/tmp/actual";
const AMOUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
});
const RANGE_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
});
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

function printUsage() {
  console.log(
    [
      "Usage: node trans.js <command> [options]",
      "",
      "Commands:",
      "  find <payee> <txn-date>",
      "      Find transactions by exact payee name and ISO date (YYYY-MM-DD).",
      "",
      "  split [--transaction-id <id> | --payee <payee> --txn-date <date>] <notes> <category> <amount> ...",
      "      Split a transaction into sub-transactions.",
      "",
      "  report <name> [--mode total|time] [--tsv] [--pbcopy]",
      "      Render a custom report by name.",
      "",
      "Environment:",
      "  ACTUAL_PASSWORD        Required.",
      "  ACTUAL_BUDGET_SYNC_ID  Optional. Budget name, groupId, or cloudFileId. Defaults to the first available budget.",
      "  ACTUAL_SERVER_URL      Optional. Defaults to http://localhost:5007",
      "  ACTUAL_DATA_DIR        Optional. Defaults to /tmp/actual",
    ].join("\n"),
  );
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

function localToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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

function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function monthStart(date, offset) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

function firstOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function lastDayOfPreviousMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 0);
}

function monthKey(isoDate) {
  return `${isoDate.slice(0, 7)}-01`;
}

function formatMonthKey(date) {
  return formatIsoDate(firstOfMonth(date));
}

function formatMonthLabel(isoDate) {
  return MONTH_LABEL_FORMATTER.format(parseIsoDate(isoDate));
}

function formatRangeLabel(isoDate) {
  return RANGE_LABEL_FORMATTER.format(parseIsoDate(isoDate));
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

function formatAmount(cents) {
  return AMOUNT_FORMATTER.format(cents / 100);
}

function formatDecimal(value) {
  return AMOUNT_FORMATTER.format(value);
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

function accountName(transaction, metadata) {
  return metadata.accountsById.get(transaction.accountId)?.name ?? "Unknown";
}

function payeeName(transaction, metadata) {
  return metadata.payeesById.get(transaction.payeeId)?.name ?? "Unknown";
}

function categoryName(transaction, metadata) {
  return metadata.categoriesById.get(transaction.categoryId)?.name ?? "Uncategorized";
}

function categoryGroupName(transaction, metadata) {
  const category = metadata.categoriesById.get(transaction.categoryId);
  const group = category ? metadata.groupsById.get(category.groupId) : null;
  return group?.name ?? "Other";
}

function categoryInfo(transaction, metadata) {
  const category = metadata.categoriesById.get(transaction.categoryId);
  if (!category) {
    return {
      groupName: "Other",
      groupSort: Number.POSITIVE_INFINITY,
      categoryName: "Uncategorized",
      categorySort: Number.POSITIVE_INFINITY,
    };
  }

  const group = metadata.groupsById.get(category.groupId);
  return {
    groupName: group?.name ?? "Other",
    groupSort: group?.sortOrder ?? Number.POSITIVE_INFINITY,
    categoryName: category.name ?? "?",
    categorySort: category.sortOrder ?? Number.POSITIVE_INFINITY,
  };
}

function groupKey(transaction, groupBy, metadata) {
  switch (groupBy) {
    case "Group":
      return transaction.categoryId ? categoryGroupName(transaction, metadata) : "Uncategorized";
    case "Payee":
      return payeeName(transaction, metadata);
    case "Account":
      return accountName(transaction, metadata);
    default:
      return categoryName(transaction, metadata);
  }
}

function resolveDateRange(report) {
  if (report.date_static && report.start_date) {
    return [report.start_date, report.end_date ?? null];
  }

  const today = localToday();
  const first = firstOfMonth(today);
  const lastPrev = lastDayOfPreviousMonth(first);

  switch (report.date_range) {
    case "thisMonth":
      return [formatIsoDate(first), null];
    case "lastMonth":
      return [formatMonthKey(monthStart(today, -1)), formatIsoDate(lastPrev)];
    case "yearToDate":
      return [`${today.getFullYear()}-01-01`, null];
    case "lastYear":
      return [`${today.getFullYear() - 1}-01-01`, `${today.getFullYear() - 1}-12-31`];
    default: {
      const match = /^last(\d+)Months$/.exec(report.date_range ?? "");
      if (match) {
        return [formatMonthKey(monthStart(today, -Number(match[1]))), formatIsoDate(lastPrev)];
      }
      return [null, null];
    }
  }
}

function formatDateRange(start, end) {
  if (!start && !end) {
    return "All time";
  }
  const parts = [];
  if (start) {
    parts.push(formatRangeLabel(start));
  }
  parts.push(end ? formatRangeLabel(end) : "present");
  return parts.join(" - ");
}

function reportHeader(report, start, end) {
  return [`# ${report.name}`, "", `*${formatDateRange(start, end)}*`, ""];
}

function monthColumns(start, end) {
  if (!start) {
    return [];
  }
  const current = firstOfMonth(parseIsoDate(start));
  const endMonth = firstOfMonth(end ? parseIsoDate(end) : localToday());
  const columns = [];
  const cursor = new Date(current);
  while (cursor <= endMonth) {
    columns.push(formatIsoDate(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return columns;
}

function applyConditions(transactions, conditionsJson, conditionsOp = "and") {
  if (!conditionsJson) {
    return [...transactions];
  }
  const conditions =
    typeof conditionsJson === "string" ? JSON.parse(conditionsJson) : conditionsJson;
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return [...transactions];
  }

  const combine = conditionsOp === "or" ? "some" : "every";

  return transactions.filter((transaction) =>
    conditions[combine]((condition) => {
      let value = null;
      switch (condition.field) {
        case "category":
          value = transaction.categoryId;
          break;
        case "account":
          value = transaction.accountId;
          break;
        case "payee":
          value = transaction.payeeId;
          break;
        default:
          value = null;
      }

      switch (condition.op) {
        case "is":
          return value === condition.value;
        case "isNot":
          return value !== condition.value;
        case "oneOf":
          return Array.isArray(condition.value) && condition.value.includes(value);
        case "notOneOf":
          return Array.isArray(condition.value) && !condition.value.includes(value);
        default:
          return true;
      }
    }),
  );
}

function totalRow(label, deposits, payments, numMonths, bold = false) {
  const total = deposits + payments;
  const average = total / 100 / numMonths;
  const cells = [
    bold ? `**${label}**` : label,
    bold ? `**${formatAmount(deposits)}**` : formatAmount(deposits),
    bold ? `**${formatAmount(payments)}**` : formatAmount(payments),
    bold ? `**${formatAmount(total)}**` : formatAmount(total),
    bold ? `**${formatDecimal(average)}**` : formatDecimal(average),
  ];
  return `| ${cells.join(" | ")} |`;
}

function renderTotalFlat(transactions, groupBy, descending, report, metadata, numMonths) {
  const groups = new Map();

  for (const transaction of transactions) {
    const key = groupKey(transaction, groupBy, metadata);
    const current = groups.get(key) ?? { deposits: 0, payments: 0 };
    if (transaction.amount > 0) {
      current.deposits += transaction.amount;
    } else {
      current.payments += transaction.amount;
    }
    groups.set(key, current);
  }

  const rows = [...groups.entries()]
    .filter(([, amounts]) => report.show_empty || amounts.deposits + amounts.payments !== 0)
    .sort((left, right) => {
      const diff =
        left[1].deposits +
        left[1].payments -
        (right[1].deposits + right[1].payments);
      if (diff !== 0) {
        return descending ? -diff : diff;
      }
      return left[0].localeCompare(right[0]);
    });

  const lines = ["| " + `${groupBy} | Deposits | Payments | Totals | Average |`, "|---|---:|---:|---:|---:|"];
  let grandDeposits = 0;
  let grandPayments = 0;

  for (const [key, amounts] of rows) {
    grandDeposits += amounts.deposits;
    grandPayments += amounts.payments;
    lines.push(totalRow(key, amounts.deposits, amounts.payments, numMonths));
  }

  lines.push(totalRow("Totals", grandDeposits, grandPayments, numMonths, true));
  return lines;
}

function renderTotalByCategory(transactions, report, metadata, numMonths) {
  const groups = new Map();

  for (const transaction of transactions) {
    const info = categoryInfo(transaction, metadata);
    const group = groups.get(info.groupName) ?? {
      sortOrder: info.groupSort,
      categories: new Map(),
    };

    const category = group.categories.get(info.categoryName) ?? {
      sortOrder: info.categorySort,
      deposits: 0,
      payments: 0,
    };

    if (transaction.amount > 0) {
      category.deposits += transaction.amount;
    } else {
      category.payments += transaction.amount;
    }

    group.categories.set(info.categoryName, category);
    groups.set(info.groupName, group);
  }

  const lines = ["| Category | Deposits | Payments | Totals | Average |", "|---|---:|---:|---:|---:|"];
  let grandDeposits = 0;
  let grandPayments = 0;

  const sortedGroups = [...groups.entries()].sort((left, right) => {
    const diff = left[1].sortOrder - right[1].sortOrder;
    return diff !== 0 ? diff : left[0].localeCompare(right[0]);
  });

  for (const [groupName, group] of sortedGroups) {
    const categories = [...group.categories.entries()].sort((left, right) => {
      const diff = left[1].sortOrder - right[1].sortOrder;
      return diff !== 0 ? diff : left[0].localeCompare(right[0]);
    });

    const groupDeposits = categories.reduce((sum, [, category]) => sum + category.deposits, 0);
    const groupPayments = categories.reduce((sum, [, category]) => sum + category.payments, 0);

    if (!report.show_empty && groupDeposits + groupPayments === 0) {
      continue;
    }

    grandDeposits += groupDeposits;
    grandPayments += groupPayments;
    lines.push(totalRow(groupName, groupDeposits, groupPayments, numMonths, true));

    for (const [categoryName, category] of categories) {
      if (!report.show_empty && category.deposits + category.payments === 0) {
        continue;
      }
      lines.push(totalRow(categoryName, category.deposits, category.payments, numMonths));
    }
  }

  lines.push(totalRow("Totals", grandDeposits, grandPayments, numMonths, true));
  return lines;
}

function renderTotalMode(transactions, groupBy, descending, report, start, end, metadata) {
  const lines = reportHeader(report, start, end);
  const numMonths = monthColumns(start, end).length || 1;
  if (groupBy === "Category") {
    return [...lines, ...renderTotalByCategory(transactions, report, metadata, numMonths)];
  }
  return [...lines, ...renderTotalFlat(transactions, groupBy, descending, report, metadata, numMonths)];
}

function formatCells(amounts, months) {
  let total = 0;
  const cells = months.map((month) => {
    const amount = amounts.get(month) ?? 0;
    total += amount;
    return formatAmount(amount);
  });
  return { cells, total };
}

function renderTimeFlat(transactions, groupBy, months, descending, report, metadata) {
  const grouped = new Map();

  for (const transaction of transactions) {
    const key = groupKey(transaction, groupBy, metadata);
    const month = monthKey(transaction.date);
    const amounts = grouped.get(key) ?? new Map();
    amounts.set(month, (amounts.get(month) ?? 0) + transaction.amount);
    grouped.set(key, amounts);
  }

  const sortedKeys = [...grouped.keys()]
    .filter((key) => report.show_empty || [...grouped.get(key).values()].some((value) => value !== 0))
    .sort((left, right) => {
      const leftTotal = [...grouped.get(left).values()].reduce((sum, value) => sum + value, 0);
      const rightTotal = [...grouped.get(right).values()].reduce((sum, value) => sum + value, 0);
      if (leftTotal !== rightTotal) {
        return descending ? rightTotal - leftTotal : leftTotal - rightTotal;
      }
      return left.localeCompare(right);
    });

  const lines = [
    `| ${groupBy} | ${months.map(formatMonthLabel).join(" | ")} | Total |`,
    `|---${" | ---:".repeat(months.length)} | ---:|`,
  ];
  const totalsByMonth = new Map();
  let grandTotal = 0;

  for (const key of sortedKeys) {
    const { cells, total } = formatCells(grouped.get(key), months);
    grandTotal += total;
    for (const month of months) {
      totalsByMonth.set(month, (totalsByMonth.get(month) ?? 0) + (grouped.get(key).get(month) ?? 0));
    }
    lines.push(`| ${key} | ${cells.join(" | ")} | ${formatAmount(total)} |`);
  }

  lines.push(
    `| **Total** | ${months
      .map((month) => `**${formatAmount(totalsByMonth.get(month) ?? 0)}**`)
      .join(" | ")} | **${formatAmount(grandTotal)}** |`,
  );
  return lines;
}

function renderTimeByCategory(transactions, months, report, metadata) {
  const groups = new Map();

  for (const transaction of transactions) {
    const info = categoryInfo(transaction, metadata);
    const group = groups.get(info.groupName) ?? {
      sortOrder: info.groupSort,
      categories: new Map(),
    };
    const category = group.categories.get(info.categoryName) ?? {
      sortOrder: info.categorySort,
      months: new Map(),
    };
    const month = monthKey(transaction.date);
    category.months.set(month, (category.months.get(month) ?? 0) + transaction.amount);
    group.categories.set(info.categoryName, category);
    groups.set(info.groupName, group);
  }

  const lines = [
    `| Category | ${months.map(formatMonthLabel).join(" | ")} | Total |`,
    `|---${" | ---:".repeat(months.length)} | ---:|`,
  ];
  const grandTotals = new Map();
  let grandTotal = 0;

  const sortedGroups = [...groups.entries()].sort((left, right) => {
    const diff = left[1].sortOrder - right[1].sortOrder;
    return diff !== 0 ? diff : left[0].localeCompare(right[0]);
  });

  for (const [groupName, group] of sortedGroups) {
    const groupMonths = new Map();
    const categoryRows = [];
    const categories = [...group.categories.entries()].sort((left, right) => {
      const diff = left[1].sortOrder - right[1].sortOrder;
      return diff !== 0 ? diff : left[0].localeCompare(right[0]);
    });

    for (const [categoryName, category] of categories) {
      const { cells, total } = formatCells(category.months, months);
      if (!report.show_empty && total === 0) {
        continue;
      }
      for (const month of months) {
        groupMonths.set(month, (groupMonths.get(month) ?? 0) + (category.months.get(month) ?? 0));
      }
      categoryRows.push(`| ${categoryName} | ${cells.join(" | ")} | ${formatAmount(total)} |`);
    }

    const groupTotal = [...groupMonths.values()].reduce((sum, value) => sum + value, 0);
    if (!report.show_empty && groupTotal === 0) {
      continue;
    }

    lines.push(
      `| **${groupName}** | ${months
        .map((month) => `**${formatAmount(groupMonths.get(month) ?? 0)}**`)
        .join(" | ")} | **${formatAmount(groupTotal)}** |`,
    );
    lines.push(...categoryRows);

    for (const month of months) {
      grandTotals.set(month, (grandTotals.get(month) ?? 0) + (groupMonths.get(month) ?? 0));
    }
    grandTotal += groupTotal;
  }

  lines.push(
    `| **Total** | ${months
      .map((month) => `**${formatAmount(grandTotals.get(month) ?? 0)}**`)
      .join(" | ")} | **${formatAmount(grandTotal)}** |`,
  );
  return lines;
}

function renderTimeMode(transactions, groupBy, descending, report, start, end, metadata) {
  const effectiveStart =
    start ??
    (transactions.length > 0
      ? transactions.reduce((min, transaction) => (transaction.date < min ? transaction.date : min), transactions[0].date)
      : formatIsoDate(localToday()));
  const months = monthColumns(effectiveStart, end);
  const lines = reportHeader(report, start, end);
  if (groupBy === "Category") {
    return [...lines, ...renderTimeByCategory(transactions, months, report, metadata)];
  }
  return [...lines, ...renderTimeFlat(transactions, groupBy, months, descending, report, metadata)];
}

function toTsv(lines) {
  const output = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith("|--")) {
      continue;
    }
    if (line.startsWith("|")) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replaceAll("**", ""));
      output.push(cells.join("\t"));
    } else if (line.startsWith("# ")) {
      output.push(line.slice(2));
    } else if (line.startsWith("*") && line.endsWith("*")) {
      output.push(line.slice(1, -1));
    }
  }
  return output.join("\n");
}

function stripMarkdownBold(value) {
  return value.replaceAll("**", "");
}

function renderTerminalCell(value) {
  if (value.startsWith("**") && value.endsWith("**")) {
    return `\x1b[1m${stripMarkdownBold(value)}\x1b[22m`;
  }
  return stripMarkdownBold(value);
}

function isNumericCell(value) {
  return /^-?[\d,]+(?:\.\d+)?$/.test(stripMarkdownBold(value).trim());
}

function renderCliTable(lines) {
  const preamble = [];
  let header = null;
  const rows = [];
  let headerDone = false;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    if (line.startsWith("# ")) {
      preamble.push(line.slice(2));
      continue;
    }
    if (line.startsWith("*") && line.endsWith("*")) {
      preamble.push(line.slice(1, -1));
      continue;
    }
    if (line.startsWith("|--")) {
      headerDone = true;
      continue;
    }
    if (!line.startsWith("|")) {
      continue;
    }

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (!headerDone && !header) {
      header = cells;
    } else {
      rows.push(cells);
    }
  }

  if (!header) {
    return lines.join("\n");
  }

  const colAligns = header.map((_, columnIndex) => {
    if (columnIndex === 0) {
      return "left";
    }
    return rows.every((row) => isNumericCell(row[columnIndex] ?? "")) ? "right" : "left";
  });

  const table = new Table({
    head: header.map(stripMarkdownBold),
    colAligns,
    style: { head: [], border: [] },
    wordWrap: true,
  });

  for (const row of rows) {
    table.push(row.map(renderTerminalCell));
  }

  return [...preamble, table.toString()].join("\n\n");
}

function htmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toHtml(lines) {
  const parts = [];
  const rows = [];
  let headerDone = false;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    if (line.startsWith("# ")) {
      parts.push(`<h3>${htmlEscape(line.slice(2))}</h3>`);
      continue;
    }
    if (line.startsWith("*") && line.endsWith("*")) {
      parts.push(`<p><em>${htmlEscape(line.slice(1, -1))}</em></p>`);
      continue;
    }
    if (line.startsWith("|--")) {
      headerDone = true;
      continue;
    }
    if (!line.startsWith("|")) {
      continue;
    }

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (!headerDone) {
      rows.push(`<tr>${cells.map((cell) => `<th>${htmlEscape(cell)}</th>`).join("")}</tr>`);
      continue;
    }

    const tds = cells.map((cell) => {
      const bold = cell.startsWith("**") && cell.endsWith("**");
      const text = cell.replaceAll("**", "");
      const align = /^-?[\d,]+(?:\.\d+)?$/.test(text) ? ' align="right"' : "";
      const inner = bold ? `<b>${htmlEscape(text)}</b>` : htmlEscape(text);
      return `<td${align}>${inner}</td>`;
    });
    rows.push(`<tr>${tds.join("")}</tr>`);
  }

  return (
    `<html><body>${parts.join("")}` +
    `<table border="1" cellpadding="4" cellspacing="0">${rows.join("")}</table>` +
    "</body></html>"
  );
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

async function withActual(fn) {
  const actualApi = await getActualApi();
  if (!process.env.ACTUAL_PASSWORD) {
    fail("ACTUAL_PASSWORD is required.");
  }

  await actualApi.init({
    dataDir: DATA_DIR,
    serverURL: SERVER_URL,
    password: process.env.ACTUAL_PASSWORD,
  });

  try {
    const budget = await resolveBudget();
    if (budget.id) {
      await actualApi.loadBudget(budget.id);
    } else if (budget.cloudFileId) {
      const result = await actualApi.downloadBudget(budget.cloudFileId);
      if (result?.error) {
        if (result.error.reason === "file-exists" && result.error.meta?.id) {
          await actualApi.loadBudget(result.error.meta.id);
        } else if (result.error.reason === "not-found") {
          fail(
            `Budget ${JSON.stringify(budget.name ?? budget.cloudFileId)} not found. Check the sync id of your budget in the Advanced section of the settings page.`,
          );
        } else {
          fail(
            `Failed to download budget ${JSON.stringify(budget.name ?? budget.cloudFileId)}.`,
          );
        }
      }
    } else {
      fail(`Budget ${JSON.stringify(budget.name ?? "(unknown)")} is missing both local id and cloud file id.`);
    }
    await actualApi.sync();
    return await fn();
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

function parseCommandArgs(argv) {
  const args = argv.slice(2);
  const command = args.shift();

  if (!command || command === "-h" || command === "--help") {
    return { command: "help" };
  }

  switch (command) {
    case "find":
      if (args.includes("-h") || args.includes("--help")) {
        return { command: "help" };
      }
      if (args.length !== 2) {
        fail("Usage: node trans.js find <payee> <txn-date>");
      }
      return { command, payee: args[0], txnDate: args[1] };
    case "split": {
      const parsed = {
        command,
        transactionId: null,
        payee: null,
        txnDate: null,
        splitTriplets: [],
      };
      const positional = [];
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--transaction-id") {
          parsed.transactionId = args[++index];
        } else if (arg === "--payee") {
          parsed.payee = args[++index];
        } else if (arg === "--txn-date") {
          parsed.txnDate = args[++index];
        } else if (arg === "-h" || arg === "--help") {
          return { command: "help" };
        } else {
          positional.push(arg);
        }
      }

      if (!parsed.transactionId && !(parsed.payee && parsed.txnDate)) {
        fail("Provide --transaction-id or both --payee and --txn-date.");
      }
      if (parsed.transactionId && (parsed.payee || parsed.txnDate)) {
        fail("Use either --transaction-id or --payee/--txn-date, not both.");
      }
      if (positional.length === 0 || positional.length % 3 !== 0) {
        fail("Split entries must be provided as repeated triplets: <notes> <category> <amount>.");
      }

      for (let index = 0; index < positional.length; index += 3) {
        parsed.splitTriplets.push({
          notes: positional[index],
          categoryName: positional[index + 1],
          amount: parseAmountInput(positional[index + 2]),
        });
      }

      return parsed;
    }
    case "report": {
      if (args.length === 0) {
        fail("Usage: node trans.js report <name> [--mode total|time] [--tsv] [--pbcopy]");
      }
      const parsed = { command, name: null, mode: null, tsv: false, pbcopy: false };
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!parsed.name && !arg.startsWith("-")) {
          parsed.name = arg;
        } else if (arg === "--mode") {
          parsed.mode = args[++index];
        } else if (arg === "--tsv") {
          parsed.tsv = true;
        } else if (arg === "--pbcopy") {
          parsed.pbcopy = true;
        } else if (arg === "-h" || arg === "--help") {
          return { command: "help" };
        } else {
          fail(`Unknown argument ${JSON.stringify(arg)}.`);
        }
      }
      if (!parsed.name) {
        fail("Report name is required.");
      }
      if (parsed.mode && parsed.mode !== "total" && parsed.mode !== "time") {
        fail("--mode must be either total or time.");
      }
      return parsed;
    }
    default:
      fail(`Unknown command ${JSON.stringify(command)}.`);
  }
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

function filterReportTransactions(transactions, report, metadata) {
  let filtered = [...transactions];

  if (!report.show_offbudget) {
    filtered = filtered.filter((transaction) => !metadata.accountsById.get(transaction.accountId)?.offbudget);
  }

  if (report.balance_type === "Expense") {
    filtered = filtered.filter((transaction) => transaction.amount < 0);
  } else if (report.balance_type === "Income") {
    filtered = filtered.filter((transaction) => transaction.amount > 0);
  }

  filtered = applyConditions(filtered, report.conditions, report.conditions_op ?? "and");

  if (!report.show_hidden) {
    filtered = filtered.filter((transaction) => !metadata.categoriesById.get(transaction.categoryId)?.hidden);
  }

  if (!report.show_uncategorized) {
    filtered = filtered.filter((transaction) => Boolean(transaction.categoryId));
  }

  return filtered;
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

    const groupBy = report.group_by || "Category";
    const descending = report.sort_by !== "asc";
    const mode = args.mode ?? report.mode;
    const lines =
      mode === "time"
        ? renderTimeMode(transactions, groupBy, descending, report, start, end, metadata)
        : renderTotalMode(transactions, groupBy, descending, report, start, end, metadata);

    if (args.pbcopy) {
      console.log(lines.join("\n"));
      await copyRtf(toHtml(lines));
      console.log("Copied to clipboard.");
      return;
    }

    if (args.tsv) {
      console.log(toTsv(lines));
      return;
    }

    console.log(renderCliTable(lines));
  });
}

async function main() {
  const args = parseCommandArgs(process.argv);
  switch (args.command) {
    case "help":
      printUsage();
      break;
    case "find":
      await commandFind(args);
      break;
    case "split":
      await commandSplit(args);
      break;
    case "report":
      await commandReport(args);
      break;
    default:
      fail(`Unsupported command ${JSON.stringify(args.command)}.`);
  }
}

await main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
