/**
 * @fileoverview Production metadata through the CERN record tool and resource.
 * @module tests/tools/record-production-metadata.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it } from 'vitest';
import { recordResource } from '@/mcp-server/resources/definitions/record.resource.js';
import { getRecords } from '@/mcp-server/tools/definitions/get-records.tool.js';
import type { RawHit } from '@/services/cern-opendata/types.js';
import {
  disposeInstalledService,
  errorOf,
  installService,
  textOf,
} from '../fixtures/cern-opendata-harness.js';
import { hit, jsonResponse, portalRoute, searchBody } from '../fixtures/cern-opendata-upstream.js';
import captured from '../fixtures/record-production-hits.json' with { type: 'json' };

/** CERN search hits captured on 2026-11-21, trimmed to tested metadata with inert script strings. */
const productionHits: readonly RawHit[] = captured;

const serve = (records: readonly RawHit[]) =>
  installService([portalRoute('/api/records/', () => jsonResponse(searchBody(records)))]);

const read = (recid: string) =>
  recordResource.handler(
    recordResource.params!.parse({ recid }),
    createMockContext({
      errors: recordResource.errors,
      uri: new URL(`cern-opendata://record/${recid}`),
    }),
  );

afterEach(disposeInstalledService);

it('keeps sparse metadata sparse and renders only the methodology description', async () => {
  const description = '<p>Production description only.</p>';
  serve([hit(1, { recid: '1', methodology: { description } })]);
  const tool = await runToolContract(getRecords, { ids: ['1'] });
  const [record] = getRecords.output.parse(tool.structuredContent).records;
  expect(record).toMatchObject({ recid: '1', methodology_html: description, links: [] });
  expect(Object.keys(record ?? {}).filter((key) => /methodology|cross_section/.test(key))).toEqual([
    'methodology_html',
  ]);
  expect(await read('1')).toEqual(record);
  expect(textOf(tool)).toContain('### Methodology\n```\nProduction description only.\n```');
  expect(textOf(tool)).not.toContain('Cross section');
});

it('exposes the default record projection and its script recovery on both tool surfaces and the resource', async () => {
  serve(productionHits);
  const tool = await runToolContract(getRecords, { ids: ['75592'] });
  const [record] = getRecords.output.parse(tool.structuredContent).records;
  expect(record).toMatchObject({
    recid: '75592',
    methodology_steps: expect.arrayContaining([
      expect.objectContaining({
        type: 'GEN',
        generators: ['pythia8'],
        release: 'CMSSW_10_6_19_patch2',
      }),
      expect.objectContaining({
        type: 'HLT',
        global_tag: '80X_mcRun2_asymptotic_2016_TrancheIV_v6',
        release: 'CMSSW_8_0_33_UL',
      }),
      expect.objectContaining({
        type: 'PAT',
        global_tag: '106X_mcRun2_asymptotic_v17',
        release: 'CMSSW_10_6_25',
      }),
    ]),
    methodology_scripts_notice: expect.stringContaining('8 scripts omitted'),
  });
  const resource = await read('75592');
  expect(recordResource.output?.parse(resource)).toEqual(record);
  const text = textOf(tool);
  const recoDataset =
    '/ZZ_TuneCP5_13TeV-pythia8/RunIISummer20UL16RECO-106X_mcRun2_asymptotic_v13-v2/AODSIM';
  expect(record?.methodology_steps?.find((step) => step.type === 'RECO')?.output_dataset).toBe(
    recoDataset,
  );
  expect(text.split('### Methodology')[1]).toContain(recoDataset);
  expect(text).toContain('8 scripts omitted');
  expect(text).toContain('cern_opendata_get_records with ids ["75592"] and include_scripts: true');
  expect(text).toContain('pythia8');
  expect(text).not.toContain('fixture 1');
});

