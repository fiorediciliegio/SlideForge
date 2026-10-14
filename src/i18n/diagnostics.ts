/**
 * 诊断信息错误码体系（系统语言 v1 · 反馈 1 指定方向）。
 *
 * 背景：研究流程的 gaps / rationale / diagnostic_errors 直接以中/英文字符串
 * 持久化进 checkpoint，日德界面只能落英文，且切换语言后旧文案不会跟随。
 *
 * 设计（方案 §4.7 / 决策 D8）：
 * - 产生点只持久化「错误码 + 参数」，不持久化文案：
 *     gaps.push(encodeDiagnostic("IMG_SEARCH_LIMIT_REACHED", { limit: 12 }))
 *     → "@diag:IMG_SEARCH_LIMIT_REACHED {\"limit\":12}"
 * - 展示层经 renderDiagnostic(locale, raw) 解码并按当前界面语言翻译；
 * - 非码值（历史记录 / 外部数据）原样透传——历史 checkpoint 零迁移（D5）；
 * - 四语文案用 satisfies Record<Locale, string> 编译期强制对齐，加语言时
 *   TypeScript 直接报缺口，无需回填历史数据。
 */

import type { Locale } from "./locales";
import { formatMessage } from "./index";

export const DIAGNOSTIC_PREFIX = "@diag:";

export const diagnosticCodes = [
  // ---- 图片研究（image research）----
  "IMG_SESSION_DECIDES_SCOPE",
  "IMG_ATTACHMENT_BUDGET_REACHED_SKIPPED",
  "IMG_ATTACHMENT_BUDGET_REACHED_PRESERVED",
  "IMG_SKIPPED_SINGLE_SIZE_LIMIT",
  "IMG_SKIPPED_BUDGET_REACHED",
  "IMG_SOME_EXCEEDED_SIZE_LIMIT",
  "IMG_SEARCH_INTERRUPTED_RESUMED",
  "IMG_RECOVERY_REATTACH_FAILED",
  "IMG_ATTACHMENT_URL_FAILED",
  "IMG_AGENT_PROTOCOL_ERRORS",
  "IMG_IMPORT_SAVE_FAILED",
  "IMG_SEARCH_LIMIT_REACHED",
  "IMG_SEARCH_LIMIT_REACHED_GENERIC",
  "IMG_DUPLICATE_QUERY",
  "IMG_QUERY_NO_CANDIDATES",
  "IMG_APS_FETCH_FAILED",
  "IMG_EXISTING_SUFFICIENT",
  "IMG_SESSION_INCOMPLETE",
  "IMG_NO_USABLE_CANDIDATES",
  "IMG_DISABLED_IN_SETTINGS",
  // ---- 网页研究（web research）----
  "WEB_QUERY_FAILED",
  "WEB_QUERY_NO_RESULTS",
  "WEB_PAGE_READ_FAILED",
] as const;

export type DiagnosticCode = (typeof diagnosticCodes)[number];

export type DiagnosticParams = Record<string, string | number>;

/** 把诊断码 + 参数编码为可持久化的单字符串（不改变 gaps: string[] 协议）。 */
export function encodeDiagnostic(code: DiagnosticCode, params: DiagnosticParams = {}): string {
  const keys = Object.keys(params);
  return keys.length > 0 ? `${DIAGNOSTIC_PREFIX}${code} ${JSON.stringify(params)}` : `${DIAGNOSTIC_PREFIX}${code}`;
}

