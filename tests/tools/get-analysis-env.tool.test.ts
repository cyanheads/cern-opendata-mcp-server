/**
 * @fileoverview Tests for cern_opendata_get_analysis_env: recid handling, the
 * three upstream legs and the requests they send, the assembled environment
 * (software, environment records, example software, guides, other links), guide
 * section extraction and caps, degrade-with-notice on the linked-records and
 * guide legs, the licence kept separate from the CC0 data claim, errors on the
 * wire, upstream failure classes, and the text twin of structuredContent.
 * Upstream I/O is a strict fetch fake.
 * @module tests/tools/get-analysis-env.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAnalysisEnv } from '@/mcp-server/tools/definitions/get-analysis-env.tool.js';
import { getRecords } from '@/mcp-server/tools/definitions/get-records.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { absoluteUrl } from '@/services/cern-opendata/text.js';
import type { RawHit } from '@/services/cern-opendata/types.js';
import {
  type ContractResult,
  dataOf,
  disposeInstalledService,
  errorOf,
  installService,
  requestedUrls,
  settle,
  textOf,
} from '../fixtures/cern-opendata-harness.js';
import {
  docBody,
  environmentSystemHit,
  HTML_ERROR_PAGE,
  hit,
  jsonResponse,
  NOT_FOUND_BODY,
  portalRoute,
  prefixedCmsHit,
  richDatasetHit,
  SYNTAX_ERROR_BODY,
  searchBody,
  softwareHit,
} from '../fixtures/cern-opendata-upstream.js';
import { cpuTimedAsync } from '../fixtures/cpu-time.js';

type Output = Awaited<ReturnType<typeof getAnalysisEnv.handler>>;
type Result = Output & { notice?: string };

const LICENSE_NOTE =
  'Container images, software and guide code are licensed separately from the CC0 data; each software record states its own license.';

const GUIDE_MD = [
  '# Docker guide',
  '',
  'Opening text.',
  '',
  '## <a name="intro">Introduction</a>',
  '',
  'Intro text.',
  '',
  '### Sub',
  '',
  'Sub text.',
  '',
  '## <a name="install">Install</a>',
  '',
  '```bash',
  '# not a heading',
  '## nor this',
  '```',
  '',
  'Install text.',
  '',
  '## <a name="last">Last</a>',
  '',
  'Last text.',
].join('\n');

interface Upstream {
  docs?: Record<string, unknown>;
  /** Leg 2 body or responder. */
  linked?: unknown | (() => Response);
  /** Leg 1 hits answered to `q=recid:N`, by recid. */
  records?: Record<string, RawHit>;
}

const linkedHits = (...hits: RawHit[]) => searchBody(hits, { total: hits.length });

function routes({ records = { '9001': richDatasetHit }, linked, docs = {} }: Upstream = {}) {
  return [
    portalRoute(
      '/api/records/',
      (request) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        const found = records[/^recid:(\S+)$/.exec(q)?.[1] ?? ''];
        return jsonResponse(searchBody(found ? [found] : []));
      },
      { query: (p) => p.get('q')?.startsWith('recid:') === true },
    ),
    portalRoute(
      '/api/records/',
      typeof linked === 'function'
        ? (linked as () => Response)
        : () => jsonResponse(linked ?? linkedHits()),
      { query: (p) => p.get('q')?.includes('use_with.links.recid') === true },
    ),
    portalRoute(/^\/api\/docs\/[^/]+$/, (request) => {
      const slug = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
      return slug in docs
        ? jsonResponse(docs[slug])
        : jsonResponse(NOT_FOUND_BODY, { status: 404 });
    }),
  ];
}

const serve = (upstream: Upstream = {}, options?: Parameters<typeof installService>[1]) =>
  installService(routes(upstream), options);

const run = (input: Parameters<typeof runToolContract<typeof getAnalysisEnv>>[1]) =>
  runToolContract(getAnalysisEnv, input);

const success = (result: ContractResult) => dataOf<Result>(result);

const paths = (http: ReturnType<typeof installService>['http']) =>
  http.calls.map((call) => new URL(call.request.url).pathname);

const DOCS = { 'cms-guide-docker': docBody('cms-guide-docker', GUIDE_MD, 'Docker guide') };

/** A record carrying `usage.links` and nothing else of note. */
const withLinks = (recid: string, links: { description?: string; url?: string }[], extra = {}) =>
  hit(recid, {
    recid,
    title: `Record ${recid}`,
    type: { primary: 'Dataset', secondary: ['Collision'] },
    experiment: ['CMS'],
    usage: { links },
    ...extra,
  });

afterEach(() => {
  disposeInstalledService();
});

describe('cern_opendata_get_analysis_env registration', () => {
  it('is registered, read-only, idempotent and open-world', () => {
    expect(allToolDefinitions).toContain(getAnalysisEnv);
    expect(getAnalysisEnv.name).toBe('cern_opendata_get_analysis_env');
    expect(getAnalysisEnv.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('declares record_not_found, rate_limited and upstream_unreadable with the right codes', () => {
    const byReason = Object.fromEntries(
      (getAnalysisEnv.errors ?? []).map((entry) => [entry.reason, entry]),
    );
    expect(Object.keys(byReason).sort()).toEqual([
      'rate_limited',
      'record_not_found',
      'upstream_unreadable',
    ]);
    expect(byReason.record_not_found).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      severity: 'notice',
    });
    expect(byReason.rate_limited).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
    });
    expect(byReason.upstream_unreadable).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
    });
    for (const entry of getAnalysisEnv.errors ?? []) {
      expect(entry.recovery, entry.reason).toContain('cern_opendata_get_analysis_env');
    }
  });

  it('declares only the optional notice as enrichment: no required list fields', () => {
    expect(Object.keys(getAnalysisEnv.enrichment ?? {})).toEqual(['notice']);
  });

  it('says in its description that the software is licensed apart from the CC0 data', () => {
    expect(getAnalysisEnv.description).toContain('licensed separately from the CC0 data');
  });

  it('describes every notice it writes, the anchor fallback included', () => {
    expect(getAnalysisEnv.enrichment?.notice?.description).toBe(
      'What could not be assembled and how to get it: an empty environment, linked records that could not be read, guides not fetched, not found or cut, a guide anchor no heading carries, or more linked records than shown.',
    );
  });

  it('describes a quoted section with the LF line ends it is joined with', () => {
    const guides = z.toJSONSchema(getAnalysisEnv.output, { unrepresentable: 'any' }).properties
      ?.guides;
    const guide = typeof guides === 'object' ? guides.items : undefined;
    const section =
      guide && typeof guide === 'object' && !Array.isArray(guide)
        ? guide.properties?.section
        : undefined;
    expect(typeof section === 'object' ? section.description : undefined).toBe(
      'The linked section (or the opening section) as markdown, as the portal sent it but with LF line ends; at most 12,000 characters.',
    );
  });
});

