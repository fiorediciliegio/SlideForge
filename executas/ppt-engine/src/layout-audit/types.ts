export type AuditSeverity = "info" | "warning" | "suspicious" | "error";

export type AuditRule =
  | "SLIDE_OUT_OF_BOUNDS"
  | "CONTAINER_OVERFLOW"
  | "TEXT_OVERFLOW"
  | "ELEMENT_OVERLAP"
  | "TEXT_RING_CONTACT"
  | "TEXT_FRAME_CONTACT"
  | "BROKEN_IMAGE"
  | "RENDER_STATE";

export interface AuditRect {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface AuditTextLineRect extends AuditRect {
  fontSize: number;
  lineHeight: number;
}

export interface AuditBorderBand {
  side: "top" | "right" | "bottom" | "left";
  width: number;
  colorAlpha: number;
  rect: AuditRect;
}

export interface AuditElement {
  index: number;
  tagName: string;
  selector: string;
  text: string;
  rect: AuditRect;
  zIndex: number | null;
  position: string;
  display: string;
  overflowX: string;
  overflowY: string;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  parentIndex: number | null;
  ancestorIndices: number[];
  isImage: boolean;
  isTextLeaf: boolean;
  textLineRects: AuditTextLineRect[];
  borderBands: AuditBorderBand[];
  hasNamedClass: boolean;
  imageComplete?: boolean;
  imageNaturalWidth?: number;
  imageNaturalHeight?: number;
  className: string;
  positioningContextIndex: number | null;
}

export interface AuditOverlap {
  firstIndex: number;
  secondIndex: number;
  intersection: AuditRect;
  intersectionArea: number;
  smallerElementArea: number;
  smallerElementRatio: number;
  severity: AuditSeverity | "ignored";
  reason?: string;
}

export interface AuditIssue {
  rule: AuditRule;
  severity: AuditSeverity;
  message: string;
  elementIndices: number[];
  details?: Record<string, unknown>;
}

export interface AuditSlideReport {
  slideIndex: number;
  pageId?: string | null;
  selector: string;
  rect: AuditRect;
  canvas: { width: number; height: number };
  renderState: "ready" | "hidden" | "invalid" | "unknown";
  elements: AuditElement[];
  rawOverlaps: AuditOverlap[];
  issues: AuditIssue[];
}

export interface AuditSourceHint {
  pageId: string | null;
  tsxFile: string | null;
  anchorText: string | null;
  likelyLineStart: number | null;
  likelyLineEnd: number | null;
}

export interface AgentProblem {
  problemId: string;
  rules: AuditRule[];
  severity: AuditSeverity;
  confidence: number;
  title: string;
  diagnosis: string;
  target: {
    elementIndices: number[];
    selectors: string[];
    texts: string[];
    rects: AuditRect[];
  };
  affectedElementCount: number;
  evidence: Record<string, unknown>;
  sourceHint: Pick<AuditSourceHint, "anchorText" | "likelyLineStart" | "likelyLineEnd">;
  detailsRef: string;
}

export interface AgentSlideReport {
  slideIndex: number;
  pageId: string | null;
  tsxFile: string | null;
  renderState: AuditSlideReport["renderState"];
  problems: AgentProblem[];
}

export interface AgentAuditReport {
  schemaVersion: 1;
  reportType: "agent";
  input: string;
  generatedAt: string;
  viewport: { width: number; height: number };
  summary: {
    slideCount: number;
    problemCount: number;
    errorCount: number;
    warningCount: number;
    slidesWithProblems: number;
  };
  slides: AgentSlideReport[];
  debugReport: {
    available: true;
    note: string;
  };
}

export interface LayoutAuditOptions {
  input: string;
  slideSelector?: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  overlapThresholds?: {
    warning: number;
    suspicious: number;
    error: number;
  };
}

export interface LayoutAuditReport {
  schemaVersion: 1;
  input: string;
  generatedAt: string;
  viewport: { width: number; height: number };
  slideSelector: string | null;
  slides: AuditSlideReport[];
  summary: {
    slideCount: number;
    visibleElementCount: number;
    issueCount: number;
    errorCount: number;
    warningCount: number;
  };
  metadata: {
    engine: "ppt-engine-dom-geometry-auditor";
    readiness: "browser-rendered";
    heuristicNote: string;
  };
}
