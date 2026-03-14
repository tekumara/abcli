import os
from contextlib import contextmanager
from datetime import date, timedelta
from decimal import Decimal

import cyclopts
from actual import Actual
from actual.database import Transactions
from actual.queries import create_transaction, get_category, get_transactions

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


def _resolve_transaction(session, *, transaction_id: str | None, payee: str | None, txn_date: date | None) -> Transactions:
    if transaction_id:
        t = session.get(Transactions, transaction_id)
        if not t:
            raise ValueError(f"Transaction {transaction_id!r} not found")
        return t
    if payee and txn_date:
        return _find_transaction(session, payee, txn_date)
    raise ValueError("Provide --transaction-id or both --payee and --txn-date")


@app.command
def split(
    splits: list[tuple[str, str, float]],
    *,
    transaction_id: str | None = None,
    payee: str | None = None,
    txn_date: date | None = None,
):
    """Split a transaction into sub-transactions.

    Each split is a triplet of: notes category amount.
    Identify the transaction by --transaction-id, or --payee and --txn-date.
    """
    with open_actual() as actual:
        s = actual.session
        t = _resolve_transaction(s, transaction_id=transaction_id, payee=payee, txn_date=txn_date)

        print("Splitting transaction:")
        _print_transaction(t)

        original_amount = t.get_amount()
        split_total = Decimal(str(sum(amount for _, _, amount in splits)))
        if split_total != original_amount:
            print(f"\n  WARNING: split total ({split_total}) != transaction amount ({original_amount})")

        t.is_parent = 1
        t.category_id = None

        for notes, category_name, amount in splits:
            cat = get_category(s, category_name)
            if not cat:
                raise ValueError(f"Category {category_name!r} not found")
            child = create_transaction(
                s, t.get_date(), t.account, t.payee, notes, cat, amount=Decimal(str(amount)),
            )
            child.parent_id = t.id
            child.is_parent = 0
            child.is_child = 1
            print(f"  + {notes}, {category_name}, {amount}")

        actual.commit()
        print("Done.")


if __name__ == "__main__":
    app()