describe('cern_opendata_get_analysis_env input', () => {
  it.each([
    ['9001'],
    [' 9001 '],
    ['recid:9001'],
    ['RECID: 9001'],
    ['https://opendata.cern.ch/record/9001'],
    ['http://opendata.cern.ch/api/records/9001?ln=en'],
    ['09001'],
  ])('reads the recid spelling %j as 9001', async (recid) => {
    const { http } = serve({ docs: DOCS });
    expect(success(await run({ recid })).recid).toBe('9001');
    expect(requestedUrls(http)[0]?.searchParams.get('q')).toBe('recid:9001');
  });

  it.each([['cms-93956'], ['CMS-93956'], ['https://opendata.cern.ch/record/cms-093956']])(
    'looks the prefixed spelling %j up as cms-93956 in both searches',
    async (recid) => {
      const { http } = serve({ records: { 'cms-93956': prefixedCmsHit } });
      const result = await run({ recid });
      expect(success(result)).toMatchObject({
        recid: 'cms-93956',
        title: '/EphemeralHLTPhysics1/Run2024F-v1/RAW',
      });
      const [record, linked] = requestedUrls(http);
      expect(record?.searchParams.get('q')).toBe('recid:cms-93956');
      expect(linked?.searchParams.get('q')).toBe('use_with.links.recid:cms-93956');
      expect(textOf(result)).toContain('## Analysis environment for record cms-93956');
    },
  );

  it.each([
    [''],
    ['   '],
    ['abc'],
    ['-1'],
    ['12.5'],
    ['0'],
    ['https://evil.example/record/9001'],
    ['1234567890123'],
    ['cms-'],
    ['cms-93956x'],
    ['cms_93956'],
  ])('rejects the recid %j as invalid arguments before any request', async (recid) => {
    const { http } = serve();
    const result = await run({ recid });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(errorOf(result).data).toMatchObject({ reason: 'invalid_arguments' });
    expect(http.calls).toHaveLength(0);
  });

  it('requires a recid: a missing key is invalid arguments', async () => {
    const { http } = serve();
    expect(errorOf(await run({} as never)).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
  });
});

describe('cern_opendata_get_analysis_env requests', () => {
  it('sends the record search, the linked-records search and one doc GET', async () => {
    const { http } = serve({ docs: DOCS });
    await run({ recid: '9001' });
    expect(http.calls).toHaveLength(3);
    const [record, linked, doc] = requestedUrls(http);
    expect(record?.pathname).toBe('/api/records/');
    expect(record?.searchParams.get('q')).toBe('recid:9001');
    expect(record?.searchParams.get('size')).toBe('1');
    expect(record?.searchParams.get('skip_files')).toBe('1');
    expect(record?.searchParams.get('ondemand')).toBe('true');
    expect(linked?.pathname).toBe('/api/records/');
    expect(linked?.searchParams.get('q')).toBe(
      'use_with.links.recid:9001 OR (type.primary:Environment AND run_period:("Run2011A" OR "Run2012B"))',
    );
    expect(linked?.searchParams.get('size')).toBe('50');
    expect(linked?.searchParams.get('skip_files')).toBe('1');
    expect(linked?.searchParams.get('ondemand')).toBe('true');
    expect(doc?.pathname).toBe('/api/docs/cms-guide-docker');
  });

  it('filters the linked search by the first experiment only', async () => {
    const { http } = serve({ docs: DOCS });
    await run({ recid: '9001' });
    expect(requestedUrls(http)[1]?.searchParams.getAll('experiment')).toEqual(['CMS']);
  });

  it('sends no experiment filter when the record states none', async () => {
    const record = hit('9100', { recid: '9100', run_period: ['Run2012B'] });
    const { http } = serve({ records: { '9100': record } });
    await run({ recid: '9100' });
    expect(requestedUrls(http)[1]?.searchParams.has('experiment')).toBe(false);
  });

  it('asks only for software that declares the record when no run period is usable', async () => {
    const record = hit('9101', {
      recid: '9101',
      experiment: ['CMS'],
      run_period: ['Run 2012', 'Run2012B") OR (x', 'a"b'],
    });
    const { http } = serve({ records: { '9101': record } });
    await run({ recid: '9101' });
    expect(requestedUrls(http)[1]?.searchParams.get('q')).toBe('use_with.links.recid:9101');
  });

  it('keeps only the usable run periods in the clause, so record data cannot break the query', async () => {
    const record = hit('9102', {
      recid: '9102',
      experiment: ['CMS'],
      run_period: [
        'Run2012B',
        'evil") OR type.primary:Dataset OR ("x',
        'HIRun2010',
        'Run2013A.v1-x_y',
      ],
    });
    const { http } = serve({ records: { '9102': record } });
    await run({ recid: '9102' });
    expect(requestedUrls(http)[1]?.searchParams.get('q')).toBe(
      'use_with.links.recid:9102 OR (type.primary:Environment AND run_period:("Run2012B" OR "HIRun2010" OR "Run2013A.v1-x_y"))',
    );
  });

  it('sends no doc requests when the record links no guide', async () => {
    const { http } = serve({ records: { '9103': withLinks('9103', []) } });
    await run({ recid: '9103' });
    expect(http.calls).toHaveLength(2);
  });
});

describe('cern_opendata_get_analysis_env result', () => {
  it('assembles the software environment of the record, the type and the license note', async () => {
    serve({ docs: DOCS });
    const result = success(await run({ recid: '9001' }));
    expect(result).toMatchObject({
      recid: '9001',
      title: 'Rich dataset /A/B/C',
      type: { primary: 'Dataset', secondary: ['Collision', 'Derived'] },
      experiment: ['CMS', 'ATLAS'],
      run_period: ['Run2011A', 'Run2012B'],
      software: {
        release: 'CMSSW_10_6_30',
        global_tag: '106X_dataRun2_v37',
        container_images: [{ name: 'cmsopendata/cmssw_10_6_30', registry: 'dockerhub' }],
        environment_recid: '9003',
        description: '<p>Environment <i>notes</i>.</p>',
      },
      separately_licensed: true,
      license_note: LICENSE_NOTE,
    });
  });

  it('keeps the licence apart from the CC0 data claim: no license, citation or CC0 stamp in the output', async () => {
    const stated = hit('9104', {
      recid: '9104',
      title: 'CC0-stating dataset',
      type: { primary: 'Dataset', secondary: ['Collision'] },
      license: { attribution: 'CC0-1.0' },
      system_details: { release: 'CMSSW_5_3_32' },
    });
    serve({ records: { '9104': stated } });
    const result = await run({ recid: '9104' });
    const data = success(result);
    expect(data.separately_licensed).toBe(true);
    expect(data.license_note).toBe(LICENSE_NOTE);
    expect(data).not.toHaveProperty('license');
    expect(data).not.toHaveProperty('citation');
    expect(JSON.stringify(data)).not.toContain('CC0-1.0');
    expect(textOf(result)).toContain(`**Separately licensed:** yes. ${LICENSE_NOTE}`);
  });

  it('relays each software record license and leaves an unstated one absent, never inherited', async () => {
    const unlicensed = hit('102', {
      recid: '102',
      title: 'Unlicensed example',
      type: { primary: 'Software', secondary: ['Tool'] },
      experiment: ['CMS'],
    });
    serve({ docs: DOCS, linked: linkedHits(softwareHit, unlicensed) });
    const { example_software: sw } = success(await run({ recid: '9001' }));
    expect(sw[0]).toMatchObject({ recid: '101', license_id: 'GPL-3.0-only' });
    expect(sw[1]).toEqual({
      recid: '102',
      title: 'Unlicensed example',
      secondary: ['Tool'],
      portal_url: 'https://opendata.cern.ch/record/102',
    });
    expect(sw[1]).not.toHaveProperty('license_id');
  });

  it('omits what the record states nothing about: software is empty with no container images listed', async () => {
    const bare = hit('9105', { recid: '9105', type: { primary: 'Dataset' } });
    serve({ records: { '9105': bare } });
    const result = success(await run({ recid: '9105' }));
    expect(result.software).toEqual({ container_images: [] });
    expect(result.type).toEqual({ primary: 'Dataset', secondary: [] });
    expect(result).not.toHaveProperty('title');
    expect(result).not.toHaveProperty('experiment');
    expect(result).not.toHaveProperty('run_period');
    expect(result.environment_records).toEqual([]);
    expect(result.example_software).toEqual([]);
    expect(result.guides).toEqual([]);
    expect(result.other_links).toEqual([]);
  });

  it('keeps container images that state no registry and drops those with no name', async () => {
    serve({ records: { '12100': environmentSystemHit } });
    const { software } = success(await run({ recid: '12100' }));
    expect(software.container_images).toEqual([
      { name: 'cmsopendata/cmssw_5_3_32', registry: 'dockerhub' },
      { name: 'cmsopendata/other' },
    ]);
    expect(software.environment_recid).toBe('12101');
  });

  it('sorts linked records into environment records by secondary type and example software, dropping other types', async () => {
    const env = (recid: string, secondary: string[] | undefined, runPeriod?: string[]) =>
      hit(recid, {
        recid,
        title: `Env ${recid}`,
        type: { primary: 'Environment', ...(secondary ? { secondary } : {}) },
        ...(runPeriod ? { run_period: runPeriod } : {}),
      });
    serve({
      docs: DOCS,
      linked: linkedHits(
        env('1', ['Condition'], ['Run2012B']),
        env('2', ['VM']),
        env('3', ['Validation']),
        env('4', ['Other thing']),
        env('5', undefined),
        softwareHit,
        hit('6', { recid: '6', type: { primary: 'Dataset', secondary: ['Collision'] } }),
        hit('7', { recid: '7', type: { primary: 'Documentation' } }),
      ),
    });
    const result = success(await run({ recid: '9001' }));
    expect(result.environment_records.map((e) => [e.recid, e.kind])).toEqual([
      ['1', 'condition'],
      ['2', 'vm'],
      ['3', 'validation'],
      ['4', 'other'],
      ['5', 'other'],
    ]);
    expect(result.environment_records[0]).toEqual({
      recid: '1',
      title: 'Env 1',
      kind: 'condition',
      run_period: ['Run2012B'],
      portal_url: 'https://opendata.cern.ch/record/1',
    });
    expect(result.environment_records[1]).not.toHaveProperty('run_period');
    expect(result.example_software.map((s) => s.recid)).toEqual(['101']);
    expect(result.example_software[0]).toEqual({
      recid: '101',
      title: 'CMS analysis example: Higgs to four leptons',
      secondary: ['Analysis'],
      license_id: 'GPL-3.0-only',
      source_code_repository_url: 'https://github.com/cms-opendata-analyses/HiggsExample',
      portal_url: 'https://opendata.cern.ch/record/101',
    });
  });

  it('reads a secondary type named like a built-in object member as other', async () => {
    const env = (recid: string, secondary: string[]) =>
      hit(recid, { recid, type: { primary: 'Environment', secondary } });
    serve({
      docs: DOCS,
      linked: linkedHits(env('1', ['constructor']), env('2', ['toString', 'VM'])),
    });
    const result = success(await run({ recid: '9001' }));
    expect(result.environment_records.map((e) => [e.recid, e.kind])).toEqual([
      ['1', 'other'],
      ['2', 'vm'],
    ]);
  });

  it('never lists the record itself among its linked records', async () => {
    serve({ records: { '12100': environmentSystemHit }, linked: linkedHits(environmentSystemHit) });
    const result = success(await run({ recid: '12100' }));
    expect(result.environment_records).toEqual([]);
    expect(result).not.toHaveProperty('notice');
  });

  it('sorts usage links into guides and other links, making relative URLs absolute', async () => {
    const record = withLinks('9106', [
      { description: 'Docker guide', url: '/docs/cms-guide-docker#intro' },
      { description: 'Absolute http', url: 'http://opendata.cern.ch/docs/other-guide' },
      {
        description: 'Absolute https, trailing slash',
        url: 'https://opendata.cern.ch/docs/third/',
      },
      { description: 'Query string', url: '/docs/fourth?x=1#frag' },
      { description: 'Getting started', url: '/getting-started/cms/2011' },
      { description: 'External', url: 'https://example.org/docs/not-portal' },
      { description: 'No url' },
      { url: '   ' },
    ]);
    serve({ records: { '9106': record }, docs: DOCS });
    const result = success(await run({ recid: '9106' }));
    expect(result.guides.map((g) => [g.slug, g.url, g.anchor, g.link_description])).toEqual([
      [
        'cms-guide-docker',
        'https://opendata.cern.ch/docs/cms-guide-docker#intro',
        'intro',
        'Docker guide',
      ],
      ['other-guide', 'http://opendata.cern.ch/docs/other-guide', undefined, 'Absolute http'],
      [
        'third',
        'https://opendata.cern.ch/docs/third/',
        undefined,
        'Absolute https, trailing slash',
      ],
      ['fourth', 'https://opendata.cern.ch/docs/fourth?x=1#frag', 'frag', 'Query string'],
    ]);
    expect(result.other_links).toEqual([
      { url: 'https://opendata.cern.ch/getting-started/cms/2011', description: 'Getting started' },
      { url: 'https://example.org/docs/not-portal', description: 'External' },
    ]);
  });

  it('sends a link with a line break in its anchor to other links, URL-encoded in the text', async () => {
    const record = withLinks('9107', [{ description: 'Odd', url: '/docs/cms-guide-docker#a\nb' }]);
    serve({ records: { '9107': record } });
    const result = await run({ recid: '9107' });
    expect(success(result).guides).toEqual([]);
    expect(success(result).other_links).toHaveLength(1);
    expect(textOf(result)).toContain('https://opendata.cern.ch/docs/cms-guide-docker#a%0Ab');
  });

  it.each([['/docs/..'], ['/docs/.'], ['/docs/../'], ['https://opendata.cern.ch/docs/..#intro']])(
    'sends a doc link whose slug is a dot segment (%s) to other links, requesting no doc',
    async (url) => {
      const record = withLinks('9108', [{ description: 'Dots', url }]);
      const { http } = serve({ records: { '9108': record } });
      const result = success(await run({ recid: '9108' }));
      expect(result.guides).toEqual([]);
      expect(result.other_links).toEqual([{ url: absoluteUrl(url), description: 'Dots' }]);
      expect(http.calls).toHaveLength(2);
      expect(paths(http)).toEqual(['/api/records/', '/api/records/']);
    },
  );
});

describe('cern_opendata_get_analysis_env guide links from the record', () => {
  /** A slug and fragment no portal guide carries: markdown links, HTML and an instruction. */
  const HOSTILE_LINK =
    '/docs/[a](https:evil.example)<img#x; SYSTEM: [docs](https://evil.example) <img src=y>';

  it('escapes a slug in its notice and reads a fragment that is not an anchor name as no anchor', async () => {
    const record = withLinks('9140', [{ description: 'Guide', url: HOSTILE_LINK }]);
    const { http } = serve({ records: { '9140': record } });
    const result = success(await run({ recid: '9140' }));
    const [guide] = result.guides;
    expect(guide?.slug).toBe('[a](https:evil.example)<img');
    expect(guide).not.toHaveProperty('anchor');
    expect(guide?.fetched).toBe(false);
    expect(paths(http)[2]).toBe('/api/docs/%5Ba%5D(https%3Aevil.example)%3Cimg');
    expect(result.notice).toBe(
      'Guide \\[a\\](https:evil.example)&lt;img was not found; call cern_opendata_get_records with ids ["\\[a\\](https:evil.example)&lt;img"] for the page body.',
    );
    expect(result.notice).not.toMatch(/(?<!\\)\]\(/);
    expect(result.notice).not.toContain('<img');
    expect(result.notice).not.toContain('SYSTEM');
  });

  it.each([
    ['markup', 'intro"><img src=x>'],
    ['a space', 'intro x'],
    ['a markdown link', 'x](https://evil.example)'],
    ['101 characters', 'a'.repeat(101)],
  ])(
    'quotes the opening section, with no anchor and no anchor notice, for a fragment holding %s',
    async (_shape, fragment) => {
      const record = withLinks('9141', [{ url: `/docs/cms-guide-docker#${fragment}` }]);
      serve({ records: { '9141': record }, docs: DOCS });
      const result = success(await run({ recid: '9141' }));
      const [guide] = result.guides;
      expect(guide).not.toHaveProperty('anchor');
      expect(guide?.fetched).toBe(true);
      expect(guide?.section?.startsWith('# Docker guide')).toBe(true);
      expect(result).not.toHaveProperty('notice');
    },
  );

  it('keeps an anchor of up to 100 letters, digits, dots, colons, hyphens and underscores', async () => {
    const anchor = `A.b:c-d_9${'x'.repeat(91)}`;
    const record = withLinks('9142', [{ url: `/docs/cms-guide-docker#${anchor}` }]);
    serve({ records: { '9142': record }, docs: DOCS });
    const result = success(await run({ recid: '9142' }));
    expect(result.guides[0]?.anchor).toBe(anchor);
    expect(result.notice).toBe(
      `Guide cms-guide-docker has no section anchored ${anchor}; its opening section is quoted instead.`,
    );
  });

  it('escapes the reason a degraded linked search gives in its notice', async () => {
    vi.useFakeTimers();
    try {
      serve({ linked: () => new Response('down', { status: 503, statusText: '<b>[x](y)</b>' }) });
      const outcome = await settle(() => runToolContract(getAnalysisEnv, { recid: '9001' }));
      if (!outcome.ok) throw outcome.error;
      const { notice } = success(outcome.value);
      expect(notice).toMatch(/^Linked environment and software records could not be read \(/);
      expect(notice).not.toContain('<b>');
      expect(notice).not.toMatch(/(?<!\\)\]\(/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cern_opendata_get_analysis_env guides', () => {
  const guideRecord = (recid: string, links: { description?: string; url: string }[]) =>
    withLinks(recid, links);

  it('quotes the anchored section up to the next heading of the same or higher level, sub-sections included', async () => {
    serve({ docs: DOCS });
    const [guide] = success(await run({ recid: '9001' })).guides;
    expect(guide).toEqual({
      slug: 'cms-guide-docker',
      url: 'https://opendata.cern.ch/docs/cms-guide-docker#intro',
      link_description: 'CMS Docker guide',
      anchor: 'intro',
      title: 'Docker guide',
      section: '## <a name="intro">Introduction</a>\n\nIntro text.\n\n### Sub\n\nSub text.\n',
      section_truncated: false,
      fetched: true,
    });
  });

  it('never reads a # line inside a fenced code block as a heading', async () => {
    const record = guideRecord('9108', [{ url: '/docs/cms-guide-docker#install' }]);
    serve({ records: { '9108': record }, docs: DOCS });
    const [guide] = success(await run({ recid: '9108' })).guides;
    expect(guide?.section).toContain('# not a heading');
    expect(guide?.section).toContain('## nor this');
    expect(guide?.section).toContain('Install text.');
    expect(guide?.section).not.toContain('Last text.');
  });

  it('quotes to the end of the body when the anchored heading is the last section', async () => {
    const record = guideRecord('9109', [{ url: '/docs/cms-guide-docker#last' }]);
    serve({ records: { '9109': record }, docs: DOCS });
    const [guide] = success(await run({ recid: '9109' })).guides;
    expect(guide?.section).toBe('## <a name="last">Last</a>\n\nLast text.');
  });

  it('without an anchor quotes from the start to the second level-2 heading', async () => {
    const record = guideRecord('9110', [{ description: 'Guide', url: '/docs/cms-guide-docker' }]);
    serve({ records: { '9110': record }, docs: DOCS });
    const result = success(await run({ recid: '9110' }));
    const [guide] = result.guides;
    expect(guide?.section?.startsWith('# Docker guide')).toBe(true);
    expect(guide?.section).toContain('Intro text.');
    expect(guide?.section).not.toContain('Install text.');
    expect(guide).not.toHaveProperty('anchor');
    expect(result).not.toHaveProperty('notice');
  });

  it('quotes a whole body that has fewer than two level-2 headings', async () => {
    const record = guideRecord('9111', [{ url: '/docs/short' }]);
    serve({
      records: { '9111': record },
      docs: { short: docBody('short', 'One line.\n\n## Only heading\n\nText.') },
    });
    expect(success(await run({ recid: '9111' })).guides[0]?.section).toBe(
      'One line.\n\n## Only heading\n\nText.',
    );
  });

  it('falls back to the opening section when the anchor names no heading, with a notice', async () => {
    const record = guideRecord('9112', [{ url: '/docs/cms-guide-docker#nowhere' }]);
    serve({ records: { '9112': record }, docs: DOCS });
    const result = success(await run({ recid: '9112' }));
    expect(result.guides[0]?.section?.startsWith('# Docker guide')).toBe(true);
    expect(result.guides[0]?.fetched).toBe(true);
    expect(result.notice).toBe(
      'Guide cms-guide-docker has no section anchored nowhere; its opening section is quoted instead.',
    );
  });

  it('treats an anchor that sits on no heading line the same way', async () => {
    const record = guideRecord('9113', [{ url: '/docs/plain#target' }]);
    serve({
      records: { '9113': record },
      docs: {
        plain: docBody(
          'plain',
          'Text with <a name="target">an anchor</a> in a paragraph.\n\n## H2a\n\n## H2b',
        ),
      },
    });
    const result = success(await run({ recid: '9113' }));
    expect(result.notice).toContain('has no section anchored target');
    expect(result.guides[0]?.section).toBe(
      'Text with <a name="target">an anchor</a> in a paragraph.\n\n## H2a\n',
    );
  });

  it.each([
    ['name', '<a class="x" name="target">'],
    ['id, unquoted', "<a href='#' id=target>"],
    ['id, case-insensitive', '<A ID = "TARGET"/>'],
    ['name with a trailing space', '<a name="target" >'],
  ])('finds the anchor in a heading tag by %s', async (_form, tag) => {
    const record = guideRecord('9116', [{ url: '/docs/tags#target' }]);
    serve({
      records: { '9116': record },
      docs: { tags: docBody('tags', `# Top\n\n## ${tag}Target</a>\n\nBody.\n\n## Next`) },
    });
    const result = success(await run({ recid: '9116' }));
    expect(result.guides[0]?.section).toBe(`## ${tag}Target</a>\n\nBody.\n`);
    expect(result).not.toHaveProperty('notice');
  });

  it('scans a heading line of 20,000 unclosed anchor tags in linear time', async () => {
    const noisy = (anchors: number) =>
      `## ${'<a id '.repeat(anchors)}\n\nNoise.\n\n## <a name="intro">Intro</a>\n\nIntro text.`;
    serve({
      records: {
        '9117': guideRecord('9117', [{ url: '/docs/noisy#intro' }]),
        '9118': guideRecord('9118', [{ url: '/docs/quiet#intro' }]),
      },
      docs: {
        noisy: docBody('noisy', noisy(20_000)),
        quiet: docBody('quiet', noisy(1_250)),
      },
    });
    const fastest = { '9117': Number.POSITIVE_INFINITY, '9118': Number.POSITIVE_INFINITY };
    for (let round = 0; round < 3; round++) {
      for (const recid of ['9118', '9117'] as const) {
        const { ms, value } = await cpuTimedAsync(() => run({ recid }));
        expect(success(value).guides[0]?.section).toBe(
          '## <a name="intro">Intro</a>\n\nIntro text.',
        );
        fastest[recid] = Math.min(fastest[recid], ms);
      }
    }
    expect(fastest['9117'] / fastest['9118']).toBeLessThan(64);
    expect(fastest['9117']).toBeLessThan(250);
  });

  it('cuts a section at 12,000 characters, flags it and names the body offset where it stops', async () => {
    const long = `## <a name="big">Big</a>\n\n${'x'.repeat(20_000)}`;
    const record = guideRecord('9114', [{ url: '/docs/big#big' }]);
    serve({ records: { '9114': record }, docs: { big: docBody('big', long) } });
    const result = success(await run({ recid: '9114' }));
    const [guide] = result.guides;
    expect(guide?.section).toHaveLength(12_000);
    expect(guide?.section_truncated).toBe(true);
    expect(result.notice).toBe(
      'Guide big was cut at 12,000 characters; call cern_opendata_get_records with ids ["big"] and body_offset 12000 to read on from the cut.',
    );
  });

  it("names the cut of an anchored section at the section's start plus its quoted length", async () => {
    const preamble = '# Top\n\nOpening text.\n\n## <a name="first">First</a>\n\nFirst text.\n\n';
    const long = `${preamble}## <a name="big">Big</a>\n\n${'x'.repeat(20_000)}\n\n## <a name="after">After</a>`;
    const record = guideRecord('9118', [{ url: '/docs/big#big' }]);
    serve({ records: { '9118': record }, docs: { big: docBody('big', long) } });
    const result = success(await run({ recid: '9118' }));
    const offset = preamble.length + 12_000;
    expect(result.guides[0]?.section).toBe(long.slice(preamble.length, offset));
    expect(result.notice).toBe(
      `Guide big was cut at 12,000 characters; call cern_opendata_get_records with ids ["big"] and body_offset ${offset} to read on from the cut.`,
    );
  });

  it('maps the cut back to the body as the portal sent it when its lines end in CRLF', async () => {
    const lines = [
      '# Top',
      '',
      'Opening.',
      '',
      '## <a name="big">Big</a>',
      '',
      ...Array.from({ length: 1_500 }, (_, i) => `line ${String(i).padStart(4, '0')} xxxx`),
    ];
    const long = lines.join('\r\n');
    const record = guideRecord('9119', [{ url: '/docs/big#big' }]);
    serve({ records: { '9119': record }, docs: { big: docBody('big', long) } });
    const result = success(await run({ recid: '9119' }));
    const section = result.guides[0]?.section ?? '';
    expect(section).toHaveLength(12_000);
    const offset = Number(/body_offset (\d+) to read on/.exec(result.notice ?? '')?.[1]);
    const start = long.indexOf('## <a name="big">');
    expect(long.slice(start, offset).replaceAll('\r\n', '\n')).toBe(section);
    expect(offset).toBeGreaterThan(start + 12_000);
  });

  it('continues a cut section in one hop: get_records from the named offset reads on exactly where it stopped', async () => {
    const preamble = '# Top\n\nOpening text.\n\n';
    const long = `${preamble}## <a name="big">Big</a>\n\n${'0123456789'.repeat(3_000)}`;
    const record = guideRecord('9120', [{ url: '/docs/big#big' }]);
    installService([
      ...routes({ records: { '9120': record }, docs: { big: docBody('big', long) } }),
      portalRoute(
        '/api/records/',
        () =>
          jsonResponse(
            searchBody([
              hit('big', {
                slug: 'big',
                title: 'Big',
                type: { primary: 'Documentation' },
                body: { content: long, format: 'md' },
              }),
            ]),
          ),
        { query: (p) => p.get('q')?.startsWith('slug:') === true },
      ),
    ]);
    const env = success(await run({ recid: '9120' }));
    const hop = /call cern_opendata_get_records with ids \["([^"]+)"\] and body_offset (\d+)/.exec(
      env.notice ?? '',
    );
    expect(hop?.[1]).toBe('big');
    const next = dataOf<{ records: { body?: string; body_offset?: number }[] }>(
      await runToolContract(getRecords, { ids: [hop?.[1] ?? ''], body_offset: Number(hop?.[2]) }),
    ).records[0];
    expect(next?.body_offset).toBe(Number(hop?.[2]));
    expect(`${env.guides[0]?.section}${next?.body}`).toBe(
      long.slice(preamble.length, Number(hop?.[2]) + (next?.body?.length ?? 0)),
    );
  });

  it('does not flag a section of exactly 12,000 characters', async () => {
    const record = guideRecord('9115', [{ url: '/docs/exact' }]);
    serve({ records: { '9115': record }, docs: { exact: docBody('exact', 'y'.repeat(12_000)) } });
    const result = success(await run({ recid: '9115' }));
    expect(result.guides[0]).toMatchObject({ section_truncated: false, fetched: true });
    expect(result).not.toHaveProperty('notice');
  });

  it('fetches the first two guides only and lists the rest unfetched, with a notice each', async () => {
    const links = ['a', 'b', 'c', 'd'].map((slug) => ({ description: slug, url: `/docs/${slug}` }));
    const docs = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((slug) => [slug, docBody(slug, `Body ${slug}`)]),
    );
    const { http } = serve({ records: { '9116': guideRecord('9116', links) }, docs });
    const result = success(await run({ recid: '9116' }));
    expect(result.guides.map((g) => [g.slug, g.fetched])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
      ['d', false],
    ]);
    expect(result.guides[2]).toEqual({
      slug: 'c',
      url: 'https://opendata.cern.ch/docs/c',
      link_description: 'c',
      fetched: false,
    });
    expect(paths(http).filter((p) => p.startsWith('/api/docs/'))).toEqual([
      '/api/docs/a',
      '/api/docs/b',
    ]);
    expect(result.notice).toBe(
      'Guide c was not fetched; call cern_opendata_get_records with ids ["c"] for the page body. Guide d was not fetched; call cern_opendata_get_records with ids ["d"] for the page body.',
    );
  });

  it('reads a doc once when both fetched links name the same slug, each with its own section', async () => {
    const links = [
      { description: 'one', url: '/docs/cms-guide-docker#intro' },
      { description: 'two', url: '/docs/cms-guide-docker#last' },
    ];
    const { http } = serve({ records: { '9117': guideRecord('9117', links) }, docs: DOCS });
    const { guides } = success(await run({ recid: '9117' }));
    expect(paths(http).filter((p) => p.startsWith('/api/docs/'))).toHaveLength(1);
    expect(guides.map((g) => [g.anchor, g.fetched])).toEqual([
      ['intro', true],
      ['last', true],
    ]);
    expect(guides[0]?.section).toContain('Intro text.');
    expect(guides[1]?.section).toContain('Last text.');
  });

  it('marks a guide the portal 404s as not found, keeping the link and a notice', async () => {
    const record = guideRecord('9118', [{ description: 'Gone', url: '/docs/gone#x' }]);
    serve({ records: { '9118': record } });
    const result = success(await run({ recid: '9118' }));
    expect(result.guides[0]).toEqual({
      slug: 'gone',
      url: 'https://opendata.cern.ch/docs/gone#x',
      link_description: 'Gone',
      anchor: 'x',
      fetched: false,
    });
    expect(result.notice).toBe(
      'Guide gone was not found; call cern_opendata_get_records with ids ["gone"] for the page body.',
    );
  });

  it('marks a guide whose doc has no body as fetched with no section', async () => {
    const record = guideRecord('9119', [{ url: '/docs/empty' }]);
    const empty = { id: 'empty', metadata: { slug: 'empty', title: 'Empty page' } };
    serve({ records: { '9119': record }, docs: { empty } });
    const [guide] = success(await run({ recid: '9119' })).guides;
    expect(guide).toMatchObject({ slug: 'empty', title: 'Empty page', fetched: true });
    expect(guide).not.toHaveProperty('section');
    expect(guide).not.toHaveProperty('section_truncated');
  });
});

describe('cern_opendata_get_analysis_env notices', () => {
  it('names an empty environment: no system_details, no linked records, no guides', async () => {
    const bare = hit('9120', {
      recid: '9120',
      type: { primary: 'Dataset', secondary: ['Simulated'] },
    });
    serve({ records: { '9120': bare } });
    const result = success(await run({ recid: '9120' }));
    expect(result.notice).toBe(
      "This record lists no software environment, and no environment or software record links to it; call cern_opendata_search_records with type Environment and the record's experiment to browse environments.",
    );
  });

  it.each([
    ['system_details', { system_details: { release: 'CMSSW_1_2_3' } }, undefined, []],
    ['a linked software record', {}, [softwareHit], []],
    [
      'a guide link',
      { usage: { links: [{ url: '/docs/cms-guide-docker' }] } },
      undefined,
      ['guide'],
    ],
  ])(
    'leaves the empty-environment notice out when the record has %s',
    async (_name, extra, linked, guide) => {
      const record = hit('9121', { recid: '9121', ...extra });
      serve({
        records: { '9121': record },
        ...(linked ? { linked: linkedHits(...linked) } : {}),
        docs: guide.length > 0 ? DOCS : {},
      });
      expect(success(await run({ recid: '9121' })).notice ?? '').not.toContain(
        'lists no software environment',
      );
    },
  );

  it('says the linked records exceed the 50 shown, naming the rest query', async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      hit(`2${i.toString().padStart(3, '0')}`, {
        recid: `2${i.toString().padStart(3, '0')}`,
        title: `Env ${i}`,
        type: { primary: 'Environment', secondary: ['Condition'] },
      }),
    );
    serve({ docs: DOCS, linked: searchBody(many, { total: 83 }) });
    const result = success(await run({ recid: '9001' }));
    expect(result.environment_records).toHaveLength(50);
    expect(result.notice).toBe(
      '83 records link to this one and only 50 are shown; call cern_opendata_search_records with query use_with.links.recid:9001 for the rest.',
    );
  });

  it('does not say so at exactly 50 linked records', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) =>
      hit(`3${i.toString().padStart(3, '0')}`, {
        recid: `3${i.toString().padStart(3, '0')}`,
        type: { primary: 'Environment' },
      }),
    );
    serve({ docs: DOCS, linked: searchBody(fifty, { total: 50 }) });
    expect(success(await run({ recid: '9001' }))).not.toHaveProperty('notice');
  });

  it('composes the fragments in order: degrade or empty first, guide notes, then the overflow', async () => {
    const record = withLinks('9122', [
      { url: '/docs/gone' },
      { url: '/docs/cms-guide-docker#nowhere' },
      { url: '/docs/c' },
    ]);
    serve({
      records: { '9122': record },
      docs: DOCS,
      linked: searchBody([softwareHit], { total: 90 }),
    });
    const notice = success(await run({ recid: '9122' })).notice ?? '';
    const order = [
      'Guide cms-guide-docker has no section anchored nowhere',
      'Guide gone was not found',
      'Guide c was not fetched',
      '90 records link to this one',
    ].map((fragment) => notice.indexOf(fragment));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('writes the notice into the text trailer, and nothing when there is none', async () => {
    const bare = hit('9123', { recid: '9123', type: { primary: 'Dataset' } });
    serve({ records: { '9123': bare }, docs: DOCS });
    const result = await run({ recid: '9123' });
    expect(result.content).toHaveLength(2);
    expect(textOf(result, 1)).toContain('This record lists no software environment');
    disposeInstalledService();
    serve({ docs: DOCS });
    const clean = await run({ recid: '9001' });
    expect(clean.content).toHaveLength(1);
  });
});

