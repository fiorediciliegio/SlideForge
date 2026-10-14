import type { PageProgress } from "../../api/types";
import type { AuthoringPage } from "./types";
import { pickLocale, type Locale } from "../../i18n/locales";
import { formatMessage } from "../../i18n/index";

/**
 * 生成流程进度/结果文案（v1.3：二元判断清零 → 四语字典 + 占位符模板）。
 * 变量插值统一走 formatMessage，语序由各语言模板自持。
 */

interface GenerationTextDict {
  retryingPage: string;
  visualMaster: string;
  authoringKit: string;
  styleGuide: string;
  persistentElements: string;
  persistentElementsReady: string;
  persistentElementsPreserved: string;
  agentSessionCompleted: string;
  pageSources: string;
  researchPlanning: string;
  webResearchDiscovery: string;
  visualResearchDiscovery: string;
  collectingWebSources: string;
  collectingVisualSources: string;
  curatingDiscoveryFacts: string;
  curatingDiscoveryImages: string;
  evidencePagePlanning: string;
  visualRhythm: string;
  pageVisualPlan: string;
  collectingSources: string;
  curatingEvidence: string;
  curatingFacts: string;
  curatingImages: string;
  prepare: string;
  complete: string;
  resumed: string;
  interrupted: string;
  invalidOutline: string;
  staleArtifacts: string;
  layoutAuditInvalid: string;
  layoutRepairMissingSource: string;
  layoutRepairSourceFetchFailed: string;
  layoutRepairSourceEmpty: string;
  pageFailed: string;
  pagePassed: string;
  generatingPage: string;
  authoringPage: string;
  renderingPage: string;
  reviewingVisuals: string;
  cancelled: string;
  agentToolsUnavailable: string;
  baselineScreenshotUploadFailed: string;
  screenshotRefreshFailed: string;
  visualReviewScreenshotUploadFailed: string;
  unknownUploadError: string;
  visualReviewImageUnavailable: string;
  finalRender: string;
  deckReady: string;
  activeSummaryFailed: string;
  activeSummaryActive: string;
  activeSummaryDone: string;
  failedSummary: string;
  streamLabel: string;
}

