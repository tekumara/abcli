export function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeDateValue(value) {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    if (/^\d{8}$/.test(value)) {
      return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    }
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    const digits = String(value);
    if (digits.length === 8) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    }
  }
  throw new Error(`Unsupported transaction date value: ${JSON.stringify(value)}`);
}

export function normalizeTransaction(rawTxn) {
  return {
    id: rawTxn.id,
    accountId: rawTxn.account_id ?? rawTxn.account ?? rawTxn.acct ?? null,
    categoryId: rawTxn.category_id ?? rawTxn.category ?? null,
    payeeId: rawTxn.payee_id ?? rawTxn.payee ?? null,
    notes: rawTxn.notes ?? "",
    amount: toFiniteNumber(rawTxn.amount, 0),
    date: normalizeDateValue(rawTxn.date),
    subtransactions: Array.isArray(rawTxn.subtransactions)
      ? rawTxn.subtransactions.map(normalizeTransaction)
      : [],
  };
}

export function extractQueryData(result) {
  if (Array.isArray(result)) {
    return result;
  }
  if (Array.isArray(result?.data)) {
    return result.data;
  }
  return [];
}
