/**
 * SlideForge WPS 加载项主逻辑（骨架，实机验证中）。
 * 调用本机能力服务（localhost:3210）；结果经 JSAPI 在当前 WPS 打开。
 *
 * 注意：WPS JSAPI 的注入对象名以官方文档/实机为准，这里做防御式兼容。
 */
const API_BASE = "http://localhost:3210";
let deckId = null;
let pptxPath = null;

const $ = (id) => document.getElementById(id);
const status = (text) => { $("status").textContent = text; };

function wpsApplication() {
  if (typeof Application !== "undefined") return Application;
  if (window.wps && typeof window.wps.WpsApplication === "function") {
    return window.wps.WpsApplication();
  }
  return null;
}

async function api(path, options) {
  const response = await fetch(API_BASE + path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  return response.json();
}

async function generate() {
  const brief = $("brief").value.trim();
  if (!brief) return status("请先输入演示需求");
  $("generate").disabled = true;
  try {
    status("创建任务…");
    const created = await api("/decks", {
      method: "POST",
      body: JSON.stringify({ brief, page_count: Number($("pages").value) }),
    });
    deckId = created.deck_id;
    for (let round = 0; round < 120; round++) {
      await new Promise((r) => setTimeout(r, 4000));
      const job = await api(`/decks/${deckId}`);
      status(`状态：${job.status}\n${(job.recent_events ?? []).slice(-2).join("\n")}`);
      if (job.status === "ready") break;
      if (job.status === "error") throw new Error(job.error);
    }
    status("导出 pptx…");
    const exported = await api(`/decks/${deckId}/export`, { method: "POST", body: "{}" });
    pptxPath = exported.outPath;
    status(`✅ 已生成：${pptxPath}`);
    $("preview").src = `${API_BASE}/decks/${deckId}/preview?pages=1`;
    $("preview").style.display = "block";
    $("open").style.display = "inline-block";
  } catch (error) {
    status(`失败：${error.message}\n请确认本机能力服务已启动（npm run serve）`);
  } finally {
    $("generate").disabled = false;
  }
}

function openInWps() {
  const app = wpsApplication();
  if (!app || !pptxPath) return status("未检测到 WPS JSAPI 或尚未生成文件");
  try {
    app.Presentations.Open(pptxPath);
    status("已在 WPS 中打开生成文件");
  } catch (error) {
    status(`打开失败：${error.message}\n可手动打开：${pptxPath}`);
  }
}

$("generate").addEventListener("click", generate);
$("open").addEventListener("click", openInWps);