const dict: Record<Locale, GenerationTextDict> = {
  zh: {
    retryingPage: "正在重新生成第 {n} 页（第 {attempt}/{total} 次尝试）",
    visualMaster: "正在生成全局视觉母版",
    authoringKit: "正在准备 Authoring Kit（创作套件）",
    styleGuide: "正在生成艺术指导",
    persistentElements: "正在生成跨页装饰",
    persistentElementsReady: "跨页装饰已生成",
    persistentElementsPreserved: "沿用现有跨页装饰",
    agentSessionCompleted: "Agent 会话已完成",
    pageSources: "正在初始化 Page Sources（页面源文件）",
    researchPlanning: "正在规划检索需求",
    webResearchDiscovery: "正在判断并补充网页资料",
    visualResearchDiscovery: "正在判断并补充图片素材",
    collectingWebSources: "正在搜索并抓取网页资料",
    collectingVisualSources: "正在搜索并下载图片素材",
    curatingDiscoveryFacts: "正在筛选资料证据",
    curatingDiscoveryImages: "正在筛选图片素材",
    evidencePagePlanning: "正在根据证据补充页面内容规划",
    visualRhythm: "正在规划整套视觉节奏",
    pageVisualPlan: "正在生成第 {n} 页的视觉计划",
    collectingSources: "正在搜索并抓取第 {n} 页资料",
    curatingEvidence: "正在筛选第 {n} 页证据",
    curatingFacts: "正在筛选第 {n} 页事实证据",
    curatingImages: "正在筛选第 {n} 页图片素材",
    prepare: "正在准备页面文件",
    complete: "生成完成",
    resumed: "已恢复上次生成进度",
    interrupted: "生成已中断，可继续生成",
    invalidOutline: "Deck Generation 需要 Confirmed Outline。",
    staleArtifacts: "无法续跑：现有页面进度已过期。",
    layoutAuditInvalid: "页面布局检查返回了无效结果。",
    layoutRepairMissingSource: "布局修复缺少页面源 HTML 或截图。",
    layoutRepairSourceFetchFailed: "无法读取布局修复所需的页面源 HTML：HTTP {status}",
    layoutRepairSourceEmpty: "布局修复所需的页面源 HTML 为空。",
    pageFailed: "页面未通过：{status}",
    pagePassed: "第 {n} 页已通过，继续下一页",
    generatingPage: "正在生成第 {n} / {total} 页",
    authoringPage: "正在思考第 {n} 页的表达",
    renderingPage: "正在渲染第 {n} 页",
    reviewingVisuals: "正在检查并修复第 {n} 页视觉问题",
    cancelled: "已停止生成",
    agentToolsUnavailable: "Agent 会话没有可执行工具权限，无法读取或编辑本地 PPT 工作区文件。请在 app grants drawer 中开启 “Let agent sessions use my tools”，然后重试本页或继续生成。",
    baselineScreenshotUploadFailed: "无法上传页面优化所需的基线截图：{detail}",
    screenshotRefreshFailed: "页面截图链接即将过期，但重新上传失败：{detail}",
    visualReviewScreenshotUploadFailed: "页面已成功渲染，但视觉检查所需的截图上传失败，已接受当前页面：{detail}",
    unknownUploadError: "未知上传错误",
    visualReviewImageUnavailable: "页面已成功渲染，但视觉检查 Agent 无法读取截图附件，已接受当前页面并跳过自动修复。",
    finalRender: "正在生成最终预览",
    deckReady: "演示文稿已生成",
    activeSummaryFailed: "{failed} 页生成失败，{accepted}/{total} 页已通过",
    activeSummaryActive: "正在生成 {active} 页，{accepted}/{total} 页已通过",
    activeSummaryDone: "{accepted}/{total} 页已通过",
    failedSummary: "{failed} 页生成失败，请重跑失败页",
    streamLabel: "第 {n} 页 · {kind}",
  },
  en: {
    retryingPage: "Regenerating page {n} (attempt {attempt}/{total})",
    visualMaster: "Generating the global visual master",
    authoringKit: "Preparing the Authoring Kit",
    styleGuide: "Creating the Workspace Style Guide",
    persistentElements: "Creating cross-slide decorations",
    persistentElementsReady: "Cross-slide decorations created",
    persistentElementsPreserved: "Preserving existing cross-slide decorations",
    agentSessionCompleted: "Agent session completed",
    pageSources: "Preparing Page Sources",
    researchPlanning: "Planning research needs",
    webResearchDiscovery: "Discovering needed web evidence",
    visualResearchDiscovery: "Discovering needed visual assets",
    collectingWebSources: "Searching and fetching web sources",
    collectingVisualSources: "Searching and downloading visual assets",
    curatingDiscoveryFacts: "Curating discovered factual evidence",
    curatingDiscoveryImages: "Curating discovered visual assets",
    evidencePagePlanning: "Planning page content from curated evidence",
    visualRhythm: "Planning deck visual rhythm",
    pageVisualPlan: "Generating the visual plan for page {n}",
    collectingSources: "Collecting sources for page {n}",
    curatingEvidence: "Curating evidence for page {n}",
    curatingFacts: "Curating facts for page {n}",
    curatingImages: "Curating images for page {n}",
    prepare: "Preparing page files",
    complete: "Generation complete",
    resumed: "Resumed previous generation progress",
    interrupted: "Generation interrupted. You can resume.",
    invalidOutline: "Deck Generation requires a confirmed outline.",
    staleArtifacts: "Unable to resume: the existing page progress is stale.",
    layoutAuditInvalid: "Page layout audit returned an invalid result.",
    layoutRepairMissingSource: "Layout repair requires the page source HTML and screenshot.",
    layoutRepairSourceFetchFailed: "Could not read the page source HTML for layout repair: HTTP {status}",
    layoutRepairSourceEmpty: "The page source HTML for layout repair is empty.",
    pageFailed: "Page did not pass: {status}",
    pagePassed: "Page {n} passed; continuing to the next page",
    generatingPage: "Generating page {n} / {total}",
    authoringPage: "Thinking through page {n}",
    renderingPage: "Rendering page {n}",
    reviewingVisuals: "Inspecting and repairing page {n} visuals",
    cancelled: "Generation stopped",
    agentToolsUnavailable: "Agent sessions cannot use executable tools, so they cannot read or edit local PPT workspace files. Enable “Let agent sessions use my tools” in the app grants drawer, then retry this page or resume generation.",
    baselineScreenshotUploadFailed: "Unable to upload the baseline screenshot required for page refinement: {detail}",
    screenshotRefreshFailed: "The page screenshot URL was near expiry, but refreshing it failed: {detail}",
    visualReviewScreenshotUploadFailed: "The page rendered successfully, but uploading the screenshot for visual review failed; the current page was accepted: {detail}",
    unknownUploadError: "unknown upload error",
    visualReviewImageUnavailable: "The page rendered successfully, but the visual review Agent could not read the screenshot attachment; the current page was accepted without automatic fixing.",
    finalRender: "Generating final preview",
    deckReady: "Deck generated",
    activeSummaryFailed: "{failed} pages failed, {accepted}/{total} accepted",
    activeSummaryActive: "Generating {active} pages, {accepted}/{total} accepted",
    activeSummaryDone: "{accepted}/{total} pages accepted",
    failedSummary: "{failed} pages failed. Retry the failed pages.",
    streamLabel: "Page {n} · {kind}",
  },
  ja: {
    retryingPage: "{n} ページ目を再生成中（{attempt}/{total} 回目）",
    visualMaster: "グローバルビジュアルマスターを生成中",
    authoringKit: "Authoring Kit（作成キット）を準備中",
    styleGuide: "スタイルガイドを生成中",
    persistentElements: "ページ共通の装飾を生成中",
    persistentElementsReady: "ページ共通の装飾を生成しました",
    persistentElementsPreserved: "既存のページ共通装飾を継続使用",
    agentSessionCompleted: "エージェントセッションが完了しました",
    pageSources: "Page Sources（ページソース）を初期化中",
    researchPlanning: "リサーチ要件を計画中",
    webResearchDiscovery: "必要な Web 資料を判断・補充中",
    visualResearchDiscovery: "必要な画像素材を判断・補充中",
    collectingWebSources: "Web 資料を検索・取得中",
    collectingVisualSources: "画像素材を検索・ダウンロード中",
    curatingDiscoveryFacts: "収集した事実証拠を選別中",
    curatingDiscoveryImages: "収集した画像素材を選別中",
    evidencePagePlanning: "証拠に基づいてページ内容の計画を補充中",
    visualRhythm: "デッキ全体のビジュアルリズムを計画中",
    pageVisualPlan: "ページ {n} のビジュアル計画を生成中",
    collectingSources: "ページ {n} の資料を収集中",
    curatingEvidence: "ページ {n} の証拠を選別中",
    curatingFacts: "ページ {n} の事実証拠を選別中",
    curatingImages: "ページ {n} の画像素材を選別中",
    prepare: "ページファイルを準備中",
    complete: "生成が完了しました",
    resumed: "前回の生成進行を再開しました",
    interrupted: "生成が中断されました。続きから再開できます",
    invalidOutline: "Deck Generation には確定済みのアウトラインが必要です。",
    staleArtifacts: "再開できません：既存のページ進行が期限切れです。",
    layoutAuditInvalid: "ページレイアウト監査が無効な結果を返しました。",
    layoutRepairMissingSource: "レイアウト修復にはページのソース HTML とスクリーンショットが必要です。",
    layoutRepairSourceFetchFailed: "レイアウト修復に必要なページのソース HTML を読み取れませんでした：HTTP {status}",
    layoutRepairSourceEmpty: "レイアウト修復に必要なページのソース HTML が空です。",
    pageFailed: "ページが合格しませんでした：{status}",
    pagePassed: "ページ {n} が合格しました。次のページに進みます",
    generatingPage: "ページ {n} / {total} を生成中",
    authoringPage: "ページ {n} の表現を検討中",
    renderingPage: "ページ {n} をレンダリング中",
    reviewingVisuals: "ページ {n} のビジュアル問題を確認・修正中",
    cancelled: "生成を停止しました",
    agentToolsUnavailable: "エージェントセッションに実行可能なツール権限がないため、ローカルの PPT ワークスペースファイルを読み書きできません。アプリの grants ドロワーで “Let agent sessions use my tools” を有効にしてから、このページを再試行するか生成を再開してください。",
    baselineScreenshotUploadFailed: "ページ最適化に必要なベースラインスクリーンショットをアップロードできませんでした：{detail}",
    screenshotRefreshFailed: "ページスクリーンショットのリンクがまもなく期限切れになりますが、再アップロードに失敗しました：{detail}",
    visualReviewScreenshotUploadFailed: "ページは正常にレンダリングされましたが、ビジュアルレビュー用スクリーンショットのアップロードに失敗したため、現在のページを受け入れました：{detail}",
    unknownUploadError: "不明なアップロードエラー",
    visualReviewImageUnavailable: "ページは正常にレンダリングされましたが、ビジュアルレビューエージェントがスクリーンショット添付を読み取れなかったため、自動修正をスキップして現在のページを受け入れました。",
    finalRender: "最終プレビューを生成中",
    deckReady: "プレゼンテーションが生成されました",
    activeSummaryFailed: "{failed} ページが失敗、{accepted}/{total} ページが合格",
    activeSummaryActive: "{active} ページを生成中、{accepted}/{total} ページが合格",
    activeSummaryDone: "{accepted}/{total} ページが合格",
    failedSummary: "{failed} ページの生成に失敗しました。失敗したページを再実行してください",
    streamLabel: "ページ {n} · {kind}",
  },
  de: {
    retryingPage: "Seite {n} wird neu generiert (Versuch {attempt}/{total})",
    visualMaster: "Globale visuelle Masterfolie wird erstellt",
    authoringKit: "Authoring Kit wird vorbereitet",
    styleGuide: "Style Guide wird erstellt",
    persistentElements: "Seitenübergreifende Dekorationen werden erstellt",
    persistentElementsReady: "Seitenübergreifende Dekorationen erstellt",
    persistentElementsPreserved: "Vorhandene seitenübergreifende Dekorationen werden beibehalten",
    agentSessionCompleted: "Agent-Sitzung abgeschlossen",
    pageSources: "Page Sources werden initialisiert",
    researchPlanning: "Recherchebedarf wird geplant",
    webResearchDiscovery: "Benötigte Web-Quellen werden ermittelt und ergänzt",
    visualResearchDiscovery: "Benötigtes Bildmaterial wird ermittelt und ergänzt",
    collectingWebSources: "Web-Quellen werden gesucht und abgerufen",
    collectingVisualSources: "Bildmaterial wird gesucht und heruntergeladen",
    curatingDiscoveryFacts: "Gesammelte Fakten werden ausgewählt",
    curatingDiscoveryImages: "Gesammeltes Bildmaterial wird ausgewählt",
    evidencePagePlanning: "Seiteninhalte werden anhand der Belege geplant",
    visualRhythm: "Der visuelle Rhythmus des Decks wird geplant",
    pageVisualPlan: "Visueller Plan für Seite {n} wird erstellt",
    collectingSources: "Quellen für Seite {n} werden gesammelt",
    curatingEvidence: "Belege für Seite {n} werden ausgewählt",
    curatingFacts: "Faktenbelege für Seite {n} werden ausgewählt",
    curatingImages: "Bildmaterial für Seite {n} wird ausgewählt",
    prepare: "Seitendateien werden vorbereitet",
    complete: "Generierung abgeschlossen",
    resumed: "Vorheriger Generierungsfortschritt wurde fortgesetzt",
    interrupted: "Generierung unterbrochen. Sie können fortfahren.",
    invalidOutline: "Deck Generation erfordert eine bestätigte Gliederung.",
    staleArtifacts: "Fortsetzen nicht möglich: Der vorhandene Seitenfortschritt ist veraltet.",
    layoutAuditInvalid: "Die Layout-Prüfung der Seite hat ein ungültiges Ergebnis zurückgegeben.",
    layoutRepairMissingSource: "Für die Layout-Reparatur werden der Quell-HTML-Code der Seite und ein Screenshot benötigt.",
    layoutRepairSourceFetchFailed: "Der Quell-HTML-Code der Seite für die Layout-Reparatur konnte nicht gelesen werden: HTTP {status}",
    layoutRepairSourceEmpty: "Der Quell-HTML-Code der Seite für die Layout-Reparatur ist leer.",
    pageFailed: "Seite nicht bestanden: {status}",
    pagePassed: "Seite {n} bestanden; weiter zur nächsten Seite",
    generatingPage: "Seite {n} / {total} wird generiert",
    authoringPage: "Die Darstellung von Seite {n} wird durchdacht",
    renderingPage: "Seite {n} wird gerendert",
    reviewingVisuals: "Visuelle Probleme auf Seite {n} werden geprüft und behoben",
    cancelled: "Generierung gestoppt",
    agentToolsUnavailable: "Agent-Sitzungen können keine ausführbaren Tools verwenden und daher keine lokalen PPT-Workspace-Dateien lesen oder bearbeiten. Aktivieren Sie „Let agent sessions use my tools“ in der App-Grants-Schublade und wiederholen Sie dann diese Seite oder setzen Sie die Generierung fort.",
    baselineScreenshotUploadFailed: "Der für die Seitenoptimierung erforderliche Basis-Screenshot konnte nicht hochgeladen werden: {detail}",
    screenshotRefreshFailed: "Der Link zum Seiten-Screenshot läuft bald ab, aber das erneute Hochladen ist fehlgeschlagen: {detail}",
    visualReviewScreenshotUploadFailed: "Die Seite wurde erfolgreich gerendert, aber der Screenshot für die visuelle Prüfung konnte nicht hochgeladen werden; die aktuelle Seite wurde übernommen: {detail}",
    unknownUploadError: "unbekannter Upload-Fehler",
    visualReviewImageUnavailable: "Die Seite wurde erfolgreich gerendert, aber der Visual-Review-Agent konnte den Screenshot-Anhang nicht lesen; die aktuelle Seite wurde ohne automatische Korrektur übernommen.",
    finalRender: "Finale Vorschau wird erstellt",
    deckReady: "Präsentation wurde erstellt",
    activeSummaryFailed: "{failed} Seiten fehlgeschlagen, {accepted}/{total} bestanden",
    activeSummaryActive: "{active} Seiten werden generiert, {accepted}/{total} bestanden",
    activeSummaryDone: "{accepted}/{total} Seiten bestanden",
    failedSummary: "{failed} Seiten fehlgeschlagen. Bitte wiederholen Sie die fehlgeschlagenen Seiten.",
    streamLabel: "Seite {n} · {kind}",
  },
};

