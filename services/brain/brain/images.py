import io

from PIL import Image, ImageChops, ImageStat

MAX_IMAGE_PIXELS = 40_000_000


def _open_rgb(content: bytes) -> Image.Image:
    with Image.open(io.BytesIO(content)) as source:
        width, height = source.size
        if width * height > MAX_IMAGE_PIXELS:
            raise ValueError(f"图像像素超过 {MAX_IMAGE_PIXELS} 上限")
        return source.convert("RGB")


def analyze_image_drift(before: bytes, after: bytes, threshold: int = 16) -> dict:
    if not 0 <= threshold <= 255:
        raise ValueError("threshold 必须在 0–255 之间")
    reference = _open_rgb(before)
    candidate = _open_rgb(after)
    original_size = {"before": list(reference.size), "after": list(candidate.size)}
    resized = reference.size != candidate.size
    if resized:
        candidate = candidate.resize(reference.size, Image.Resampling.LANCZOS)
    difference = ImageChops.difference(reference, candidate)
    statistics = ImageStat.Stat(difference)
    grayscale = difference.convert("L")
    histogram = grayscale.histogram()
    changed = sum(histogram[threshold + 1:]) if threshold < 255 else 0
    total = reference.size[0] * reference.size[1]
    bbox = difference.getbbox()
    return {
        "original_size": original_size,
        "resized": resized,
        "width": reference.size[0],
        "height": reference.size[1],
        "mean_absolute_difference": round(sum(statistics.mean) / 3, 6),
        "rms_difference": round(sum(statistics.rms) / 3, 6),
        "changed_pixel_ratio": round(changed / total if total else 0, 8),
        "changed_pixels": changed,
        "threshold": threshold,
        "difference_bbox": list(bbox) if bbox else None,
    }
