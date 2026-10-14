import type { PageProgress, RenderDeckHtmlResult, WorkspaceOutline, WorkspaceResult } from "../../src/api/types";
import { createEmptyPresentationRequirements } from "../../src/features/requirements";

export function pageAdoptionFixture(workspaceDir = "/page-adoption") {
  const pageId = "page-9";
  const before = "2026-09-30T06:00:00.000Z";
  const after = "2026-09-30T06:10:00.000Z";
  const outline: WorkspaceOutline = {
    version: 4, status: "confirmed", title: "测试演示", updated_at: before, confirmed_at: before,
    items: Array.from({ length: 12 }, (_, index) => ({ page_id: `page-${index + 1}`,
      page_type: "standard", title: `第 ${index + 1} 页标题`, content: `第 ${index + 1} 页正文` })),
  };
  const progress: PageProgress = {
    version: 1, status: "completed", updated_at: before,
    pages: outline.items.map((item) => ({ page_id: item.page_id!, status: "accepted",
      render_attempts: 1, visual_review_attempts: 0, agent_failures: 0, agent_infrastructure_failures: 0,
      last_html_path: `${workspaceDir}/output/${item.page_id}.html`, last_screenshot_path: "", last_error: "",
      render_source_sha256: `source-${item.page_id}`, snapshot_source_sha256: `source-${item.page_id}`, updated_at: before,
    })),
  };
  const workspace: WorkspaceResult = {
    workspace_root: "/", workspace_dir: workspaceDir, workspace_id: workspaceDir.slice(1),
    task: { title: outline.title }, setting: {}, outline, page_progress: progress,
    requirements: { ...createEmptyPresentationRequirements(), status: "confirmed" },
  };
  const nextProgress: PageProgress = { ...progress, updated_at: after,
    pages: progress.pages.map((page) => page.page_id === pageId ? { ...page,
      render_source_sha256: "new-source", snapshot_source_sha256: "new-source", updated_at: after,
      last_html_path: `${workspaceDir}/output/adopted/page.html`,
    } : page),
  };
  const nextWorkspace: WorkspaceResult = { ...workspace, page_progress: nextProgress };
  const rendered: RenderDeckHtmlResult = {
    workspace_dir: workspaceDir, manifest_path: `${workspaceDir}/manifest.json`,
    output_dir: `${workspaceDir}/output`, deck_html_path: `${workspaceDir}/output/deck.html`,
    title: outline.title, slide_count: 12, rendered_at: before,
    slides: outline.items.map((item, index) => ({ slide_id: item.page_id!, title: item.title, layout_id: "",
      html_path: progress.pages[index].last_html_path, screenshot_path: "", speaker_note: "",
      render_source_fingerprint: progress.pages[index].render_source_sha256,
      preview_source_fingerprint: `preview-${item.page_id}`,
    })),
  };
  const metadata: RenderDeckHtmlResult = { ...rendered, rendered_at: after,
    slides: nextProgress.pages.map((page) => ({ slide_id: page.page_id, title: page.page_id, layout_id: "",
      html_path: "", preview_unavailable: true, screenshot_path: "", speaker_note: "", manually_edited: false,
      render_source_fingerprint: page.render_source_sha256, preview_source_fingerprint: "", preview_version: page.updated_at!,
    })),
  };
  return { pageId, outline, progress, nextProgress, workspace, nextWorkspace, rendered, metadata };
}
