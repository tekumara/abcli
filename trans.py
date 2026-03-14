import os
from contextlib import contextmanager
from datetime import date, timedelta

import cyclopts
from actual import Actual
from actual.database import Transactions
from actual.queries import get_transactions

app = cyclopts.App()


@contextmanager
def open_actual():
    with Actual(
        base_url="http://localhost:5007",
        password=os.environ.get("ACTUAL_PASSWORD"),
        file=os.environ.get("ACTUAL_BUDGET_SYNC_ID"),
        data_dir="/tmp/actual",
    ) as actual:
        yield actual


def _find_transaction(session, payee: str, txn_date: date) -> Transactions:
    transactions = get_transactions(
        session,
        payee=payee,
        start_date=txn_date,
        end_date=txn_date + timedelta(days=1),
    )
    if not transactions:
        raise ValueError(f"No transaction found for payee={payee!r} on {txn_date}")
    if len(transactions) > 1:
        raise ValueError(
            f"Found {len(transactions)} transactions for payee={payee!r} on {txn_date}, "
            f"use --transaction-id instead"
        )
    return transactions[0]


def _print_transaction(t: Transactions):
    print(f"  id:       {t.id}")
    print(f"  account:  {t.account.name if t.account else None}")
    print(f"  date:     {t.get_date()}")
    print(f"  payee:    {t.payee.name if t.payee else None}")
    print(f"  notes:    {t.notes}")
    print(f"  category: {t.category.name if t.category else None}")
    print(f"  amount:   {t.get_amount()}")


@app.command
def find(payee: str, txn_date: date):
    """Find a transaction by payee and date."""
    with open_actual() as actual:
        transactions = get_transactions(
            actual.session,
            payee=payee,
            start_date=txn_date,
            end_date=txn_date + timedelta(days=1),
        )
        if not transactions:
            print(f"No transactions found for payee={payee!r} on {txn_date}")
            return
        for t in transactions:
            _print_transaction(t)
            print()


if __name__ == "__main__":
    app()
