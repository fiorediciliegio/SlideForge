export type OutlineSource = "user" | "ai" | "research";
export interface OutlineTextSegment {
  text: string;
  source: OutlineSource;
  focus: boolean;
}

export interface OutlineContentItem {
  segments: OutlineTextSegment[];
}

export interface OutlineResearchDirection {
  directions: string[];
  reason: string;
}

export interface OutlineResearchPlan {
  web: OutlineResearchDirection | null;
  images: OutlineResearchDirection | null;
}

/**
 * Lightweight per-page analysis produced after the outline itself is created.
 * `focus` stores the page's visual focus recommendation for compatibility with
 * existing workspace artifacts; `ai_generated_content` stores the AI
 * hallucination check text shown to the user. The research booleans are kept
 * so the downstream workflow can decide whether to run each search channel.
 */
export interface OutlineAnalysis {
  focus: string;
  ai_generated_content: string;
  web_needed: boolean;
  web_analysis: string;
  images_needed: boolean;
  images_analysis: string;
}
