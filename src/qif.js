function fail(message) {
  throw new Error(message);
}

function trimToNull(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function expandTwoDigitYear(year) {
  return year >= 70 ? 1900 + year : 2000 + year;
}

function inferDateOrder(dateFormat, segments) {
  const formatTokens = String(dateFormat ?? "").match(/[dmy]+/gi);
  if (formatTokens?.length === 3) {
    const order = formatTokens.map((token) => token[0].toUpperCase());
    if (new Set(order).size === 3) {
      return order;
    }
  }

  if (segments[0]?.length === 4) {
    return ["Y", "M", "D"];
  }

  const [first, second] = segments.map(Number);
  if (first > 12 && second <= 12) {
    return ["D", "M", "Y"];
  }
  if (second > 12 && first <= 12) {
    return ["M", "D", "Y"];
  }

  return ["M", "D", "Y"];
}

export function parseQifDate(value, { dateFormat } = {}) {
  const raw = trimToNull(value);
  if (!raw) {
    fail("QIF transaction date is required.");
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const segments = raw.match(/\d+/g);
  if (!segments || segments.length !== 3) {
    fail(`Invalid QIF date ${JSON.stringify(value)}.`);
  }

  const order = inferDateOrder(dateFormat, segments);
  const parts = {};
  for (let index = 0; index < order.length; index += 1) {
    parts[order[index]] = Number(segments[index]);
  }

  let year = parts.Y;
  const yearSegmentIndex = order.indexOf("Y");
  if (segments[yearSegmentIndex].length <= 2) {
    year = expandTwoDigitYear(year);
  }

  const month = parts.M;
  const day = parts.D;

  if (![year, month, day].every(Number.isInteger)) {
    fail(`Invalid QIF date ${JSON.stringify(value)}.`);
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail(`Invalid QIF date ${JSON.stringify(value)}.`);
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

export function normalizeParsedQifTransactions(
  transactions,
  { dateFormat = null, amountToInteger } = {},
) {
  if (!Array.isArray(transactions)) {
    fail("Parsed QIF transactions must be an array.");
  }
  if (typeof amountToInteger !== "function") {
    fail("amountToInteger is required to build Actual import transactions.");
  }

  return transactions.map((transaction, index) => {
    if (!transaction || Array.isArray(transaction) || typeof transaction !== "object") {
      fail(`Parsed QIF transaction ${index + 1} is not a structured transaction object.`);
    }

    const amount = Number(transaction.amount);
    if (!Number.isFinite(amount)) {
      fail(`Invalid QIF amount ${JSON.stringify(transaction.amount)}.`);
    }

    return {
      ...transaction,
      date: parseQifDate(transaction.date, { dateFormat }),
      amount: amountToInteger(amount),
    };
  });
}
