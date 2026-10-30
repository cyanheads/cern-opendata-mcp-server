/**
 * @fileoverview Guard package-root agent docs without stripping nested SDK runtime modules.
 * @module tests/scripts/packaging.test
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleanEntry } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as lintEntry } from '../../scripts/lint-packaging.js';

describe('dependency agent documentation selectors', () => {
  it.each([
    'node_modules/plain/skills/workflow/SKILL.md',
    'node_modules/@scope/pkg/skills/workflow/SKILL.md',
    'node_modules/outer/node_modules/@scope/pkg/framework-skills/dev/SKILL.md',
    'node_modules/plain/.claude/settings.json',
    'node_modules/plain/SKILL.md',
  ])('removes package-root documentation: %s', (entry) => {
    expect(cleanEntry.test(entry)).toBe(true);
    expect(lintEntry.test(entry)).toBe(true);
  });
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.js',
    'node_modules/outer/node_modules/@scope/sdk/dist/ext/skills/index.js',
    'node_modules/plain/dist/skills/loader.js',
  ])('preserves nested runtime modules: %s', (entry) => {
    expect(cleanEntry.test(entry)).toBe(false);
    expect(lintEntry.test(entry)).toBe(false);
  });
});
