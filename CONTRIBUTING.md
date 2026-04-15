# Contributing

## Tests

Run the synthetic mapper tests:

```bash
npm test
```

Run the disposable-budget smoke tests:

```bash
npm run smoke:transfer
npm run smoke:st-george
npm run smoke:qif
npm run smoke:split
```

Run the real-write smoke variant:

```bash
npm run smoke:transfer:write
npm run smoke:st-george:write
npm run smoke:qif:write
```

`smoke:split` writes to a disposable budget because `abctl split` has no dry-run mode.

## Release flow

- Push conventional commits to `main` such as `feat: ...` and `fix: ...`.
- `.github/workflows/release-please.yml` opens or updates the release PR.
- Merging that PR creates the tag and GitHub Release.
- The existing publish workflow then publishes the package to npm from the `release.published` event.
