/**
 * @fileoverview Record identifier forms: recid spelling reduction and the
 * first-match-wins classification `cern_opendata_get_records` applies to each
 * id. Every classified value is regex-validated, so no `"` or `\` ever reaches
 * a search query built from it.
 * @module services/cern-opendata/identifiers
 */

/** The identifier forms a lookup can resolve. */
export type IdentifierKind = 'recid' | 'doi' | 'cms_dataset_path' | 'doc_slug';

/** One input id after classification. `value` is the normalized form that is queried. */
export interface ClassifiedId {
  /** The id exactly as the caller gave it. */
  input: string;
  kind: IdentifierKind | 'unrecognized';
  /** Normalized value; for `unrecognized`, the trimmed input. */
  value: string;
}

/**
 * A reduced recid for `get_records` classification: digits, optionally after
 * an experiment prefix of 1-16 letters (`atlas-160006`). The digit count is
 * not capped here, since an id reaches only the search `q` (Decision 40).
 */
const RECID_PATTERN = /^(?:[a-z]{1,16}-)?\d+$/;
const DOI_PATTERN = /^10\.\d{4,9}\/[^\s"\\]+$/;
const CMS_DATASET_PATH_PATTERN = /^\/[^/\s"\\]+\/[^/\s"\\]+\/[^/\s"\\]+$/;
const DOC_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const RECID_PREFIX = /^recid:\s*/i;
const RECORD_URL =
  /^https?:\/\/opendata\.cern\.ch\/(?:record|api\/records)\/((?:[a-z]+-)?\d+)(?:[/?#].*)?$/i;
/** A recid spelling to normalize: an optional letter prefix and `-`, then digits. */
const RECID_SPELLING = /^(?:([a-z]+)-)?(\d+)$/i;
const DOI_PREFIX = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i;
const DOC_URL = /^https?:\/\/opendata\.cern\.ch\/docs\/([^/?#]+)\/?(?:[?#].*)?$/i;

/**
 * Reduce a recid spelling: trim, strip a leading `recid:` (any case), reduce a
 * portal record URL (`/record/{recid}` or `/api/records/{recid}`, any trailing
 * path, query or fragment, either scheme) to its recid, then lowercase an
 * experiment prefix and strip leading zeros from the number (`ATLAS-0160006` →
 * `atlas-160006`, `06004` → `6004`), the only form search matches. An all-zero
 * number reduces to `''` or `atlas-`, which no recid pattern accepts. The
 * result is not validated.
 */
export function reduceRecidSpelling(raw: string): string {
  const trimmed = raw.trim().replace(RECID_PREFIX, '');
  const reduced = RECORD_URL.exec(trimmed)?.[1] ?? trimmed;
  const parts = RECID_SPELLING.exec(reduced);
  if (!parts) return reduced;
  const [, prefix, digits = ''] = parts;
  const number = digits.replace(/^0+/, '');
  return prefix ? `${prefix.toLowerCase()}-${number}` : number;
}

/** Classify one id: recid, then DOI, then CMS dataset path, then doc slug. */
export function classifyIdentifier(input: string): ClassifiedId {
  const trimmed = input.trim();

  const recid = reduceRecidSpelling(trimmed);
  if (RECID_PATTERN.test(recid)) return { input, kind: 'recid', value: recid };

  const doi = trimmed.replace(DOI_PREFIX, '');
  if (DOI_PATTERN.test(doi)) return { input, kind: 'doi', value: doi };

  if (CMS_DATASET_PATH_PATTERN.test(trimmed)) {
    return { input, kind: 'cms_dataset_path', value: trimmed };
  }

  const slug = (DOC_URL.exec(trimmed)?.[1] ?? trimmed).toLowerCase();
  if (DOC_SLUG_PATTERN.test(slug)) return { input, kind: 'doc_slug', value: slug };

  return { input, kind: 'unrecognized', value: trimmed };
}