it.each([false, true])('projects cached data independently (first opt-in %s)', async (first) => {
  const { http } = serve(productionHits);
  const lookup = (include_scripts: boolean) =>
    runToolContract(getRecords, { ids: ['75592'], include_scripts });
  const initial = await lookup(first);
  const next = await lookup(!first);
  const [normal, optedIn] = first ? [next, initial] : [initial, next];
  const [projected] = getRecords.output.parse(normal.structuredContent).records;
  const [full] = getRecords.output.parse(optedIn.structuredContent).records;
  const steps = captured.find((entry) => entry.id === '75592')?.metadata.methodology.steps;
  expect(steps).toHaveLength(7);
  expect(full?.methodology_steps).toEqual(steps);
  expect(full).not.toHaveProperty('methodology_scripts_notice');
  expect(projected?.methodology_steps?.map((step) => step.type)).toEqual([
    'GEN',
    'SIM',
    'DIGI2RAW',
    'HLT',
    'RECO',
    'PAT',
    'NANO',
  ]);
  expect(projected?.methodology_steps?.[0]?.configuration_files).toEqual([
    { title: 'Production script' },
    {
      title: 'Generator parameters',
      url: 'https://cms-pdmv-prod.web.cern.ch/mcm/public/restapi/requests/get_fragment/SUS-RunIISummer20UL16GEN-00021',
    },
    {
      title: 'Configuration file',
      process: 'GEN',
      cms_confdb_id: '3c7c6643753d478b3d448a41520e16a2',
    },
  ]);
  const scripts = steps?.flatMap((step) =>
    step.configuration_files.flatMap((file) =>
      'script' in file && typeof file.script === 'string' ? [file.script] : [],
    ),
  );
  expect(scripts).toHaveLength(8);
  const text = textOf(optedIn);
  const blocks = Array.from(text.matchAll(/^`{4}\n([\s\S]*?)\n`{4}$/gm), ([, body]) => body);
  expect(blocks).toEqual(scripts);
  expect(text).toContain(
    '<https://cms-pdmv-prod.web.cern.ch/mcm/public/restapi/requests/get_fragment/SUS-RunIISummer20UL16GEN-00021>',
  );
  expect(text).not.toContain('scripts omitted');
  expect(await read('75592')).toEqual(projected);
  expect(http.calls).toHaveLength(1);
});

it('keeps LHCb repeats, sparse CMS configurations and methodology links in order', async () => {
  serve(productionHits);
  const tool = await runToolContract(getRecords, { ids: ['28064', '9638', '31316'] });
  const [lhcb, cms, linked] = getRecords.output.parse(tool.structuredContent).records;
  const expected = (id: string) =>
    captured.find((entry) => entry.id === id)?.metadata.methodology.steps;
  expect(lhcb?.methodology_steps).toEqual(expected('28064'));
  expect(lhcb?.methodology_steps).toHaveLength(10);
  expect(cms?.methodology_steps).toEqual(expected('9638'));
  expect(cms?.methodology_steps?.[1]?.global_tag).toBe('');
  expect(cms?.methodology_steps?.[0]?.configuration_files).toHaveLength(2);
  expect(linked?.links).toEqual([{ source: 'methodology', recid: '12504' }]);
  expect(linked).not.toHaveProperty('methodology_steps');
  for (const [id, record] of [
    ['28064', lhcb],
    ['9638', cms],
    ['31316', linked],
  ] as const) {
    expect(record).not.toHaveProperty('methodology_scripts_notice');
    expect(await read(id)).toEqual(record);
  }
  const text = textOf(tool);
  expect(text).toContain('| 10 | Stripping21r0p2-Merging |');
  expect(text).toContain('DaVinci/DV-Stripping21r0p2-Stripping.py');
  expect(text).toContain('50fd69070552b55d4010033587ee6bd4');
  expect(text).toContain('ab2ced424e65b0878996877341308483');
  expect(text).toContain('| 2 | SIM | CMSSW_5_3_10_patch1 | "" |');
  expect(text).toContain('[methodology] Not available — recid 12504');
  expect(text).not.toContain('scripts omitted');
});

