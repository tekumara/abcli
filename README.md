# actual budget scripts

Scripts for working with [Actual Budget](actual.md).

## Bankwest

Automates Bankwest Online Banking via Chrome DevTools Protocol (CDP). Requires Chrome running with remote debugging on port 9222 and logged in to Bankwest.

Start Chrome:

```
node browser-start.js
```

This launches a separate Chrome instance with its own profile directory (`~/.cache/browser-tools`). If Chrome is already running on `:9222`, it exits immediately.

Use `--profile` to copy your existing Chrome profile (cookies, logins) into the separate Chrome instance first.

### Account Balances

[bankwest-balances.js](bankwest-balances.js) — prints all account balances grouped by category.

The active tab must be on the Bankwest Account Balances page.

```
❯ node bankwest-balances.js

Bankwest Account Balances — MR SMITH
As at: 29/03/2026 5:48 EDT

Transaction Accounts
────────────────────────────────────────────────────────────────────────
Nickname                   Account Number     Current Balance    Available Balance
────────────────────────────────────────────────────────────────────────
Offset Joint               123-456 7890123    $1,234.56          $1,234.56
Offset Jane                123-456 7890456    $2,345.67          $2,345.67
Offset John                123-456 7890789    $3,456.78          $3,456.78
...
```

### Transaction Export

[bankwest-transactions.js](bankwest-transactions.js) — exports transactions as a QIF file (MS Money format).

Navigates to the transaction search page automatically. The account name is a case-insensitive substring match against the Bankwest dropdown options — it must match exactly one account, otherwise available options are listed.

```
❯ node bankwest-transactions.js --help
Usage: bankwest-transactions.js <account-name> [options]

  account-name    Case-insensitive substring match against Bankwest
                  account dropdown (e.g. "offset joint", ""home loan john").
                  Must match exactly one account.

  -r, --range     Date range preset (default: L30Days)
                  L7Days, L14Days, L30Days, L60Days, L90Days,
                  LMONTH, SLMONTH, TLMONTH
  --from          Custom start date (DD/MM/YYYY), requires --to
  --to            Custom end date (DD/MM/YYYY), requires --from
  -o, --output    Output directory for exported file (default: cwd)
```

Examples:

```
node bankwest-transactions.js "offset joint" -r L30Days
node bankwest-transactions.js "home loan john" -r L90Days -o ~/Downloads
node bankwest-transactions.js "offset joint" --from 01/01/2026 --to 28/03/2026
```

## Imports

Cleaning transactions before importing them:

- [St George](stg) - download as CSV
- [NAB](nab) - download as QIF

## Transactions

```
❯ python -m trans
Usage: trans.py COMMAND

╭─ Commands ─────────────────────────────────────────────────────────────────────────────────────────────────╮
│ find         Find a transaction by payee and date.                                                         │
│ report       Render a custom report by name as a markdown table.                                           │
│ split        Split a transaction into sub-transactions.                                                    │
│ --help (-h)  Display this message and exit.                                                                │
│ --version    Display application version.                                                                  │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```
