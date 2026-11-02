from pathlib import Path
import yaml

root = Path(__file__).resolve().parents[1]
files = sorted((root / "contracts" / "openapi").glob("*.yaml"))
if not files:
    raise SystemExit("no OpenAPI files found")
for file in files:
    document = yaml.safe_load(file.read_text(encoding="utf-8"))
    assert document["openapi"].startswith("3."), file
    assert document["info"]["title"], file
    assert document["paths"], file
    print(f"OK {file.relative_to(root)}: {len(document['paths'])} paths")
