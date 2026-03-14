import json
import os
import subprocess
import tempfile
from collections import defaultdict
from collections.abc import Sequence
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
    return " - ".join(parts)


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


def _cat_info(t: Transactions) -> tuple[str, float, str, float]:
    """Returns (group_name, group_sort, cat_name, cat_sort) for budget ordering."""
    if t.category:
        cname = t.category.name or "?"
        csort = t.category.sort_order or 0.0
        if t.category.group:
            gname = t.category.group.name or "?"
            gsort = t.category.group.sort_order or 0.0
        else:
            gname, gsort = "Other", float("inf")
    else:
        gname, gsort = "Other", float("inf")
        cname, csort = "Uncategorized", float("inf")
    return gname, gsort, cname, csort


def _apply_conditions(
    txns: Sequence[Transactions], conditions_json: str | None, conditions_op: str | None = "and",
) -> list[Transactions]:
    if not conditions_json:
        return list(txns)
    conditions = json.loads(conditions_json)
    if not conditions:
        return list(txns)

    def _field(t: Transactions, field: str) -> str | None:
        match field:
            case "category":
                return t.category_id
            case "account":
                return t.acct
            case "payee":
                return t.payee_id
            case _:
                return None

    def _check(t: Transactions, cond: dict) -> bool:
        val = _field(t, cond["field"])
        target = cond["value"]
        match cond["op"]:
            case "is":
                return val == target
            case "isNot":
                return val != target
            case "oneOf":
                return val in target
            case "notOneOf":
                return val not in target
            case _:
                return True

    combine = any if conditions_op == "or" else all
    return [t for t in txns if combine(_check(t, c) for c in conditions)]


def _month_columns(start: date | None, end: date | None) -> list[date]:
    """Generate first-of-month dates spanning start to end (inclusive)."""
    if not start:
        return []
    current = start.replace(day=1)
    end_month = (end or date.today()).replace(day=1)
    columns = []
    while current <= end_month:
        columns.append(current)
        current = _month_start(current, 1)
    return columns


def _report_header(rpt: CustomReports, start: date | None, end: date | None) -> list[str]:
    return [f"# {rpt.name}", "", f"*{_format_date_range(start, end)}*", ""]


def _render_total_mode(
    txns: Sequence[Transactions],
    group_by: str,
    descending: bool,
    rpt: CustomReports,
    start: date | None,
    end: date | None,
) -> list[str]:
    lines = _report_header(rpt, start, end)
    num_months = len(_month_columns(start, end)) or 1

    if group_by == "Category":
        lines += _render_total_by_category(txns, rpt, num_months)
    else:
        lines += _render_total_flat(txns, group_by, descending, rpt, num_months)

    return lines


def _total_row(label: str, dep: Decimal, pay: Decimal, num_months: int, bold: bool = False) -> str:
    total = dep + pay
    avg = total / num_months
    if bold:
        return (
            f"| **{label}** | **{dep:,.2f}** | **{pay:,.2f}** "
            f"| **{total:,.2f}** | **{avg:,.2f}** |"
        )
    return f"| {label} | {dep:,.2f} | {pay:,.2f} | {total:,.2f} | {avg:,.2f} |"


_TOTAL_HEADER = "| {col} | Deposits | Payments | Totals | Average |"
_TOTAL_SEP = "|---|---:|---:|---:|---:|"


def _render_total_flat(
    txns: Sequence[Transactions],
    group_by: str,
    descending: bool,
    rpt: CustomReports,
    num_months: int,
) -> list[str]:
    groups: dict[str, list[Decimal]] = {}
    for t in txns:
        key = _group_key(t, group_by)
        if key not in groups:
            groups[key] = [Decimal(0), Decimal(0)]
        amt = t.get_amount()
        groups[key][0 if amt > 0 else 1] += amt

    if not rpt.show_empty:
        groups = {k: v for k, v in groups.items() if v[0] + v[1] != 0}

    sorted_groups = sorted(
        groups.items(), key=lambda x: x[1][0] + x[1][1], reverse=descending,
    )

    lines = [_TOTAL_HEADER.format(col=group_by), _TOTAL_SEP]
    grand_dep = grand_pay = Decimal(0)
    for key, (dep, pay) in sorted_groups:
        grand_dep += dep
        grand_pay += pay
        lines.append(_total_row(key, dep, pay, num_months))
    lines.append(_total_row("Totals", grand_dep, grand_pay, num_months, bold=True))
    return lines


