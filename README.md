<div align="center">
  <h1>@cyanheads/cern-opendata-mcp-server</h1>
  <p><b>Search CERN Open Data, fetch records, files, analysis environments, CMS good-run lists, HLT paths via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cern-opendata-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cern-opendata-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cern-opendata-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/cern-opendata-mcp-server/releases/latest/download/cern-opendata-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cern-opendata-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2Vybi1vcGVuZGF0YS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22cern-opendata-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcern-opendata-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://cern-opendata.caseyjhand.com/mcp](https://cern-opendata.caseyjhand.com/mcp)

</div>

---

## Overview

Particle-physics data from the CERN Open Data Portal: collision, simulated and derived datasets, analysis software, environments and documentation from ALICE, ATLAS, CMS, LHCb and other experiments. Search with exact-vocabulary filters and live facet counts, open records with license and citation, list data files, assemble a record's analysis environment, and look up CMS good-run lists and trigger paths. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `cern_opendata_search_records` | Search datasets, software, environments, documentation and supplementary records with exact-vocabulary filters and live facet counts |
| `cern_opendata_get_records` | Fetch full metadata for 1–20 records by recid, DOI, CMS dataset path or documentation slug, with license and citation |
| `cern_opendata_list_files` | Page through a record's file indexes and files: XRootD URIs, HTTPS URLs, sizes, checksums, tape availability |
| `cern_opendata_get_analysis_env` | Assemble a record's analysis environment: container images, CMSSW release, global tag, linked environment and software records, guide sections |
| `cern_opendata_get_validated_runs` | Get a CMS validated-run (good-run) list for a dataset, a list or a run period, with luminosity-section ranges |
| `cern_opendata_search_trigger_paths` | Look up CMS High-Level Trigger paths by name or prefix, parsed into run ranges, versions and L1 seeds |
| `cern_opendata_list_reference` | Decode the vocabulary the other tools accept: experiments, record types, energies, formats, physics categories, LHCb stripping, identifiers, query syntax, licensing, run periods |

### Resources

| Resource | Description |
|:---|:---|
| `cern-opendata://record/{recid}` | One record's metadata, license and citation, in the `cern_opendata_get_records` record shape |

Tool-only clients get the same data from `cern_opendata_get_records`.

## Capability reference

### `cern_opendata_search_records` <sub>tool</sub>

- Optional `query` (an OpenSearch `query_string`, up to 500 characters) plus OR-list filters `type`, `experiment`, `category` (physics category, `Higgs Physics::Standard Model`), `keywords`, `collision_energy`, `collision_type`, `file_type`, `availability`, `collection`, and the LHCb `magnet_polarity`, `stripping_stream` and `stripping_version`, each an array or a comma-separated string; `year_from`/`year_to` and `min_events`/`max_events` bound the data-taking year and event count
- `sort` (`bestmatch`, `mostrecent` for newest `date_published` first, `title`, `title_desc`), `limit` 1–50 (default 10) and `page` from 1; `page × limit` past 10,000 fails as `page_window_exceeded`
- Compact `hits` with recids, plus thirteen live `facets` that each ignore their own filter (`type` and `category` with their secondary values); `applied_filters` echoes what ran, and values outside the verified vocabulary appear under `unrecognized_values`

---

### `cern_opendata_get_records` <sub>tool</sub>

- `ids`: 1–20 recids, DOIs, CMS dataset paths (`/Primary/Era/TIER`) or documentation slugs, mixed in one array or comma-separated string
- Each record carries a `license` with its `basis` (`record`, `cern_terms_default`, `not_stated`) and, when it has a DOI, a ready `citation`
- Documentation and news bodies come in slices of up to 30,000 characters: `body_offset` with that one id reads on from the `body_next_offset` the last slice returned
- Each response stays within 64,000 bytes: records past the budget are left out whole and listed in `deferred`, to pass back as `ids` (the first record always comes back whole)
- Records also return what they state of a `variables` dictionary (name, type, unit, description), a physics `category`, pile-up (`pileup_html`, with the pile-up datasets under `links`), `keywords`, and the LHCb `magnet_polarity` and `stripping` stream and version
- Unresolved identifiers land in `missing` with `interpreted_as` and guidance instead of failing the call; file lists come from `cern_opendata_list_files`

