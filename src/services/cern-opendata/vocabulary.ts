/**
 * @fileoverview Canonical CERN Open Data vocabulary: the exact facet values the
 * portal accepts, the case- and whitespace-insensitive canonicalization the
 * search filters apply, and the static reference tables served by
 * `cern_opendata_list_reference`.
 * @module services/cern-opendata/vocabulary
 */

/** Filter parameters that carry a canonical vocabulary table. */
export type VocabularyParam =
  | 'type'
  | 'experiment'
  | 'collision_energy'
  | 'collision_type'
  | 'file_type'
  | 'availability';

/** Topics served by `cern_opendata_list_reference`, in display order. */
export const REFERENCE_TOPICS = [
  'experiments',
  'record_types',
  'collision_energies',
  'collision_types',
  'file_types',
  'availability',
  'identifiers',
  'query_syntax',
  'licensing',
  'run_periods',
] as const;

export type ReferenceTopic = (typeof REFERENCE_TOPICS)[number];

/** One decoded vocabulary value. */
export interface ReferenceEntry {
  meaning: string;
  value: string;
}

/** One reference topic: a summary line plus its entries. */
export interface ReferenceTable {
  entries: ReferenceEntry[];
  summary: string;
  topic: ReferenceTopic;
}

/** The `list_reference` topic that documents each filter parameter's values. */
export const PARAM_TOPIC: Record<VocabularyParam, ReferenceTopic> = {
  type: 'record_types',
  experiment: 'experiments',
  collision_energy: 'collision_energies',
  collision_type: 'collision_types',
  file_type: 'file_types',
  availability: 'availability',
};

const FORMAT_LABEL = 'format label used by the portal';

const EXPERIMENT_MEANINGS: Record<string, string> = {
  ALICE:
    'A Large Ion Collider Experiment: LHC experiment specialised in heavy-ion collisions and the quark-gluon plasma.',
  ATLAS: 'A Toroidal LHC ApparatuS: general-purpose LHC detector.',
  CMS: 'Compact Muon Solenoid: general-purpose LHC detector; its releases include validated-run lists and trigger path records.',
  DELPHI: 'LEP experiment recording electron-positron collisions (1989-2000).',
  JADE: "Experiment at DESY's PETRA electron-positron collider (1979-1986).",
  LHCb: 'LHC experiment specialised in beauty and charm physics and CP violation.',
  OPERA:
    'Neutrino-oscillation experiment at Gran Sasso that observed the CERN CNGS muon-neutrino beam.',
  PHENIX: "Heavy-ion experiment at Brookhaven's Relativistic Heavy Ion Collider (RHIC).",
  TOTEM:
    'LHC experiment measuring the total proton-proton cross-section and elastic and diffractive scattering.',
};

/** Record types: every reachable primary, then each `Primary::Secondary` pair. */
const RECORD_TYPE_MEANINGS: Record<string, string> = {
  Dataset: 'Data records: collision, derived or simulated datasets.',
  'Dataset::Collision': 'Data recorded from beam collisions.',
  'Dataset::Derived':
    'Datasets derived from collision or simulated data, often reduced for education and outreach.',
  'Dataset::Simulated': 'Monte Carlo simulated events.',
  Documentation: 'Documentation pages; they carry no recid and resolve by slug.',
  'Documentation::About': 'Pages about the portal and the experiments.',
  'Documentation::Activities': 'Educational and outreach activities.',
  'Documentation::Authors': 'Author lists.',
  'Documentation::Guide': 'Guides and tutorials.',
  'Documentation::Help': 'Help pages.',
  'Documentation::Policy': 'Data-release and data-access policies.',
  'Documentation::Report': 'Reports.',
  'Documentation::Stripping': 'LHCb stripping documentation.',
  Environment: 'Records describing how to analyse data: conditions, virtual machines, validation.',
  'Environment::Condition': 'Condition (calibration and alignment) data records.',
  'Environment::VM': 'Virtual machine images.',
  'Environment::Validation': 'CMS validated-run (good-run) lists.',
  Software: 'Software records, each licensed separately from the CC0 data.',
  'Software::Analysis': 'Analysis code and examples.',
  'Software::Framework': 'Experiment software frameworks.',
  'Software::Tool': 'Tools.',
  'Software::Validation': 'Validation code.',
  'Software::Workflow': 'Workflow and production code.',
  Supplementaries:
    'Supplementary material: configurations, trigger information, luminosity, notes.',
  'Supplementaries::Computing Note': 'Computing notes.',
  'Supplementaries::Configuration': 'Configuration files.',
  'Supplementaries::Configuration HLT': 'CMS High-Level Trigger menu configurations.',
  'Supplementaries::Configuration LHE': 'LHE event-generation configurations.',
  'Supplementaries::Configuration RECO': 'Reconstruction configurations.',
  'Supplementaries::Configuration SIM': 'Simulation configurations.',
  'Supplementaries::Correction': 'Corrections.',
  'Supplementaries::Logbook': 'Logbooks.',
  'Supplementaries::Luminosity': 'Luminosity information.',
  'Supplementaries::Manual': 'Manuals.',
  'Supplementaries::Trigger':
    'CMS High-Level Trigger path records; cern_opendata_search_trigger_paths parses them.',
  News: 'News items; served as documentation pages and resolved by slug.',
};

