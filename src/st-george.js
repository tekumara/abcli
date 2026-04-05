const REQUIRED_HEADERS = ["Date", "Description", "Debit", "Credit", "Balance"];

const DESCRIPTION_PREFIX_PATTERN = [
  "Visa Purchase(?: O/Seas)?",
  "Visa Credit(?: Overseas)?",
  "Osko Withdrawal",
  "Osko Deposit",
  "Sct Deposit",
  "Eftpos Debit",
  "Eftpos Credit",
  "Tfr Wdl BPAY Internet",
  "(?:Cardless )?Atm Withdrawal(?: -Wbc)?",
  "Internet Deposit",
  "Internet Withdrawal",
].join("|");

const DESCRIPTION_PREFIX_REGEX = new RegExp(
  `^(${DESCRIPTION_PREFIX_PATTERN})\\s+(\\S+)(?:\\s+(.*))?$`,
);

function fail(message) {
  throw new Error(message);
}

function normalizeHeader(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      row.push(current);
      current = "";

      if (row.some((value) => value !== "")) {
        rows.push(row);
      }
      row = [];

      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    current += char;
  }

  row.push(current);
  if (row.some((value) => value !== "")) {
    rows.push(row);
  }

  if (inQuotes) {
    fail("Invalid CSV: unterminated quoted field.");
  }

  return rows;
}

function parseRequiredHeaders(headers) {
  for (const requiredHeader of REQUIRED_HEADERS) {
    if (!headers.includes(requiredHeader)) {
      fail(`Missing required St.George CSV column ${JSON.stringify(requiredHeader)}.`);
    }
  }
}

function parseCsvAmount(value, lineNumber, fieldName) {
  const raw = String(value ?? "").trim();
  if (raw === "") {
    return null;
  }

  const normalized = raw.replace(/,/g, "");
  if (!/^\d*(?:\.\d{0,2})?$/.test(normalized) || normalized === ".") {
    fail(
      `Invalid ${fieldName} amount ${JSON.stringify(value)} on St.George CSV line ${lineNumber}.`,
    );
  }

  const [wholePart = "", fractionPart = ""] = normalized.split(".");
  const whole = wholePart === "" ? "0" : wholePart;
  const fraction = fractionPart.padEnd(2, "0").slice(0, 2);
  return Number(whole) * 100 + Number(fraction || "0");
}

function parseStGeorgeDate(value, lineNumber) {
  const raw = String(value ?? "").trim();
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match) {
    fail(`Invalid St.George date ${JSON.stringify(value)} on line ${lineNumber}.`);
  }

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    fail(`Invalid St.George date ${JSON.stringify(value)} on line ${lineNumber}.`);
  }

  return `${yearText}-${monthText}-${dayText}`;
}

function trimDescription(value, lineNumber) {
  const description = String(value ?? "").trim();
  if (!description) {
    fail(`Missing Description value on St.George CSV line ${lineNumber}.`);
  }
  return description;
}

function transactionAmountFromRow(row) {
  const debit = parseCsvAmount(row.Debit, row.__line, "Debit");
  const credit = parseCsvAmount(row.Credit, row.__line, "Credit");

  const hasDebit = debit !== null;
  const hasCredit = credit !== null;
  const nonZeroDebit = hasDebit && debit !== 0;
  const nonZeroCredit = hasCredit && credit !== 0;

  if (nonZeroDebit && nonZeroCredit) {
    fail(
      `St.George CSV line ${row.__line} has both Debit and Credit populated.`,
    );
  }

  if (nonZeroCredit) {
    return credit;
  }
  if (nonZeroDebit) {
    return -debit;
  }
  if (hasCredit) {
    return credit;
  }
  if (hasDebit) {
    return debit === 0 ? 0 : -debit;
  }
  return 0;
}

function buildImportedId(row, isoDate, occurrence) {
  const parts = [
    "stgeorge",
    isoDate,
    trimDescription(row.Description, row.__line),
    String(row.Debit ?? "").trim(),
    String(row.Credit ?? "").trim(),
    String(row.Balance ?? "").trim(),
  ];
  if (occurrence > 1) {
    parts.push(`dup:${occurrence}`);
  }
  return parts.join("|");
}

export function splitStGeorgeDescription(description) {
  const rawDescription = String(description ?? "").trim();
  const match = rawDescription.match(DESCRIPTION_PREFIX_REGEX);

  if (!match) {
    return {
      payeeName: rawDescription,
      notes: undefined,
      reference: undefined,
    };
  }

  const [, notes, reference, payeeText = ""] = match;
  const payeeName = payeeText.trim() || rawDescription;
  return { payeeName, notes, reference };
}

export function parseStGeorgeCsv(text) {
  const rows = parseCsv(String(text ?? ""));
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map(normalizeHeader);
  parseRequiredHeaders(headers);

  return rows.slice(1).map((columns, index) => {
    const row = Object.fromEntries(
      headers.map((header, columnIndex) => [header, columns[columnIndex] ?? ""]),
    );
    row.__line = index + 2;
    return row;
  });
}

export function mapStGeorgeRowsToImportTransactions(rows, { accountId } = {}) {
  const normalizedAccountId = String(accountId ?? "").trim();
  if (!normalizedAccountId) {
    fail("accountId is required to build Actual import transactions.");
  }

  const occurrences = new Map();

  return rows.map((row) => {
    const date = parseStGeorgeDate(row.Date, row.__line);
    const description = trimDescription(row.Description, row.__line);
    const { payeeName, notes } = splitStGeorgeDescription(description);
    const amount = transactionAmountFromRow(row);
    const fingerprint = [date, description, row.Debit, row.Credit, row.Balance]
      .map((value) => String(value ?? "").trim())
      .join("|");
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);

    const transaction = {
      account: normalizedAccountId,
      date,
      amount,
      payee_name: payeeName,
      imported_payee: description,
      imported_id: buildImportedId(row, date, occurrence),
    };

    if (notes) {
      transaction.notes = notes;
    }

    return transaction;
  });
}

export function parseStGeorgeCsvToImportTransactions(text, { accountId } = {}) {
  return mapStGeorgeRowsToImportTransactions(parseStGeorgeCsv(text), {
    accountId,
  });
}
