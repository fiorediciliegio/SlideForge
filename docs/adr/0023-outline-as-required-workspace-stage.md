---
status: accepted
---

# Outline is a required independent Workspace stage

Outline is a required Workspace stage between Confirmed Presentation Requirements and downstream Deck Generation. Presentation Requirements Confirmation clears the current Outline and automatically starts Outline Creation; the resulting valid Outline Draft must always pass through Outline Review and explicit Outline Confirmation before downstream work begins.

Outline Creation and Rewrite Requests consume Confirmed Presentation Requirements directly, without legacy context rows or Outline-owned output language, and run before template handling or visual theme creation. Outline Creation uses the compact title/content/research output protocol; Rewrite Requests additionally carry and return page type and Copy Rewrite Freedom metadata. The Outline artifact owns only its title, lifecycle, and ordered entries; each entry contains a title, Core Message, Required Content Markdown, page type, and Copy Rewrite Freedom.

Manual edits remain local until Save or Outline Confirmation, while successful Rewrite Requests save automatically. Rewrite Requests may make explicit structural changes and remain in Outline Review until the user confirms the result. `ppt-engine` owns deterministic Outline validation and the unified save and confirmation operations that also synchronize Presentation Requirements `slide_count` and the Workspace title. Existing legacy Outline tools and schemas are removed rather than migrated during local development.

**Consequences**

- Outline lifecycle is `empty`, `draft`, or `confirmed`; transient creation and failure states remain UI and interaction-log concerns.
- Outline Drafts contain no `page_id`; Outline Confirmation atomically assigns a fresh identity to every entry for the new Confirmed Outline and Deck Generation.
- Outline Review supports editing the presentation title, editing all entry fields, adding and deleting entries, reordering entries, and submitting a natural-language Rewrite Request.
- Every persisted Outline Draft and Confirmed Outline is complete and valid: the title is non-empty, at least one entry exists, every entry has a one-line title and Core Message, and Required Content contains at least one non-empty line. Outline Review accepts plain lines or Markdown list markers and deterministically normalizes every saved line into the canonical `- ` list form.
- Outline page count is flexible. Saving a valid Outline synchronizes the confirmed Presentation Requirements `slide_count` to the saved entry count without reopening Presentation Requirements Review.
- During Active Deck Generation, navigation away from generation and Outline editing are disabled. After generation completes, a saved Outline Draft may coexist with the previous Deck until the user confirms the Outline; confirmation replaces the old generation state and starts full regeneration.
- Full regeneration after Outline reconfirmation clears Page Progress and derived render artifacts, assigns new identities to every entry, and initializes every active Page Source from the Bootstrap. Partial identity and Page Source preservation belongs to future Deck Refinement or Page Refinement instead.
- The Workspace stores only the current Outline and does not retain a separate prior Confirmed Outline or parallel Deck version.

## 本次大纲协议迁移

Outline Creation 与 Rewrite 现在统一返回 `presentation_title` 和 `pages`，每页只包含 `title` 与 `content: string[]`。研究计划、视觉重点和 AI 幻觉检查不再属于大纲领域模型；Web 事实资料在大纲生成前由独立 Web Research 阶段产出并注入提示词。