describe('cern_opendata_get_analysis_env degraded legs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settled = async (recid = '9001', signal?: AbortSignal) => {
    const outcome = await settle(() =>
      runToolContract(getAnalysisEnv, { recid }, signal ? { context: { signal } } : undefined),
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };

  const rateLimited = () => new Response('', { status: 429, headers: { 'retry-after': '60' } });

  it.each([
    ['a 429', rateLimited, 'rate_limited'],
    ['an HTML page', () => new Response(HTML_ERROR_PAGE, { status: 200 }), 'upstream_unreadable'],
  ])(
    'degrades on %s from the linked search: empty lists, a notice naming %s, the record still returned',
    async (_name, linked, label) => {
      serve({ docs: DOCS, linked });
      const result = success(await settled());
      expect(result.environment_records).toEqual([]);
      expect(result.example_software).toEqual([]);
      expect(result.software.release).toBe('CMSSW_10_6_30');
      expect(result.guides[0]?.fetched).toBe(true);
      expect(result.notice).toBe(
        `Linked environment and software records could not be read (${label}); call cern_opendata_get_analysis_env again in a minute.`,
      );
    },
  );

  it('degrades on a persistent 503 from the linked search after retrying, with a notice', async () => {
    const { http } = serve({ docs: DOCS, linked: () => new Response('down', { status: 503 }) });
    const result = success(await settled());
    expect(result.notice).toMatch(
      /^Linked environment and software records could not be read \(.+\); call cern_opendata_get_analysis_env again in a minute\.$/,
    );
    expect(result.software.release).toBe('CMSSW_10_6_30');
    expect(
      http.calls.filter((c) => new URL(c.request.url).searchParams.get('q')?.includes('use_with'))
        .length,
    ).toBe(3);
  });

  it('never claims an empty environment when the linked search degraded', async () => {
    const bare = hit('9124', { recid: '9124', type: { primary: 'Dataset' } });
    serve({ records: { '9124': bare }, linked: rateLimited });
    const notice = success(await settled('9124')).notice ?? '';
    expect(notice).toContain('could not be read');
    expect(notice).not.toContain('lists no software environment');
  });

  it('fails the call, rather than degrading, when the portal rejects the query the server built', async () => {
    serve({ docs: DOCS, linked: () => jsonResponse(SYNTAX_ERROR_BODY, { status: 400 }) });
    const result = await settled();
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.message).toContain('rejected a query this server built');
  });

  it('degrades a guide whose fetch fails: not fetched, a notice, the rest of the result intact', async () => {
    const { http } = installService([
      ...routes({ docs: DOCS }).slice(0, 2),
      portalRoute(/^\/api\/docs\//, () => new Response('down', { status: 503 })),
    ]);
    const result = success(await settled());
    expect(result.guides[0]).toMatchObject({ slug: 'cms-guide-docker', fetched: false });
    expect(result.notice).toBe(
      'Guide cms-guide-docker was not fetched; call cern_opendata_get_records with ids ["cms-guide-docker"] for the page body.',
    );
    expect(result.software.release).toBe('CMSSW_10_6_30');
    expect(
      http.calls.filter((c) => new URL(c.request.url).pathname.startsWith('/api/docs/')),
    ).toHaveLength(3);
  });

  it('degrades a guide that answers 429 the same way', async () => {
    installService([...routes().slice(0, 2), portalRoute(/^\/api\/docs\//, rateLimited)]);
    expect(success(await settled()).notice).toContain('Guide cms-guide-docker was not fetched');
  });

  it('degrades both the linked search and a guide in one result', async () => {
    installService([
      ...routes({ linked: rateLimited }).slice(0, 2),
      portalRoute(/^\/api\/docs\//, rateLimited),
    ]);
    const notice = success(await settled()).notice ?? '';
    expect(notice).toContain('Linked environment and software records could not be read');
    expect(notice).toContain('Guide cms-guide-docker was not fetched');
  });

  it('reports a call cancelled during the legs as RequestCancelled, never as a degraded success', async () => {
    const controller = new AbortController();
    serve({
      docs: DOCS,
      linked: () => {
        controller.abort(new Error('client left'));
        return jsonResponse(linkedHits());
      },
    });
    const result = await settled('9001', controller.signal);
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('reports a call cancelled while the linked leg failed as RequestCancelled too', async () => {
    const controller = new AbortController();
    serve({
      docs: DOCS,
      linked: () => {
        controller.abort(new Error('client left'));
        return rateLimited();
      },
    });
    expect(errorOf(await settled('9001', controller.signal)).code).toBe(
      JsonRpcErrorCode.RequestCancelled,
    );
  });
});

describe('cern_opendata_get_analysis_env errors on the wire', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settled = async (recid = '9001', signal?: AbortSignal) => {
    const outcome = await settle(() =>
      runToolContract(getAnalysisEnv, { recid }, signal ? { context: { signal } } : undefined),
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };

  it('record_not_found: no hit names the recid, routes to search, and skips the other legs', async () => {
    const { http } = serve();
    const result = await settled('424242');
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'record_not_found', recid: '424242' });
    expect(error.message).toBe('No record has recid 424242.');
    const text = textOf(result);
    expect(text).toContain('Recovery: Call cern_opendata_search_records');
    expect(text).toContain('reason record_not_found');
    expect(http.calls).toHaveLength(1);
  });

  it('record_not_found: a search that answers a different record is no hit', async () => {
    serve({ records: { '7777': richDatasetHit } });
    expect(errorOf(await settled('7777')).data).toMatchObject({ reason: 'record_not_found' });
  });

  it('maps a 429 on the record search to rate_limited with retryAfter, without retrying or reading other legs', async () => {
    const { http } = installService([
      portalRoute(
        '/api/records/',
        () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
      ),
    ]);
    const result = await settled();
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
    expect(textOf(result)).toContain('Recovery: Wait the retryAfter seconds');
    expect(textOf(result)).toContain('call cern_opendata_get_analysis_env again');
    expect(http.calls).toHaveLength(1);
  });

  it('maps an HTML body on the record search to upstream_unreadable, retried, with the declared recovery', async () => {
    const { http } = installService([
      portalRoute('/api/records/', () => new Response(HTML_ERROR_PAGE, { status: 200 })),
    ]);
    const result = await settled();
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
    expect(textOf(result)).toContain(
      'Recovery: Call cern_opendata_get_analysis_env again in a minute',
    );
    expect(http.calls).toHaveLength(3);
  });

  it('fails a persistent 503 on the record search as ServiceUnavailable after three attempts', async () => {
    const { http } = installService([
      portalRoute('/api/records/', () => new Response('down', { status: 503 })),
    ]);
    expect(errorOf(await settled()).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(http.calls).toHaveLength(3);
  });

  it('fails a refused connection as ServiceUnavailable, naming the portal', async () => {
    const fetchFake = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    installService([], { fetch: fetchFake as unknown as typeof fetch });
    const result = await settled();
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(errorOf(result).message).toContain('Could not reach CERN Open Data');
  });

  it('stops a stalled portal at the call deadline as a Timeout', async () => {
    const hanging = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    installService([], { fetch: hanging as unknown as typeof fetch });
    expect(errorOf(await settled()).code).toBe(JsonRpcErrorCode.Timeout);
  });

  it('reports a cancelled call as RequestCancelled without a request', async () => {
    const { http } = serve();
    const controller = new AbortController();
    controller.abort(new Error('client left'));
    expect(errorOf(await settled('9001', controller.signal)).code).toBe(
      JsonRpcErrorCode.RequestCancelled,
    );
    expect(http.calls).toHaveLength(0);
  });
});

describe('cern_opendata_get_analysis_env format', () => {
  it('renders every field of the result with its values', async () => {
    serve({
      docs: DOCS,
      linked: linkedHits(
        hit('11', {
          recid: '11',
          title: 'Condition data',
          type: { primary: 'Environment', secondary: ['Condition'] },
          run_period: ['Run2011A'],
        }),
        softwareHit,
      ),
    });
    const result = await run({ recid: '9001' });
    const text = textOf(result);
    expect(text).toContain('## Analysis environment for record 9001: Rich dataset /A/B/C');
    expect(text).toContain(
      '**Type:** Dataset (Collision, Derived) · **Experiment:** CMS, ATLAS · **Run periods:** Run2011A, Run2012B',
    );
    expect(text).toContain(
      '**Release:** CMSSW_10_6_30 · **Global tag:** 106X_dataRun2_v37 · **Environment record:** 9003',
    );
    expect(text).toContain('- cmsopendata/cmssw_10_6_30 (registry: dockerhub)');
    expect(text).toContain('**Environment description:**\n```\nEnvironment notes.\n```');
    expect(text).toContain('### Environment records (1)');
    expect(text).toContain(
      '| 11 | condition | Condition data | Run2011A | https://opendata.cern.ch/record/11 |',
    );
    expect(text).toContain('### Example software (1)');
    expect(text).toContain(
      '| 101 | CMS analysis example: Higgs to four leptons | Analysis | GPL-3.0-only | https://github.com/cms-opendata-analyses/HiggsExample | https://opendata.cern.ch/record/101 |',
    );
    expect(text).toContain('### Guides (1)');
    expect(text).toContain('#### cms-guide-docker § intro');
    expect(text).toContain(
      '**URL:** https://opendata.cern.ch/docs/cms-guide-docker#intro · **Link text:** CMS Docker guide · **Anchor:** intro',
    );
    expect(text).toContain(
      '**Title:** Docker guide · **Fetched:** yes · **Section cut at 12,000 characters:** no',
    );
    expect(text).toContain('```\n## <a name="intro">Introduction</a>');
    expect(text).toContain('### Other links (0)\nNone.');
    expect(text).toContain(`**Separately licensed:** yes. ${LICENSE_NOTE}`);
  });

  it('renders absent values as Not available and empty sections as none, never as zero or blank', async () => {
    const bare = hit('9130', { recid: '9130' });
    serve({ records: { '9130': bare } });
    const text = textOf(await run({ recid: '9130' }));
    expect(text).toContain('## Analysis environment for record 9130: Not available');
    expect(text).toContain(
      '**Type:** Not available · **Experiment:** Not available · **Run periods:** Not available',
    );
    expect(text).toContain(
      '**Release:** Not available · **Global tag:** Not available · **Environment record:** Not available',
    );
    expect(text).toContain('**Container images:** none listed');
    expect(text).toContain('### Environment records (0)\nNone found.');
    expect(text).toContain('### Example software (0)\nNone found.');
    expect(text).toContain('### Guides (0)\nNone linked.');
    expect(text).toContain('### Other links (0)\nNone.');
    expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it('renders the secondary types of a record that states no primary type', async () => {
    const secondaryOnly = hit('9132', { recid: '9132', type: { secondary: ['Collision'] } });
    serve({ records: { '9132': secondaryOnly } });
    const result = await run({ recid: '9132' });
    expect(success(result).type).toEqual({ primary: '', secondary: ['Collision'] });
    expect(textOf(result)).toContain('**Type:** Not available (Collision) · **Experiment:**');
  });

  it('renders a guide that was not fetched as such, without a section or a cut flag', async () => {
    const record = withLinks('9131', [{ description: 'Later', url: '/docs/later#x' }]);
    serve({ records: { '9131': record } });
    const text = textOf(await run({ recid: '9131' }));
    expect(text).toContain('#### later § x');
    expect(text).toContain('**Title:** Not available · **Fetched:** no\n');
    expect(text).not.toContain('Section cut at');
  });

  it('renders a software record with no license or repository as Not available', async () => {
    const plain = hit('103', { recid: '103', title: 'Plain', type: { primary: 'Software' } });
    serve({ docs: DOCS, linked: linkedHits(plain) });
    const text = textOf(await run({ recid: '9001' }));
    expect(text).toContain(
      '| 103 | Plain | Not available | Not available | Not available | https://opendata.cern.ch/record/103 |',
    );
  });

  it('keeps CR/LF, markup and bidi controls in upstream text out of the inline slots', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const hostile = hit('9132', {
      recid: '9132',
      title: 'Evil\r\n# Injected heading\n- [link](http://evil.example) <script>',
      type: { primary: 'Dataset', secondary: ['Col\nlision'] },
      experiment: ['CMS\r\n## x', 'ATLAS|y'],
      run_period: [`Run${rlo}2012`],
      system_details: {
        release: 'CMSSW\n# 1',
        global_tag: 'GT|1 [x]',
        container_images: [{ name: 'img\n- bad', registry: 'reg\r\nistry' }],
        recid: '5\n6',
      },
      usage: {
        links: [
          { description: 'Guide\n# H', url: '/docs/cms-guide-docker#intro' },
          { description: 'Other\n- [x](http://e.example)', url: '/getting-started/a b\n[1]' },
        ],
      },
    });
    const section = 'before\n```\n# fenced heading\n```\nafter';
    const hostileEnv = hit('12', {
      recid: '12',
      title: 'Env\n# Heading | cell',
      type: { primary: 'Environment', secondary: ['VM'] },
      run_period: ['P\n1'],
    });
    serve({
      records: { '9132': hostile },
      docs: {
        'cms-guide-docker': docBody(
          'cms-guide-docker',
          `## <a name="intro">Intro</a>\n\n${section}`,
          'T\n# x',
        ),
      },
      linked: linkedHits(hostileEnv),
    });
    const result = await run({ recid: '9132' });
    const text = textOf(result);
    const outsideFences = text.replace(/(`{3,})\n[\s\S]*?\n\1/g, '');
    const lines = outsideFences.split('\n');
    expect(lines.filter((line) => line.startsWith('## '))).toEqual([
      '## Analysis environment for record 9132: Evil  # Injected heading - \\[link\\](http://evil.example) &lt;script&gt;',
    ]);
    expect(lines.some((line) => line.startsWith('# '))).toBe(false);
    expect(text).toContain(
      '**Type:** Dataset (Col lision) · **Experiment:** CMS  ## x, ATLAS\\|y · **Run periods:** Run2012',
    );
    expect(text).toContain(
      '**Release:** CMSSW # 1 · **Global tag:** GT\\|1 \\[x\\] · **Environment record:** 5 6',
    );
    expect(text).toContain('- img - bad (registry: reg  istry)');
    expect(text).toContain('| 12 | vm | Env # Heading \\| cell | P 1 |');
    expect(text).toContain('**Title:** T # x');
    expect(text).toContain('**Link text:** Guide # H');
    expect(text).toContain(
      'https://opendata.cern.ch/getting-started/a%20b%0A%5B1%5D: Other - \\[x\\](http://e.example)',
    );
    expect(text.split(/```+\n/).length).toBeGreaterThan(1);
    expect(text).toContain(
      '````\n## <a name="intro">Intro</a>\n\nbefore\n```\n# fenced heading\n```\nafter\n````',
    );
    expect(outsideFences).not.toMatch(new RegExp(`[\\r${rlo}]`));
    // structuredContent keeps the strings as received.
    expect(success(result).title).toContain('\r\n# Injected heading');
  });

  it('renders the same recids, release, images and guide slugs that structuredContent carries', async () => {
    serve({ docs: DOCS, linked: linkedHits(environmentSystemHit, softwareHit) });
    const result = await run({ recid: '9001' });
    const data = success(result);
    const text = textOf(result);
    expect(text).toContain(data.recid);
    expect(text).toContain(data.software.release);
    expect(text).toContain(data.software.global_tag);
    for (const image of data.software.container_images) expect(text).toContain(image.name);
    for (const env of data.environment_records) expect(text).toContain(env.recid);
    for (const sw of data.example_software) expect(text).toContain(sw.recid);
    for (const guide of data.guides) {
      expect(text).toContain(guide.slug);
      expect(text).toContain(guide.url);
      if (guide.section) expect(text).toContain('Intro text.');
    }
  });
});