const COLLISION_ENERGY_MEANINGS: Record<string, string> = {
  '0.9TeV': 'Centre-of-mass energy 0.9 TeV (900 GeV).',
  '0TeV': 'Label for records without beam-beam collision energy, such as cosmic or interfill data.',
  '2.76TeV': 'Centre-of-mass energy 2.76 TeV.',
  '5.02TeV': 'Centre-of-mass energy 5.02 TeV.',
  '5TeV': 'Centre-of-mass energy 5 TeV; a separate exact value from 5.02TeV.',
  '7TeV': 'Centre-of-mass energy 7 TeV.',
  '8TeV': 'Centre-of-mass energy 8 TeV.',
  '12GeV': 'Centre-of-mass energy 12 GeV.',
  '13TeV': 'Centre-of-mass energy 13 TeV.',
  '13.6TeV': 'Centre-of-mass energy 13.6 TeV.',
  '13TeV, 13.6TeV':
    'One upstream value, not two: records spanning 13 TeV and 13.6 TeV data. Filter on it as written.',
  '89-94 GeV': 'LEP1 centre-of-mass energy range around the Z pole.',
  '130-140 GeV': 'LEP2 centre-of-mass energy range.',
  '161-174 GeV': 'LEP2 centre-of-mass energy range.',
  '181-210 GeV': 'LEP2 centre-of-mass energy range.',
};

const COLLISION_TYPE_MEANINGS: Record<string, string> = {
  pp: 'Proton-proton collisions.',
  PbPb: 'Lead-lead collisions. The corpus spells this both PbPb and Pb-Pb, so the filter sends both.',
  pPb: 'Proton-lead collisions.',
  'e+e-': 'Electron-positron collisions (LEP, PETRA).',
  Interfill: 'Data recorded between LHC fills, without beam collisions.',
};

