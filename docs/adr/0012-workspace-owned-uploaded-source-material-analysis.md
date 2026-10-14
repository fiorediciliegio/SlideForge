# Workspace-owned Uploaded Source Material analysis

Deck authoring will support user-uploaded source files as Workspace-owned Uploaded Source Material. Uploaded files are saved and indexed as Workspace artifacts from upload time; their identity is a stable uploaded-source id, not the original filename, so same-name or same-content uploads can remain distinct. Deleting an attachment removes it from the active uploaded-source set by default rather than making filename reuse overwrite older material. The first version uses an allowlist and size limits instead of accepting arbitrary files.

Uploaded Source Material is not Raw Research Material and is not Research Evidence by itself. The app will not run a fixed extraction pipeline for Excel, Word, HTML, or other supported files before analysis. Instead, Uploaded Source Factual Analysis and Uploaded Source Visual Analysis run in separate Agent sessions that receive the uploaded artifact paths and decide how to inspect them with available session tools. Each Agent writes a draft; app code applies deterministic draft gates and merges valid drafts into a deck-level Uploaded Source Analysis. A valid draft may report that some uploaded material could not be parsed or understood and still allow continuation through a structured continuation decision. Agent session failure, missing drafts, invalid drafts, missing continuation decisions, and analysis timeout are analysis failures; Outline Creation continues without Uploaded Source Analysis context instead of blocking the workflow, and it must not consume a partial or invalid analysis.

The first attachment-analysis integration uses a valid Uploaded Source Analysis only as optional Outline Creation context. Page Authoring does not read the full analysis, and Research Discovery does not treat it as prior source context. Attachment-derived content reaches Page Authoring only through the Confirmed Outline. A later evidence-aware integration may assign relevant uploaded-source facts and visual assets into page-level Research Evidence, but that is outside this decision's initial scope.

**Considered Options**

- Treat uploaded files as Raw Research Material. Rejected because user-provided files have a different trust and lifecycle boundary from web/image search results, and they must inform Outline Creation before Research Discovery exists.
- Let Page Authoring read full Uploaded Source Analysis directly. Rejected because it would bypass page-level evidence assignment and reintroduce a deck-level grounding pool into page authoring.
- Run a deterministic app-side extraction pipeline before Agent analysis. Rejected for this design because the intended behavior is to rely on Agent session capabilities to inspect supported uploaded artifacts, while app code owns persistence, indexing, path handling, stale checks, draft gates, and merging.
- Use original filenames as uploaded material identity or dedupe same-name/same-content uploads automatically. Rejected because filenames are display metadata, not stable identity, and automatic dedupe would obscure user operation history and replacement/deletion semantics.
- Merge uploaded factual and visual analysis into one Agent draft. Rejected for the same reason Research Curation drafts are split: factual evidence and visual-asset judgment have different failure modes and must not promote image text or chart content as factual evidence unless separately captured.

**Consequences**

- Uploading requires a Workspace; if none exists, the app must create or select one before saving Uploaded Source Material.
- Uploading, removing, or replacing Uploaded Source Material makes existing Uploaded Source Analysis stale and requires dependent Outline Drafts or Confirmed Outlines to be regenerated or reconfirmed before downstream generation uses the changed material.
- Uploaded Source Analysis is best-effort before Outline Creation. Failure, timeout, or a non-continuable result is recorded for diagnostics, then Outline Creation proceeds without attachment context.
- The initial integration does not promote uploaded-source facts or visual assets into Research Evidence; Page Authoring receives attachment-derived content only when it is represented in the Confirmed Outline.
- The app must expose uploaded-source indexing, active/removed status, duplicate warnings, Agent file-tool paths, draft validation, and analysis freshness without implementing format-specific content extraction as the default path.