def _render_total_by_category(
    txns: Sequence[Transactions], rpt: CustomReports, num_months: int,
) -> list[str]:
    cat_groups: dict[str, dict] = {}
    for t in txns:
        gname, gsort, cname, csort = _cat_info(t)
        if gname not in cat_groups:
            cat_groups[gname] = {"sort": gsort, "cats": {}}
        cats = cat_groups[gname]["cats"]
        if cname not in cats:
            cats[cname] = {"sort": csort, "dep": Decimal(0), "pay": Decimal(0)}
        amt = t.get_amount()
        cats[cname]["dep" if amt > 0 else "pay"] += amt

    lines = [_TOTAL_HEADER.format(col="Category"), _TOTAL_SEP]
    grand_dep = grand_pay = Decimal(0)
    for gname, ginfo in sorted(cat_groups.items(), key=lambda x: x[1]["sort"]):
        g_dep = sum((c["dep"] for c in ginfo["cats"].values()), Decimal(0))
        g_pay = sum((c["pay"] for c in ginfo["cats"].values()), Decimal(0))
        if not rpt.show_empty and g_dep + g_pay == 0:
            continue
        grand_dep += g_dep
        grand_pay += g_pay
        lines.append(_total_row(gname, g_dep, g_pay, num_months, bold=True))
        for cname, cinfo in sorted(ginfo["cats"].items(), key=lambda x: x[1]["sort"]):
            if not rpt.show_empty and cinfo["dep"] + cinfo["pay"] == 0:
                continue
            lines.append(_total_row(cname, cinfo["dep"], cinfo["pay"], num_months))
    lines.append(_total_row("Totals", grand_dep, grand_pay, num_months, bold=True))
    return lines


def _render_time_mode(
    txns: Sequence[Transactions],
    group_by: str,
    descending: bool,
    rpt: CustomReports,
    start: date | None,
    end: date | None,
) -> list[str]:
    effective_start = start or (min(t.get_date() for t in txns) if txns else date.today())
    months = _month_columns(effective_start, end)
    lines = _report_header(rpt, start, end)

    if group_by == "Category":
        lines += _render_time_by_category(txns, months, rpt)
    else:
        lines += _render_time_flat(txns, group_by, months, descending, rpt)

    return lines


def _fmt_cells(amounts: dict[date, Decimal], months: list[date]) -> tuple[list[str], Decimal]:
    """Format per-month cells and return (cells, row_total)."""
    cells = []
    total = Decimal(0)
    for m in months:
        amt = amounts.get(m, Decimal(0))
        cells.append(f"{amt:,.2f}")
        total += amt
    return cells, total