/** 解码持久化字符串；非码值（历史文案等）返回 null。 */
export function decodeDiagnostic(raw: string): { code: DiagnosticCode; params: DiagnosticParams } | null {
  if (typeof raw !== "string" || !raw.startsWith(DIAGNOSTIC_PREFIX)) return null;
  const body = raw.slice(DIAGNOSTIC_PREFIX.length);
  const spaceIndex = body.indexOf(" ");
  const codeText = spaceIndex === -1 ? body : body.slice(0, spaceIndex);
  if (!(diagnosticCodes as readonly string[]).includes(codeText)) return null;
  let params: DiagnosticParams = {};
  if (spaceIndex !== -1) {
    try {
      const parsed: unknown = JSON.parse(body.slice(spaceIndex + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed as DiagnosticParams;
      }
    } catch {
      return null;
    }
  }
  return { code: codeText as DiagnosticCode, params };
}

const diagnosticText = {
  IMG_SESSION_DECIDES_SCOPE: {
    zh: "由图片研究 Session 决定搜索范围。",
    en: "The image research Session will decide the search scope.",
    ja: "検索範囲は画像リサーチセッションが決定します。",
    de: "Der Suchumfang wird von der Bildrecherche-Session festgelegt.",
  },
  IMG_ATTACHMENT_BUDGET_REACHED_SKIPPED: {
    zh: "图片研究 Agent 附件总大小预算已达到 {budgetMb} MB，部分候选已跳过。",
    en: "The image research Agent attachment budget of {budgetMb} MB was reached; some candidates were skipped.",
    ja: "画像リサーチエージェントの添付ファイル総量上限 {budgetMb} MB に達したため、一部の候補をスキップしました。",
    de: "Das Anhangs-Budget des Bildrecherche-Agenten von {budgetMb} MB wurde erreicht; einige Kandidaten wurden übersprungen.",
  },
  IMG_ATTACHMENT_BUDGET_REACHED_PRESERVED: {
    zh: "图片研究 Agent 附件总大小预算已达到 {budgetMb} MB，已保留已有图片结果。",
    en: "The image research Agent attachment budget of {budgetMb} MB was reached; existing image results were preserved.",
    ja: "画像リサーチエージェントの添付ファイル総量上限 {budgetMb} MB に達したため、既存の画像結果を保持しました。",
    de: "Das Anhangs-Budget des Bildrecherche-Agenten von {budgetMb} MB wurde erreicht; vorhandene Bildergebnisse wurden beibehalten.",
  },
  IMG_SKIPPED_SINGLE_SIZE_LIMIT: {
    zh: "因图片超过图片研究 Agent 的单张附件大小限制而跳过。",
    en: "Skipped because the image exceeds the image research Agent single-attachment size limit.",
    ja: "画像が画像リサーチエージェントの添付ファイル1件あたりのサイズ上限を超えたためスキップしました。",
    de: "Übersprungen, da das Bild die Größenbeschränkung für einzelne Anhänge des Bildrecherche-Agenten überschreitet.",
  },
  IMG_SKIPPED_BUDGET_REACHED: {
    zh: "因图片研究 Agent 附件总大小预算已达到 {budgetMb} MB 而跳过。",
    en: "Skipped because the image research Agent attachment budget of {budgetMb} MB was reached.",
    ja: "画像リサーチエージェントの添付ファイル総量上限 {budgetMb} MB に達したためスキップしました。",
    de: "Übersprungen, da das Anhangs-Budget des Bildrecherche-Agenten von {budgetMb} MB erreicht wurde.",
  },
  IMG_SOME_EXCEEDED_SIZE_LIMIT: {
    zh: "部分候选图片超过单张附件大小限制，已跳过。",
    en: "Some image candidates exceeded the single-attachment size limit and were skipped.",
    ja: "一部の画像候補が添付ファイル1件あたりのサイズ上限を超えたためスキップしました。",
    de: "Einige Bildkandidaten überschritten die Größenbeschränkung für einzelne Anhänge und wurden übersprungen.",
  },
  IMG_SEARCH_INTERRUPTED_RESUMED: {
    zh: "上次图片搜索在结果写入前中断，已由新的图片研究 Session 继续处理。",
    en: "The previous image search was interrupted before its results were saved; a new image research Session will continue.",
    ja: "前回の画像検索は結果が保存される前に中断されました。新しい画像リサーチセッションが処理を引き継ぎます。",
    de: "Die vorherige Bildsuche wurde unterbrochen, bevor die Ergebnisse gespeichert wurden; eine neue Bildrecherche-Session setzt die Verarbeitung fort.",
  },
  IMG_ATTACHMENT_URL_FAILED: {
    zh: "部分图片无法获取有效的分析附件地址，已跳过。",
    en: "Some images could not obtain a valid analysis attachment URL and were skipped.",
    ja: "一部の画像で有効な分析用添付URLを取得できなかったため、スキップしました。",
    de: "Einige Bilder wurden übersprungen, da keine gültige URL für den Analyseanhang verfügbar war.",
  },
  IMG_RECOVERY_REATTACH_FAILED: {
    zh: "恢复图片研究时，部分待分析候选未能重新提供给 Session。",
    en: "Some pending image candidates could not be reattached while resuming image research.",
    ja: "画像リサーチの再開時に、分析待ちの一部候補をセッションに再添付できませんでした。",
    de: "Beim Fortsetzen der Bildrecherche konnten einige ausstehende Bildkandidaten der Session nicht erneut bereitgestellt werden.",
  },
  IMG_AGENT_PROTOCOL_ERRORS: {
    zh: "图片研究 Agent 连续返回无效协议，研究已中断。",
    en: "The image research Agent returned invalid protocol output repeatedly, so research was stopped.",
    ja: "画像リサーチエージェントが無効なプロトコル出力を繰り返し返したため、リサーチを中断しました。",
    de: "Der Bildrecherche-Agent hat wiederholt ungültige Protokollausgaben zurückgegeben; die Recherche wurde abgebrochen.",
  },
  IMG_IMPORT_SAVE_FAILED: {
    zh: "部分入选图片未能保存为本地素材。",
    en: "Some selected images could not be saved as local assets.",
    ja: "選択された一部の画像をローカルアセットとして保存できませんでした。",
    de: "Einige ausgewählte Bilder konnten nicht als lokale Assets gespeichert werden.",
  },
  IMG_SEARCH_LIMIT_REACHED: {
    zh: "图片研究已达到最多 {limit} 次搜索。",
    en: "Image research reached the maximum of {limit} searches.",
    ja: "画像リサーチの検索回数が上限の {limit} 回に達しました。",
    de: "Die Bildrecherche hat das Maximum von {limit} Suchanfragen erreicht.",
  },
  IMG_SEARCH_LIMIT_REACHED_GENERIC: {
    zh: "已达到图片搜索上限。",
    en: "The image search limit was reached.",
    ja: "画像検索の上限に達しました。",
    de: "Das Limit für die Bildsuche wurde erreicht.",
  },
  IMG_DUPLICATE_QUERY: {
    zh: "图片研究 Agent 重复提出搜索词“{query}”，已停止继续搜索。",
    en: "The image research Agent repeated query “{query}”; further image search was stopped.",
    ja: "画像リサーチエージェントが検索クエリ「{query}」を繰り返し提案したため、これ以上の画像検索を停止しました。",
    de: "Der Bildrecherche-Agent hat die Suchanfrage „{query}“ wiederholt; die weitere Bildsuche wurde gestoppt.",
  },
  IMG_QUERY_NO_CANDIDATES: {
    zh: "图片搜索词“{query}”未获得可用候选。",
    en: "No usable image candidates were collected for query “{query}”.",
    ja: "検索クエリ「{query}」で利用可能な画像候補を取得できませんでした。",
    de: "Für die Suchanfrage „{query}“ wurden keine verwertbaren Bildkandidaten gefunden.",
  },
  IMG_APS_FETCH_FAILED: {
    zh: "部分候选图片未能通过 APS 获取。",
    en: "Some image candidates could not be fetched into APS.",
    ja: "一部の画像候補を APS から取得できませんでした。",
    de: "Einige Bildkandidaten konnten nicht in APS abgerufen werden.",
  },
  IMG_EXISTING_SUFFICIENT: {
    zh: "已有图片素材足够，未执行新的图片搜索。",
    en: "Existing image assets were sufficient; no new image search was needed.",
    ja: "既存の画像アセットで十分だったため、新しい画像検索は実行されませんでした。",
    de: "Die vorhandenen Bild-Assets waren ausreichend; es war keine neue Bildsuche erforderlich.",
  },
  IMG_SESSION_INCOMPLETE: {
    zh: "图片研究 Session 未能完成，本轮保留已有图片结果。",
    en: "The image research Session did not complete; existing image results were preserved.",
    ja: "画像リサーチセッションが完了しなかったため、今回は既存の画像結果を保持します。",
    de: "Die Bildrecherche-Session konnte nicht abgeschlossen werden; vorhandene Bildergebnisse wurden beibehalten.",
  },
  IMG_NO_USABLE_CANDIDATES: {
    zh: "未获得可用图片候选。",
    en: "No usable image candidates were returned.",
    ja: "利用可能な画像候補が返されませんでした。",
    de: "Es wurden keine verwertbaren Bildkandidaten zurückgegeben.",
  },
  IMG_DISABLED_IN_SETTINGS: {
    zh: "图片搜索已在设置中关闭。",
    en: "Image research is disabled in settings.",
    ja: "画像検索は設定で無効になっています。",
    de: "Die Bildsuche ist in den Einstellungen deaktiviert.",
  },
  WEB_QUERY_FAILED: {
    zh: "搜索词“{query}”执行失败。",
    en: "Search failed for query “{query}”.",
    ja: "検索クエリ「{query}」の実行に失敗しました。",
    de: "Die Suche nach „{query}“ ist fehlgeschlagen.",
  },
  WEB_QUERY_NO_RESULTS: {
    zh: "搜索词“{query}”未获得可用结果。",
    en: "No usable result was collected for query “{query}”.",
    ja: "検索クエリ「{query}」で利用可能な結果を取得できませんでした。",
    de: "Für die Suchanfrage „{query}“ wurden keine verwertbaren Ergebnisse gefunden.",
  },
  WEB_PAGE_READ_FAILED: {
    zh: "网页“{url}”未能读取正文。",
    en: "The page “{url}” could not be read.",
    ja: "ページ「{url}」の本文を読み取れませんでした。",
    de: "Der Inhalt der Seite „{url}“ konnte nicht gelesen werden.",
  },
} satisfies Record<DiagnosticCode, Record<Locale, string>>;

/**
 * 展示层入口：码值 → 当前界面语言文案；非码值（历史记录/外部数据）原样透传。
 * 所有渲染 gaps / rationale / diagnostic_errors / candidate.reason 的组件统一走这里。
 */
export function renderDiagnostic(locale: Locale, raw: string): string {
  const decoded = decodeDiagnostic(raw);
  if (!decoded) return raw;
  return formatMessage(diagnosticText[decoded.code][locale], decoded.params);
}

/** 数组版便捷入口。 */
export function renderDiagnostics(locale: Locale, raws: readonly string[]): string[] {
  return raws.map((raw) => renderDiagnostic(locale, raw));
}
