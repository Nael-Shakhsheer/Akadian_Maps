"""Turn an uploaded schematic (PDF / PNG / JPEG bytes) into a plan image, OCR its labels, and clean them up.

All processing happens in memory on this machine; nothing is written unencrypted and nothing is sent anywhere.
"""
import re
import cv2
import numpy as np
import pymupdf

RENDER_DPI = 250
OCR_SCALE = 2  # plan text is often only ~8px tall

_ocr = None


def _ocr_engine():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR  # bundled ONNX models, runs offline
        _ocr = RapidOCR()
    return _ocr


def sniff(data: bytes) -> str:
    if data[:4] == b"%PDF":
        return "pdf"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    raise ValueError("Unsupported file: upload a PDF, PNG or JPEG schematic.")


def render(data: bytes) -> np.ndarray:
    """Schematic bytes -> grayscale plan image (uint8)."""
    kind = sniff(data)
    if kind != "pdf":
        im = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
        if im is None:
            raise ValueError("Could not decode the image.")
        return im
    doc = pymupdf.open(stream=data, filetype="pdf")
    page = doc[0]
    # If the page is mostly embedded raster strips (common for exported floor plans), crop to them.
    rects = [r for img in page.get_images(full=True) for r in page.get_image_rects(img[0])]
    big = [r for r in rects if r.width * r.height > 0.15 * page.rect.width * page.rect.height / 4]
    clip = None
    if big:
        clip = big[0]
        for r in big[1:]:
            clip |= r
        clip = (clip * page.rotation_matrix) & page.rect
    pix = page.get_pixmap(dpi=RENDER_DPI, clip=clip, colorspace=pymupdf.csGRAY)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width).copy()


def encode_png(im: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", im)
    return buf.tobytes()


def decode_png(data: bytes) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)


def ocr(im: np.ndarray) -> list:
    """OCR every text box -> [{text, x, y, w, h, score}] in plan pixels."""
    big = cv2.resize(cv2.cvtColor(im, cv2.COLOR_GRAY2BGR), None, fx=OCR_SCALE, fy=OCR_SCALE, interpolation=cv2.INTER_CUBIC)
    res, _ = _ocr_engine()(big, box_thresh=0.3, text_score=0.3)
    items = []
    for box, text, score in res or []:
        xs = [p[0] / OCR_SCALE for p in box]
        ys = [p[1] / OCR_SCALE for p in box]
        items.append({"text": text, "x": round(sum(xs) / 4, 1), "y": round(sum(ys) / 4, 1),
                      "w": round(max(xs) - min(xs), 1), "h": round(max(ys) - min(ys), 1), "score": round(float(score), 2)})
    return items


# ---------- label cleanup ----------
FIXES = [  # common OCR misreads of plan keywords
    (r"STA[I1!]?R", "STAIR"), (r"SH[AE][FHNE]?[TF]", "SHAFT"), (r"SHAF[A-Z]*?T", "SHAFT"),
    (r"C[DO]RR", "CORR"), (r"\bLEV", "ELEV"), (r"ELEV[B]", "ELEV8"), (r"JNISEX", "UNISEX"),
    (r"JANT", "JAN1"), (r"WOMENS(?!\d)", "WOMENS1"),
]
KEYWORDS = "SHAFT|ELEC|TELDATA|MECH|JAN|STAIR|ELEV|CORR|VEST|LOBBY|ATRIUM|WOMENS|MENS|UNISEX|DOCK|TRASH"
KIND = {"STAIR": "stair", "ELEV": "elevator", "VEST": "entrance", "WOMENS": "restroom", "MENS": "restroom",
        "UNISEX": "restroom", "CORR": "circulation", "LOBBY": "circulation", "ATRIUM": "circulation"}
SUFFIX_DIGIT = {"8": "B", "0": "D", "1": "I", "4": "A", "6": "G", "5": "S", "2": "Z"}


def _fix_room(tok, prefix):
    if prefix.isalpha():
        if prefix == "G":
            tok = re.sub(r"^[6C0O]", "G", tok)
        return tok if re.fullmatch(rf"{prefix}\d{{2}}[A-Z]{{0,2}}", tok) else None
    if prefix and not tok.startswith(prefix):
        return None
    if re.fullmatch(r"\d{4}", tok):  # 3-digit room + letter suffix read as a digit
        tok = tok[:3] + SUFFIX_DIGIT.get(tok[3], tok[3])
    return tok if re.fullmatch(r"\d{3}[A-Z]{0,2}", tok) else None


def _tokens(text, prefix):
    t = re.sub(r"[^A-Z0-9!]", "", text.upper())
    for a, b in FIXES:
        t = re.sub(a, b, t)
    out = []
    for m in re.finditer(rf"({KEYWORDS})(\d*)|([A-Z]?\d{{2,4}}[A-Z]{{0,2}})", t):
        if m.group(1):
            out.append((m.group(1) + m.group(2), KIND.get(m.group(1), "service")))
        else:
            r = _fix_room(m.group(3), prefix)
            if r:
                out.append((r, "room"))
    return out


def labels_from_ocr(items: list, prefix: str) -> list:
    """Raw OCR -> [{id, kind, x, y}] room labels for one floor (prefix: 'G', '1', '2', ...)."""
    labels = {}
    for it in items:
        toks = _tokens(it["text"], prefix)
        for i, (tid, kind) in enumerate(toks):
            x = it["x"] + (i - (len(toks) - 1) / 2) * it["w"] / max(len(toks), 1)  # spread merged tokens
            if tid not in labels or labels[tid]["score"] < it["score"]:
                labels[tid] = {"id": tid, "kind": kind, "x": round(x), "y": round(it["y"]), "score": it["score"]}
    out = sorted(labels.values(), key=lambda l: (l["kind"], l["id"]))
    for l in out:
        l.pop("score")
    return out


def is_title(text: str) -> bool:
    """Drawing titles / sheet numbers: long strings that aren't room labels."""
    t = re.sub(r"[^A-Za-z0-9]", "", text)
    return len(t) >= 12
