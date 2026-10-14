import type { PptBackend } from "../../api/pptBackend";
import type { TemplateReferenceHtmlPage, TemplateReferencePage } from "../../api/types";

export async function resolveWorkspaceTemplateReference(input: {
  backend: Pick<PptBackend, "listWorkspaceTemplateReferences" | "getWorkspaceTemplateReferenceHtml">;
  workspaceDir: string;
  selectedPath: string;
  selectReference: (candidates: TemplateReferencePage[]) => Promise<string>;
}): Promise<TemplateReferenceHtmlPage> {
  let selectedPath = input.selectedPath;
  if (!selectedPath) {
    const catalog = await input.backend.listWorkspaceTemplateReferences({
      workspace_dir: input.workspaceDir,
    });
    selectedPath = await input.selectReference(catalog.reference_html_pages);
  }
  return input.backend.getWorkspaceTemplateReferenceHtml({
    workspace_dir: input.workspaceDir,
    path: selectedPath,
  });
}