---

### `cern_opendata_list_files` <sub>tool</sub>

- `recid` required; without `index`, returns the record's file indexes and regular files, and with an index key, that index's files, read without the rest of the record
- `limit` 1–500 (default 50), continued with `next_cursor`; each file carries `xrootd_uri`, `size_in_bytes`, `checksum` and `availability`, an `https_url` when one can be built from its key or EOS path, and `key` or `filename` as the portal states them, and each index a `uri_list_url` listing every XRootD URI in it
- Files marked `on demand` sit on tape and must be requested on the record's portal page first; an umbrella record with no files of its own returns its child recids under `children`

---

### `cern_opendata_get_analysis_env` <sub>tool</sub>

- `recid` required; `software` carries the record's own container images, CMSSW release, global tag and environment recid
- `environment_records` (condition, VM, validation) for the record's run periods and `example_software` that declares it works with the record, up to 50 between them; `guides` quotes the linked section of the first two portal guides, each capped at 12,000 characters, and a cut names the `cern_opendata_get_records` `body_offset` that reads on from it
- Always `separately_licensed: true`; linked records or guides that can't be read leave a `notice` instead of failing the call

---

### `cern_opendata_get_validated_runs` <sub>tool</sub>

- Exactly one of `recid` (a CMS collision dataset or a validated-run list) or `run_period` (`Run2012B`; `2012B` also matches); `variant` `full` or `muons_only`; `run_min`/`run_max`; `limit` 1–2000 (default 200)
- A dataset `recid` bounds the runs to the dataset's first and last listed run, echoed in `run_bounds`; when several lists match, `matched_lists` names them and no runs are read
- Each run carries `lumi_sections` and `lumi_ranges`; `list.https_url` downloads the whole list file. CMS only: other records fail as `no_validated_runs`

---

### `cern_opendata_search_trigger_paths` <sub>tool</sub>

- `path`: an exact name (`HLT_IsoMu24`, `AlCa_EcalPi0`) or a prefix with one trailing `*` (`HLT_IsoMu*`); a name without the `HLT_` prefix is matched against record path names in the case given and also searched with `HLT_` added, and a `_v<n>` version suffix is dropped; optional `year`, `limit` 1–50 (default 10) and `page`
- Each per-year record is parsed into the primary `datasets` its title names, `first_seen`, `last_seen`, per-version run ranges with their `l1_seed`, and HLT menu record links; `parsed: false` marks a record to read from its `abstract_html`
- CMS open data from 2011–2016 only

---

### `cern_opendata_list_reference` <sub>tool</sub>

- Optional `topic`: `experiments`, `record_types`, `collision_energies`, `collision_types`, `file_types`, `availability`, `categories`, `lhcb`, `identifiers`, `query_syntax`, `licensing` or `run_periods`; omit it for every table
- Static and offline; `categories`, `lhcb` and `run_periods` are dated snapshots, while the search facets and `cern_opendata_get_validated_runs` read the live portal

---

### `cern-opendata://record/{recid}` <sub>resource</sub>

- One record by `recid` (`6004`, or a prefixed recid such as `atlas-160006`; leading zeros ignored) as `application/json`, in the `cern_opendata_get_records` record shape: metadata (variable dictionary, physics category, pile-up and LHCb run conditions included), license and citation, without file lists
- `recid` comes from `cern_opendata_search_records`; reads carry a 15-minute public cache hint

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CERN Open Data-specific:

- Keyless and read-only; it never stages tape files or writes anything
- One shared pacer at 50 requests a minute, under the portal's published 60 per client IP, and one 50-second deadline per call across queue wait and retries
- Filter values canonicalized against the portal's verified vocabulary (`13 tev` → `13TeV`, `lhcb` → `LHCb`, `Pb-Pb` → `PbPb`, `dataset/collision` → `Dataset::Collision`); unknown values are sent as given and flagged
- Tape-resident (`ondemand`) records are included in every search and lookup, where the portal otherwise drops them silently
- File manifests, and file indexes read on their own, are cached for 15 minutes, so paging through a record's or an index's files costs one read

