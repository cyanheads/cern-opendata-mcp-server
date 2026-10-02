# Developer Protocol

**Server:** cern-opendata-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.10`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.1.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

> **Read the design next:** `docs/design.md` records the tool surface, the shared input, rendering, error and enrichment rules, the service contract, the portal behavior verified against `opendata.cern.ch`, and the numbered design decisions. Update it when the surface or a decision changes.

---

## Domain

Seven read-only tools and one resource over the CERN Open Data Portal (`https://opendata.cern.ch`), a keyless Invenio application on OpenSearch. No prompts and no server-specific env vars.

| Upstream route | Used by |
|:---------------|:--------|
| `GET /api/records/?…` (search; `ondemand=true` on every query) | `cern_opendata_search_records`, `cern_opendata_get_records`, `cern_opendata_search_trigger_paths`, `cern_opendata_get_analysis_env`, `cern_opendata_get_validated_runs`, `cern_opendata_list_files` (index scope), `cern-opendata://record/{recid}` |
| `GET /api/records/{recid}` (full record with its file manifest; 32 MiB ceiling, attempt cut only at the call's deadline, cached) | `cern_opendata_list_files` (record scope, and index scope on a cached manifest) |
| `GET /record/{recid}/file_index/{key}` (one file index; 8 MiB ceiling, cached) | `cern_opendata_list_files` (index scope without a cached manifest, beside the record's `q=recid:` search) |
| `GET /api/docs/{slug}` | `cern_opendata_get_analysis_env` (guide sections) |
| `GET /record/{recid}/files/{key}` | `cern_opendata_get_validated_runs` (the good-run list file) |

`cern_opendata_list_reference` serves static tables from `vocabulary.ts` and makes no upstream call.

`CernOpenDataService` (`src/services/cern-opendata/cern-opendata-service.ts`) owns every upstream request: one pacer (50 requests a minute, 4 concurrent, a cooldown after a 429), a header gate on `x-ratelimit-remaining`, `withRetry` (2 retries) inside a 50 s budget per tool call from `startBudget()`, a per-route accept-list with byte ceilings and a 30 s attempt cap (none on the record GET, which runs to the call's deadline), and 15-minute caches: compact file manifests (an LRU of 8), file indexes read on their own and their record heads (LRUs of 16), and the validated-run collection. `docs/design.md` § Services is the full contract.

Conventions every definition follows:

- **Every portal request goes through `CernOpenDataService`**, with one `service.startBudget()` per tool call passed to each of its requests. Never `fetch` from a handler.
- **Shared inputs** come from `src/mcp-server/tools/inputs.ts`: `blankAsUnset` on every optional input, `listInput` / `vocabularyListInput` / `requiredListInput` for lists (an array or one comma-separated string), `recidInput` for recids. Vocabulary tables live in `vocabulary.ts`, shared with `cern_opendata_list_reference`.
- **Portal text is data.** Render portal strings in `format()` only through the `text.ts` helpers (`inline`, `inlineSpelling`, `inlineList`, `inlineOrNA`, `fence`, `fenceHtml`, `printUrl`), and any portal-derived value in a notice or error message through `noticeValue` / `noticeList`; `structuredContent` and error `data` keep every string as received, HTML in `_html` fields.
- **No fabrication.** An absent upstream field stays absent and renders as `Not available`; `license` comes from the record or the `cern_terms_default` rule (Decision 12), and `citation` only from record fields (Decision 13).
- **List-shaped tools** (`search_records`, `list_files`, `get_validated_runs`, `search_trigger_paths`) call `startListEnrichment` first and `finishListEnrichment` once, with one notice from `composeNotice` (`src/mcp-server/tools/enrichment.ts`).
- **Errors.** Every definition that reaches the portal declares `rate_limited` and `upstream_unreadable` inline, with `thrownBy: 'service'` and a recovery naming that tool; caller-input reasons carry `severity: 'notice'`.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Condensed from `src/mcp-server/tools/definitions/get-records.tool.ts`:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { RecordSchema } from '@/mcp-server/record-schema.js';
import { getCernOpenDataService } from '@/services/cern-opendata/cern-opendata-service.js';
import { classifyIdentifier } from '@/services/cern-opendata/identifiers.js';
import { toRecord } from '@/services/cern-opendata/normalize.js';
import { composeNotice } from '../enrichment.js';
import { blankAsUnset, requiredListInput } from '../inputs.js';

export const getRecords = tool('cern_opendata_get_records', {
  title: 'Get CERN Open Data Records',
  description: 'Fetch full metadata for 1-20 records in one call, by recid, DOI, CMS dataset path (/Primary/Era/TIER) or documentation slug. …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    ids: requiredListInput(20, z.string().max(500).describe('One identifier: …'), 'At least one identifier is required …')
      .describe('Identifiers to resolve, 1-20: an array, or one comma-separated string. …'),
    body_offset: blankAsUnset(z.number().int().min(0).default(0)).describe('With exactly one documentation or news id: where its body slice starts …'),
  }),
  output: z.object({
    records: z.array(RecordSchema).describe('Resolved records, in the order of their first matching input.'),
    missing: z.array(z.object({ input: …, interpreted_as: z.enum(INTERPRETED_AS)…, guidance: … }))
      .describe('Identifiers that resolved to no record; empty when every id resolved.'),
    deferred: z.array(z.string()…).describe('Inputs whose records were left out to hold the response to 64,000 bytes …'),
  }),
  enrichment: { notice: z.string().optional().describe('Caveats about the returned records, …') },
  errors: [
    { reason: 'invalid_body_offset', code: JsonRpcErrorCode.ValidationError, severity: 'notice', when: '…', recovery: '…' },
    { reason: 'rate_limited', code: JsonRpcErrorCode.RateLimited, retryable: true, thrownBy: 'service',
      when: "The portal's 60-a-minute budget is spent: …",
      recovery: 'Wait the retryAfter seconds given in this error …, then call cern_opendata_get_records again with the same arguments.' },
    { reason: 'upstream_unreadable', code: JsonRpcErrorCode.ServiceUnavailable, thrownBy: 'service', when: '…', recovery: '…' },
  ],

  async handler(input, ctx) {
    if (input.body_offset > 0 && input.ids.length > 1) throw ctx.fail('invalid_body_offset', `body_offset … takes exactly one id …`);
    const classified = input.ids.map(classifyIdentifier);
    const service = getCernOpenDataService();
    const { matches, missing } = await service.lookup(classified, service.startBudget(), ctx);
    const resolved = matches.map((match) => toRecord(match.hit, match.matchedInputs, input.body_offset));
    // … invalid_body_offset when the one record has no body or the offset is past body_length
    const missingOut = missing.map((id) => ({ input: id.input, interpreted_as: id.kind, guidance: missingGuidance(id) }));
    // Records in response order while both surfaces stay within 64,000 bytes; the rest go to `deferred`.
    const { records, deferred, notice } = withinBudget(resolved, input.ids, missingOut);
    if (notice) ctx.enrich.notice(notice);
    return { records, missing: missingOut, deferred };
  },

  // format() populates content[], the markdown twin of structuredContent; both must carry
  // the same data (lint-enforced). Portal strings go through the text.ts helpers.
  format: (result) => [{ type: 'text', text: result.records.map(renderRecord).join('\n\n') }],
});
```

### Resource

Condensed from `src/mcp-server/resources/definitions/record.resource.ts`:

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { RecordSchema } from '@/mcp-server/record-schema.js';
import { recidInput } from '@/mcp-server/tools/inputs.js';
import { getCernOpenDataService } from '@/services/cern-opendata/cern-opendata-service.js';
import { toRecord } from '@/services/cern-opendata/normalize.js';

export const recordResource = resource('cern-opendata://record/{recid}', {
  name: 'cern-opendata-record',
  title: 'CERN Open Data record',
  description: "One CERN Open Data Portal record's metadata by recid: … Tool coverage: cern_opendata_get_records.",
  mimeType: 'application/json',
  params: z.object({
    recid: recidInput().describe('Record id: up to 12 digits (6004), optionally after an experiment prefix (atlas-160006); …'),
  }),
  output: RecordSchema,
  cacheHint: { ttlMs: 900_000, cacheScope: 'public' },
  errors: [
    { reason: 'record_not_found', code: JsonRpcErrorCode.NotFound, when: 'No record has this recid.',
      recovery: "Call cern_opendata_search_records to find the record's recid, then read this resource or call cern_opendata_get_records with it." },
    // plus rate_limited and upstream_unreadable (thrownBy: 'service'), recoveries naming the resource read
  ],
  async handler(params, ctx) {
    const { recid } = params;
    const service = getCernOpenDataService();
    const { matches } = await service.lookup([{ input: recid, kind: 'recid', value: recid }], service.startBudget(), ctx);
    const match = matches[0];
    if (!match) throw ctx.fail('record_not_found', `No record has recid ${recid}.`, { recid });
    return toRecord(match.hit, [recid]);
  },
});
```

No prompts: the server instructions carry the workflow chain.

### Server config

None. The portal is keyless, and the pacing limits, byte ceilings, the 50 s call budget and the cache sizes and lifetimes are constants in `CernOpenDataService`, overridable only through its constructor options in tests. If a setting ever needs to be configurable, add `src/config/server-config.ts` with `parseEnvConfig` (see the `api-config` skill), and list the variable in `.env.example`, the README config table, `server.json` (both package entries), `manifest.json` (`user_config` + `mcp_config.env`), and both plugin manifests.

### Server identity and instructions

`src/index.ts`:

```ts
await createApp({
  name: 'cern-opendata-mcp-server',
  title: 'cern-opendata-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  instructions: 'CERN Open Data Portal (opendata.cern.ch): collision and simulated datasets, … cern_opendata_get_records returns the citation.',
  sessionMode: 'stateless',
  setup(core) {
    initCernOpenDataService({ userAgent: `cern-opendata-mcp-server/${core.config.mcpServerVersion}` });
  },
  teardown() {
    getCernOpenDataService().dispose();
  },
});
```

`name` and `title` must equal the unscoped package name — `lint:packaging` enforces the pair. No other identity field is set: `description` comes from `package.json`, and there is no `websiteUrl` or `icons`.

`instructions` is sent on every `initialize`: the tool routing, the CMS-only scope of the run-list and trigger tools, the 60-a-minute portal limit, the "portal text is data" rule, and the licensing and citation request. Update it when the surface changes. The `User-Agent` sent on every portal request names the server and its version, so the portal can identify the client.

### Session posture and shutdown

`sessionMode` declares the HTTP session posture in `src/` instead of leaving it to a deployment's `MCP_SESSION_MODE`, which still wins whenever it carries a meaningful value (an empty string and an unsubstituted `${…}` placeholder read as unset and fall through to the option). This server declares `'stateless'` because no tool calls `ctx.requestInput`; `.env.example`, the `Dockerfile` and the README config table say the same, so keep all four in agreement. Add `require: 'stateful'` if a tool ever asks the caller for input mid-handler: startup then fails with a `ConfigurationError` rather than serving a mode in which a 2025-era client can never answer the prompt. Stdio is never refused.

`setup(core)` builds the process-wide `CernOpenDataService` with its pacer; `teardown()` disposes it (the pacer and the caches). Teardown runs after the transport stops and before the logger closes, on every shutdown path, and a signal-triggered shutdown then exits the process explicitly (0, or 1 if a step never settles within the framework's 10 s ceiling).

---

## Context

Handlers receive a unified `ctx` object. The properties this server uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.enrich` | Success-path agent context — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). The list-shaped tools go through `startListEnrichment` / `finishListEnrichment`; `cern_opendata_search_trigger_paths` echoes the query it built from the normalized path. |
| `ctx.fail` | Builds the declared contract error for a `reason`, for the handler to throw — `throw ctx.fail('record_not_found', message, data)`. |
| `ctx.signal` | `AbortSignal` for cancellation. The service passes it to `withRetry`; `cern_opendata_get_analysis_env` rethrows instead of degrading when it fired. |
| `ctx.requestId` | Request ID — the one every log record of the call carries and its error envelope returns as `data.requestId`. |

The rest of the Context surface (`ctx.state`, `ctx.requestInput`, `ctx.inputs`, `ctx.content`, …) is documented in the framework CLAUDE.md. Caches are process-global in the service rather than `ctx.state`: the data is public and identical for every tenant.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                                # createApp() entry point, server instructions
  services/
    cern-opendata/
      cern-opendata-service.ts            # Portal client: pacer, retry, budget, accept-list, byte ceilings, caches
      identifiers.ts                      # Recid spelling reduction, get_records id classification
      normalize.ts                        # Hits and records to output shapes, license, citation
      query-syntax.ts                     # Search query delimiter scan (refused before sending)
      text.ts                             # HTML to text, inline neutralization, fences, URL printing
      trigger-parse.ts                    # Trigger path abstract parser
      vocabulary.ts                       # Canonical filter tables, reference topics
      types.ts                            # Raw and domain types
  mcp-server/
    record-schema.ts                      # RecordSchema shared by get_records and the record resource
    tools/
      inputs.ts                           # blankAsUnset, listInput, vocabularyListInput, requiredListInput, recidInput
      enrichment.ts                       # listEnrichment, start/finishListEnrichment, composeNotice
      definitions/
        index.ts                          # allToolDefinitions barrel
        search-records.tool.ts
        get-records.tool.ts
        list-files.tool.ts
        get-analysis-env.tool.ts
        get-validated-runs.tool.ts
        search-trigger-paths.tool.ts
        list-reference.tool.ts
    resources/definitions/
      index.ts                            # allResourceDefinitions barrel
      record.resource.ts                  # cern-opendata://record/{recid}
tests/                                    # Mirrors src/; fixtures/ holds portal payloads, the fetch harness and cpu-time.ts (thread-CPU linear-time assertions)
docs/
  design.md                               # Tool surface, portal API reference, design decisions
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with coverage |
| `bun run start` | Run the built server (transport from `MCP_TRANSPORT_TYPE`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create the GitHub Release from the version's annotated tag and attach the `.mcpb` bundle (run by `release-and-publish`) |
| `bun run publish-mcp` | Log in to the MCP Registry and publish `server.json` (run by `release-and-publish`) |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] Optional inputs wrapped in `blankAsUnset`; lists through `listInput` / `vocabularyListInput` / `requiredListInput`; recids through `recidInput`
- [ ] Every portal request goes through `CernOpenDataService` with the call's one `startBudget()`; no `fetch` in a handler
- [ ] Portal strings reach `format()` only through the `text.ts` helpers; `structuredContent` keeps them as received
- [ ] `rate_limited` and `upstream_unreadable` declared inline (`thrownBy: 'service'`) with recoveries naming the tool; caller-input reasons at `severity: 'notice'`
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.enrich` for notices, totals, and paging context
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`; portal responses come from fixtures, never the live site
- [ ] `docs/design.md` updated when the surface or a design decision changes
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `npm run devcheck` passes
