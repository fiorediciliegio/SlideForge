import json
import time
import urllib.error
import urllib.request

from .config import BrainConfig
from .prompts import build_outline_messages


def generate_outline(
    config: BrainConfig,
    brief: str,
    page_count: int,
    language: str = "中文",
    source_text: str = "",
) -> dict:
    if not config.openai_api_key:
        raise RuntimeError("Python 大脑层未配置 OPENAI_API_KEY")
    messages = build_outline_messages(brief, page_count, language, source_text)
    payload = json.dumps({
        "model": config.openai_model,
        "messages": messages,
        "temperature": 0.4,
    }, ensure_ascii=False).encode("utf-8")
    last_error = None
    for attempt in range(3):
        request = urllib.request.Request(
            f"{config.openai_base_url}/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.openai_api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=240) as response:
                result = json.loads(response.read().decode("utf-8"))
            text = result["choices"][0]["message"]["content"]
            outline = _parse_outline(text, page_count)
            usage = result.get("usage")
            if isinstance(usage, dict):
                outline["usage"] = usage
            return outline
        except (urllib.error.URLError, KeyError, IndexError, TypeError, ValueError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(attempt + 1)
    raise RuntimeError(f"大纲模型调用失败：{last_error}")


def _parse_outline(text: str, page_count: int) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```json").removeprefix("```JSON").removeprefix("```")
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    begin = cleaned.find("{")
    end = cleaned.rfind("}")
    if begin < 0 or end <= begin:
        raise ValueError("模型未返回 JSON 大纲")
    value = json.loads(cleaned[begin:end + 1])
    if not isinstance(value, dict) or not isinstance(value.get("title"), str) or not value["title"].strip():
        raise ValueError("大纲 title 无效")
    pages = value.get("pages")
    if not isinstance(pages, list) or len(pages) != page_count:
        raise ValueError(f"大纲页数不符：期望 {page_count}")
    for page in pages:
        if not isinstance(page, dict) or not isinstance(page.get("title"), str) or not page["title"].strip():
            raise ValueError("大纲页面 title 无效")
        bullets = page.get("bullets")
        if not isinstance(bullets, list) or not all(isinstance(item, str) for item in bullets):
            raise ValueError("大纲页面 bullets 无效")
    return value
