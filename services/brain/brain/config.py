from dataclasses import dataclass
import os


@dataclass(frozen=True)
class BrainConfig:
    host: str
    port: int
    internal_token: str | None
    openai_base_url: str = "https://api.deepseek.com"
    openai_api_key: str | None = None
    openai_model: str = "deepseek-chat"


def load_config() -> BrainConfig:
    port = int(os.getenv("BRAIN_PORT", "3212"))
    if not 1 <= port <= 65535:
        raise ValueError("BRAIN_PORT 必须是 1–65535 的整数")
    token = os.getenv("GATEWAY_INTERNAL_TOKEN", "").strip() or None
    if os.getenv("NODE_ENV") == "production" and not token:
        raise ValueError("生产大脑服务必须配置 GATEWAY_INTERNAL_TOKEN")
    return BrainConfig(
        host=os.getenv("BRAIN_HOST", "127.0.0.1"),
        port=port,
        internal_token=token,
        openai_base_url=os.getenv("OPENAI_BASE_URL", "https://api.deepseek.com").rstrip("/"),
        openai_api_key=os.getenv("OPENAI_API_KEY") or None,
        openai_model=os.getenv("OPENAI_MODEL", "deepseek-chat"),
    )
