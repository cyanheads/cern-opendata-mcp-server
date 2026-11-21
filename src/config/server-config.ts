/** @fileoverview CERN Open Data server configuration resolved after framework dotenv loading. */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const serverConfigSchema = z.object({ clampLimits: z.stringbool().default(true) });
let serverConfig: z.infer<typeof serverConfigSchema> | undefined;

/** Parse and retain the server-specific environment settings for the lifetime of the process. */
export function getServerConfig(): z.infer<typeof serverConfigSchema> {
  serverConfig ??= parseEnvConfig(serverConfigSchema, {
    clampLimits: 'CERN_OPENDATA_CLAMP_LIMITS',
  });
  return serverConfig;
}
