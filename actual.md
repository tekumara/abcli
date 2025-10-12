# actual budget

Notes for using [Actual Budget](https://actualbudget.org/).

## Client vs server

> Actual has two parts: the client (the stuff you see and interact with), and an optional sync server. The server is what allows syncing your budget file between devices and allows for bank syncing. A full list of what does and does not require the sync server can be found in [this table](https://actualbudget.org/docs/install).

## Desktop client

The desktop client is an electron app that stores files locally.

Install:

```
brew install actual
```

The electron app files under _~/Documents/Actual_.

This location can be configured from the cog icon on the Files page.

## Server

The server keeps its copy of files inside the sqlite db at _user-files/\*.blob_.

## Imports

Dupes will be matched during import but this requires the correct fields are selected.
If the fields are changed in the UI after the file is loaded, it won't rematch.
Close the UI (or restart Actual) and open the import modal again.

Dupe [matching is fuzzy](https://github.com/actualbudget/actual/blob/cde81da72c214ee5b068fa487e5a715e5f2dbffb/packages/loot-core/src/server/accounts/sync.ts#L506) and dates don't need to be exact. Fuzzy matching looks 7 days ahead and 7 days back. This can mean an [imported transaction is matched when it shouldn't](https://github.com/actualbudget/actual/issues/2668#issuecomment-2081316772) when transactions are within a week of each other, and the amount matches eg:

1. 01/03/2025 Coffee -6.23 marked as a new transaction and imported
2. 24/02/2025 Coffee -6.23 marked as an already imported transaction

Review matches in the Import modal, and click the left icon on the row to toggle between ignore, update, and add.

If you uncheck `Merge with existing transactions` the matching won't happen with existing transactions but it will still happen amongst the import set with no ability to override this. You may end up duplicates if you are importing transactions that already exist.

`Clear transactions on import` will set the `clear` checkbox on the imported transaction.

### Recommended process

1. Delete any existing transactions for the day being imported.
1. Check `Merge with existing transactions` - this will allow you to override de-dupes within the import set
1. Find updates and greyed out already imported transactions in the import set and change them to `+`

## Transfers

When making a transfer do not create a rule to rename the payees. It applies incorrectly.

## Rules

If you set the category on a transaction for the same Payee three times then a rule will be automatically created.

See [Rules](https://actualbudget.org/docs/budgeting/rules/).

## Known issues & requested features

- [[Feature] Resizable columns #536](https://github.com/actualbudget/actual/issues/536)
- [[Bug]: Transaction order is incorrect after importing data with the same date #3928](https://github.com/actualbudget/actual/issues/3928)
- [[Bug]: Running balance not visible when sortin by oldest transaction first #3808](https://github.com/actualbudget/actual/issues/3808)
- [[Feature] Create New Category on the fly #3947](https://github.com/actualbudget/actual/issues/3947)
- [[Feature] "Make Transfer" Operation Keyboard Shortcut #4109](https://github.com/actualbudget/actual/issues/4109)
- [[Feature] Export report data as csv #3272](https://github.com/actualbudget/actual/issues/3272)
