/* Web adapter: state and authority stay on the server. */
globalThis.agentUI = (() => {
  let controller, current, project, draft, dirty = false, saving = false, blocked = false, editSequence = 0, saveTimer;
  let activeId, renderedRevision, renderedDraft, dragIndex;
  const text = (tag, value, className) => { const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node; };
  const terminal = run => ["completed","failed","cancelled"].includes(run.phase);
  const label = {queued:"等待项目执行名额",planning:"识别需求与规划",waiting_outline:"等待确认大纲",generating:"生成页面",checking:"质量检查",revising:"定向修订",waiting_user:"等待补充信息",paused_budget:"预算不足，已暂停",interrupted:"任务已中断，可继续",completed:"预览已交付",failed:"执行失败",cancelled:"本次执行已取消"};
  function renderProgress() {
    const waits=current.resource_waits??{}, parts=[];
    if(waits.capacity)parts.push(`等待页面生成容量（${waits.capacity}页）`);
    if(waits.budget)parts.push(`等待在途调用结算（${waits.budget}页）`);
    if(waits.engine)parts.push(`等待引擎检查（${waits.engine}页）`);
    if(project&&project.revision_id===current.preview_revision)parts.push(`已生成 ${project.pages.length} / ${project.outline.pages.length} 页`);
    $("agentProgress").textContent=[label[current.phase]??current.phase,...parts,current.error,current.quality_state==="draft"?"草稿/检查未完成":""].filter(Boolean).join(" · ");
    $("status").textContent=$("agentProgress").textContent;
  }
  function options() {
    const mode=$("pagePolicy").value, count=Number($("pages").value);
    return {version:1,generation_mode:$("generationMode").value,research_allowed:$("researchToggle").checked,
      page_policy:mode==="auto"?{mode}:{mode,...(mode==="fixed"?{count}:{min:count,max:Number($("maxPages").value)})},
      budget:{active_seconds:Number($("agentMinutes").value)*60,estimated_cost_cny:Number($("agentCost").value)}};
  }
  $("pagePolicy").addEventListener("change",()=>{$("maxPages").style.display=$("pagePolicy").value==="range"?"":"none";$("pages").disabled=$("pagePolicy").value==="auto";});
  function stop() { if(controller)controller.abort();controller=null; }
  async function detach() {
    if(dirty&&!(await flushSave())){toast("大纲尚未保存，请先处理保存冲突再切换作品","error");return false;}
    stop();activeId=undefined;current=undefined;project=undefined;localStorage.removeItem("sf-agent-active-deck");$("agentPanel").style.display="none";return true;
  }
  async function watch(id) {
    if(id!==activeId&&dirty&&!(await flushSave()))return toast("大纲尚未保存，请先处理保存冲突再切换作品","error");
    stop(); activeId=id;state.deckId=id;current=undefined;project=undefined;renderedRevision=undefined;renderedDraft=undefined;draft=undefined;dirty=false;blocked=false;
    localStorage.setItem("sf-agent-active-deck",id);
    $("agentPanel").style.display="block";$("workspaceEmpty").style.display="none";
    controller=new AbortController();const signal=controller.signal;
    document.querySelector('[data-tab="workspace"]').click();
    await refresh(id);
    if(current&&!terminal(current))void subscribe(id,signal);
  }
  async function refresh(id, snapshot) {
    if(id!==activeId)return;
    const job=snapshot??await api(`/decks/${id}`);
    if(id!==activeId||id!==state.deckId)return;
    if(job.error&&!job.agent){$("agentProgress").textContent=job.error;return;}
    if(!job.agent)return;
    if(current&&current.run_seq===job.agent.run_seq&&job.agent.checkpoint_seq<current.checkpoint_seq)return;
    const previousPhase=current?.phase;current=job.agent;
    $("generationMode").value=current.options.generation_mode;
    renderProgress();
    const budget=current.budget;
    $("agentBudget").textContent=`有效执行 ${Math.round(budget.active_seconds)} / ${budget.limit_seconds} 秒 · 模型费用估算 ¥${budget.spent_cny.toFixed(4)} / ¥${budget.limit_cny} · 在途预留 ¥${budget.reserved_cny.toFixed(4)}（非导出点数）`;
    $("status").textContent=$("agentProgress").textContent;
    $("agentCancel").disabled=terminal(current);
    $("applyEdit").disabled=!terminal(current);
    const waiting=current.phase==="waiting_user";
    $("agentQuestion").style.display=waiting?"block":"none";
    $("agentQuestionText").textContent=current.request?.question??"";
    $("agentAcceptOutline").style.display=waiting&&current.request?.reason_code==="structure"&&current.request.proposal?"inline-flex":"none";
    $("agentUsePageCount").style.display=waiting&&current.request?.reason_code==="page_policy"&&current.request.proposal?.requested>=2&&current.request.proposal?.requested<=20?"inline-flex":"none";
    $("agentResume").style.display=["interrupted","paused_budget"].includes(current.phase)?"block":"none";
    const unknown=current.unknown_calls??[];
    $("agentUnknown").textContent=unknown.length?`${unknown.length} 次模型调用结果未知，费用可能已产生；原预留仍保留。`:"";
    $("unknownConsentLabel").style.display=unknown.length?"block":"none";
    if(current.preview_revision!==renderedRevision||current.draft_revision!==renderedDraft||!project) {
      const loaded=await api(`/decks/${id}/project`);if(loaded.error)return;
      if(id!==activeId||id!==state.deckId||!current)return;
      project=loaded.project;
      renderProgress();
      renderContext();
      if(!dirty&&!saving){draft=loaded.draft;renderDraft();renderedDraft=current.draft_revision;}
      if(project.pages.length&&project.revision_id!==renderedRevision) {
        state.pageCount=project.pages.length;state.shown=new Set();state.pageImages=new Map();$("pageList").replaceChildren();
        let previous=-1;
        while(id===activeId&&id===state.deckId&&state.shown.size<state.pageCount&&state.shown.size!==previous) {previous=state.shown.size;await pullNewPreviews();}
        if(id!==activeId||id!==state.deckId)return;
        $("workspaceMain").style.display="grid";
        $("applyEdit").disabled=!terminal(current);
        if(state.editingPage)void loadHistory();
      } else if(!project.pages.length)$("workspaceMain").style.display="none";
      renderedRevision=project.revision_id;
    }
    if(project&&previousPhase!==current.phase)renderContext();
    $("agentDraft").style.display=current.phase==="waiting_outline"?"block":"none";
    if(terminal(current))$("generate").disabled=false;
  }
  async function subscribe(id,signal) {
    while(!signal.aborted&&id===activeId&&!terminal(current)) {
      try {
        const response=await fetch(`/decks/${id}/events`,{headers:{"x-api-key":apiKey},signal});
        if(!response.ok)throw new Error(`进度连接 HTTP ${response.status}`);
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="";
        while(!signal.aborted) {
          const {done,value}=await reader.read();if(done)break;
          buffer+=decoder.decode(value,{stream:true});let end;
          while((end=buffer.indexOf("\n\n"))>=0) {
            const event=buffer.slice(0,end);buffer=buffer.slice(end+2);
            const data=event.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).join("\n");
            if(data)await refresh(id,JSON.parse(data));
          }
          if(terminal(current)){await reader.cancel();return;}
        }
      } catch(error) {if(signal.aborted)return;$("agentProgress").textContent=`进度连接中断，正在重新获取状态：${error.message}`;}
      await new Promise(resolve=>setTimeout(resolve,2000));
      if(!signal.aborted)await refresh(id);
    }
  }
  function renderContext() {
    const target=$("agentContext");target.replaceChildren();
    target.append(text("div",`场景：${project.scenario.category}${project.scenario.subtype?" · "+project.scenario.subtype:""}`));
    const sceneControls=document.createElement("div");sceneControls.className="hero-controls";sceneControls.style.margin="8px 0";
    const category=document.createElement("select");category.setAttribute("aria-label","更正应用场景");
    for(const value of ["企业","学术/教育","旅游","其他","待明确"]){const option=text("option",value);option.value=value;category.append(option);}category.value=project.scenario.category;
    const subtype=document.createElement("input");subtype.value=project.scenario.subtype;subtype.placeholder="具体用途，如产品发布、学术汇报";
    const correct=text("button","更正场景","btn ghost sm");correct.disabled=!["waiting_outline","waiting_user","completed","cancelled","interrupted"].includes(current.phase);
    correct.addEventListener("click",async()=>{const result=await api(`/decks/${activeId}/scenario`,{method:"POST",body:JSON.stringify({expected_project_revision:project.revision_id,scenario:{category:category.value,subtype:subtype.value,reason:"用户手动纠正"}})});if(!result.error){await refresh(activeId);toast("场景已更正，请核对大纲后确认","success");}});
    sceneControls.append(category,subtype,correct);target.append(sceneControls);
    const details=document.createElement("details");details.append(text("summary",`项目约束 ${project.constraints.length} 条 · 资料 ${project.sources.length} 份`));
    details.className="agent-constraints";
    details.append(text("pre",project.constraints.map(item=>item.source==="outline"?
      `已确认大纲：${project.outline.title}\n${project.outline.pages.map((page,index)=>`${index+1}. ${page.title}\n${page.bullets.map(bullet=>`   · ${bullet}`).join("\n")}`).join("\n")}`:item.text).join("\n\n")));
    for(const source of project.sources)details.append(text("div",`${source.name} · ${source.chars} 字 · ${source.kind}`));
    const missingNames={original_attachments:"原始附件",confirmed_constraints:"此前确认的约束",historical_versions:"历史页面版本",complete_brand_rules:"完整品牌规则"};
    if(project.missing.length)details.append(text("p",`旧作品缺失信息：${project.missing.map(value=>missingNames[value]??value).join("、")}；仅从现存文件建立基线。`,"muted"));
    target.append(details);
  }
  function draftPolicy() {const mode=$("draftPolicy").value;return mode==="auto"?{mode}:mode==="fixed"?{mode,count:Number($("draftMin").value)}:{mode,min:Number($("draftMin").value),max:Number($("draftMax").value)};}
  function renderDraftPolicy() {
    const mode=$("draftPolicy").value,automatic=mode==="auto";
    $("draftMax").style.display=mode==="fixed"?"none":"";
    $("draftMin").readOnly=automatic;$("draftMax").readOnly=automatic;
    if(automatic){$("draftMin").value=2;$("draftMax").value=20;}
    $("draftMin").title=mode==="fixed"?"固定页数":"最少页数";
  }
  function renderDraft() {
    if(!draft)return;
    $("outlineTitle").value=draft.title;
    const policy=draft.page_policy??current.options.page_policy;
    $("draftPolicy").value=policy.mode;$("draftMin").value=policy.count??policy.min??draft.pages.length;$("draftMax").value=policy.max??20;
    renderDraftPolicy();
    renderRows();$("outlineSaveStatus").textContent="已保存";
  }
  function renderRows() {
    const target=$("outlineRows");target.replaceChildren();
    draft.pages.forEach((page,index)=>{
      const row=document.createElement("div");row.className="card";row.style.marginBottom="10px";row.draggable=true;
      row.append(text("div",`↕ 第 ${index+1} 页`));
      const title=document.createElement("input");title.value=page.title;title.style.width="100%";title.setAttribute("aria-label",`第${index+1}页标题`);
      title.addEventListener("input",()=>{page.title=title.value;changed();});row.append(title);
      const bullets=document.createElement("textarea");bullets.value=page.bullets.join("\n");bullets.style.width="100%";bullets.setAttribute("aria-label",`第${index+1}页要点，每行一条`);
      bullets.addEventListener("input",()=>{page.bullets=bullets.value.split("\n").filter(value=>value.trim());changed();});row.append(bullets);
      const remove=text("button","删除这一页","btn ghost sm");remove.disabled=draft.pages.length<=2;remove.addEventListener("click",()=>{draft.pages.splice(index,1);changed();renderRows();});row.append(remove);
      row.addEventListener("dragstart",event=>{dragIndex=index;event.dataTransfer.effectAllowed="move";});
      row.addEventListener("dragover",event=>event.preventDefault());row.addEventListener("drop",event=>{event.preventDefault();if(dragIndex===undefined)return;const [moved]=draft.pages.splice(dragIndex,1);draft.pages.splice(index,0,moved);dragIndex=undefined;changed();renderRows();});target.append(row);
    });
  }
  function changed() {dirty=true;editSequence++;$("outlineSaveStatus").textContent="未保存";clearTimeout(saveTimer);saveTimer=setTimeout(()=>void flushSave(),500);}
  async function flushSave() {
    clearTimeout(saveTimer);if(saving||blocked||!dirty)return !dirty;
    saving=true;
    try {
      while(dirty&&!blocked) {
        const sequence=editSequence;
        const value={expected_draft_revision:draft.draft_revision,title:draft.title,pages:structuredClone(draft.pages),page_policy:draftPolicy()};
        const result=await api(`/decks/${activeId}/outline-draft`,{method:"PUT",body:JSON.stringify(value)});
        if(result.error){blocked=true;$("outlineSaveStatus").textContent=`保存失败：${result.error}。本地编辑仍保留，请刷新比较后重试。`;break;}
        current={...current,...result.agent};draft.draft_revision=current.draft_revision;renderedDraft=current.draft_revision;
        dirty=sequence!==editSequence;
        $("outlineSaveStatus").textContent=dirty?"保存新修改中…":"已保存";
      }
    } catch(error) {$("outlineSaveStatus").textContent=`未保存：${error.message}`;}
    finally {saving=false;}
    return !dirty;
  }
  $("outlineTitle").addEventListener("input",()=>{if(draft){draft.title=$("outlineTitle").value;changed();}});
  $("draftPolicy").addEventListener("change",()=>{renderDraftPolicy();changed();});
  for(const id of ["draftMin","draftMax"])$(id).addEventListener("change",changed);
  $("outlineAdd").addEventListener("click",()=>{if(draft.pages.length>=20)return toast("最多20页","error");draft.pages.push({page_id:`slide-${crypto.randomUUID()}`,title:"新页面",bullets:[]});changed();renderRows();});
  $("outlineConfirm").addEventListener("click",async()=>{
    if(saving||!(await flushSave()))return toast("请等待大纲成功保存后再确认","error");
    const result=await api(`/decks/${activeId}/outline-confirm`,{method:"POST",body:JSON.stringify({draft_revision:draft.draft_revision})});
    if(!result.error)await refresh(activeId);
  });
  $("agentRespond").addEventListener("click",async()=>{const result=await api(`/decks/${activeId}/respond`,{method:"POST",body:JSON.stringify({request_id:current.request.request_id,response:$("agentAnswer").value,expected_checkpoint:current.checkpoint_seq})});if(!result.error)await refresh(activeId);});
  for(const [id,field] of [["agentAcceptOutline","accept_outline"],["agentUsePageCount","accept_page_count"]])$(id).addEventListener("click",async()=>{const result=await api(`/decks/${activeId}/respond`,{method:"POST",body:JSON.stringify({request_id:current.request.request_id,expected_checkpoint:current.checkpoint_seq,[field]:true})});if(!result.error)await refresh(activeId);});
  $("agentContinue").addEventListener("click",async()=>{
    const unknown=current.unknown_calls??[];
    const result=await api(`/decks/${activeId}/continue`,{method:"POST",body:JSON.stringify({expected_checkpoint:current.checkpoint_seq,budget_addition:{active_seconds:Number($("agentAddMinutes").value)*60,estimated_cost_cny:Number($("agentAddCost").value)},retry_unknown_call_ids:$("agentUnknownConsent").checked?unknown.map(call=>call.call_id):[]})});
    if(!result.error){$("agentUnknownConsent").checked=false;await refresh(activeId);}
  });
  $("agentCancel").addEventListener("click",async()=>{await api(`/decks/${activeId}/cancel`,{method:"POST",body:"{}"});await refresh(activeId);});
  async function revise(instruction) {
    {
      const result=await api(`/decks/${state.deckId}/project`);
      if(result.project)project=result.project;
      else if(result.legacy){const response=await api(`/decks/${state.deckId}/agent-revise`,{method:"POST",body:JSON.stringify({page_ids:[`page-${state.editingPage}`],instruction,expected_project_revision:"legacy"})});if(!response.error)await watch(state.deckId);return;}
    }
    const page=project?.pages[state.editingPage-1];if(!page)return toast("请先选择已经生成的页面","error");
    const response=await api(`/decks/${state.deckId}/agent-revise`,{method:"POST",body:JSON.stringify({page_ids:[page.page_id],instruction,expected_project_revision:project.revision_id})});if(!response.error)await watch(state.deckId);
  }
  async function loadHistory() {
    if(!state.deckId||!state.editingPage)return;
    const loaded=await api(`/decks/${state.deckId}/project`);if(loaded.project)project=loaded.project;
    if(!project||!state.editingPage)return;
    const page=project.pages[state.editingPage-1];if(!page)return;
    const history=await api(`/decks/${activeId}/pages/${page.page_id}/history`);if(!Array.isArray(history))return;
    const target=$("pageHistory");target.replaceChildren();
    for(const version of history){const row=text("div",`${version.at} · ${version.instruction} `);row.style.marginTop="8px";const button=text("button","回退","btn ghost sm");button.disabled=!terminal(current);button.addEventListener("click",async()=>{const result=await api(`/decks/${activeId}/pages/${page.page_id}/rollback`,{method:"POST",body:JSON.stringify({target_page_revision:version.revision_id,expected_project_revision:project.revision_id})});if(!result.error)await refresh(activeId);});row.append(button);target.append(row);}
  }
  $("pageHistoryPanel").addEventListener("toggle",()=>{if($("pageHistoryPanel").open)void loadHistory();});
  window.addEventListener("beforeunload",event=>{if(dirty){event.preventDefault();event.returnValue="";}});
  const remembered=localStorage.getItem("sf-agent-active-deck");
  if(remembered)api(`/decks/${remembered}`).then(job=>{if(job.agent)void watch(remembered);}).catch(error=>toast(`恢复作品失败：${error.message}`,"error"));
  async function tabChanged(tab) {
    if(tab!=="workspace"){stop();return;}
    if(activeId&&!controller&&current){controller=new AbortController();const signal=controller.signal;await refresh(activeId);if(!signal.aborted&&current&&!terminal(current))void subscribe(activeId,signal);}
  }
  return {options,watch,revise,loadHistory,stop,detach,tabChanged,refreshCurrent:()=>activeId===state.deckId?refresh(activeId):Promise.resolve()};
})();
