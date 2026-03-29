#!/bin/bash

# Clean CSV exported from UI (nb: set the UI to order from oldest to latest).

if [ "$1" ]; then
    outfile="${1}.actual.csv"
else
    outfile="/dev/stdout"
fi

duckdb -csv -c "
    select '' as Num, strftime(Date, '%d/%m/%Y') as Date,
    -- format by stripping out leading transaction type and datetime (eg: 20Dec08:47)
    -- and using it in Notes below
    regexp_replace(
        Description, '^(Visa Purchase( O/Seas)?|Visa Credit( Overseas)?|Osko Withdrawal|Osko Deposit|Sct Deposit|Eftpos Debit|Eftpos Credit|Tfr Wdl BPAY Internet|(Cardless )?Atm Withdrawal( -Wbc)?|Internet Deposit|Internet Withdrawal)\s+\S+\s',''
    ) as Payee,
    regexp_extract(
        Description, '^(Visa Purchase( O/Seas)?|Visa Credit( Overseas)?|Osko Withdrawal|Osko Deposit|Sct Deposit|Eftpos Debit|Eftpos Credit|Tfr Wdl BPAY Internet|(Cardless )?Atm Withdrawal( -Wbc)?|Internet Deposit|Internet Withdrawal)'
    ) as Notes,
    '' as Category,'' as S,
    Debit,
    Credit,
    Balance,
    from read_csv_auto('/dev/stdin');
" < "${1:-/dev/stdin}" > "$outfile"
