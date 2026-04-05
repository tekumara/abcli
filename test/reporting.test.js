import assert from "node:assert/strict";
import test from "node:test";

import { formatBudgetDate } from "../src/reporting.js";

test("formatBudgetDate renders supported Actual date formats", () => {
  assert.equal(formatBudgetDate("2026-04-05", "dd/MM/yyyy"), "05/04/2026");
  assert.equal(formatBudgetDate("2026-04-05", "MM/dd/yyyy"), "04/05/2026");
  assert.equal(formatBudgetDate("2026-04-05", "yyyy/MM/dd"), "2026/04/05");
  assert.equal(formatBudgetDate("2026-04-05", "dd.MM.yyyy"), "05.04.2026");
  assert.equal(formatBudgetDate("2026-04-05", "DD/MM/YYYY"), "05/04/2026");
  assert.equal(formatBudgetDate("2026-04-05", "MM/DD/YYYY"), "04/05/2026");
  assert.equal(formatBudgetDate("2026-04-05", "YYYY/MM/DD"), "2026/04/05");
  assert.equal(formatBudgetDate("2026-04-05", "DD.MM.YYYY"), "05.04.2026");
});
