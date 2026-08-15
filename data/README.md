# Policy Database

`policies.json` is the canonical policy database.
`policies.js` is generated for the static app and assigns the same list to `window.POLICY_DB`.

Update locally:

```bash
node tools/update-policies.mjs
```

With the Ontong Youth Policy API:

```bash
YOUTH_POLICY_API_KEY=... node tools/update-policies.mjs
```

The updater validates required fields, merges imported rows by `id`, writes `data/update-report.json`, and keeps manually curated rules unless the imported row fills a newer value.

Important limits:

- The API key is required for automatic broad collection.
- Imported policies are marked `confidence: "verify"` because eligibility text still needs human review before strict pass/fail rules can be trusted.
- Local static QA at `127.0.0.1:8765` disables anonymous stats so console checks stay clean.