it('preserves CMS cross-section values on both tool surfaces and in the resource', async () => {
  serve(productionHits);
  const tool = await runToolContract(getRecords, { ids: ['75592', '9638', '28064'] });
  const [newCms, olderCms, lhcb] = getRecords.output.parse(tool.structuredContent).records;
  const modern = {
    filter_efficiency: '1.000e+00',
    neg_weight_fraction: '0.000e+00',
    total_value: '1.208e+01',
    total_value_uncertainty: '7.904e-02',
  };
  const older = {
    filter_efficiency: '1',
    filter_efficiency_error: '0',
    matching_efficiency: '1',
    matching_efficiency_error: '-1',
    total_value: '16',
  };
  expect(newCms).toHaveProperty('cross_section', modern);
  expect(olderCms).toHaveProperty('cross_section', older);
  expect(lhcb).not.toHaveProperty('cross_section');
  expect(await read('75592')).toHaveProperty('cross_section', modern);
  expect(await read('9638')).toHaveProperty('cross_section', older);
  expect(await read('28064')).not.toHaveProperty('cross_section');
  const text = textOf(tool);
  expect(text).toContain(
    'Cross section:** 1.208e+01 ± 7.904e-02 pb · filter efficiency 1.000e+00 · negative weights 0.000e+00 %',
  );
  expect(text).toContain(
    'Cross section:** 16 pb · filter efficiency 1 (error 0) · matching efficiency 1 (error -1)',
  );
  expect(text.match(/Cross section:/g)).toHaveLength(2);
});

it('honors blank options, unresolved lookups and existing body-offset recovery', async () => {
  serve(productionHits);
  const blank = await runToolContract(getRecords, { ids: ['75592'], include_scripts: '' });
  expect(textOf(blank)).toContain('8 scripts omitted');

  const missing = await runToolContract(getRecords, { ids: ['321'], include_scripts: true });
  expect(getRecords.output.parse(missing.structuredContent).records).toEqual([]);
  expect(textOf(missing)).toContain('No identifier resolved to a record.');

  const invalid = await runToolContract(getRecords, { ids: ['75592'], include_scripts: 'no' });
  expect(errorOf(invalid).data?.reason).toBe('invalid_arguments');
  expect(textOf(invalid)).toContain('include_scripts');

  const offset = await runToolContract(getRecords, {
    ids: ['75592'],
    body_offset: 1,
    include_scripts: true,
  });
  expect(errorOf(offset).data?.reason).toBe('invalid_body_offset');
  expect(textOf(offset)).toContain('one documentation or news id');
});

it('returns the full selected record and its notice beside the existing lookup continuation', async () => {
  serve(productionHits);
  const ids = ['75592', ...Array.from({ length: 19 }, (_, i) => String(100 + i)), '9638'];
  const tool = await runToolContract(getRecords, { ids });
  const result = getRecords.output.parse(tool.structuredContent);
  expect(result.records.map((record) => record.recid)).toEqual(['75592']);
  expect(result.records[0]?.methodology_steps).toHaveLength(7);
  expect(result.records[0]?.methodology_scripts_notice).toContain('8 scripts omitted');
  expect(result.missing).toHaveLength(19);
  expect(result.deferred).toEqual(['9638']);
  expect(tool.structuredContent).toHaveProperty(
    'notice',
    expect.stringContaining('past the first 20'),
  );
  expect(textOf(tool)).toContain('8 scripts omitted');
  expect(textOf(tool)).toContain('## Deferred\n- 9638');
  const continuation = await runToolContract(getRecords, {
    ids: result.deferred,
    include_scripts: true,
  });
  expect(getRecords.output.parse(continuation.structuredContent).records[0]?.recid).toBe('9638');
  expect(textOf(continuation)).not.toContain('scripts omitted');
});
