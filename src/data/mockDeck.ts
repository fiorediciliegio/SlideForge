import type {
  OutlineAnalysis,
  OutlineResearchPlan,
  OutlineTextSegment,
} from "../api/outlineTypes";

export interface Slide {
  title: string;
  subtitle: string;
}

export type OutlinePageType = "cover" | "standard";

export interface OutlineDetail {
  /** 当前页选中的素材标识；空数组表示不配图。 */
  selected_image_ids?: string[];
  page_type: OutlinePageType;
  title: string;
  /** 这一页的完整内容；默认散文，用户指定的形式和原文优先。 */
  content: string;
  title_segments?: OutlineTextSegment[];
  research?: OutlineResearchPlan;
  analysis?: OutlineAnalysis;
  /** 用户明确提出的本页创作要求；无要求时省略。 */
  creation_requirements?: string;
}

/**
 * 页面设计 Agent 看到的这一页内容。内容采用大纲已确认的文案形式，
 * 这里不再做任何结构化改写。
 */
export function outlineDetailToText(item: OutlineDetail): string {
  return item.content;
}

export function legacyOutlineTextToDetail(title: string, value: string): OutlineDetail {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    page_type: "standard",
    title,
    content: lines.join("\n") || title,
  };
}

export interface LocalDeck {
  name: string;
  editedLabelKey: "today" | "yesterday" | "date";
  editedDate?: string;
  slides: number;
}

export const initialDeck: Slide[] = [
  {
    title: "AI Agents That Do the Work",
    subtitle:
      "Repeatable workflows transformed into reusable AI skills for the enterprise."
  },
  {
    title: "The Cost of Manual Work",
    subtitle:
      "Research, notes, spreadsheets, and emails create hidden operational drag."
  },
  {
    title: "From Tasks to Reusable Skills",
    subtitle: "Repeated workflows can become reusable AI capabilities."
  },
  {
    title: "How Anna Executes Across Tools",
    subtitle: "Anna connects reasoning, local execution, and approved tools."
  },
  {
    title: "Business Development Example",
    subtitle: "Turn one company name into a pitch-ready collaboration package."
  },
  {
    title: "Security Boundaries",
    subtitle: "Authority, data, and execution must be bounded by the system."
  },
  {
    title: "Build Your First AI Skill",
    subtitle:
      "Start with one repeated workflow and package it into a reusable skill."
  }
];

export const outlineDetails: OutlineDetail[] = [
  {
    page_type: "cover",
    title: "AI Agents That Do the Work",
    content: "Contrast chat-based AI with agents that execute workflows. Explain how repeated processes become reusable AI skills. Position Anna as the system that turns instructions into executable work."
  },
  {
    page_type: "standard",
    title: "The Cost of Manual Work",
    content: "Cover research, notes, spreadsheets, and email handoffs. Highlight copy-paste errors and fragmentation. Show the cost of repeated weekly processes."
  },
  {
    page_type: "standard",
    title: "From Tasks to Reusable Skills",
    content: "Capture the workflow once. Package the steps as a reusable skill. Run the same capability again with new inputs."
  },
  {
    page_type: "standard",
    title: "How Anna Executes Across Tools",
    content: "Introduce local tools, browser actions, and approved services. Separate conversational reasoning from execution. Emphasize that users remain in control."
  },
  {
    page_type: "standard",
    title: "Business Development Example",
    content: "Start with one company name. Research and organize the findings. Produce a pitch-ready collaboration brief."
  },
  {
    page_type: "standard",
    title: "Security Boundaries",
    content: "Explain why prompts are not a security boundary. Cover mediated access to credentials, files, and tools. Show how authority remains bounded."
  },
  {
    page_type: "standard",
    title: "Build Your First AI Skill",
    content: "Choose one repeated process. Define its inputs and outputs. Package it so Anna can run it again."
  }
];

export const localDecks: LocalDeck[] = [
  { name: "AI Agent Workflows", editedLabelKey: "today", slides: 7 },
  { name: "BD Workflow Pitch", editedLabelKey: "yesterday", slides: 9 },
  {
    name: "Security Boundaries",
    editedLabelKey: "date",
    editedDate: "May 6",
    slides: 6
  },
  {
    name: "Investor Update",
    editedLabelKey: "date",
    editedDate: "May 3",
    slides: 12
  }
];

export function createLocalProjectDeck(projectName: string): Slide[] {
  const count =
    localDecks.find((deck) => deck.name === projectName)?.slides ?? 7;

  return Array.from({ length: count }, (_, index) => ({
    title: `${projectName} Slide ${index + 1}`,
    subtitle: "Local project data"
  }));
}
