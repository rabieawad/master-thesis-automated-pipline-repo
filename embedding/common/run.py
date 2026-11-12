"""A named run: folder layout, settings check, per-archive state, packing of finished results.

  <root>/input/                       .tgz / .tar.gz / .tar archives of *.functions.json (you upload these)
  <root>/output/<run>/run.json        model and settings; a resumed run must use the same ones
  <root>/output/<run>/state.json      per input archive: pending / in_progress / done, counts, times
  <root>/output/<run>/_cache/         vectors of unique texts, shared by every archive of the run
  <root>/output/<run>/work/<name>/    per-bundle .npz files of the archive being processed
  <root>/output/<run>/<name>.embeddings.tgz   finished archive: <name>/<bundle>.<model>.npz + manifest.json
  <root>/output/<run>/logs/           one log per job, sample reports
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import tarfile
import time
from pathlib import Path

log = logging.getLogger(__name__)

ARCHIVE_EXTS = (".tar.gz", ".tgz", ".tar")
# Settings that change the vectors; a run refuses to resume with different values.
LOCKED_SETTINGS = ("model", "model_path", "dim", "prefix", "pooling", "dtype", "text_field", "window", "overlap")


def default_root() -> Path:
    return Path(os.environ.get("EMBED_ROOT") or Path.home() / "embed_runs")


def archive_stem(path: Path) -> str:
    for ext in ARCHIVE_EXTS:
        if path.name.endswith(ext):
            return path.name[: -len(ext)]
    return path.stem


def is_archive(path: Path) -> bool:
    return path.is_file() and path.name.endswith(ARCHIVE_EXTS)


def _write_json(path: Path, data) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, path)


class Run:
    def __init__(self, root: Path, name: str, input_dir: Path | None = None, output_dir: Path | None = None):
        self.root = root
        self.name = name
        self.input_dir = input_dir or root / "input"
        self.dir = (output_dir or root / "output") / name
        self.cache_dir = self.dir / "_cache"
        self.work_dir = self.dir / "work"
        self.logs_dir = self.dir / "logs"
        self.run_file = self.dir / "run.json"
        self.state_file = self.dir / "state.json"
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {"inputs": {}}

    def exists(self) -> bool:
        return self.run_file.exists()

    # ------------------------------------------------------------- settings
    def open(self, settings: dict, force: bool = False) -> None:
        """Create the run folder, or check that a resumed run uses the same settings."""
        for d in (self.dir, self.cache_dir, self.work_dir, self.logs_dir):
            d.mkdir(parents=True, exist_ok=True)
        if self.run_file.exists():
            old = json.loads(self.run_file.read_text())
            diff = {k: (old.get(k), settings.get(k)) for k in LOCKED_SETTINGS if old.get(k) != settings.get(k)}
            if diff and not force:
                lines = "\n".join(f"  {k}: run has {a!r}, now {b!r}" for k, (a, b) in diff.items())
                raise SystemExit(f"run '{self.name}' was started with other settings:\n{lines}\n"
                                 "Use the same settings, another --run name, or --force-settings.")
            log.info("resuming run '%s' (started %s)", self.name, old.get("created"))
        else:
            _write_json(self.run_file, {**settings, "created": time.strftime("%Y-%m-%dT%H:%M:%S")})
            log.info("new run '%s' in %s", self.name, self.dir)

    def settings(self) -> dict:
        return json.loads(self.run_file.read_text()) if self.run_file.exists() else {}

    # ---------------------------------------------------------------- inputs
    def available_inputs(self) -> list[Path]:
        if not self.input_dir.is_dir():
            return []
        return sorted(p for p in self.input_dir.iterdir() if is_archive(p))

    def select_inputs(self, names: list[str] | None) -> list[Path]:
        """All archives in the input folder, or only the named ones (names in the input folder, or paths)."""
        if not names:
            found = self.available_inputs()
            if not found:
                raise SystemExit(f"no .tgz/.tar.gz/.tar files in {self.input_dir}")
            return found
        out, missing = [], []
        for n in names:
            p = Path(n)
            cand = p if p.is_absolute() or p.exists() else self.input_dir / n
            (out if is_archive(cand) else missing).append(cand)
        if missing:
            have = ", ".join(p.name for p in self.available_inputs()) or "none"
            raise SystemExit(f"not found: {', '.join(map(str, missing))}\nin {self.input_dir}: {have}")
        stems = [archive_stem(p) for p in out]
        dupes = {s for s in stems if stems.count(s) > 1}
        if dupes:
            raise SystemExit(f"two inputs would get the same output name: {', '.join(sorted(dupes))}")
        return out

    # ----------------------------------------------------------------- state
    def entry(self, archive: Path) -> dict:
        return self.state["inputs"].get(archive_stem(archive), {"status": "pending"})

    def is_done(self, archive: Path) -> bool:
        e = self.entry(archive)
        return e.get("status") == "done" and self.output_archive(archive).exists()

    def mark(self, archive: Path, status: str, **info) -> None:
        st = archive.stat()
        e = self.state["inputs"].setdefault(archive_stem(archive), {})
        e.update(status=status, input=archive.name, input_bytes=st.st_size, input_mtime=int(st.st_mtime),
                 updated=time.strftime("%Y-%m-%dT%H:%M:%S"), **info)
        _write_json(self.state_file, self.state)

    def input_changed(self, archive: Path) -> bool:
        e = self.entry(archive)
        st = archive.stat()
        return e.get("status") == "done" and (e.get("input_bytes") != st.st_size or e.get("input_mtime") != int(st.st_mtime))

    # ---------------------------------------------------------------- output
    def bundle_dir(self, archive: Path) -> Path:
        return self.work_dir / archive_stem(archive)

    def output_archive(self, archive: Path) -> Path:
        return self.dir / f"{archive_stem(archive)}.embeddings.tgz"

    def pack(self, archive: Path) -> Path:
        """Pack work/<name>/ into <name>.embeddings.tgz (atomic), then delete work/<name>/."""
        src, dst = self.bundle_dir(archive), self.output_archive(archive)
        tmp = dst.with_name(dst.name + ".tmp")
        with tarfile.open(tmp, "w:gz", compresslevel=1) as tar:  # float16 vectors barely compress; keep it fast
            tar.add(src, arcname=archive_stem(archive))
        os.replace(tmp, dst)
        shutil.rmtree(src)
        return dst
