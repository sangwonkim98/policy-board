# policy-board

이거 나 되나 (수도권 청년정책 판정기): a static web tool that lists youth policies students and workers in Seoul and Gyeonggi can apply for now, and gives each one a pass / maybe / fail verdict with the reason.

> **Status:** ongoing · **Period:** 2026-08-15 ~ (last code change 2026-08-16; the policy database job commits daily, latest 2026-10-31) · **Visibility:** public
> **Outcome:** a single-page app (`index.html`) with a rule engine, a curated database of 23 policies, PWA install and offline support, and a daily GitHub Actions update job.
> **Next step:** the 2026-10-31 update report says `YOUTH_POLICY_API_KEY` is not set, so the daily job fetches nothing new. Setting that secret is what turns on broad automatic collection. The 66 basic local governments listed as not collected are still open.

## What and why

Government portals such as 온통청년 and 경기청년포털 already have filters. People still do not use them much, because after filtering they get dozens of results and do not know which ones they actually qualify for. Checking each requirement by hand is the real work.

So the main output here is the verdict and its reason, not the list. Two examples from the UI:

> 안산시 청년 전·월세보증금 대출이자 지원 → ❌ 전·월세 거주자만 해당됩니다
> 국가근로장학금 2차 → ⚠️ 학자금 지원구간 9구간 이하여야 함 (구간 미입력)

The tool is for students and workers in the Seoul metropolitan area. The UI is in Korean. It is unofficial: it is not affiliated with any government body and does not guarantee accuracy. Verdicts are for reference only; always check the original notice before applying.

### Verdict engine

Each policy has `rules`. The engine compares them with the user's profile and sorts every reason into one of four kinds:

| Mark | Meaning | Effect on verdict |
|------|---------|-------------------|
| `✕` | clearly not eligible | ❌ |
| `◇` | profile field empty, cannot decide | ⚠️ (user can fix in the app) |
| `?` | eligibility itself is uncertain | ⚠️ (needs outside check) |
| `준비할 것` | eligible, only preparation needed | none, stays ✅ |

The last kind is the important one. Without it almost every policy has some document to prepare, and the number of ✅ results stays at zero.

Age is handled as a range. A birth year alone cannot fix someone's exact age, so the engine keeps `[before birthday, after birthday]`; if the range crosses a threshold it marks ⚠️ instead of deciding. Age extensions for military service are also ⚠️, because the length of service is unknown.

### What the engine does not judge

The rule engine checks only what a machine can check: age, region, status, income bracket. It cannot judge grades, awards or how well someone's activities fit. For those, the page assembles a prompt and the user pastes it into their own ChatGPT or Claude. No API key or server is needed, and each user keeps the LLM they already use.

### Privacy

The profile is stored only in the browser's `localStorage`. When the site runs behind `worker.js` (Cloudflare Worker), the page also posts coarse anonymous events to `/api/e`: region bucket (서울, 경기, 인천, 기타), status, age band, and counts of pass/maybe/fail verdicts. Birth year, school and notes are dropped on the client. The visitor token is a hash of IP, user agent and date, so it changes every day. Events expire after 90 days. Stats are off when Do Not Track is set, when the user opts out (`policyboard.noStats` in `localStorage`), and on the local server at `127.0.0.1:8765`.

## Usage

Requirements: Python 3 for the local server, Node.js (the workflow uses Node 22) for the updater. No build step, no runtime dependencies.

View locally:

```bash
python3 serve.py   # http://127.0.0.1:8765
```

Update the policy database:

```bash
node tools/update-policies.mjs
```

The updater validates required fields, merges imported rows by `id`, regenerates `data/policies.js`, and writes `data/update-report.json`. With an Ontong Youth Policy OPEN API key it also collects policies automatically:

```bash
YOUTH_POLICY_API_KEY=... node tools/update-policies.mjs
```

Environment variables read by the updater:

| Name | Purpose |
|---|---|
| `YOUTH_POLICY_API_KEY` | Ontong Youth Policy OPEN API key. Without it, the updater only validates and regenerates. |
| `YOUTH_POLICY_MAX_PAGES` | Pages to fetch (default 5; the workflow sets 10). |
| `YOUTH_POLICY_PAGE_SIZE` | Rows per page (default 100). |

Imported policies are marked `confidence: "verify"`, because their eligibility text needs human review before strict pass/fail rules can be trusted. Manually curated rules are kept unless the imported row has a newer value.

`.github/workflows/update-policies.yml` runs the updater every day at 04:12 Asia/Seoul (and on manual dispatch) with the `YOUTH_POLICY_API_KEY` repository secret, then commits any change to the three data files.

Deployment: the repository root is the static output for Cloudflare Pages (`_headers` sets security headers). `worker.js` serves the static assets and the two stats endpoints, `/api/e` and `/api/stats`; it needs a KV binding named `STATS` and silently skips stats without it. The Wrangler config (`wrangler.jsonc`) is gitignored and not in the repository.

## Layout

| Path | What it holds |
|---|---|
| `index.html` | The whole app: verdict engine, UI, prompt builder, stats client. |
| `data/policies.json` | Canonical policy database (`policies` array, sources, schema version). |
| `data/policies.js` | Generated copy that sets `window.POLICY_DB` for the static app. |
| `data/update-report.json` | Result of the last updater run. |
| `data/README.md` | Notes on the database and updater limits. |
| `tools/update-policies.mjs` | Validates and updates the database, optionally from the OPEN API. |
| `tools/sources.json` | Data sources and how each one is reviewed. |
| `.github/workflows/update-policies.yml` | Daily update job. |
| `worker.js` | Cloudflare Worker: static assets plus anonymous stats in KV. |
| `sw.js`, `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` | PWA: offline cache and home screen install. |
| `serve.py` | Local static server on port 8765 (threaded, so the service worker can register). |
| `_headers`, `robots.txt` | Cloudflare Pages headers and crawler rules. |
| `DESIGN.md` | Visual rules for the UI (Korean). Read it before changing the screen. |

## Related

- Project list on the owner's site: https://sangwon.sw-kim.com/projects/

## Notes

### Data coverage

Sources collected: central agencies (한국장학재단, 국토부, 고용노동부), the Seoul and Gyeonggi provincial governments, 안산시, and 가톨릭대 campus scholarship notices. `tools/sources.json` also lists 청년몽땅정보통 and 경기청년포털 as portals for manual review.

The database is not complete. The 66 basic local governments are not collected, and campus scholarships cover only 가톨릭대. The tool is meant to scan and give a verdict, not to list everything. Every entry carries a link to the original notice and the date it was checked, and uncertain values are marked `confidence: "verify"`.

### Caching

`sw.js` uses network-first for `index.html`, so an online user always sees the latest deadlines, and cache-first for icons and the manifest. Offline, both fall back to the cache. `_headers` sets `Cache-Control: max-age=0, must-revalidate` on `index.html`.

### Visual QA

`DESIGN.md` describes the check loop: run `python3 serve.py`, check the console and network, take screenshots at 390x844, 768x1024 and 1280x900, and confirm there is no overlapping or clipped text and no horizontal scroll.
