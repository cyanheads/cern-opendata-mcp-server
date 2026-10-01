/**
 * @fileoverview Every tool definition the server registers.
 * @module mcp-server/tools/definitions/index
 */

import { getAnalysisEnv } from './get-analysis-env.tool.js';
import { getRecords } from './get-records.tool.js';
import { getValidatedRuns } from './get-validated-runs.tool.js';
import { listFiles } from './list-files.tool.js';
import { listReference } from './list-reference.tool.js';
import { searchRecords } from './search-records.tool.js';
import { searchTriggerPaths } from './search-trigger-paths.tool.js';

export const allToolDefinitions = [
  searchRecords,
  getRecords,
  listFiles,
  getAnalysisEnv,
  getValidatedRuns,
  searchTriggerPaths,
  listReference,
];
