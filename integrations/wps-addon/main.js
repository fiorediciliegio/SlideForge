let download;

const $ = (id) => document.getElementById(id);
const status = (text) => { $("status").textContent = text; };

async function request(path, apiKey, options) {
  const response = await fetch(path, {
    mode: "same-origin",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    ...options,
  });
  if (!response.ok) {
    const { error } = await response.json();
    throw new Error(error ?? `HTTP ${response.status}`);
  }
  return response;
}

async function api(path, apiKey, options) {
  const response = await request(path, apiKey, options);
  return response.json();
}

async function generate() {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) return status("请先填写 SlideForge 业务 Key");
  const brief = $("brief").value.trim();
  if (!brief) return status("请先输入演示需求");
  $("generate").disabled = true;
  $("insert").hidden = true;
  try {
    status("创建任务…");
    const { deck_id: deckId } = await api("/decks", apiKey, {
      method: "POST",
      body: JSON.stringify({ brief, page_count: Number($("pages").value) }),
    });
    const deckPath = `/decks/${deckId}`;
    let job;
    for (let round = 0; round < 120; round++) {
      await new Promise((r) => setTimeout(r, 4000));
      job = await api(deckPath, apiKey);
      if (job.status === "ready") break;
      if (job.status === "error") throw new Error(job.error);
      status(`${deckId} · 生成中\n${(job.recent_events ?? []).slice(-2).join("\n")}`);
    }
    if (job.status !== "ready") throw new Error(`等待任务 ${deckId} 超时`);

    status(`${deckId} · 导出 PPTX…`);
    let exported = await api(`${deckPath}/export`, apiKey, { method: "POST", body: JSON.stringify({idempotency_key:crypto.getRandomValues(new Uint32Array(4)).join("-")}) });
    if (exported.status_url) {
      const statusUrl=exported.status_url;
      while(true) {
        const task=await api(statusUrl,apiKey);
        if(task.state==="completed"){exported=task.result;break;}
        if(task.state==="failed"||task.state==="cancelled")throw new Error(task.error??"导出已取消");
        status(`${deckId} · ${task.state==="queued"?"导出排队中":"引擎正在导出"}…`);
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
    const {download_url:url}=exported;
    if (!url) throw new Error("导出响应缺少下载地址，请确认已启动 SlideForge 四进程 dev");
    download = { url, apiKey };
    status(`${deckId} · 已导出，可以插入当前演示`);
    $("insert").hidden = false;
  } catch (error) {
    status(`失败：${error.message}`);
  } finally {
    $("generate").disabled = false;
  }
}

async function insertIntoPresentation() {
  const insert = $("insert");
  const generateButton = $("generate");
  insert.disabled = true;
  generateButton.disabled = true;
  const app = window.Application;
  let tempPath;
  try {
    const presentation = app.ActivePresentation;
    if (!presentation) throw new Error("请先打开要插入的演示文稿");
    status("正在下载 PPTX…");
    const response = await request(download.url, download.apiKey);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    }

    const tempDir = app.Env.GetTempPath().replace(/[\\/]+$/, "");
    const suffix = crypto.getRandomValues(new Uint32Array(4)).join("-");
    tempPath = `${tempDir}\\slideforge-${suffix}.pptx`;
    if (!app.FileSystem.writeAsBinaryString(tempPath, binary)) throw new Error("无法写入临时 PPTX");
    const slides = presentation.Slides;
    const inserted = slides.InsertFromFile(tempPath, slides.Count);
    if (inserted === 0) throw new Error("WPS 未插入任何幻灯片");
    status(`已插入 ${inserted} 页，请在 WPS 中保存文稿。`);
    insert.hidden = true;
  } catch (error) {
    status(`插入失败：${error.message}`);
  } finally {
    insert.disabled = false;
    generateButton.disabled = false;
    if (tempPath && app.FileSystem.Exists(tempPath) && !app.FileSystem.unlinkSync(tempPath)) {
      status(`${$("status").textContent}\n无法清理临时文件：${tempPath}`);
    }
  }
}

$("generate").addEventListener("click", generate);
$("insert").addEventListener("click", insertIntoPresentation);
