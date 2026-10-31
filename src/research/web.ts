/**
 * F1 · 联网研究：DuckDuckGo HTML 检索 + 正文抓取（免 API key）。
 * 检索结果带来源 URL，注入生成时强制来源归属。
 */

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
  text?: string;
}

export interface ResearchResult {
  query: string;
  sources: ResearchSource[];
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

export async function searchWeb(query: string, maxResults = 4): Promise<ResearchSource[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`检索失败：HTTP ${response.status}`);
  const html = await response.text();

  const sources: ResearchSource[] = [];
  const resultBlocks = html.split(/class="result results_links/g).slice(1);
  for (const block of resultBlocks) {
    const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    let href = decodeEntities(linkMatch[1]);
    // DuckDuckGo 跳转链接里取 uddg 真实地址
    const uddg = href.match(/uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    const title = decodeEntities(linkMatch[2].replace(/<[^>]+>/g, "").trim());
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? decodeEntities(snippetMatch[1].replace(/<[^>]+>/g, "").trim()) : "";
    sources.push({ title, url: href, snippet });
    if (sources.length >= maxResults) break;
  }
  return sources;
}

export async function fetchPageText(url: string, maxChars = 2500): Promise<string> {
  try {
    const response = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return "";
    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, maxChars);
  } catch {
    return "";
  }
}

export async function researchWeb(query: string): Promise<ResearchResult> {
  const sources = await searchWeb(query, 3);
  // 只抓前两个正文，控制时延与 token 预算
  for (const source of sources.slice(0, 2)) {
    source.text = await fetchPageText(source.url);
  }
  return { query, sources };
}

/** 检索资料 → 提示词注入块（强制来源归属）。 */
export function researchContextBlock(result: ResearchResult): string {
  const lines = result.sources.map((source, index) => {
    const body = source.text ? `正文摘录：${source.text}` : `摘要：${source.snippet}`;
    return `[资料 ${index + 1}] 标题：${source.title}\n来源：${source.url}\n${body}`;
  });
  return `【联网检索资料，使用时必须保留来源归属，不得把推测写成事实】\n${lines.join("\n\n")}`;
}
