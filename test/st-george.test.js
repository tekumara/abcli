import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  mapStGeorgeRowsToImportTransactions,
  parseStGeorgeCsv,
  parseStGeorgeCsvToImportTransactions,
  splitStGeorgeDescription,
} from "../src/st-george.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "st-george");

test("maps synthetic St.George fixture rows to Actual import transactions", async () => {
  const [csvText, expectedText] = await Promise.all([
    readFile(path.join(FIXTURE_DIR, "synthetic-input.csv"), "utf8"),
    readFile(path.join(FIXTURE_DIR, "synthetic-expected.json"), "utf8"),
  ]);

  const actual = parseStGeorgeCsvToImportTransactions(csvText, {
    accountId: "acct-smoke",
  });
  const expected = JSON.parse(expectedText);

  assert.deepEqual(actual, expected);
});

test("parses the synthetic St.George CSV into row objects", async () => {
  const csvText = await readFile(path.join(FIXTURE_DIR, "synthetic-input.csv"), "utf8");
  const rows = parseStGeorgeCsv(csvText);

  assert.equal(rows.length, 12);
  assert.equal(rows[0].Date, "05/04/2026");
  assert.equal(rows[11].Description, "Visa Purchase 30Dec18:19 DELI, CBD");
});

test("splits known St.George description prefixes into payee and notes", () => {
  assert.deepEqual(
    splitStGeorgeDescription("Visa Purchase 20Dec08:47 COFFEE SHOP"),
    {
      payeeName: "COFFEE SHOP",
      notes: "Visa Purchase",
      reference: "20Dec08:47",
    },
  );

  assert.deepEqual(
    splitStGeorgeDescription("Loan A/C Fee"),
    {
      payeeName: "Loan A/C Fee",
      notes: undefined,
      reference: undefined,
    },
  );
});

test("rejects rows with both debit and credit populated", () => {
  assert.throws(
    () =>
      mapStGeorgeRowsToImportTransactions(
        [
          {
            __line: 2,
            Date: "05/04/2026",
            Description: "Internet Withdrawal 20Dec08:47 BAD ROW",
            Debit: "10.00",
            Credit: "9.00",
            Balance: "100.00",
          },
        ],
        { accountId: "acct-smoke" },
      ),
    /both Debit and Credit populated/,
  );
});

test("rejects invalid dates", () => {
  assert.throws(
    () =>
      parseStGeorgeCsvToImportTransactions(
        [
          "Date,Description,Debit,Credit,Balance",
          "31/02/2026,Visa Purchase 20Dec08:47 BAD DATE,1.00,,100.00",
        ].join("\n"),
        { accountId: "acct-smoke" },
      ),
    /Invalid St\.George date/,
  );
});
