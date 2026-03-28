# actual budget scripts

Scripts for working with [Actual Budget](actual.md).

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
