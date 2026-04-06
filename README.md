# actual budget cli

CLI for working with [Actual Budget](actual.md).

## Usage

```bash
Usage: abctl [options] [command]

Actual budget helper commands.

Options:
  -h, --help                    display help for command

Commands:
  budgets                       List budgets and their sync ids.
  accounts                      List accounts and their current balances.
  uncategorized                 List uncategorized transactions across all accounts.
  make-transfer|transfer [options]
                                Find uncategorized transfer pairs and link them.
  find <payee> <txn-date>       Find transactions by exact payee name and ISO date (YYYY-MM-DD).
  split [options] <entries...>  Split a transaction into sub-transactions.
  report [options] <name>       Render a custom report by name.
  qif-import [options] <account> <qif-path>
                                Import a QIF file into an Actual account.
  st-george-import [options] <account> <csv-path>
                                Import a St.George CSV into an Actual account.
  help [command]                display help for command

Environment:
  ACTUAL_PASSWORD        Required.
  ACTUAL_SYNC_ID         Optional. Budget name, groupId, or cloudFileId. Defaults to the first available budget.
  ACTUAL_SERVER_URL      Optional. Defaults to http://localhost:5007
  ACTUAL_DATA_DIR        Optional. Defaults to /tmp/actual
```

For `split`, express `<entries...>` as repeated triplets:

```bash
<notes> <category> <amount> [<notes> <category> <amount> ...]
```

Example:

```bash
abctl split --transaction-id abc123 "Groceries run" "Food" -45.60 "Petrol" "Transport" -30
```

If the split amounts do not add up, you can append the exact remainder as one extra split using the parent transaction category:

```bash
abctl split --add-remainder-split --transaction-id abc123 "Agent fees" "Expenses" -90
```

## Make Transfer

Preview uncategorized transfer candidates without writing:

```bash
abctl make-transfer --dry-run
```

Link all unambiguous uncategorized transfer pairs:

```bash
abctl make-transfer
```

The command only links pairs when there is exactly one uncategorized inflow and one uncategorized outflow with the same date and absolute amount in two different accounts. Ambiguous groups are reported and skipped.

## Split

Split by transaction id:

```bash
abctl split --transaction-id abc123 "Groceries run" "Food" -45.60 "Petrol" "Transport" -30
```

Split by exact payee and ISO date:

```bash
abctl split --payee "Example Store" --txn-date 2026-04-05 "Groceries run" "Food" -45.60
```

Each split entry is a repeated `<notes> <category> <amount>` triplet. Quote notes or category names when they contain spaces.

Use `--add-remainder-split` to append one extra split for any remaining difference. The extra split uses the parent transaction category, so it only works when the original transaction is already categorized.

## St.George Import

Preview the mapped `ImportTransactionEntity` objects:

```bash
abctl st-george-import <account> path/to/st-george.csv --json
```

Preview Actual's reconciliation result without writing:

```bash
abctl st-george-import <account> path/to/st-george.csv --dry-run
```

Import the CSV into an account:

```bash
abctl st-george-import <account> path/to/st-george.csv
```

`<account>` may be either the Actual account id or account name. Matching prefers exact id, then exact name, then unique case-insensitive name, then a unique case-insensitive substring match. If the match is ambiguous, the command fails and asks you to use the id.

## QIF Import

Preview the parsed transactions returned by Actual:

```bash
abctl qif-import <account> path/to/file.qif --json
```

Preview reconciliation without writing:

```bash
abctl qif-import <account> path/to/file.qif --dry-run
```

Import the QIF into an account:

```bash
abctl qif-import <account> path/to/file.qif
```

Optional flags:

- `--import-notes` keeps the QIF memo field as Actual notes.
- `--swap-payee-and-memo` uses the QIF memo field as the payee before optional note import.

`<account>` may be either the Actual account id or account name. Matching prefers exact id, then exact name, then unique case-insensitive name, then a unique case-insensitive substring match. If the match is ambiguous, the command fails and asks you to use the id.
