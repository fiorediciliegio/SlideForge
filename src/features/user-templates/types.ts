import type { HostUploadRef, VisualStylePresetPreview, PrepareWorkspaceDiagnosticBundleResult } from "../../api/types";
import type { UserTemplateLogChannel, UserTemplateDiagnosticContext } from "../../../executas/ppt-engine/src/user-templates/diagnostics";
import type { UserTemplate, DesignProfile } from "../../../executas/ppt-engine/src/user-templates/types";
export type { UserTemplate, UserTemplateMetadata, DesignProfile, DesignProfileColor, DesignProfileFixedAsset } from "../../../executas/ppt-engine/src/user-templates/types";

/** Metadata of one imported profile asset (e.g. a logo) stored under the template's assets/ directory. */
export interface ProfileAssetMeta {
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export interface UserTemplateListEntry extends UserTemplate {
  preview_images: VisualStylePresetPreview[];
}
export interface UserTemplateBackend {
  readonly diagnosticLoggingEnabled?: boolean;
  listUserTemplates(): Promise<{ templates: UserTemplateListEntry[] }>;
  getUserTemplate(input: { id: string; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<UserTemplate>;
  createUserTemplate(input: { filename: string; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<UserTemplate>;
  createImageUserTemplate(input: { files: { filename: string; host_upload: HostUploadRef }[]; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<UserTemplate>;
  saveUserTemplateSource(input: { id: string; filename: string; host_upload: HostUploadRef; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<UserTemplate>;
  selectUserTemplatePages(input: { id: string; page_numbers: number[]; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<UserTemplate>;
  saveUserTemplateHtml(input: { id: string; page_number?: number; content: string; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<UserTemplate>;
  saveUserTemplateProfile(input: { id: string; profile: DesignProfile; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<UserTemplate>;
  saveUserTemplateProfileAsset(input: { id: string; filename: string; host_upload: HostUploadRef; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<ProfileAssetMeta>;
  publishUserTemplate(input: { id: string; metadata: import("./types").UserTemplateMetadata; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<UserTemplate>;
  getUserTemplateHtml(input: { id: string; page_number?: number; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<{ html: string; previous_html: string | null }>;
  getUserTemplateAsset(input: { id: string; asset: "source" | "reference" | "preview" | "profile_asset"; page_number?: number; filename?: string; diagnostic_context?: UserTemplateDiagnosticContext }): Promise<HostUploadRef>;
  appendUserTemplateLog(input: { id: string; channel: UserTemplateLogChannel; entry: Record<string, unknown>; payload_keys?: string[] }): Promise<{ appended: boolean }>;
  prepareUserTemplateDiagnosticBundle(input: { id: string }): Promise<PrepareWorkspaceDiagnosticBundleResult>;
  deleteUserTemplate(input: { id: string }): Promise<{ deleted: true; id: string }>;
}

export type TemplateStage = "upload" | "analyze" | "images" | "master" | "pages" | "describe" | "profile";
/** One reference page's live state inside the recreation step. */
export interface TemplatePageProgress { page_number: number; status: "pending" | "running" | "done"; preview_url?: string }
/** A page whose dominant colors drifted from the confirmed palette. */
export interface TemplateStepDetailDrift { page_number: number; unmatched: string[] }
/** Optional expandable payload for one timeline step. */
export interface TemplateStepDetail {
  page_numbers?: number[];
  images?: { page_number: number; url: string }[];
  master_preview_url?: string;
  pages?: TemplatePageProgress[];
  name?: string;
  description?: string;
  profile_colors?: string[];
  drifts?: TemplateStepDetailDrift[];
}
export interface TemplateProgress { stage: TemplateStage; completed?: number; total?: number; detail?: TemplateStepDetail }
/** A timeline entry accumulated by the hook from the workflow's stage reports. */
export interface TemplateStep extends TemplateProgress { status: "running" | "done" | "failed" | "stopped" }
