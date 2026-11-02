import hashlib


def chunk_document(
    text: str,
    max_chars: int = 12_000,
    chunk_size: int = 4_000,
    overlap: int = 200,
) -> dict:
    if not 1 <= max_chars <= 12_000:
        raise ValueError("max_chars 必须在 1–12000 之间")
    if not 500 <= chunk_size <= 4_000:
        raise ValueError("chunk_size 必须在 500–4000 之间")
    if overlap < 0 or overlap >= chunk_size or overlap > 500:
        raise ValueError("overlap 必须小于 chunk_size 且不超过 500")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")[:max_chars]
    chunks = []
    start = 0
    while start < len(normalized):
        end = min(start + chunk_size, len(normalized))
        chunks.append({
            "index": len(chunks),
            "start": start,
            "end": end,
            "text": normalized[start:end],
        })
        if end == len(normalized):
            break
        start = end - overlap
    return {
        "document_id": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        "chars": len(normalized),
        "chunks": chunks,
    }


def extract_document(filename: str, content: bytes) -> dict:
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else "txt"
    if suffix in {"txt", "md"}:
        text = content.decode("utf-8-sig")
        kind = "txt"
    elif suffix == "docx":
        text = _extract_docx(content)
        kind = "docx"
    elif suffix == "pdf":
        text = _extract_pdf(content)
        kind = "pdf"
    else:
        raise ValueError("仅支持 TXT、DOCX 或 PDF 附件")
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise ValueError("附件未提取到可读文本")
    return {
        "kind": kind,
        "chars": len(text),
        "text": text,
        "document_id": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }


def _extract_docx(content: bytes) -> str:
    import io
    import zipfile
    import xml.etree.ElementTree as ET

    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    paragraphs = []
    for paragraph in root.iter(f"{namespace}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{namespace}t"))
        if text.strip():
            paragraphs.append(text)
    return "\n".join(paragraphs)


def _extract_pdf(content: bytes) -> str:
    try:
        import fitz
    except ImportError as error:
        raise RuntimeError("PDF 提取需要安装 PyMuPDF") from error
    with fitz.open(stream=content, filetype="pdf") as document:
        return "\n".join(page.get_text() for page in document)