/** All 65 `file_type` values from the live facet, with meanings where established. */
const FILE_TYPE_MEANINGS: Record<string, string> = {
  '.ckpt': 'Model checkpoint file (machine-learning weights).',
  C: 'C/C++ source file, such as a ROOT macro.',
  DAOD_HION14: 'ATLAS derived AOD (DAOD) for heavy-ion analyses.',
  DAOD_PHYSLITE: 'ATLAS PHYSLITE derived AOD: a calibrated, reduced analysis format.',
  DST: 'LHCb Data Summary Tape: fully reconstructed events.',
  DSTO: FORMAT_LABEL,
  HEPMC: 'HepMC event-generator record format.',
  LHE: 'Les Houches Event file: parton-level generator events.',
  LONG: FORMAT_LABEL,
  MDST: 'LHCb micro-DST: a reduced DST holding selected candidates.',
  NTuple: 'Flat n-tuple of analysis variables, typically ROOT trees.',
  RAWD: FORMAT_LABEL,
  SHORT: FORMAT_LABEL,
  XSHORT: FORMAT_LABEL,
  aod: 'CMS AOD (Analysis Object Data) data tier.',
  aodsim: 'CMS AODSIM: AOD for simulated events.',
  cc: 'C++ source file.',
  csv: 'Comma-separated values.',
  dat: 'Generic data file.',
  db: 'Database file.',
  docx: 'Word document.',
  fevtdebughlt:
    'CMS FEVTDEBUGHLT data tier: full event content plus trigger debugging information.',
  'gen-sim': 'CMS GEN-SIM data tier: generated and detector-simulated events.',
  'gen-sim-digi-raw': 'CMS GEN-SIM-DIGI-RAW: simulated events digitized into RAW format.',
  'gen-sim-reco': 'CMS GEN-SIM-RECO: simulated events after reconstruction.',
  gz: 'Gzip-compressed file.',
  h5: 'HDF5 file.',
  hdd: FORMAT_LABEL,
  hdf5: 'HDF5 file.',
  html: 'HTML page.',
  ig: 'CMS iSpy event-display file.',
  ipynb: 'Jupyter notebook.',
  iso: 'Disk image.',
  jpg: 'JPEG image.',
  json: 'JSON file.',
  m4v: 'Video file.',
  miniaod: 'CMS MiniAOD data tier: a compact analysis format.',
  miniaodsim: 'CMS MiniAODSIM: MiniAOD for simulated events.',
  nanoaod: 'CMS NanoAOD data tier: a flat ROOT analysis format.',
  'nanoaod-pf': FORMAT_LABEL,
  'nanoaod-poet': FORMAT_LABEL,
  'nanoaod-reduced': FORMAT_LABEL,
  'nanoaod-run1': FORMAT_LABEL,
  nanoaodsim: 'CMS NanoAODSIM: NanoAOD for simulated events.',
  'nanoaodsim-poet': FORMAT_LABEL,
  'nanoaodsim-reduced': FORMAT_LABEL,
  'nanoaodsim-run1': FORMAT_LABEL,
  ova: 'Open Virtualization Appliance: a virtual machine image.',
  parquet: 'Apache Parquet columnar file.',
  pdf: 'PDF document.',
  png: 'PNG image.',
  premix: 'CMS PREMIX: pre-mixed pile-up events for simulation.',
  py: 'Python source file.',
  raw: 'CMS RAW data tier: detector readout.',
  reco: 'CMS RECO data tier: full reconstruction output.',
  root: 'ROOT file.',
  sh: 'Shell script.',
  tar: 'Tar archive.',
  'tar.gz': 'Gzip-compressed tar archive.',
  tgz: 'Gzip-compressed tar archive.',
  txt: 'Text file.',
  xls: 'Excel spreadsheet.',
  xml: 'XML file.',
  yaml: 'YAML file.',
  zip: 'Zip archive.',
};

const AVAILABILITY_MEANINGS: Record<string, string> = {
  online:
    'Record level: every file is on disk and downloadable now. File level: the file is on disk.',
  partial: 'Record level: some files are on disk, the rest on tape.',
  ondemand:
    "Record level: the files are on tape and must be requested on the record's portal page before download.",
  requested: 'Record level: a transfer of the files from tape has been requested.',
};

/** The six primaries search can serve; sent as the default `type` (Glossary excluded). */
export const SEARCHABLE_TYPE_PRIMARIES = [
  'Dataset',
  'Documentation',
  'Environment',
  'Software',
  'Supplementaries',
  'News',
] as const;

/** Both upstream spellings the canonical `PbPb` collision type expands to. */
export const PBPB_SPELLINGS = ['PbPb', 'Pb-Pb'] as const;

const CANONICAL_VALUES: Record<VocabularyParam, readonly string[]> = {
  type: Object.keys(RECORD_TYPE_MEANINGS),
  experiment: Object.keys(EXPERIMENT_MEANINGS),
  collision_energy: Object.keys(COLLISION_ENERGY_MEANINGS),
  collision_type: Object.keys(COLLISION_TYPE_MEANINGS),
  file_type: Object.keys(FILE_TYPE_MEANINGS),
  availability: Object.keys(AVAILABILITY_MEANINGS),
};

