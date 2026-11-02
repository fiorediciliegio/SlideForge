import { z } from "zod";

export const engineValidatePageSchema = z.object({
  html: z.string().min(1).max(1_000_000),
});

export const enginePreviewSchema = z.object({
  runDir: z.string().min(1),
  pages: z.array(z.number().int().min(1)).max(4).optional(),
  maxPages: z.number().int().min(1).max(20).optional(),
});

export const engineExportSchema = z.object({
  runDir: z.string().min(1),
  outPath: z.string().min(1).optional(),
  format: z.enum(["pptx", "pdf"]).optional(),
});
