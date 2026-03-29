import Table from "cli-table3";

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

export function stripAnsi(value) {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function rstrip(value) {
  return value.replace(/\s+$/u, "");
}

export function centerText(value, width = process.stdout.columns ?? 80) {
  const visibleWidth = stripAnsi(value).length;
  if (visibleWidth >= width) {
    return value;
  }
  const padding = Math.floor((width - visibleWidth) / 2);
  return `${" ".repeat(padding)}${value}`;
}

export function renderTerminalCell(row, value) {
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
