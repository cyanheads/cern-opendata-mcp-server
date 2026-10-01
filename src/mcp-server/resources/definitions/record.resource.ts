/**
 * @fileoverview cern-opendata://record/{recid} — one record's metadata, license
 * and citation, in the Record shape `cern_opendata_get_records` returns per
 * entry (which covers the same data for tool-only clients).
 * @module mcp-server/resources/definitions/record.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { RecordSchema } from '@/mcp-server/record-schema.js';
import { getCernOpenDataService } from '@/services/cern-opendata/cern-opendata-service.js';
import { reduceRecidSpelling } from '@/services/cern-opendata/identifiers.js';
import { toRecord } from '@/services/cern-opendata/normalize.js';

export const recordResource = resource('cern-opendata://record/{recid}', {
  name: 'cern-opendata-record',
  title: 'CERN Open Data record',
  description:
    "One CERN Open Data Portal record's metadata by recid: description, run periods, collision and distribution details, related records, software-environment summary, license and citation. File lists are not included. Tool coverage: cern_opendata_get_records.",
  mimeType: 'application/json',
  params: z.object({
    recid: z
      .string()
      .regex(/^0*[1-9]\d*$/, 'A recid is digits, such as 6004.')
      .describe(
        'Record id: digits, such as 6004; leading zeros are ignored. cern_opendata_search_records and cern_opendata_get_records return it.',
      ),
  }),
  output: RecordSchema,
  cacheHint: { ttlMs: 900_000, cacheScope: 'public' },
  errors: [
    {
      reason: 'record_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No record has this recid.',
      recovery:
        "Call cern_opendata_search_records to find the record's recid, then read this resource or call cern_opendata_get_records with it.",
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "The portal's 60-a-minute budget is spent: it answered 429, or the request could not start within the call's deadline. data.retryAfter is set.",
      recovery:
        'Wait the retryAfter seconds given in this error (the portal allows 60 requests a minute per IP), then read cern-opendata://record/{recid} again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The portal answered with a body the server could not read: not JSON, missing the expected envelope, or over the byte ceiling (then data.retryable is false). Also raised when a search answers 404.',
      recovery:
        'Read cern-opendata://record/{recid} again in a minute; if it repeats, the portal is serving an error page or an oversized response, so read the same data on https://opendata.cern.ch instead.',
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    const recid = reduceRecidSpelling(params.recid);
    const service = getCernOpenDataService();
    const { matches } = await service.lookup(
      [{ input: params.recid, kind: 'recid', value: recid }],
      service.startBudget(),
      ctx,
    );
    const match = matches[0];
    if (!match) {
      throw ctx.fail('record_not_found', `No record has recid ${recid}.`, { recid });
    }
    return toRecord(match.hit, [recid]);
  },
});
