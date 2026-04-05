import assert from "node:assert/strict";
import test from "node:test";

import { normalizeParsedQifTransactions, parseQifDate } from "../src/qif.js";

function amountToInteger(amount) {
  return Math.round(amount * 100);
}

test("parses QIF dates using the configured budget date format", () => {
  assert.equal(parseQifDate("05/04/2026", { dateFormat: "DD/MM/YYYY" }), "2026-04-05");
  assert.equal(parseQifDate("05/04/2026", { dateFormat: "MM/DD/YYYY" }), "2026-05-04");
  assert.equal(parseQifDate("5/4'26", { dateFormat: "DD/MM/YYYY" }), "2026-04-05");
});

test("normalizes parsed QIF transactions for Actual import", () => {
  const actual = normalizeParsedQifTransactions(
    [
      {
        date: "05/04/2026",
        amount: -12.34,
        payee_name: "Coffee Shop",
        imported_payee: "Coffee Shop",
        notes: "Morning caffeine",
      },
      {
        date: "2026-04-06",
        amount: 2500,
        payee_name: "Employer",
        imported_payee: "Employer",
        notes: null,
      },
    ],
    {
      accountId: "acct-qif",
      dateFormat: "DD/MM/YYYY",
      amountToInteger,
    },
  );

  assert.deepEqual(actual, [
    {
      account: "acct-qif",
      date: "2026-04-05",
      amount: -1234,
      payee_name: "Coffee Shop",
      imported_payee: "Coffee Shop",
      notes: "Morning caffeine",
    },
    {
      account: "acct-qif",
      date: "2026-04-06",
      amount: 250000,
      payee_name: "Employer",
      imported_payee: "Employer",
    },
  ]);
});

test("preserves server-normalized payee and notes fields", () => {
  const actual = normalizeParsedQifTransactions(
    [
      {
        date: "04/05/2026",
        amount: -9.5,
        payee_name: "Swapped Memo",
        imported_payee: "Swapped Memo",
        notes: "ORIGINAL PAYEE",
      },
    ],
    {
      accountId: "acct-qif",
      dateFormat: "MM/DD/YYYY",
      amountToInteger,
    },
  );

  assert.deepEqual(actual, [
    {
      account: "acct-qif",
      date: "2026-04-05",
      amount: -950,
      payee_name: "Swapped Memo",
      imported_payee: "Swapped Memo",
      notes: "ORIGINAL PAYEE",
    },
  ]);
});

test("does not synthesize payee fields from each other", () => {
  const actual = normalizeParsedQifTransactions(
    [
      {
        date: "04/05/2026",
        amount: -9.5,
        imported_payee: "Only Imported Payee",
      },
      {
        date: "04/06/2026",
        amount: -1.25,
        payee_name: "Only Payee Name",
      },
    ],
    {
      accountId: "acct-qif",
      dateFormat: "MM/DD/YYYY",
      amountToInteger,
    },
  );

  assert.deepEqual(actual, [
    {
      account: "acct-qif",
      date: "2026-04-05",
      amount: -950,
      imported_payee: "Only Imported Payee",
    },
    {
      account: "acct-qif",
      date: "2026-04-06",
      amount: -125,
      payee_name: "Only Payee Name",
    },
  ]);
});

test("rejects invalid parsed QIF dates", () => {
  assert.throws(
    () =>
      normalizeParsedQifTransactions(
        [
          {
            date: "31/02/2026",
            amount: -10,
            payee_name: "Bad Date",
          },
        ],
        {
          accountId: "acct-qif",
          dateFormat: "DD/MM/YYYY",
          amountToInteger,
        },
      ),
    /Invalid QIF date/,
  );
});