/** Spellings that do not reduce to a canonical value by case and whitespace alone. */
const ALIASES: Partial<Record<VocabularyParam, Record<string, string>>> = {
  collision_type: { 'pb-pb': 'PbPb' },
  availability: { 'on-demand': 'ondemand' },
};

/** The match key: the value lowercased with all whitespace removed. */
function matchKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

const TABLES = Object.fromEntries(
  (Object.keys(CANONICAL_VALUES) as VocabularyParam[]).map((param) => {
    const table = new Map<string, string>();
    for (const value of CANONICAL_VALUES[param]) table.set(matchKey(value), value);
    for (const [alias, value] of Object.entries(ALIASES[param] ?? {})) table.set(alias, value);
    return [param, table];
  }),
) as Record<VocabularyParam, Map<string, string>>;

/** `/` or a single `:` between primary and secondary becomes `::`. */
function normalizeTypeSeparator(value: string): string {
  return value.replace(/\s*(?:::|:|\/)\s*/, '::');
}

/**
 * Canonicalize one filter value: a known value becomes its canonical spelling;
 * an unknown one is returned trimmed, as given, because the vocabulary grows
 * with each release.
 */
export function canonicalize(param: VocabularyParam, raw: string): string {
  const trimmed = raw.trim();
  const keyed = param === 'type' ? normalizeTypeSeparator(trimmed) : trimmed;
  return TABLES[param].get(matchKey(keyed)) ?? trimmed;
}

/** Whether a (canonicalized) value is in the parameter's verified table. */
export function isKnownValue(param: VocabularyParam, value: string): boolean {
  return TABLES[param].get(matchKey(value)) === value;
}

/** True for `Glossary` in any form (`glossary`, `Glossary::x`); search rejects it. */
export function isGlossaryType(value: string): boolean {
  return matchKey(value).startsWith('glossary');
}

/** CMS run periods with validated-run lists, as of the snapshot date. */
interface RunPeriodSnapshot {
  full: string[];
  muonsOnly: string[];
  period: string;
}

const RUN_PERIOD_SNAPSHOT: RunPeriodSnapshot[] = [
  { period: 'Commissioning2010', full: ['14200', '14201'], muonsOnly: [] },
  { period: 'Run2010B', full: ['1000'], muonsOnly: [] },
  { period: 'HIRun2010', full: ['14202'], muonsOnly: ['14203'] },
  { period: 'Run2011A', full: ['1001', '14206', '14208'], muonsOnly: ['14207', '14209'] },
  { period: 'Run2011B', full: ['1001', '14206'], muonsOnly: ['14207'] },
  { period: 'HIRun2011', full: ['14204'], muonsOnly: ['14205'] },
  { period: 'Run2012A', full: ['1002'], muonsOnly: ['1005'] },
  { period: 'Run2012B', full: ['1002'], muonsOnly: ['1005'] },
  { period: 'Run2012C', full: ['1002'], muonsOnly: ['1005'] },
  { period: 'Run2012D', full: ['1002'], muonsOnly: ['1005'] },
  { period: 'HIRun2013', full: ['14216'], muonsOnly: ['14217'] },
  { period: 'Run2013A', full: ['14218'], muonsOnly: ['14219'] },
  { period: 'Run2015C', full: ['14210'], muonsOnly: ['14211'] },
  { period: 'Run2015D', full: ['14210'], muonsOnly: ['14211'] },
  { period: 'Run2015E', full: ['14212'], muonsOnly: ['14213'] },
  ...['B', 'C', 'D', 'E', 'F', 'G', 'H'].map((era) => ({
    period: `Run2016${era}`,
    full: ['14220'],
    muonsOnly: ['14221'],
  })),
];