export function generationText(locale: Locale) {
  const d = pickLocale(locale, dict);
  const pageNo = (page: Pick<AuthoringPage, "index">) => page.index + 1;
  const detailOr = (detail: string) => detail || d.unknownUploadError;
  return {
    retryingPage: (n: number, attempt: number, total: number) => formatMessage(d.retryingPage, { n, attempt, total }),
    visualMaster: d.visualMaster,
    authoringKit: d.authoringKit,
    styleGuide: d.styleGuide,
    persistentElements: d.persistentElements,
    persistentElementsReady: d.persistentElementsReady,
    persistentElementsPreserved: d.persistentElementsPreserved,
    agentSessionCompleted: d.agentSessionCompleted,
    pageSources: d.pageSources,
    researchPlanning: d.researchPlanning,
    webResearchDiscovery: d.webResearchDiscovery,
    visualResearchDiscovery: d.visualResearchDiscovery,
    collectingWebSources: d.collectingWebSources,
    collectingVisualSources: d.collectingVisualSources,
    curatingDiscoveryFacts: d.curatingDiscoveryFacts,
    curatingDiscoveryImages: d.curatingDiscoveryImages,
    evidencePagePlanning: d.evidencePagePlanning,
    visualRhythm: d.visualRhythm,
    pageVisualPlan: (page: Pick<AuthoringPage, "index" | "title">) => formatMessage(d.pageVisualPlan, { n: pageNo(page) }),
    collectingSources: (page: Pick<AuthoringPage, "index" | "title">) => formatMessage(d.collectingSources, { n: pageNo(page) }),
    curatingEvidence: (page: Pick<AuthoringPage, "index" | "title">) => formatMessage(d.curatingEvidence, { n: pageNo(page) }),
    curatingFacts: (page: Pick<AuthoringPage, "index" | "title">) => formatMessage(d.curatingFacts, { n: pageNo(page) }),
    curatingImages: (page: Pick<AuthoringPage, "index" | "title">) => formatMessage(d.curatingImages, { n: pageNo(page) }),
    prepare: d.prepare,
    complete: d.complete,
    resumed: d.resumed,
    interrupted: d.interrupted,
    invalidOutline: d.invalidOutline,
    staleArtifacts: d.staleArtifacts,
    layoutAuditInvalid: d.layoutAuditInvalid,
    layoutRepairMissingSource: d.layoutRepairMissingSource,
    layoutRepairSourceFetchFailed: (status: number) =>
      formatMessage(d.layoutRepairSourceFetchFailed, { status }),
    layoutRepairSourceEmpty: d.layoutRepairSourceEmpty,
    pageFailed: (page: PageProgress["pages"][number]) =>
      page.last_error || formatMessage(d.pageFailed, { status: page.status }),
    pagePassed: (page: Pick<AuthoringPage, "index" | "title">) => formatMessage(d.pagePassed, { n: pageNo(page) }),
    generatingPage: (page: Pick<AuthoringPage, "index" | "title">, total: number) =>
      formatMessage(d.generatingPage, { n: pageNo(page), total }),
    authoringPage: (page: Pick<AuthoringPage, "index" | "title">) => formatMessage(d.authoringPage, { n: pageNo(page) }),
    renderingPage: (page: Pick<AuthoringPage, "index" | "title">) => formatMessage(d.renderingPage, { n: pageNo(page) }),
    reviewingVisuals: (page: Pick<AuthoringPage, "index" | "title">) => formatMessage(d.reviewingVisuals, { n: pageNo(page) }),
    cancelled: d.cancelled,
    agentToolsUnavailable: d.agentToolsUnavailable,
    baselineScreenshotUploadFailed: (detail: string) =>
      formatMessage(d.baselineScreenshotUploadFailed, { detail: detailOr(detail) }),
    screenshotRefreshFailed: (detail: string) =>
      formatMessage(d.screenshotRefreshFailed, { detail: detailOr(detail) }),
    visualReviewScreenshotUploadFailed: (detail: string) =>
      formatMessage(d.visualReviewScreenshotUploadFailed, { detail: detailOr(detail) }),
    visualReviewImageUnavailable: d.visualReviewImageUnavailable,
    finalRender: d.finalRender,
    deckReady: d.deckReady,
    activeSummary: (input: { active: number; accepted: number; failed: number; total: number }) => {
      if (input.failed > 0) {
        return formatMessage(d.activeSummaryFailed, input);
      }
      if (input.active > 0) {
        return formatMessage(d.activeSummaryActive, input);
      }
      return formatMessage(d.activeSummaryDone, input);
    },
    failedSummary: (failedCount: number) => formatMessage(d.failedSummary, { failed: failedCount }),
    streamLabel: (pageIndex: number, kind: string) => formatMessage(d.streamLabel, { n: pageIndex + 1, kind }),
  };
}
