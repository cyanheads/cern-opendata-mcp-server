---
name: cern-opendata-guide
description: Find CERN Open Data suitable for an analysis with cern_opendata_* tools, follow datasets into file indexes and analysis environments, and resolve CMS certification and trigger evidence. Use when a task requires connecting these records or deciding whether the returned evidence is complete.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this server to discover published CERN Open Data and assemble the records, file locations, software context and documentation needed for an analysis. It supplies metadata and download locations; it does not execute physics analyses or stage tape files. CMS certification and trigger workflows do not establish coverage for other experiments.

## Identifiers

Resolve a DOI, CMS dataset path or portal URL with `cern_opendata_get_records` before following the returned recid into file or environment tools. Search hits for documentation and news carry a slug instead: use that slug to read their bodies.

Copy file-index keys from `cern_opendata_list_files`, validated-list recids from `cern_opendata_get_validated_runs` candidates, and menu recids from `cern_opendata_search_trigger_paths`. These are different hops; a dataset name, trigger name or guessed file name is not a replacement. Keep each file cursor with the record and index that issued it.

## Gates

- Before reporting that data is absent, inspect search notices and applied filters. Resolve unknown spellings with `cern_opendata_list_reference`; copy case-sensitive collection and keyword values from records. Facet lists can omit values, and each facet ignores its own filter. Neither an absent facet value nor the end of the 10,000-match paging window proves absence.
- Before reporting that a dataset has no files, inspect indexes, child records and availability. An umbrella record delegates files to children; an indexed record can return no regular files while listing many indexed files. Tape-only records can state a file count without exposing file entries. Direct the user to the portal for staging rather than treating a returned location as immediately downloadable.
- Before declaring an environment complete, read its notices and guide fetch state. A failed linked-record lookup can yield empty arrays; a guide excerpt is not the complete guide. Resolve omissions needed for the user's task before giving setup instructions.
- Before treating certified runs as the selected answer, require one selected list. Several candidates mean a reconstruction-pass or intended-use choice remains. Use their titles and the dataset context to choose; do not silently take the first or substitute muons-only certification for full certification.
- Before claiming trigger applicability, check the dataset's run range against the returned per-version coverage. If parsing failed, inspect the returned abstract rather than treating missing parsed fields as absent physics information. Path existence alone establishes neither applicability throughout the dataset nor a prescale factor.

## Core chain

Discover candidate datasets with `cern_opendata_search_records`, inspect full records with `cern_opendata_get_records`, then follow the chosen recid into files and analysis context. Compare the record's experiment, collision or simulation type, data tier, run period and stated usage with the requested analysis before choosing it. Retain the returned citation when delivering the data selection.

## Workflows

### Locate the data files

Call `cern_opendata_list_files` on the selected record. Follow child recids when the record is an umbrella, or choose a returned index key when files are grouped. Page within that scope using the returned cursor unchanged. For an entire index's XRootD locations, use its returned URI-list URL rather than reconstructing paths. Report tape staging and incomplete portal listings explicitly.

### Assemble the analysis environment

Call `cern_opendata_get_analysis_env` on the selected dataset. Use the dataset's stated release, global tag and images as the starting context; inspect candidate condition, VM and validation records before choosing among them. The environment search includes run-period matches, so appearing in the result alone does not establish suitability for the chosen collision or simulated dataset.

Read relevant guides with `cern_opendata_get_records` when their excerpts do not cover the needed setup step. Follow a guide's slug and the supplied continuation offset; continue full document bodies with their returned next offset. Preserve reference definitions supplied beside excerpts when resolving their links. Keep separately licensed software and guide code distinct from the data's license.

### Establish CMS certification and trigger context

Start `cern_opendata_get_validated_runs` from the CMS collision dataset so its linked certification and dataset run bounds guide selection. If several lists match, select the appropriate candidate and continue with its recid. When changing from dataset selection to a list recid, carry forward the dataset bounds if the task still concerns that dataset: a list recid selects the list itself. Distinguish whole-list summary counts from returned runs, and preserve the upper run bound when continuing a bounded result.

If the dataset links no list, follow the tool's period-specific recovery. The reference table is a snapshot; the live validated-run collection is authoritative. Do not infer that an unsupported period or a non-CMS dataset has no valid data.

Take trigger names from the dataset's methodology or other stated analysis context into `cern_opendata_search_trigger_paths`. Compare the returned year and version run ranges with the dataset. For prescales, follow menu recids into configuration files and locate CMS luminosity records for the column used by run and luminosity section; trigger search does not return those factors. Its 2011–2016 coverage limits any negative conclusion.

For field queries and exact filter vocabulary, consult `cern_opendata_list_reference` rather than translating portal URL parameters into tool arguments.
