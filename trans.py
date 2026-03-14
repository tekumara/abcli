import json
import os
from collections import defaultdict
from contextlib import contextmanager
from datetime import date, timedelta
from decimal import Decimal

import cyclopts
from actual import Actual
from actual.database import CustomReports, Transactions
from actual.queries import create_transaction, get_category, get_transactions
from rich.console import Console
from rich.markdown import Markdown
from sqlmodel import select

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


def _month_start(d: date, offset: int) -> date:
    """First day of the month `offset` months from `d`."""
    total = d.year * 12 + (d.month - 1) + offset
    return date(total // 12, total % 12 + 1, 1)


def _resolve_date_range(rpt: CustomReports) -> tuple[date | None, date | None]:
    """Returns (start, end) as inclusive dates."""
    if rpt.date_static and rpt.start_date:
        return date.fromisoformat(rpt.start_date), (
            date.fromisoformat(rpt.end_date) if rpt.end_date else None
        )
    today = date.today()
    first = today.replace(day=1)
    last_of_prev = first - timedelta(days=1)
    match rpt.date_range:
        case "thisMonth":
            return first, None
        case "lastMonth":
            return _month_start(today, -1), last_of_prev
        case s if s and s.startswith("last") and s.endswith("Months"):
            n = int(s.removeprefix("last").removesuffix("Months"))
            return _month_start(today, -n), last_of_prev
        case "yearToDate":
            return date(today.year, 1, 1), None
        case "lastYear":
            return date(today.year - 1, 1, 1), date(today.year - 1, 12, 31)
        case _:
            return None, None


def _format_date_range(start: date | None, end: date | None) -> str:
    if not start and not end:
        return "All time"
    parts = []
    if start:
        parts.append(start.strftime("%b %Y"))
    if end:
        parts.append(end.strftime("%b %Y"))
    else:
        parts.append("present")
    return " – ".join(parts)


def _group_key(t: Transactions, group_by: str) -> str:
    match group_by:
        case "Group":
            return (t.category.group.name or "?") if (t.category and t.category.group) else "Uncategorized"
        case "Payee":
            return (t.payee.name or "?") if t.payee else "Unknown"
        case "Account":
            return (t.account.name or "?") if t.account else "Unknown"
        case _:
            return (t.category.name or "?") if t.category else "Uncategorized"


@app.command
def report(name: str):
    """Render a custom report by name as a markdown table."""
    with open_actual() as actual:
        s = actual.session
        all_reports = s.exec(select(CustomReports)).all()
        rpt = next((r for r in all_reports if r.name == name and not r.tombstone), None)
        if not rpt:
            available = sorted(r.name or "?" for r in all_reports if not r.tombstone)
            msg = f"Report {name!r} not found."
            if available:
                msg += f" Available: {', '.join(available)}"
            Console().print(f"[red]{msg}[/red]")
            return

        start, end = _resolve_date_range(rpt)
        txns = get_transactions(
            s,
            start_date=start,
            end_date=end + timedelta(days=1) if end else None,
            off_budget=None if rpt.show_offbudget else False,
        )

        if rpt.balance_type == "Expense":
            txns = [t for t in txns if t.get_amount() < 0]
        elif rpt.balance_type == "Income":
            txns = [t for t in txns if t.get_amount() > 0]

        if rpt.selected_categories:
            raw = json.loads(rpt.selected_categories)
            cat_ids = {(c["id"] if isinstance(c, dict) else c) for c in raw}
            txns = [t for t in txns if t.category_id in cat_ids]

        if not rpt.show_hidden:
            txns = [t for t in txns if not t.category or not t.category.hidden]
        if not rpt.show_uncategorized:
            txns = [t for t in txns if t.category_id]

        groups = defaultdict(Decimal)
        for t in txns:
            groups[_group_key(t, rpt.group_by or "Category")] += t.get_amount()

        if not rpt.show_empty:
            groups = {k: v for k, v in groups.items() if v != 0}

        descending = rpt.sort_by != "asc"
        sorted_groups = sorted(groups.items(), key=lambda x: x[1], reverse=descending)

        header = rpt.group_by or "Category"
        lines = [
            f"# {rpt.name}",
            "",
            f"*{_format_date_range(start, end)}*",
            "",
            f"| {header} | Amount |",
            "|---|---:|",
        ]
        total = Decimal(0)
        for key, amount in sorted_groups:
            total += amount
            lines.append(f"| {key} | {amount:,.2f} |")
        lines.append(f"| **Total** | **{total:,.2f}** |")

        Console().print(Markdown("\n".join(lines)))


if __name__ == "__main__":
    app()
