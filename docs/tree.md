# cern-opendata-mcp-server - Directory Structure

Generated on: 2026-10-01 10:44:29

```text
cern-opendata-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       └── record.resource.ts
│   │   ├── tools/
│   │   │   ├── definitions/
│   │   │   │   ├── get-analysis-env.tool.ts
│   │   │   │   ├── get-records.tool.ts
│   │   │   │   ├── get-validated-runs.tool.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── list-files.tool.ts
│   │   │   │   ├── list-reference.tool.ts
│   │   │   │   ├── search-records.tool.ts
│   │   │   │   └── search-trigger-paths.tool.ts
│   │   │   ├── enrichment.ts
│   │   │   └── inputs.ts
│   │   └── record-schema.ts
│   ├── services/
│   │   └── cern-opendata/
│   │       ├── cern-opendata-service.ts
│   │       ├── identifiers.ts
│   │       ├── normalize.ts
│   │       ├── text.ts
│   │       ├── trigger-parse.ts
│   │       ├── types.ts
│   │       └── vocabulary.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── cern-opendata-harness.ts
│   │   └── cern-opendata-upstream.ts
│   ├── fuzz/
│   ├── integration/
│   ├── resources/
│   │   └── record.resource.test.ts
│   ├── services/
│   │   └── cern-opendata/
│   │       ├── identifiers.test.ts
│   │       ├── normalize.test.ts
│   │       ├── service-accessor.test.ts
│   │       ├── service-boundary.test.ts
│   │       ├── service-methods.test.ts
│   │       ├── text.test.ts
│   │       ├── trigger-parse.test.ts
│   │       └── vocabulary.test.ts
│   ├── shared/
│   │   └── inputs.test.ts
│   ├── smoke/
│   │   └── definitions.smoke.test.ts
│   └── tools/
│       ├── get-analysis-env.tool.test.ts
│       ├── get-records.tool.test.ts
│       ├── get-validated-runs.tool.test.ts
│       ├── list-files.tool.test.ts
│       ├── list-reference.tool.test.ts
│       ├── search-records.tool.test.ts
│       ├── search-trigger-paths.tool.test.ts
│       └── upstream-failures.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
