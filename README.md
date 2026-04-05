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
  help [command]                display help for command

Environment:
  ACTUAL_PASSWORD        Required.
  ACTUAL_SYNC_ID         Optional. Budget name, groupId, or cloudFileId. Defaults to the first available budget.
  ACTUAL_SERVER_URL      Optional. Defaults to http://localhost:5007
  ACTUAL_DATA_DIR        Optional. Defaults to /tmp/actual
```