function describeRunPeriod({ full, muonsOnly }: RunPeriodSnapshot): string {
  const fullText = `full: ${full.join(', ')}`;
  const muonsText =
    muonsOnly.length > 0 ? `muons_only: ${muonsOnly.join(', ')}` : 'no muons_only list';
  return `Validated-run lists (recids) ${fullText}; ${muonsText}.`;
}

function entriesOf(meanings: Record<string, string>): ReferenceEntry[] {
  return Object.entries(meanings).map(([value, meaning]) => ({ value, meaning }));
}

/** Every reference table, in {@link REFERENCE_TOPICS} order. */
export const REFERENCE_TABLES: readonly ReferenceTable[] = [
  {
    topic: 'experiments',
    summary:
      'Experiments with records on the portal, for the experiment filter. Values are exact upstream; input case is normalized (lhcb becomes LHCb).',
    entries: entriesOf(EXPERIMENT_MEANINGS),
  },
  {
    topic: 'record_types',
    summary:
      'Values for the type filter: a primary type or Primary::Secondary, combined with OR. dataset/collision and Dataset:Collision are normalized to Dataset::Collision. Without a type filter, search covers the six servable primaries. Glossary entries are not served by this server; News pages resolve as documentation.',
    entries: [
      ...entriesOf(RECORD_TYPE_MEANINGS),
      {
        value: 'Glossary',
        meaning:
          'Not served: glossary entries have no readable endpoint, search excludes them, and the type filter rejects them.',
      },
    ],
  },
  {
    topic: 'collision_energies',
    summary:
      'Values for the collision_energy filter. Heavy-ion and proton-lead energies are per nucleon pair. "13TeV, 13.6TeV" is a single value.',
    entries: entriesOf(COLLISION_ENERGY_MEANINGS),
  },
  {
    topic: 'collision_types',
    summary: 'Values for the collision_type filter. Pb-Pb is accepted and normalized to PbPb.',
    entries: entriesOf(COLLISION_TYPE_MEANINGS),
  },
  {
    topic: 'file_types',
    summary: `Values for the file_type filter (a record's distribution.formats): CMS data tiers, ATLAS and LHCb formats, and generic file formats. No two values differ only by case, so input case is normalized. "${FORMAT_LABEL}" marks a value whose meaning the portal does not document.`,
    entries: entriesOf(FILE_TYPE_MEANINGS),
  },
  {
    topic: 'availability',
    summary:
      'Record-level states for the availability filter (on demand and on-demand are normalized to ondemand), and the per-file states cern_opendata_list_files reports.',
    entries: [
      ...entriesOf(AVAILABILITY_MEANINGS),
      {
        value: 'on demand',
        meaning:
          "File level (spelled with a space): the file is on tape; request it on the record's portal page before downloading.",
      },
    ],
  },
  {
    topic: 'identifiers',
    summary: 'Identifier forms the tools accept, with their accepted spellings.',
    entries: [
      {
        value: 'recid',
        meaning:
          'Digits (6004); also recid:6004 or https://opendata.cern.ch/record/6004. Taken by cern_opendata_get_records, cern_opendata_list_files, cern_opendata_get_analysis_env, cern_opendata_get_validated_runs and the cern-opendata://record/{recid} resource.',
      },
      {
        value: 'DOI',
        meaning:
          '10.7483/OPENDATA.CMS.YLIC.86ZZ; also doi:..., https://doi.org/... or https://dx.doi.org/.... Matched case-insensitively. Taken by cern_opendata_get_records.',
      },
      {
        value: 'CMS dataset path',
        meaning:
          '/Primary/Era/TIER, the exact record title, such as /DoubleMuParked/Run2012B-22Jan2013-v1/AOD. Taken by cern_opendata_get_records.',
      },
      {
        value: 'documentation slug',
        meaning:
          'cms-guide-docker, or https://opendata.cern.ch/docs/cms-guide-docker. Also resolves news items. Taken by cern_opendata_get_records.',
      },
      {
        value: 'file-index key',
        meaning:
          'An indexes[].key from cern_opendata_list_files (ending _file_index.json; the .txt spelling is accepted). Taken by cern_opendata_list_files as index.',
      },
      {
        value: 'trigger path',
        meaning:
          'HLT_IsoMu24, or a prefix pattern HLT_IsoMu*. A trailing _v<n> is stripped and a missing HLT_ prefix added. Taken by cern_opendata_search_trigger_paths.',
      },
      {
        value: 'run period',
        meaning:
          'Run2012B, or 2012B; see topic run_periods. Taken by cern_opendata_get_validated_runs as run_period.',
      },
    ],
  },
  {
    topic: 'query_syntax',
    summary:
      'Forms for the query parameter of cern_opendata_search_records: OpenSearch query_string with default operator AND over the title (boosted) and every field. Invalid syntax fails with invalid_query.',
    entries: [
      {
        value: 'muon tau',
        meaning: 'Every term must match (default operator AND).',
      },
      { value: '"exact phrase"', meaning: 'Phrase match.' },
      { value: 'a OR b, NOT a, (a OR b) c', meaning: 'Boolean operators and grouping.' },
      { value: 'title:"..."', meaning: 'Match within the title.' },
      {
        value: 'doi:"10.7483/OPENDATA.CMS.YLIC.86ZZ"',
        meaning: 'DOI match; case-sensitive, and portal DOIs are stored uppercase.',
      },
      { value: 'recid:(1 OR 2)', meaning: 'Records by recid.' },
      { value: 'slug:("a" OR "b")', meaning: 'Documentation and news pages by slug.' },
      {
        value: 'use_with.links.recid:N',
        meaning: 'Software and environment records that declare they work with record N.',
      },
      { value: 'run_period:("Run2012B")', meaning: 'Records for a run period.' },
      {
        value: 'type.primary:Environment',
        meaning: 'Field match on the primary record type (the type filter is usually simpler).',
      },
      { value: 'distribution.number_files:>10000', meaning: 'Numeric comparison on a field.' },
      {
        value: 'HLT_IsoMu*',
        meaning:
          'Trailing wildcard on a bare term; a field-qualified wildcard such as title:HLT_IsoMu* does not match.',
      },
      {
        value: '/DoubleMuParked/Run2012B-22Jan2013-v1/AOD',
        meaning: 'Slashes are escaped automatically, so dataset paths can be searched as written.',
      },
    ],
  },
  {
    topic: 'licensing',
    summary: 'How licenses and citations work for portal content.',
    entries: [
      {
        value: 'Datasets',
        meaning:
          'CC0-1.0 under the CERN Open Data Terms of Use. A Dataset record that states no license is reported as CC0-1.0 with basis cern_terms_default.',
      },
      {
        value: 'Per-record license',
        meaning:
          'A license the record states (CC0-1.0, GPL-3.0-only, MIT and Apache-2.0 are observed) is relayed with basis record.',
      },
      {
        value: 'Software, environments, documentation, supplementaries',
        meaning:
          "Licensed separately from the CC0 data. Without a stated license the basis is not_stated: check the record's portal page (software is commonly GPL).",
      },
      {
        value: 'Container images and guide code',
        meaning:
          'Always licensed separately from the data; cern_opendata_get_analysis_env marks them so.',
      },
      {
        value: 'Citation',
        meaning:
          'CERN asks reusers to cite the data they use by DOI in applications and publications; cern_opendata_get_records returns a ready citation for records with a DOI.',
      },
      {
        value: 'Terms of Use section 5',
        meaning:
          'CERN may restrict clients that interfere with portal operations; this server paces itself under the 60-requests-a-minute limit.',
      },
    ],
  },
  {
    topic: 'run_periods',
    summary:
      'Static snapshot dated 2026-10-01 of the CMS run periods with validated-run lists and the variants each has. cern_opendata_get_validated_runs reads the live CMS-Validated-Runs collection and is the source of truth, so a period added upstream after that date is still found by the live tool. A bare 2012B matches Run2012B. CMS trigger path records cover 2010-2016.',
    entries: RUN_PERIOD_SNAPSHOT.map((snapshot) => ({
      value: snapshot.period,
      meaning: describeRunPeriod(snapshot),
    })),
  },
];
