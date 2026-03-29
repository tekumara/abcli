import Table from "cli-table3";

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

function fail(message) {
  throw new Error(message);
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

export function formatAmount(cents) {
  return AMOUNT_FORMATTER.format(cents / 100);
}

function formatDecimal(value) {
  return AMOUNT_FORMATTER.format(value);
}

export function accountName(transaction, metadata) {
  return metadata.accountsById.get(transaction.accountId)?.name ?? "Unknown";
}

export function payeeName(transaction, metadata) {
  return metadata.payeesById.get(transaction.payeeId)?.name ?? "Unknown";
}

export function categoryName(transaction, metadata) {
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

export function resolveDateRange(report) {
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

function makeColumns(labels) {
  return labels.map((label, index) => ({
    label,
    align: index === 0 ? "left" : "right",
  }));
}

function makeRow(cells, { bold = false } = {}) {
  return {
    cells: cells.map((cell) => String(cell ?? "")),
    bold,
  };
}

function createReportTable(report, start, end, columns, rows) {
  return {
    title: report.name,
    subtitle: formatDateRange(start, end),
    columns: makeColumns(columns),
    rows,
  };
}

function totalRow(label, deposits, payments, numMonths, bold = false) {
  const total = deposits + payments;
  const average = total / 100 / numMonths;
  return makeRow(
    [
      label,
      formatAmount(deposits),
      formatAmount(payments),
      formatAmount(total),
      formatDecimal(average),
    ],
    { bold },
  );
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

  const sortedGroups = [...groups.entries()]
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

  const rows = [];
  let grandDeposits = 0;
  let grandPayments = 0;

  for (const [, amounts] of sortedGroups) {
    grandDeposits += amounts.deposits;
    grandPayments += amounts.payments;
  }

  for (const [key, amounts] of sortedGroups) {
    rows.push(totalRow(key, amounts.deposits, amounts.payments, numMonths));
  }

  rows.push(totalRow("Totals", grandDeposits, grandPayments, numMonths, true));
  return rows;
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

  const rows = [];
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
    rows.push(totalRow(groupName, groupDeposits, groupPayments, numMonths, true));

    for (const [categoryNameValue, category] of categories) {
      if (!report.show_empty && category.deposits + category.payments === 0) {
        continue;
      }
      rows.push(totalRow(categoryNameValue, category.deposits, category.payments, numMonths));
    }
  }

  rows.push(totalRow("Totals", grandDeposits, grandPayments, numMonths, true));
  return rows;
}

function renderTotalMode(transactions, groupBy, descending, report, start, end, metadata) {
  const numMonths = monthColumns(start, end).length || 1;
  const columns = [
    groupBy === "Category" ? "Category" : groupBy,
    "Deposits",
    "Payments",
    "Totals",
    "Average",
  ];
  if (groupBy === "Category") {
    return createReportTable(
      report,
      start,
      end,
      columns,
      renderTotalByCategory(transactions, report, metadata, numMonths),
    );
  }
  return createReportTable(
    report,
    start,
    end,
    columns,
    renderTotalFlat(transactions, groupBy, descending, report, metadata, numMonths),
  );
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
    .filter(
      (key) => report.show_empty || [...grouped.get(key).values()].some((value) => value !== 0),
    )
    .sort((left, right) => {
      const leftTotal = [...grouped.get(left).values()].reduce((sum, value) => sum + value, 0);
      const rightTotal = [...grouped.get(right).values()].reduce((sum, value) => sum + value, 0);
      if (leftTotal !== rightTotal) {
        return descending ? rightTotal - leftTotal : leftTotal - rightTotal;
      }
      return left.localeCompare(right);
    });

  const rows = [];
  const totalsByMonth = new Map();
  let grandTotal = 0;

  for (const key of sortedKeys) {
    const { cells, total } = formatCells(grouped.get(key), months);
    grandTotal += total;
    for (const month of months) {
      totalsByMonth.set(month, (totalsByMonth.get(month) ?? 0) + (grouped.get(key).get(month) ?? 0));
    }
    rows.push(makeRow([key, ...cells, formatAmount(total)]));
  }

  rows.push(
    makeRow(
      [
        "Total",
        ...months.map((month) => formatAmount(totalsByMonth.get(month) ?? 0)),
        formatAmount(grandTotal),
      ],
      { bold: true },
    ),
  );
  return rows;
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

  const rows = [];
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

    for (const [categoryNameValue, category] of categories) {
      const { cells, total } = formatCells(category.months, months);
      if (!report.show_empty && total === 0) {
        continue;
      }
      for (const month of months) {
        groupMonths.set(month, (groupMonths.get(month) ?? 0) + (category.months.get(month) ?? 0));
      }
      categoryRows.push(makeRow([categoryNameValue, ...cells, formatAmount(total)]));
    }

    const groupTotal = [...groupMonths.values()].reduce((sum, value) => sum + value, 0);
    if (!report.show_empty && groupTotal === 0) {
      continue;
    }

    rows.push(
      makeRow(
        [
          groupName,
          ...months.map((month) => formatAmount(groupMonths.get(month) ?? 0)),
          formatAmount(groupTotal),
        ],
        { bold: true },
      ),
    );
    rows.push(...categoryRows);

    for (const month of months) {
      grandTotals.set(month, (grandTotals.get(month) ?? 0) + (groupMonths.get(month) ?? 0));
    }
    grandTotal += groupTotal;
  }

  rows.push(
    makeRow(
      [
        "Total",
        ...months.map((month) => formatAmount(grandTotals.get(month) ?? 0)),
        formatAmount(grandTotal),
      ],
      { bold: true },
    ),
  );
  return rows;
}

function renderTimeMode(transactions, groupBy, descending, report, start, end, metadata) {
  const effectiveStart =
    start ??
    (transactions.length > 0
      ? transactions.reduce(
          (min, transaction) => (transaction.date < min ? transaction.date : min),
          transactions[0].date,
        )
      : formatIsoDate(localToday()));
  const months = monthColumns(effectiveStart, end);
  const columns = [
    groupBy === "Category" ? "Category" : groupBy,
    ...months.map(formatMonthLabel),
    "Total",
  ];
  if (groupBy === "Category") {
    return createReportTable(
      report,
      start,
      end,
      columns,
      renderTimeByCategory(transactions, months, report, metadata),
    );
  }
  return createReportTable(
    report,
    start,
    end,
    columns,
    renderTimeFlat(transactions, groupBy, months, descending, report, metadata),
  );
}

export function buildReportTable({
  transactions,
  report,
  metadata,
  mode = report.mode,
  start,
  end,
}) {
  const groupBy = report.group_by || "Category";
  const descending = report.sort_by !== "asc";
  return mode === "time"
    ? renderTimeMode(transactions, groupBy, descending, report, start, end, metadata)
    : renderTotalMode(transactions, groupBy, descending, report, start, end, metadata);
}

export function toTsv(reportTable) {
  const output = [];
  if (reportTable.title) {
    output.push(reportTable.title);
  }
  if (reportTable.subtitle) {
    output.push(reportTable.subtitle);
  }
  if (reportTable.columns.length > 0) {
    output.push(reportTable.columns.map((column) => column.label).join("\t"));
  }
  for (const row of reportTable.rows) {
    output.push(row.cells.join("\t"));
  }
  return output.join("\n");
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function rstrip(value) {
  return value.replace(/\s+$/u, "");
}

function centerText(value, width = process.stdout.columns ?? 80) {
  const visibleWidth = stripAnsi(value).length;
  if (visibleWidth >= width) {
    return value;
  }
  const padding = Math.floor((width - visibleWidth) / 2);
  return `${" ".repeat(padding)}${value}`;
}

function renderTerminalCell(row, value) {
  if (row.bold) {
    return `\x1b[1m${value}\x1b[22m`;
  }
  return value;
}

export function renderCliTable(reportTable) {
  if (reportTable.columns.length === 0) {
    return [reportTable.title, reportTable.subtitle].filter(Boolean).join("\n");
  }

  const table = new Table({
    head: reportTable.columns.map((column) => column.label),
    colAligns: reportTable.columns.map((column) => column.align),
    style: { head: [], border: [], compact: true },
    wordWrap: true,
    chars: {
      top: "",
      "top-mid": "",
      "top-left": "",
      "top-right": "",
      bottom: "",
      "bottom-mid": "",
      "bottom-left": "",
      "bottom-right": "",
      left: "",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "",
      "right-mid": "",
      middle: "  ",
    },
  });

  for (const row of reportTable.rows) {
    table.push(row.cells.map((cell) => renderTerminalCell(row, cell)));
  }

  const tableLines = table
    .toString()
    .split("\n")
    .map(rstrip);
  const [headerLine, ...bodyLines] = tableLines;
  const headerIndent = headerLine.match(/^\s*/u)?.[0] ?? "";
  const underline = `${headerIndent}${"─".repeat(stripAnsi(headerLine.trimStart()).length)}`;

  const preamble = [reportTable.title, reportTable.subtitle]
    .filter(Boolean)
    .map((line) => centerText(line));

  return [...preamble, "", headerLine, underline, ...bodyLines].join("\n");
}

function htmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function toHtml(reportTable) {
  const parts = [];
  const rows = [];

  if (reportTable.title) {
    parts.push(`<h3>${htmlEscape(reportTable.title)}</h3>`);
  }
  if (reportTable.subtitle) {
    parts.push(`<p><em>${htmlEscape(reportTable.subtitle)}</em></p>`);
  }

  if (reportTable.columns.length > 0) {
    rows.push(
      `<tr>${reportTable.columns
        .map((column) => `<th>${htmlEscape(column.label)}</th>`)
        .join("")}</tr>`,
    );
  }

  for (const row of reportTable.rows) {
    const tds = row.cells.map((cell, index) => {
      const align = reportTable.columns[index]?.align === "right" ? ' align="right"' : "";
      const inner = row.bold ? `<b>${htmlEscape(cell)}</b>` : htmlEscape(cell);
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

export function filterReportTransactions(transactions, report, metadata) {
  let filtered = [...transactions];

  if (!report.show_offbudget) {
    filtered = filtered.filter(
      (transaction) => !metadata.accountsById.get(transaction.accountId)?.offbudget,
    );
  }

  if (report.balance_type === "Expense") {
    filtered = filtered.filter((transaction) => transaction.amount < 0);
  } else if (report.balance_type === "Income") {
    filtered = filtered.filter((transaction) => transaction.amount > 0);
  }

  filtered = applyConditions(filtered, report.conditions, report.conditions_op ?? "and");

  if (!report.show_hidden) {
    filtered = filtered.filter(
      (transaction) => !metadata.categoriesById.get(transaction.categoryId)?.hidden,
    );
  }

  if (!report.show_uncategorized) {
    filtered = filtered.filter((transaction) => Boolean(transaction.categoryId));
  }

  return filtered;
}
