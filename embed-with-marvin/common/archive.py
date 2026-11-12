"""Find the *.functions.json files of a run: extract a .tgz / .tar.gz safely, or use a folder as it is."""
from __future__ import annotations

import logging
import os
import tarfile
from pathlib import Path

log = logging.getLogger(__name__)

SUFFIX = ".functions.json"


def _safe_members(tar: tarfile.TarFile, dest: Path):
    """Only regular *.functions.json files whose path stays inside dest (no absolute paths, '..' or links)."""
    root = dest.resolve()
    for m in tar.getmembers():
        if not m.isfile() or not m.name.endswith(SUFFIX):
            continue
        target = (root / m.name).resolve()
        if root != target and root not in target.parents:
            log.warning("skipping unsafe path in archive: %s", m.name)
            continue
        yield m


def extract_archive(archive: Path, dest: Path) -> Path:
    """Extract the function files of `archive` into `dest` (created if needed) and return dest."""
    dest.mkdir(parents=True, exist_ok=True)
    marker = dest / ".extracted"
    if marker.exists() and marker.read_text() == str(archive.resolve()):
        log.info("archive already extracted in %s", dest)
        return dest
    log.info("extracting %s -> %s", archive, dest)
    with tarfile.open(archive, "r:*") as tar:
        members = list(_safe_members(tar, dest))
        try:  # Python 3.12+: extra protection against special files
            tar.extractall(dest, members=members, filter="data")
        except TypeError:
            tar.extractall(dest, members=members)
    marker.write_text(str(archive.resolve()))
    log.info("extracted %d function files", len(members))
    return dest


def list_function_files(folder: Path) -> list[Path]:
    """All *.functions.json below folder, sorted by name so every run sees the same order."""
    files = sorted(p for p in folder.rglob("*" + SUFFIX) if p.is_file())
    return files


def resolve_input(input_path: Path, workdir: Path) -> list[Path]:
    """Input can be a .tgz/.tar.gz/.tar archive, a folder, or a single .functions.json file."""
    if input_path.is_dir():
        return list_function_files(input_path)
    if input_path.name.endswith(SUFFIX):
        return [input_path]
    if tarfile.is_tarfile(input_path):
        name = input_path.name
        for ext in (".tar.gz", ".tgz", ".tar"):
            if name.endswith(ext):
                name = name[: -len(ext)]
        return list_function_files(extract_archive(input_path, workdir / name))
    raise SystemExit(f"input is not a folder, a .functions.json file or a tar archive: {input_path}")


def default_workdir() -> Path:
    """Node-local scratch on the cluster ($TMPDIR), else the system temp folder."""
    return Path(os.environ.get("TMPDIR") or "/tmp") / "embed_work"
