"""Embed every function of the step-06 *.functions.json archives, as a named run that can be resumed.

  python embed.py run --model jina-code-0.5b                      # every archive in <root>/input/
  python embed.py run --model jina-code-0.5b --run trial1 --files part1.tgz part3.tgz
  python embed.py run --model jina-code-0.5b --sample 0.01        # timing test, writes no results
  python embed.py status                                          # all runs
  python embed.py status --run jina-code-0.5b                     # one run, per archive

<root> is $EMBED_ROOT or ~/embed_runs. The run name defaults to the model name. Running the same run again
skips finished archives and bundles and reuses every vector already computed; archives added to input/
later are picked up by the same command. Input archives are never changed or deleted.

For each input archive <name>.tgz the run writes <root>/output/<run>/<name>.embeddings.tgz containing
<name>/<bundle>.functions.<model>.npz (arrays index, embedding, key, n_tokens, n_chunks) and manifest.json.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import random
import shutil
import signal
import socket
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common.archive import default_workdir, extract_archive, list_function_files  # noqa: E402
from common.cache import VectorCache  # noqa: E402
from common.engine import EngineConfig, count_tokens, embed_unique  # noqa: E402
from common.records import TEXT_FIELDS, load_corpus  # noqa: E402
from common.run import Run, archive_stem, default_root  # noqa: E402
from common.writer import output_path, write_file  # noqa: E402
from models import MODELS, get_model  # noqa: E402

log = logging.getLogger("embed")
EXIT_STOPPED = 3  # stopped before the end (time limit): submit the same command again

_stop = {"requested": False}


def _request_stop(signum, frame):
    _stop["requested"] = True
    log.warning("received signal %d: finishing the current batch, saving and stopping", signum)


# --------------------------------------------------------------------------- arguments
def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--root", type=Path, default=None, help="default: $EMBED_ROOT or ~/embed_runs")
        sp.add_argument("--input-dir", type=Path, default=None, help="default: <root>/input")
        sp.add_argument("--output-dir", type=Path, default=None, help="default: <root>/output")

    r = sub.add_parser("run", help="embed archives (new run or resume)")
    common(r)
    r.add_argument("--model", required=True, choices=sorted(MODELS))
    r.add_argument("--run", default=None, help="run name (default: the model name)")
    r.add_argument("--files", nargs="+", default=None, help="only these archives (names in the input folder or paths)")
    r.add_argument("--redo", nargs="+", default=[], help="process these archives again even if done")
    r.add_argument("--workdir", type=Path, default=None, help="where archives are extracted (default: $TMPDIR)")
    r.add_argument("--model-path", default=None, help="local model folder instead of downloading from Hugging Face")
    r.add_argument("--text-field", default="auto", choices=sorted(TEXT_FIELDS), help="auto = textNorm, else text, else rawText")
    r.add_argument("--window", type=int, default=32768, help="max tokens per function before it is chunked")
    r.add_argument("--overlap", type=int, default=256, help="token overlap between chunks")
    r.add_argument("--token-budget", type=int, default=131072, help="max padded tokens per batch")
    r.add_argument("--max-batch", type=int, default=256)
    r.add_argument("--device", default="auto")
    r.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
    r.add_argument("--attn", default="auto", help="auto | flash_attention_2 | sdpa | eager")
    r.add_argument("--sample", type=float, default=None,
                   help="embed this fraction of unique texts, print throughput and projected time; writes no results")
    r.add_argument("--seed", type=int, default=0)
    r.add_argument("--keep-extracted", action="store_true", help="do not delete extracted input files")
    r.add_argument("--force-settings", action="store_true", help="resume even if settings differ (mixes vectors!)")

    s = sub.add_parser("status", help="show runs and the state of each archive")
    common(s)
    s.add_argument("--run", default=None, help="one run (default: list all runs)")
    return p.parse_args(argv)


def setup_logging(log_file: Path | None = None):
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not root.handlers:
        h = logging.StreamHandler()
        h.setFormatter(fmt)
        root.addHandler(h)
    if log_file:
        fh = logging.FileHandler(log_file)
        fh.setFormatter(fmt)
        root.addHandler(fh)


# --------------------------------------------------------------------------------- run
def cmd_run(args) -> int:
    root = args.root or default_root()
    run = Run(root, args.run or args.model, args.input_dir, args.output_dir)
    inputs = run.select_inputs(args.files)
    workdir = (args.workdir or default_workdir()) / run.name

    embedder = get_model(args.model, model_path=args.model_path, device=args.device, dtype=args.dtype, attn=args.attn)
    cfg = EngineConfig(window=args.window, overlap=args.overlap, token_budget=args.token_budget, max_batch=args.max_batch)

    if args.sample:
        run.logs_dir.mkdir(parents=True, exist_ok=True)
        setup_logging(run.logs_dir / f"sample_{time.strftime('%Y%m%d-%H%M%S')}_{os.environ.get('SLURM_JOB_ID', 'local')}.log")
        embedder.load()
        return run_sample(args, run, inputs, embedder, cfg, workdir)

    redo = {archive_stem(Path(n)) for n in args.redo}
    pending = [a for a in inputs if archive_stem(a) in redo or not run.is_done(a)]
    for a in inputs:
        if run.input_changed(a) and a not in pending:
            log.warning("%s changed since it was embedded; use --redo %s to process it again", a.name, a.name)
    if not pending:
        setup_logging()
        log.info("run '%s': all %d selected archives are already done (%s)", run.name, len(inputs), run.dir)
        return 0

    embedder.load()
    settings = {**embedder.describe(), "model": embedder.name, "text_field": args.text_field,
                "window": cfg.window, "overlap": cfg.overlap}
    run.open(settings, force=args.force_settings)
    setup_logging(run.logs_dir / f"run_{time.strftime('%Y%m%d-%H%M%S')}_{os.environ.get('SLURM_JOB_ID', 'local')}.log")
    log.info("run '%s': %d archives selected, %d to process: %s", run.name, len(inputs), len(pending),
             ", ".join(a.name for a in pending))

    signal.signal(signal.SIGUSR1, _request_stop)  # SLURM warning before the time limit (see job_embed.slurm)
    signal.signal(signal.SIGTERM, _request_stop)
    cache = VectorCache(run.cache_dir, embedder.dim)

    for i, archive in enumerate(pending, 1):
        if _stop["requested"]:
            break
        log.info("=== [%d/%d] %s", i, len(pending), archive.name)
        stopped = process_archive(run, archive, embedder, cache, cfg, args, workdir)
        if stopped:
            break

    if _stop["requested"]:
        log.warning("stopped early; submit the same command again to continue run '%s'", run.name)
        return EXIT_STOPPED
    log.info("run '%s' finished: results in %s", run.name, run.dir)
    return 0


def process_archive(run: Run, archive: Path, embedder, cache: VectorCache, cfg: EngineConfig, args, workdir: Path) -> bool:
    """Extract, embed new texts, write one .npz per bundle, pack, clean up. Returns True if stopped early."""
    t0 = time.time()
    run.mark(archive, "in_progress", started=run.entry(archive).get("started") or time.strftime("%Y-%m-%dT%H:%M:%S"))
    extracted = extract_archive(archive, workdir / archive_stem(archive))
    corpus = load_corpus(list_function_files(extracted), args.text_field)

    todo = {k: t for k, t in corpus.texts.items() if k not in cache}
    log.info("%d unique texts, %d already in the run's cache, %d to embed",
             len(corpus.texts), len(corpus.texts) - len(todo), len(todo))
    stats = embed_unique(embedder, todo, cache, cfg, should_stop=lambda: _stop["requested"])
    if stats.get("stopped"):
        run.mark(archive, "in_progress", note="stopped before all texts were embedded")
        return True

    out_dir = run.bundle_dir(archive)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = existing = 0
    for ff in corpus.files:
        path = output_path(ff.path, out_dir, embedder.name)
        if path.exists() and archive_stem(archive) not in {archive_stem(Path(n)) for n in args.redo}:
            existing += 1
            continue
        write_file(ff, cache, path)
        written += 1
    manifest = {
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "run": run.name, "input": archive.name,
        "host": socket.gethostname(), "slurm_job": os.environ.get("SLURM_JOB_ID"),
        "python": platform.python_version(), "versions": _versions(),
        "model": embedder.describe(), "engine": vars(cfg), "text_field": args.text_field,
        "bundles": len(corpus.files), "bundles_skipped": corpus.bad_files,
        "functions": corpus.total_functions, "functions_without_text": sum(f.skipped for f in corpus.files),
        "unique_texts": len(corpus.texts), "embedded_now": stats, "seconds": round(time.time() - t0, 1),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))
    packed = run.pack(archive)
    run.mark(archive, "done", finished=time.strftime("%Y-%m-%dT%H:%M:%S"), output=packed.name,
             bundles=len(corpus.files), bundles_skipped=len(corpus.bad_files), functions=corpus.total_functions,
             unique_texts=len(corpus.texts), newly_embedded=stats.get("embedded", 0), note=None)
    if not args.keep_extracted:
        shutil.rmtree(extracted, ignore_errors=True)
    log.info("%s done: %d bundles (%d written, %d from an earlier job) -> %s in %.1f min",
             archive.name, len(corpus.files), written, existing, packed.name, (time.time() - t0) / 60)
    return False


def run_sample(args, run: Run, inputs, embedder, cfg, workdir) -> int:
    """Embed a random fraction of the unique texts of the selected archives and project the full time."""
    files = []
    for a in inputs:
        files += list_function_files(extract_archive(a, workdir / ("sample_" + archive_stem(a))))
    corpus = load_corpus(files, args.text_field)
    keys = sorted(corpus.texts)
    random.Random(args.seed).shuffle(keys)
    n = max(1, int(len(keys) * args.sample))
    log.info("sample: %d of %d unique texts; counting tokens of all texts for the projection", n, len(keys))
    all_tokens = int(count_tokens(embedder, [corpus.texts[k] for k in keys]).sum())
    tmp_cache = VectorCache(workdir / f"sample_cache_{int(time.time())}", embedder.dim)
    stats = embed_unique(embedder, {k: corpus.texts[k] for k in keys[:n]}, tmp_cache, cfg)
    tps = stats["tokens_per_s"]
    report = {"archives": [a.name for a in inputs], "sample": stats, "all_unique_texts": len(keys),
              "all_tokens": all_tokens, "projected_minutes": round(all_tokens / max(tps, 1e-9) / 60, 1),
              "projected_cache_gb_float16": round(len(keys) * embedder.dim * 2 / 1e9, 2),
              "model": embedder.describe(), "engine": vars(cfg)}
    out = run.logs_dir / f"sample_report_{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=1))
    if not args.keep_extracted:
        shutil.rmtree(workdir, ignore_errors=True)
    log.info("SAMPLE: %.0f tokens/s, %.1f functions/s -> about %.1f min for all %d unique texts (%d tokens). Report: %s",
             tps, stats["functions_per_s"], report["projected_minutes"], len(keys), all_tokens, out)
    return 0


# ------------------------------------------------------------------------------ status
def cmd_status(args) -> int:
    root = args.root or default_root()
    out_root = args.output_dir or root / "output"
    names = [args.run] if args.run else sorted(p.name for p in out_root.glob("*") if (p / "run.json").exists())
    if not names:
        print(f"no runs in {out_root}")
        return 0
    for name in names:
        run = Run(root, name, args.input_dir, args.output_dir)
        if not run.exists():
            print(f"run '{name}' does not exist in {out_root}")
            continue
        s = run.settings()
        n_cache = sum(1 for _ in run.cache_dir.glob("part-*.npz"))
        print(f"\nrun '{name}'  model={s.get('model')}  window={s.get('window')}  text={s.get('text_field')}  "
              f"started={s.get('created')}  cache parts={n_cache}")
        rows, seen = [], set()
        for stem, e in sorted(run.state["inputs"].items()):
            seen.add(stem)
            rows.append((e.get("input", stem), e.get("status"), e.get("bundles", ""), e.get("functions", ""),
                         e.get("finished") or e.get("updated", ""), e.get("output") or e.get("note") or ""))
        for a in run.available_inputs():
            if archive_stem(a) not in seen:
                rows.append((a.name, "new", "", "", "", "in input/, not processed yet"))
        if not rows:
            print("  no archives yet")
            continue
        w = max(len(str(r[0])) for r in rows)
        print(f"  {'archive':<{w}}  {'status':<11} {'bundles':>7} {'functions':>9}  {'time':<19}  output / note")
        for r in rows:
            print(f"  {r[0]:<{w}}  {r[1]:<11} {str(r[2]):>7} {str(r[3]):>9}  {str(r[4]):<19}  {r[5] or ''}")
        done = sum(1 for r in rows if r[1] == "done")
        print(f"  {done}/{len(rows)} done")
    return 0


def _versions() -> dict:
    out = {}
    for mod in ("torch", "transformers", "numpy", "flash_attn"):
        try:
            out[mod] = __import__(mod).__version__
        except Exception:
            out[mod] = None
    return out


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.cmd == "status":
        return cmd_status(args)
    setup_logging()
    return cmd_run(args)


if __name__ == "__main__":
    sys.exit(main())
