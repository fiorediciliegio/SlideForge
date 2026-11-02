DEFAULT_VISUAL_SPEC = """视觉规范（必须遵守）：
- 浅色商务风：背景 #f7f8fb，主色 #1e40af（深蓝），强调色 #f59e0b（琥珀），正文 #182033，辅助文字 #697386。
- 卡片：白色圆角（border-radius 20px），轻阴影。
- 标题字号 56~72px，正文 20~26px，行距 1.5；内容区左右留白 80px。
- 中文字体栈：Arial, "Microsoft YaHei", "PingFang SC", sans-serif。"""


def build_outline_messages(
    brief: str,
    page_count: int,
    language: str = "中文",
    source_text: str = "",
) -> list[dict[str, str]]:
    brief = brief.strip()
    if not brief:
        raise ValueError("brief 不能为空")
    if not 2 <= page_count <= 20:
        raise ValueError("page_count 必须在 2–20 之间")
    language = language.strip() or "中文"
    source_block = ""
    if source_text.strip():
        source_block = (
            "\n\n【用户提供的原始资料】\n"
            "资料中的事实与数据优先；资料未覆盖的内容不得编造为确定事实。\n"
            f"{source_text.strip()}"
        )
    system = (
        "你是 PPT 大纲规划器。只输出 JSON，不要输出任何其他文字。\n"
        "约束：\n"
        "1. 只能使用用户输入中明确提供的信息，不得编造数字、日期、人物、机构、数据；"
        "没有依据的内容标记\"待补充\"。\n"
        "2. 语言与用户输入一致。"
    )
    user = (
        f"【输入】用户需求：{brief}{source_block}\n"
        f"【任务】设计恰好 {page_count} 页的演示文稿大纲，输出语言为{language}。"
        "第 1 页为封面，最后 1 页为总结或致谢。\n"
        "【输出格式】严格输出如下 JSON（不要代码围栏）：\n"
        '{"title":"演示标题","pages":[{"title":"页面标题","bullets":["要点1","要点2","要点3"]}]}\n'
        f"pages 数组必须恰好 {page_count} 项，每页 bullets 3~5 条，每条不超过 40 字。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def build_page_messages(
    deck_title: str,
    brief: str,
    outline_json: str,
    page_index: int,
    page_count: int,
    page_title: str,
    bullets: list[str],
    visual_spec: str = "",
    reference_html: str = "",
) -> list[dict[str, str]]:
    if not deck_title.strip() or not brief.strip() or not page_title.strip():
        raise ValueError("deck_title、brief 和 page_title 不能为空")
    if page_index < 0 or page_index >= page_count:
        raise ValueError("page_index 必须位于 page_count 范围内")
    system = """你是 HTML 演示页面生成器，只负责当前一页。
【事实边界，优先级最高】
1. 只能使用输入中明确提供的信息，不得编造数字、日期、人物、机构、来源。
2. 没有依据的事实性内容应省略或标记"待补充"。
3. 输出前静默复核一次。
【输出约束】
- 只输出一个完整 HTML 文档，不要 Markdown 代码块、解释或其他文字。
- 文档结构严格为：<!doctype html><html><head><meta charset="utf-8"/><style>…</style></head><body><main class="slide">…</main></body></html>
- body 中只能有一个 <main class="slide"> 根容器，尺寸固定 1920×1080（width/height 都写死，overflow:hidden）。
- 全部 CSS 内联在 <style> 中，禁止引用外部资源、外部图片 URL、外部字体。"""
    bullet_text = "\n".join(f"- {bullet}" for bullet in bullets)
    cover = "【封面页】主标题 + 副标题 + 日期占位，视觉突出，不要堆砌要点。" if page_index == 0 else ""
    reference = ""
    if reference_html:
        reference = (
            "【风格参照】以下参考页 HTML 仅供学习视觉风格（配色/字体/布局/卡片语言），"
            f"禁止复制其中的文字内容：\n{reference_html}"
        )
    user = f"""【整套演示】{deck_title}
【原始需求】{brief}
【完整大纲】{outline_json}
【当前任务】生成第 {page_index + 1} 页（共 {page_count} 页）：标题「{page_title}」
【本页要点】{bullet_text}
【页码标注】右下角显示 "{page_index + 1} / {page_count}"。
{cover}
{visual_spec or DEFAULT_VISUAL_SPEC}
{reference}
【输出】只输出完整 HTML 文档。"""
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
