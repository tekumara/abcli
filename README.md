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

`<account>` may be either the Actual account id or the account name. If the name is ambiguous, the command fails and asks you to use the id.

## QIF Import

Preview the normalized `ImportTransactionEntity` objects:

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

Ambiguous QIF dates use the budget's `dateFormat` preference when available.

Smoke tests:

```bash
npm run smoke:qif
npm run smoke:qif:write
```
