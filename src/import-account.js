function fail(message) {
  throw new Error(message);
}

function ambiguousAccountError(rawIdentifier, matches) {
  fail(
    `Account name ${JSON.stringify(rawIdentifier)} is ambiguous. Matching ids: ${matches
      .map((account) => account.id)
      .join(", ")}`,
  );
}

export function resolveImportAccount(accounts, identifier) {
  const rawIdentifier = String(identifier ?? "").trim();
  if (!rawIdentifier) {
    fail("Account identifier is required.");
  }

  const directIdMatch = accounts.find((account) => account.id === rawIdentifier);
  if (directIdMatch) {
    return directIdMatch;
  }

  const exactNameMatches = accounts.filter((account) => account.name === rawIdentifier);
  if (exactNameMatches.length === 1) {
    return exactNameMatches[0];
  }
  if (exactNameMatches.length > 1) {
    ambiguousAccountError(rawIdentifier, exactNameMatches);
  }

  const foldedIdentifier = rawIdentifier.toLowerCase();
  const foldedNameMatches = accounts.filter(
    (account) => account.name?.toLowerCase() === foldedIdentifier,
  );
  if (foldedNameMatches.length === 1) {
    return foldedNameMatches[0];
  }
  if (foldedNameMatches.length > 1) {
    ambiguousAccountError(rawIdentifier, foldedNameMatches);
  }

  const substringMatches = accounts.filter((account) =>
    account.name?.toLowerCase().includes(foldedIdentifier),
  );
  if (substringMatches.length === 1) {
    return substringMatches[0];
  }
  if (substringMatches.length > 1) {
    ambiguousAccountError(rawIdentifier, substringMatches);
  }

  fail(`Account ${JSON.stringify(rawIdentifier)} not found.`);
}
