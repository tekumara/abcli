#!/usr/bin/env node
/**
 * Bankwest Account Balances
 *
 * Connects to a running Chrome instance (CDP on localhost:9222),
 * verifies the active tab is the Bankwest balances page,
 * then prints all accounts and their balances.
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Logged in to Bankwest Online Banking
 *   - Active tab on: online.bankwest.com.au/CMWeb/AccountInformation/AI/Balances.aspx
 */

import puppeteer from "puppeteer-core";

const EXPECTED_URL_PATTERN = /online\.bankwest\.com\.au\/CMWeb\/AccountInformation\/AI\/Balances\.aspx/;

// Connect to Chrome
const browser = await Promise.race([
  puppeteer.connect({
    browserURL: "http://localhost:9222",
    defaultViewport: null,
  }),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Connection timeout after 5s")), 5000)
  ),
]).catch((e) => {
  console.error("✗ Could not connect to Chrome:", e.message);
  console.error("  Make sure Chrome is running. Try: node src/browser-start.js");
  process.exit(1);
});

const page = (await browser.pages()).at(-1);

if (!page) {
  console.error("✗ No active tab found");
  await browser.disconnect();
  process.exit(1);
}

// Verify we're on the right page
const currentUrl = page.url();
if (!EXPECTED_URL_PATTERN.test(currentUrl)) {
  console.error("✗ Wrong page. Expected Bankwest Account Balances page.");
  console.error(`  Current URL: ${currentUrl}`);
  console.error(`  Expected:    https://online.bankwest.com.au/CMWeb/AccountInformation/AI/Balances.aspx`);
  await browser.disconnect();
  process.exit(1);
}

// Extract ContainerContext from the page
const data = await page.evaluate(() => {
  if (typeof ContainerContext === "undefined" || !ContainerContext?.accountBalancesContext) {
    throw new Error("ContainerContext not found — page may not have loaded correctly");
  }
  return {
    customerName: ContainerContext.customerName,
    asAt: ContainerContext.accountBalancesContext.AsAtDateTime,
    balances: ContainerContext.accountBalancesContext.Balances,
    netBalances: ContainerContext.accountBalancesContext.NetBalances,
  };
});

await browser.disconnect();

// ── Output ──────────────────────────────────────────────────────────────────

const fmt = (n) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

const pad = (s, n) => String(s).padEnd(n);

console.log(`\nBankwest Account Balances — ${data.customerName}`);
console.log(`As at: ${data.asAt}\n`);

// Group by category
const groups = {};
for (const acct of data.balances) {
  const cat = acct.AccountCategoryCode ?? "OTHER";
  (groups[cat] ??= []).push(acct);
}

const categoryLabels = {
  TRANSACCTS: "Transaction Accounts",
  MORTGAGE: "Home Loans",
  CREDITCARDS: "Credit Cards",
  OTHER: "Other",
};

for (const [cat, accounts] of Object.entries(groups)) {
  console.log(`${categoryLabels[cat] ?? cat}`);
  console.log("─".repeat(72));
  console.log(
    `${pad("Nickname", 26)} ${pad("Account Number", 18)} ${pad("Current Balance", 18)} Available Balance`
  );
  console.log("─".repeat(72));

  for (const a of accounts) {
    const nickname = a.AccountNickName || a.AccountName;
    console.log(
      `${pad(nickname, 26)} ${pad(a.AccountNumber, 18)} ${pad(fmt(a.AccountCurrentBalance), 18)} ${fmt(a.AccountAvailableBalance)}`
    );
  }
  console.log();
}

// Net summary
console.log("─".repeat(72));
console.log("Summary");
console.log("─".repeat(72));
for (const net of data.netBalances) {
  console.log(`${pad(net.title, 20)} ${fmt(net.value)}`);
}
console.log();