Agent-friendly output:

- Provenance on every response: `portal_url` on each hit and record, a `license` with its `basis`, a DOI `citation`, and `applied_filters` or `effectiveQuery` echoing what ran
- Graceful partial results: unresolved ids land under `missing` with guidance, and unreadable linked records or guides in `cern_opendata_get_analysis_env` surface as a `notice` rather than a failure
- Discriminated outputs: `kind`, `license.basis`, `interpreted_as`, `scope`, `variant`, `run_bounds.source` and `parsed` let callers branch on data, not string parsing
- Portal text kept as data: titles, descriptions, guide sections and file names are fenced or escaped in `content[]` and relayed as received (HTML in `_html` fields) in `structuredContent`

## Data and licensing

Portal metadata and datasets are CC0 under the [CERN Open Data Terms of Use](https://opendata.cern.ch/docs/terms-of-use). Software, container images, documentation and guide code are licensed separately, per record (software is commonly GPL). `cern_opendata_get_records` reports each record's license and its basis: `record` when the record states one, `cern_terms_default` for a dataset that states none (CC0), and `not_stated` otherwise.

CERN asks reusers to cite each dataset's DOI in applications and publications; `cern_opendata_get_records` returns a ready citation for every record with a DOI.

This server is an independent project and is not affiliated with or endorsed by CERN.

## Known limitations

- **60 requests a minute per client IP.** The portal publishes this limit; the server paces itself to 50 a minute, and a call that cannot start within its deadline fails as `rate_limited` with `retryAfter`. A hosted deployment shares one budget across every user behind its egress IP. `cern_opendata_get_analysis_env` and `cern_opendata_get_validated_runs` cost 2–4 requests each.
- **10,000-result window.** Search and trigger-path paging reach only the first 10,000 matches; narrow deeper result sets with filters.
- **Facet lists are partial.** Terms facets return the first 10 values alphabetically (`file_type` up to 100), with the rest counted in `other_count`.
- **Tape-resident files.** Files with availability `on demand` must be requested on the record's portal page before download; staging them is a write and out of scope. A record whose availability is `ondemand` lists none of its files through the API, so `cern_opendata_list_files` reports only the count and size its metadata states.
- **CMS-only run lists and triggers.** Trigger records cover 2011–2016, and no prescale tables are published, so trigger detail is limited to what each record's abstract states. Muons-only run lists do not exist for Commissioning2010, Run2010B or the 2011 ReReco list.
- **Glossary entries are not served.** The portal's glossary links answer 404, so search excludes them.

## Getting started

### Public Hosted Instance

A public instance is available at `https://cern-opendata.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "cern-opendata-mcp-server": {
      "type": "streamable-http",
      "url": "https://cern-opendata.caseyjhand.com/mcp"
    }
  }
}
```

Every caller of the hosted instance shares one portal request budget of 50 requests a minute. For sustained use, run your own instance.

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "cern-opendata-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/cern-opendata-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "cern-opendata-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/cern-opendata-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "cern-opendata-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/cern-opendata-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account: the CERN Open Data Portal is public.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/cern-opendata-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd cern-opendata-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optional: adjust transport, logging, or telemetry settings
```

## Configuration

The server has no settings of its own; these framework variables apply.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP server host. | `127.0.0.1` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the common framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools and resource, sets the server instructions, starts the portal client. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), shared input helpers and list enrichment. |
| `src/mcp-server/resources` | The `cern-opendata://record/{recid}` resource definition. |
| `src/mcp-server/record-schema.ts` | Record output schema shared by `cern_opendata_get_records` and the resource. |
| `src/services/cern-opendata` | Portal client (pacing, retries, deadline, caches), normalization, vocabulary tables, text rendering, trigger parsing. |
| `tests/` | Unit and tool tests, mirroring the `src/` structure, run against fixture portal responses. |
| `docs/design.md` | Tool surface, verified portal behavior, and design decisions. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging and `ctx.enrich` for notices and paging context
- Register new tools and resources in the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