def _render_time_flat(
    txns: Sequence[Transactions],
    group_by: str,
    months: list[date],
    descending: bool,
    rpt: CustomReports,
) -> list[str]:
    data: dict[str, dict[date, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    for t in txns:
        key = _group_key(t, group_by)
        data[key][t.get_date().replace(day=1)] += t.get_amount()

    if not rpt.show_empty:
        data = {k: v for k, v in data.items() if any(v.values())}

    sorted_keys = sorted(data.keys(), key=lambda k: sum(data[k].values()), reverse=descending)

    month_headers = [m.strftime("%b %y") for m in months]
    lines = [
        f"| {group_by} | " + " | ".join(month_headers) + " | Total |",
        "|---" + " | ---:" * len(months) + " | ---:|",
    ]

    totals_by_month: dict[date, Decimal] = defaultdict(Decimal)
    grand_total = Decimal(0)
    for key in sorted_keys:
        cells, row_total = _fmt_cells(data[key], months)
        grand_total += row_total
        for m in months:
            totals_by_month[m] += data[key].get(m, Decimal(0))
        lines.append(f"| {key} | " + " | ".join(cells) + f" | {row_total:,.2f} |")

    total_cells = [f"**{totals_by_month.get(m, Decimal(0)):,.2f}**" for m in months]
    lines.append("| **Total** | " + " | ".join(total_cells) + f" | **{grand_total:,.2f}** |")
    return lines


def _render_time_by_category(
    txns: Sequence[Transactions], months: list[date], rpt: CustomReports,
) -> list[str]:
    cat_groups: dict[str, dict] = {}
    for t in txns:
        gname, gsort, cname, csort = _cat_info(t)
        if gname not in cat_groups:
            cat_groups[gname] = {"sort": gsort, "cats": {}}
        cats = cat_groups[gname]["cats"]
        if cname not in cats:
            cats[cname] = {"sort": csort, "months": defaultdict(Decimal)}
        cats[cname]["months"][t.get_date().replace(day=1)] += t.get_amount()

    month_headers = [m.strftime("%b %y") for m in months]
    lines = [
        "| Category | " + " | ".join(month_headers) + " | Total |",
        "|---" + " | ---:" * len(months) + " | ---:|",
    ]

    grand_totals: dict[date, Decimal] = defaultdict(Decimal)
    grand_total = Decimal(0)
    for gname, ginfo in sorted(cat_groups.items(), key=lambda x: x[1]["sort"]):
        group_months: dict[date, Decimal] = defaultdict(Decimal)
        cat_rows: list[str] = []

        for cname, cinfo in sorted(ginfo["cats"].items(), key=lambda x: x[1]["sort"]):
            cells, row_total = _fmt_cells(cinfo["months"], months)
            if not rpt.show_empty and row_total == 0:
                continue
            for m in months:
                group_months[m] += cinfo["months"].get(m, Decimal(0))
            cat_rows.append(f"| {cname} | " + " | ".join(cells) + f" | {row_total:,.2f} |")

        group_total = sum(group_months.values())
        if not rpt.show_empty and group_total == 0:
            continue

        group_cells = [f"**{group_months.get(m, Decimal(0)):,.2f}**" for m in months]
        lines.append("| **" + gname + "** | " + " | ".join(group_cells) + f" | **{group_total:,.2f}** |")
        lines.extend(cat_rows)

        for m in months:
            grand_totals[m] += group_months.get(m, Decimal(0))
        grand_total += group_total

    total_cells = [f"**{grand_totals.get(m, Decimal(0)):,.2f}**" for m in months]
    lines.append("| **Total** | " + " | ".join(total_cells) + f" | **{grand_total:,.2f}** |")
    return lines


def _to_tsv(lines: list[str]) -> str:
    """Convert markdown table lines to tab-separated values."""
    result = []
    for line in lines:
        if line.startswith("|--") or not line.strip():
            continue
        if line.startswith("|"):
            cells = [c.strip().replace("**", "") for c in line.split("|")[1:-1]]
            result.append("\t".join(cells))
        elif line.startswith("#"):
            result.append(line.lstrip("# "))
        elif line.startswith("*") and line.endswith("*"):
            result.append(line.strip("*"))
    return "\n".join(result)


def _to_html(lines: list[str]) -> str:
    """Convert markdown lines to an HTML table."""
    parts: list[str] = []
    rows: list[str] = []
    header_done = False
    for line in lines:
        if not line.strip():
            continue
        if line.startswith("# "):
            parts.append(f"<h3>{line[2:]}</h3>")
        elif line.startswith("*") and line.endswith("*"):
            parts.append(f"<p><em>{line.strip('*')}</em></p>")
        elif line.startswith("|--"):
            header_done = True
        elif line.startswith("|"):
            cells = [c.strip() for c in line.split("|")[1:-1]]
            if not header_done:
                rows.append("<tr>" + "".join(f"<th>{c}</th>" for c in cells) + "</tr>")
            else:
                tds = []
                for cell in cells:
                    bold = cell.startswith("**") and cell.endswith("**")
                    text = cell.replace("**", "")
                    try:
                        float(text.strip().replace(",", ""))
                        align = ' align="right"'
                    except ValueError:
                        align = ""
                    inner = f"<b>{text}</b>" if bold else text
                    tds.append(f"<td{align}>{inner}</td>")
                rows.append(f"<tr>{''.join(tds)}</tr>")

    return (
        f"<html><body>{''.join(parts)}"
        f'<table border="1" cellpadding="4" cellspacing="0">{"".join(rows)}</table>'
        f"</body></html>"
    )


def _copy_rtf(html: str) -> None:
    """Convert HTML to RTF and copy to macOS clipboard."""
    with tempfile.NamedTemporaryFile(suffix=".html", mode="w", delete=False) as f:
        f.write(html)
        html_path = f.name
    rtf_path = html_path.replace(".html", ".rtf")
    try:
        subprocess.run(
            ["textutil", "-convert", "rtf", html_path, "-output", rtf_path],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["osascript", "-e",
             f'set the clipboard to (read POSIX file "{rtf_path}" as «class RTF »)'],
            check=True, capture_output=True,
        )
    finally:
        os.unlink(html_path)
        if os.path.exists(rtf_path):
            os.unlink(rtf_path)


@app.command
def report(name: str, *, mode: str | None = None, tsv: bool = False, rtf: bool = False):
    """Render a custom report by name as a markdown table.

    Use --mode to override the report's display mode ("total" or "time").
    Use --tsv for tab-separated output that pastes into Google Sheets.
    Use --rtf to copy a formatted table to the clipboard (macOS).
    """
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

        txns = _apply_conditions(txns, rpt.conditions, rpt.conditions_op)

        if not rpt.show_hidden:
            txns = [t for t in txns if not t.category or not t.category.hidden]
        if not rpt.show_uncategorized:
            txns = [t for t in txns if t.category_id]

        group_by = rpt.group_by or "Category"
        descending = rpt.sort_by != "asc"

        effective_mode = mode or rpt.mode

        if effective_mode == "time":
            lines = _render_time_mode(txns, group_by, descending, rpt, start, end)
        else:
            lines = _render_total_mode(txns, group_by, descending, rpt, start, end)

        if rtf:
            Console().print(Markdown("\n".join(lines)))
            _copy_rtf(_to_html(lines))
            print("Copied to clipboard.")
        elif tsv:
            print(_to_tsv(lines))
        else:
            Console().print(Markdown("\n".join(lines)))


if __name__ == "__main__":
    app()
