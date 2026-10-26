"""Render a building's floor-plan PDFs and read their labels with OCR (the same pipeline the engine studio uses).

    python tools/prepare_building.py research-hall Research-1:1 Research-2:2 ...
    python tools/prepare_building.py merten-hall Merten-1:1:4      # 4-digit room numbers (1201A)

Each argument is <pdf name without .pdf>:<room prefix>[:<digits in a room number, default 3>]. Writes, under data/gmu/<building>/:
  plans/<name>.png         rendered plan (git-ignored: derived from GMU's file)
  ocr/<name>.ocr.json      raw OCR boxes (used to blank text when building geometry)
  ocr/<name>.labels.json   cleaned room labels (edit these, or add hand fixes in the seed config)
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from engine.pipeline import ingest

slug, specs = sys.argv[1], sys.argv[2:]
base = ROOT / "data/gmu" / slug
(base / "plans").mkdir(parents=True, exist_ok=True)
(base / "ocr").mkdir(parents=True, exist_ok=True)
for spec in specs:
    name, prefix, *digits = spec.split(":")
    digits = int(digits[0]) if digits else 3
    im = ingest.render((base / f"source/floor-plans-pdf/{name}.pdf").read_bytes())
    (base / f"plans/{name}.png").write_bytes(ingest.encode_png(im))
    items = ingest.ocr(im)
    (base / f"ocr/{name}.ocr.json").write_text(json.dumps(items, indent=1))
    labels = ingest.labels_from_ocr(items, prefix, digits)
    (base / f"ocr/{name}.labels.json").write_text(json.dumps(labels, indent=1))
    kinds = {}
    for l in labels:
        kinds[l["kind"]] = kinds.get(l["kind"], 0) + 1
    print(f"{name}: {im.shape[1]}x{im.shape[0]} px, {len(items)} text boxes, labels {kinds}")
