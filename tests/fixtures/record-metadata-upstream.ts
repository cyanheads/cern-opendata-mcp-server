/**
 * @fileoverview Search hits captured from opendata.cern.ch on 2026-10-01 with
 * the lookup's own parameters (`skip_files=1&ondemand=true&sort=bestmatch`),
 * kept as the portal sent them except where noted: variable dictionaries
 * (`dataset_semantics`), physics categories, pile-up, keywords and the LHCb
 * magnet polarity and stripping fields. Trimmed: `methodology` of 67817 (45 KB)
 * and 30595 (22 KB); 12102's 178 variables to its first 3 and the 12 whose
 * description carries `<a href>`; the stripping page's body to its first 1,000
 * characters. 12320 keeps all 622 variables.
 * @module tests/fixtures/record-metadata-upstream
 */

import type { RawHit } from '@/services/cern-opendata/types.js';
import captured from './record-metadata-hits.json' with { type: 'json' };

const hits: readonly RawHit[] = captured;
const byId = new Map(hits.map((hit) => [String(hit.id), hit]));

function hitOf(id: string): RawHit {
  const hit = byId.get(id);
  if (!hit) throw new Error(`No captured hit ${id}.`);
  return hit;
}

/** CMS derived ML sample: 87 variables with type, keyword `datascience`. */
export const variablesHit12220 = hitOf('12220');
/** TOTEM: 21 variables, every one with a unit. */
export const unitsHit84000 = hitOf('84000');
/** CMS tracker-hit ML sample: 622 variables, about 68 KB of record JSON. */
export const largeVariablesHit12320 = hitOf('12320');
/** OPERA event: variables with only `variable` and `description`. */
export const typelessVariablesHit4803 = hitOf('4803');
/** ATLAS: one description with `&lt;` entities. */
export const entityVariablesHit15009 = hitOf('15009');
/** CMS: descriptions with `<a href>` (trimmed, see the file header). */
export const anchorVariablesHit12102 = hitOf('12102');
/** CMS simulated: category with a secondary and a source, pile-up with one link. */
export const pileupHit67817 = hitOf('67817');
/** CMS pile-up sample: category with no secondary, pile-up with no links. */
export const pileupNoLinksHit30595 = hitOf('30595');
/** DELPHI: category with only a primary. */
export const categoryOnlyPrimaryHit88449 = hitOf('88449');
/** LHCb collision dataset: magnet polarity and stripping. */
export const lhcbHit28004 = hitOf('28004');
/** LHCb `Documentation::Stripping` page: stripping stream and version (body trimmed). */
export const strippingDocHit = hitOf('stripping21-bhadron-b02dhhwsd2hhhhwsbeauty2charmline');
