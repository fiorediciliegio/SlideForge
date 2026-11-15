import { z } from "zod";

export const engineSnapshotSchema = z.object({
  schema_version: z.literal(1), deck_id: z.string().min(1).max(128), revision_id: z.string().max(128).optional(), title: z.string().max(1000),
  pages: z.array(z.object({ page_id: z.string().regex(/^[\w-]+$/), html: z.string().min(1).max(2_000_000) }).strict()).min(1).max(20),
  deck_html: z.string().max(40_000_000).optional(),
}).strict();
export type EngineSnapshot = z.infer<typeof engineSnapshotSchema>;
export interface EngineParams { pages?: number[]; layout?: boolean; visual?: boolean; format?: "pptx" | "pdf" }
export interface EngineRequest {
  owner_key_hash: string; deck_id: string; snapshot_id: string; source_hash: string;
  kind: "validate" | "inspect" | "export"; operation_id: string; profile_version: string; params: EngineParams;
  agent_run_seq?: number; agent_epoch?: number;
}
export interface EngineJob extends EngineRequest {
  job_id: string; state: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string; attempt: number; lease_token?: string; queued_at: string; started_at?: string; finished_at?: string;
  result_ref?: string; error?: string;
}
export interface EngineArtifact { artifact_id: string; sha256: string; size_bytes: number }
export interface EngineResult {
  pages?: Array<{ page: number; page_id: string; report?: { ok: boolean; issues: Array<{kind:"overflow-x"|"overflow-y";detail:string}> }; image?: string }>;
  file_ref?: string; name?: string; media_type?: string; slide_count?: number; warnings?: string[];
  timings_ms?: { execution: number };
}
