import assert from "node:assert/strict";
import test from "node:test";

import { resolveImportAccount } from "../src/import-account.js";

const accounts = [
  { id: "acct-1", name: "Everyday Checking" },
  { id: "acct-2", name: "Travel Card" },
  { id: "acct-3", name: "Savings Bucket" },
  { id: "acct-4", name: "Holiday Savings" },
];

test("resolves account by exact id", () => {
  assert.equal(resolveImportAccount(accounts, "acct-2").id, "acct-2");
});

test("resolves account by exact case-insensitive name", () => {
  assert.equal(resolveImportAccount(accounts, "travel card").id, "acct-2");
});

test("resolves account by unique substring match", () => {
  assert.equal(resolveImportAccount(accounts, "every").id, "acct-1");
});

test("rejects ambiguous substring matches", () => {
  assert.throws(
    () => resolveImportAccount(accounts, "savings"),
    /ambiguous.*acct-3, acct-4/i,
  );
});

test("rejects unknown accounts", () => {
  assert.throws(
    () => resolveImportAccount(accounts, "brokerage"),
    /not found/,
  );
});
