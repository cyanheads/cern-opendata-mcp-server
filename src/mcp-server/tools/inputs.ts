/**
 * @fileoverview Shared input schema helpers for the cern_opendata_* tools:
 * blank-as-unset optionals, comma-or-array lists with vocabulary
 * canonicalization, and the recid field. Normalization runs in a preprocess,
 * before any pattern check, so what the schema validates is what the handler
 * receives.
 * @module mcp-server/tools/inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { reduceRecidSpelling } from '@/services/cern-opendata/identifiers.js';
import {
  canonicalize,
  isGlossaryType,
  isKnownValue,
  type VocabularyParam,
} from '@/services/cern-opendata/vocabulary.js';

/**
 * Map `''` and whitespace-only strings to `undefined` before `schema` runs, so
 * a form client's blank optional field reads as unset. Wrap every optional
 * input with it (strings, numbers, enums, lists); never use `.min(1)` there.
 */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

interface ListOptions {
  /** Canonicalize each trimmed item (vocabulary lookup); identity when omitted. */
  canonicalize?: (item: string) => string;
  /** A string the list treats as one value instead of splitting it on commas. */
  isWholeValue?: (raw: string) => boolean;
}

/** The element schema's `.max()` length; every list element declares one. */
function lengthCap(element: z.ZodString): number {
  if (element.maxLength === null)
    throw new Error('A list element schema needs a .max() length cap.');
  return element.maxLength;
}

/**
 * Accept an array of strings or one comma-separated string; split, trim, drop
 * empties, canonicalize, dedupe, and cut at `max + 1` items so an oversized
 * list fails with one `too_big` issue. An item longer than `itemMax` is kept
 * trimmed but never canonicalized, so the element schema rejects it before any
 * normalization reads it. In a split string, two adjacent pieces that form one
 * whole value, neither being one alone, are rejoined, so
 * `Exotica::Heavy Fermions, Heavy Righ-Handed Neutrinos, Supersymmetry` keeps
 * its comma value while `13TeV, 13.6TeV, 8TeV` stays three values. An empty
 * result becomes `undefined`.
 */
function splitList(value: unknown, max: number, itemMax: number, options: ListOptions): unknown {
  const { isWholeValue } = options;
  let items: unknown[];
  let rejoin: typeof isWholeValue;
  if (typeof value === 'string') {
    if (isWholeValue?.(value)) {
      items = [value];
    } else {
      items = value.split(',');
      rejoin = isWholeValue;
    }
  } else if (Array.isArray(value)) {
    items = value;
  } else {
    return value;
  }
  const out: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    if (out.length > max) break;
    const raw = items[i];
    if (typeof raw !== 'string') {
      out.push(raw);
      continue;
    }
    let item = raw;
    const next = items[i + 1];
    if (
      rejoin &&
      typeof next === 'string' &&
      item.trim() !== '' &&
      next.trim() !== '' &&
      rejoin(`${item},${next}`) &&
      !rejoin(item) &&
      !rejoin(next)
    ) {
      item = `${item},${next}`;
      i++;
    }
    const trimmed = item.trim();
    if (trimmed === '') continue;
    const kept =
      options.canonicalize && trimmed.length <= itemMax ? options.canonicalize(trimmed) : trimmed;
    if (!out.includes(kept)) out.push(kept);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * An optional list input: an array of strings or one comma-separated string,
 * at most `max` items after splitting, trimming, canonicalizing and deduping.
 * Blank input (`''`, `[]`, `' , '`) reads as unset. Add `.describe()` naming
 * both forms and the cap.
 */
export function listInput(max: number, element: z.ZodString, options: ListOptions = {}) {
  const itemMax = lengthCap(element);
  return z.preprocess(
    (value) => splitList(value, max, itemMax, options),
    z.array(element).max(max).optional(),
  );
}

/**
 * A required list input with the same forms as {@link listInput}; at least one
 * item must remain after blanks are dropped. A blank list (`''`, `[]`,
 * `' , '`) reaches the array schema as `[]`, so it fails with `emptyMessage`
 * rather than as a missing value.
 */
export function requiredListInput(
  max: number,
  element: z.ZodString,
  emptyMessage = 'At least one value is required.',
) {
  const itemMax = lengthCap(element);
  return z.preprocess(
    (value) =>
      typeof value === 'string' || Array.isArray(value)
        ? (splitList(value, max, itemMax, {}) ?? [])
        : value,
    z.array(element).min(1, emptyMessage).max(max),
  );
}

/** Parameters with a known value that holds a comma: `13TeV, 13.6TeV`, `Exotica::Heavy Fermions, Heavy Righ-Handed Neutrinos`. */
const COMMA_VALUE_PARAMS: ReadonlySet<VocabularyParam> = new Set(['collision_energy', 'category']);

/**
 * An optional search-filter list for a vocabulary parameter: items ≤ 100
 * characters, canonicalized against the verified table (unknown values pass
 * through trimmed). The string form of `collision_energy` and `category` is
 * first matched whole (`13TeV, 13.6TeV` is one upstream value) and split on
 * commas only when it is not one. `type` rejects Glossary in any form. Add
 * `.describe()` at the call site.
 */
export function vocabularyListInput(param: VocabularyParam, max: number) {
  const element = z.string().max(100).describe(`One ${param} value.`);
  const options: ListOptions = {
    canonicalize: (item) => canonicalize(param, item),
    ...(COMMA_VALUE_PARAMS.has(param)
      ? { isWholeValue: (raw: string) => isKnownValue(param, canonicalize(param, raw)) }
      : {}),
  };
  const list = z.array(element).max(max);
  const checked =
    param === 'type'
      ? list.refine((items) => !items.some(isGlossaryType), {
          message: 'Glossary entries are not served by this server.',
        })
      : list;
  const itemMax = lengthCap(element);
  return z.preprocess((value) => splitList(value, max, itemMax, options), checked.optional());
}

/**
 * A required recid: trims, strips a leading `recid:` (any case), reduces
 * `http(s)://opendata.cern.ch/record/{recid}` or `/api/records/{recid}` (any
 * trailing path, query or fragment) to the recid, lowercases an experiment
 * prefix and strips leading zeros from the number, then requires 1-12 digits,
 * optionally after a prefix of 1-16 letters and `-` (`6004`, `atlas-160006`),
 * so an all-zero number is rejected. Shared by the tools and the record
 * resource. For an optional recid use `blankAsUnset(recidInput().optional())`.
 */
export function recidInput() {
  return z.preprocess(
    (value) => (typeof value === 'string' ? reduceRecidSpelling(value) : value),
    z
      .string()
      .regex(
        /^(?:[a-z]{1,16}-)?\d{1,12}$/,
        'A recid is 1-12 digits (6004), optionally after an experiment prefix (atlas-160006).',
      ),
  );
}

/** Which parsed values of a canonicalized filter are not in the verified table. */
export function unrecognizedValues(
  param: VocabularyParam,
  values: readonly string[] | undefined,
): { param: VocabularyParam; value: string }[] {
  return (values ?? [])
    .filter((value) => !isKnownValue(param, value))
    .map((value) => ({ param, value }));
}
