# Freebuff News — current state and remaining work

**Status (2026-09-27):** A working Freebuff News Scout already ships in this app repo.
This document replaces the earlier proposal, which assumed no implementation existed.
The proposal's Webz.io-based plan is **not** what was built and is **not** the current
direction; see [Superseded approach](#superseded-approach).

Authoritative source for the implementation:

```text
electron/news-service.cjs   collectors, URL normalization, dedup, local scoring, cache
electron/main.cjs           createNewsService() registration
electron/preload.cjs        window.freebuffNews -> freebuff-news:get / freebuff-news:refresh
src/FreebuffNews.jsx        list, search, scores, summary, source link
src/news.css                screen styles
src/App.jsx                 newsOpen state, screen mount, Escape-to-close, entry point
```

## What exists today

### Collection — done

Five free public sources, no key, no paid API. `collectAll()` in `news-service.cjs` runs
them concurrently and isolates failures per source.

| Source | Endpoint | Window / size |
|---|---|---|
| GDELT | `api.gdeltproject.org/api/v2/doc/doc` | `timespan=24h`, `maxrecords=20` |
| Hacker News | `hn.algolia.com/api/v1/search_by_date` | `hitsPerPage=20` |
| GitHub | `api.github.com/search/repositories` | `created:>` last 7 days, `per_page=20` |
| arXiv | `export.arxiv.org/api/query` | `max_results=15`, newest first |
| RSS | Hugging Face Blog, Google AI Blog | full feed |

Every request goes through `requestJson()` with a 12s `AbortSignal.timeout` and a fixed
`Freebuff-News/1.0` user agent. Sources are currently hardcoded; there is no user-editable
interest or topic configuration.

### Per-source failure isolation — done

`collectAll()` wraps each collector in its own `try/catch` and returns
`{ name, items, error }`. A dead source yields `items: []` and an `error` message instead
of failing the refresh. The snapshot exposes this per source and the UI renders each
source as `name · count` or `name · 오류` in the footer.

### URL normalization and dedup — done

- `normalizeUrl()` parses the URL, drops the hash, removes `utm_*`, `ref`, and `source`
  query params, and strips a trailing slash.
- `itemId()` uses the normalized URL as the identity, falling back to a slugified title.
- Items are gated by `AI_TERMS` (title + summary must match an AI/agent/MCP vocabulary)
  before dedup, so a collector that drifts off-topic contributes nothing.
- Dedupe is a `Map` keyed by `id`; when two sources produce the same id, the entry with
  the longer summary wins.
- Only titles, short summaries, URLs, dates, source, and category are kept. Feed
  descriptions are truncated to 1200 characters at parse time.

### Local storage and refresh — done

- Cache file: `path.join(app.getPath('userData'), 'freebuff-news.json')`, holding
  `{ items, lastRefresh, sources, scorer, model }`. Capped at `MAX_ITEMS = 500`, sorted by
  `importance + freebuff_relevance` then publication date.
- `refresh()` is de-duplicated by a `refreshPromise` guard, so concurrent callers share one
  run.
- `freebuff-news:get` returns the cache and triggers a refresh only when there is no
  `lastRefresh` at all.
- `freebuff-news:refresh` forces a refresh and backs the UI's 새로 수집 button.
- A 6-hour `REFRESH_INTERVAL_MS` interval runs unattended, and startup performs an
  immediate refresh if the cache is older than 6 hours. The timer is `unref`'d.
- Existing items are merged with their previous record, so `collectedAt` is preserved while
  `analyzedAt` moves forward.

### Optional local LLM evaluation with a keyword fallback — done

- Ollama is called at `http://127.0.0.1:11434/api/chat` with
  `FREEBUFF_NEWS_MODEL` (default `qwen3:8b`). Only the top `MAX_TO_SCORE = 24` items are
  sent, each reduced to `{ id, title, summary, source, category }`.
- The system prompt asks for JSON with `importance`, `freebuff_relevance`, `novelty`,
  `category`, `summary`, `why_it_matters`, `possible_action`, and explicitly instructs the
  model to treat article text as untrusted data rather than instructions.
- If Ollama is unreachable or errors, the failure is logged at info level and every item
  falls back to `heuristicScore()`: importance `3 + keyword matches` (+1 for GitHub or
  arXiv), relevance `2 + matches * 2`, novelty a flat `5`, and fixed
  `why_it_matters` / `possible_action` text. The result is tagged
  `evaluator: 'keyword-fallback'`.
- `snapshot()` reports `scorer` and `model`, and the UI shows either
  `LOCAL LLM · <model>` or `KEYWORD FILTER · 무료 모드`. The user always knows which
  evaluator produced the numbers.

### UI — done

`src/FreebuffNews.jsx`, opened from the Command Center and mounted by `App.jsx` when
`newsOpen` is true (Escape closes it).

- Left: source feed with per-item source, publish time, title, summary, category, and
  importance; a client-side text search box filters title, summary, source, and category.
- Right: detail view with 중요도 / Freebuff 관련도 / 신규성 scores, 핵심 요약, 왜 중요한가,
  적용 아이디어, and a 원문 열기 link that opens the original URL in a new tab.
- Header: last update time, evaluator mode, and a manual 새로 수집 button with a busy state.
- Overview: total items, count of high-value items (importance ≥ 7 and relevance ≥ 6), and
  the number of healthy sources out of the total.
- Errors, including a missing `window.freebuffNews` bridge, surface as a visible alert
  rather than a blank screen.

### Cost and privacy

No paid news API and no paid LLM API. All five sources are unauthenticated public
endpoints; the only model call is to a local Ollama endpoint. No API key exists anywhere
in this feature, so there is no token to leak into logs or traces. Only the bounded fields
listed above are persisted; full article bodies are never stored.

## What is not implemented

These were proposed and remain open. They are listed in the order they would be built.

1. **Issue Note creation — not started.** Nothing in the news path writes a document,
   Page, or Task. There is no "make an issue note from this" action, no draft step, and no
   approval gate. This is the largest gap and the reason this document exists.
2. **User-configurable interests — not started.** Queries, sources, and the AI_TERMS gate
   are hardcoded. A user cannot say "follow MCP and local inference repos" without editing
   `news-service.cjs`.
3. **User feedback capture — not started.** There is no thumbs up/down or "investigate"
   signal, so no personalization dataset is accumulating yet.
4. **Search over time / by source — partial.** Search filters the current in-memory cache
   only. There is no date range, no source filter, and no query that reaches the providers.
5. **Tests — not started.** `news-service.cjs` exports `parseFeed`, `normalizeUrl`, and
   `heuristicScore`, which are testable, but no test file covers them. The three
   `tests/verify_*.cjs` acceptance scripts do not touch news.
6. **Provider uncertainty labels — not applicable as written.** The original proposal
   warned about Webz.io `sentiment` / `trust.categories` / `ai_allow` annotations. The free
   sources in use do not return these fields, so there is nothing to attribute today. If a
   provider with sentiment or trust labels is ever added, that attribution requirement
   returns with it.
7. **Rate-limit and quota handling — partial.** A 12s timeout and per-source error capture
   exist. GitHub's unauthenticated search limit and arXiv's request-rate guidance are not
   tracked or backoff-ed; a rate-limited response is currently reported as a plain source
   error.

## Next slice: news → Issue Note

The remaining product work is the handoff from a collected article to a user-owned note.
Keep these boundaries when building it.

1. **Draft first, save only on approval.** Produce a cited Markdown draft and show it
   before anything touches disk. Retrieval alone must not write.
2. **The note is a normal Page, not a new store.** Markdown in the configured Pages
   directory stays canonical. Do not introduce a separate issue database, and do not copy
   a provider's index.
3. **Cite sources, do not mirror them.** Record title, publisher, publication date, the
   original URL, and the short excerpt already held in the cache. Distinguish publication
   time from collection time.
4. **Attribute scores.** If the item carries `evaluator: 'ollama'`, the note should say the
   analysis came from a local model; if it is `keyword-fallback`, say the note was built
   from a keyword prefilter. A reader must not mistake a heuristic score for a judgment.
5. **No automatic side effects.** Creating a Task, linking a Project, or starting ongoing
   monitoring stays an explicit, separate user action.
6. **Route the write through the existing approval boundary.** The Harness bridge already
   owns Page and Task writes behind confirmation. The news feature should request a write,
   not perform one directly from `electron/`.

Suggested default note structure:

```markdown
# <issue title>

## Current summary

## What sources report
- [Title — Publisher, published date](url)
  <one attributed sentence>

## What is confirmed vs. uncertain

## Timeline

## Open questions

## Sources
- URL, retrieval timestamp, and which evaluator produced the analysis
```

## Acceptance criteria for the remaining work

- Opening News with no network and no Ollama still renders a usable screen with a visible
  reason, and does not hang or blank out.
- A single failing source is visible as failed while the other four still produce items.
- Refreshing twice in quick succession performs one collection pass, not two.
- Cache reload after an app restart shows the previous items immediately.
- An Issue Note draft appears with citations and an evaluator attribution, and nothing is
  written until the user approves.
- Approving the save creates a new Page identity without overwriting an existing note.

## Superseded approach

The original proposal targeted **Webz.io** as a single paid news provider and designed
Issue Notes around its result schema. That plan is not implemented and should not be
resumed as written:

- Webz.io is not free, and the project's direction is near-zero external API cost.
- Its `sentiment`, `trust.categories`, and `ai_allow` annotations were a large part of that
  design's safety reasoning; none of those fields exist in the shipped sources.
- The free multi-source approach replaced it and is what the code implements.

Keep the design intent that survives — bounded results, source links, visible evaluator,
draft before save, no automatic Task creation — and drop the Webz.io-specific schema.

## Decisions intentionally deferred

- Which sources are worth keeping long term, and whether GitHub's unauthenticated search
  limit justifies a token.
- Whether notes live as Pages only, or gain a lightweight type marker so issue notes can
  be listed separately.
- Whether a note should snapshot article text or only link to it, which depends on
  licensing terms per source.
- Any fine-tuning or LoRA work. The current rubric is a prompt plus a keyword fallback,
  and there is no user-feedback dataset to learn from yet.
