"""Build the Chrome complement ZIP from the reviewed extension sources."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
source = root / "extensions" / "carrefour360"
destination = root / "downloads" / "carrefour360.zip"
required = ["manifest.json", "service-worker.js", "a4-bridge.js", "pricing-content.js", "README.md"]
for name in required:
    if not (source / name).is_file():
        raise SystemExit(f"Missing extension source: {name}")
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    for name in sorted(required):
        entry = ZipInfo(name, date_time=(2026, 10, 23, 0, 0, 0))
        entry.compress_type = ZIP_DEFLATED
        entry.external_attr = 0o644 << 16
        archive.writestr(entry, (source / name).read_bytes())
print(f"Created {destination.relative_to(root)}")
