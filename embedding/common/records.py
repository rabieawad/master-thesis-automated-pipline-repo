"""Read *.functions.json files (step 06, v1 or v2) and collect the unique function texts to embed."""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

# Which record field holds the text to embed. "auto" prefers the name-normalised body (v2 files),
# then the printed body (v1 and v2), then the original source kept for functions escodegen cannot print.
TEXT_FIELDS = {
    "auto": ("textNorm", "text", "rawText"),
    "textNorm": ("textNorm",),
    "text": ("text", "rawText"),
}


@dataclass
class FileFunctions:
    """The functions of one input file, in file order: function index -> key of its unique text."""
    path: Path
    indices: list[int] = field(default_factory=list)
    keys: list[str] = field(default_factory=list)
    skipped: int = 0  # functions without any text


@dataclass
class Corpus:
    files: list[FileFunctions]
    texts: dict[str, str]          # unique key -> text
    bad_files: dict[str, str]      # file name -> reason it was skipped
    total_functions: int


def pick_text(rec: dict, fields: tuple[str, ...]) -> tuple[str | None, str | None]:
    """Return (text, field name) for the first non-empty field."""
    for f in fields:
        t = rec.get(f)
        if isinstance(t, str) and t.strip():
            return t, f
    return None, None


def text_key(rec: dict, text: str, used_field: str) -> str:
    """Dedup key. Reuse the hash step 06 computed for exactly this text, else hash the text."""
    if used_field == "textNorm" and rec.get("hashNorm"):
        return "n:" + rec["hashNorm"]
    if used_field == "text" and rec.get("hash"):
        return "t:" + rec["hash"]
    return "s:" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def load_corpus(paths: list[Path], text_field: str = "auto") -> Corpus:
    fields = TEXT_FIELDS[text_field]
    files, texts, bad = [], {}, {}
    total = 0
    for p in paths:
        try:
            with open(p, encoding="utf-8") as fh:
                data = json.load(fh)
            records = data["functions"]
        except Exception as e:  # empty or broken file: report it and go on
            bad[p.name] = f"{type(e).__name__}: {e}"[:200]
            continue
        if not records:
            bad[p.name] = "no functions"
            continue
        ff = FileFunctions(path=p)
        for rec in records:
            total += 1
            text, used = pick_text(rec, fields)
            if text is None:
                ff.skipped += 1
                continue
            key = text_key(rec, text, used)
            texts.setdefault(key, text)
            ff.indices.append(int(rec["index"]))
            ff.keys.append(key)
        files.append(ff)
    log.info("read %d files (%d skipped), %d functions, %d unique texts",
             len(files), len(bad), total, len(texts))
    return Corpus(files=files, texts=texts, bad_files=bad, total_functions=total)
