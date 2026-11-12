# Function embeddings

Embeds every function of the step-06 `*.functions.json` files (old v1 and new v2 format), as named runs
that can be stopped and resumed. Each input archive gives one packed result archive with one `.npz` per
bundle, and each vector is tied to its function `index`.

## Folders

```
~/embed_runs/                      root; change with EMBED_ROOT=/other/path
  input/                           put your .tgz / .tar.gz / .tar archives here, split however you like
  output/
    <run>/                         one folder per run; the run name defaults to the model name
      run.json                     model and settings (a resumed run must use the same ones)
      state.json                   per input archive: in_progress / done, counts, times
      _cache/                      vectors of unique texts, shared by every archive of the run
      work/<name>/                 bundles of the archive being processed right now
      <name>.embeddings.tgz        finished: <name>/<bundle>.functions.<model>.npz + <name>/manifest.json
      logs/                        one log per job, sample reports
```

Input archives are never changed or deleted. Extracted copies live in `$TMPDIR` and are deleted when an
archive is done.

## On Marvin

```bash
cd embedding
bash slurm/setup_env.sh                 # once: creates ~/envs/embed (torch >= 2.7.1, transformers >= 4.53)
mkdir -p ~/embed_runs/input             # then copy your .tgz files into it

sbatch slurm/job_embed.slurm --model jina-code-0.5b --sample 0.01     # timing test, writes no results
sbatch slurm/job_embed.slurm --model jina-code-0.5b                   # all archives in input/
sbatch slurm/job_embed.slurm --model jina-code-0.5b --run trial1 --files part1.tgz part3.tgz

python embed.py status                  # all runs     (load the env first: module load Miniforge3;
python embed.py status --run jina-code-0.5b            #  source activate ~/envs/embed)
```

Resuming: submit the same command again. Finished archives are skipped, finished bundles are not
rewritten, and every vector already computed is reused, so at most about 10 minutes of GPU work is lost.
Five minutes before the time limit the job saves and stops by itself (exit code 3). New archives added to
`input/` later are picked up by the same command. A run started with one model or window refuses to
continue with another; use a new `--run` name for that. `--redo part1.tgz` processes a finished archive again.

## Code layout

| Path | Part | What it does |
| --- | --- | --- |
| `embed.py` | shared | `run` and `status` commands |
| `common/run.py` | shared | run folder, settings check, per-archive state, packing |
| `common/archive.py` | shared | safe extraction, finds `*.functions.json` |
| `common/records.py` | shared | reads files, picks the text (`textNorm` > `text` > `rawText`), dedups identical texts |
| `common/engine.py` | shared | token counting, chunking, length-sorted batches, OOM retry, progress, stop on signal |
| `common/cache.py` | shared | vectors of unique texts saved in parts every 10 minutes |
| `common/writer.py` | shared | one `.npz` per bundle |
| `models/base.py` | interface | what every model adapter implements |
| `models/hf_base.py` | shared for HF models | tokenizer, prefix, pooling, dtype, attention backend |
| `models/jina_code.py` | model-specific | jina-code-embeddings-0.5b: 896 dims, 32k tokens, last-token pooling, prompt |
| `models/__init__.py` | registry | model name -> adapter |
| `slurm/job_embed.slurm` | cluster | Marvin job (ag_ifi_martini, sgpu_long, 1 A100, 8 h) |
| `slurm/setup_env.sh` | cluster | creates the environment, run once by hand |
| `check_outputs.py` | shared | checks unpacked results against the input files |

A new model = one adapter file in `models/` + one line in `models/__init__.py`.

## Result file

`<bundle>.functions.<model>.npz`, read with `np.load(path)`:

- `index` (int32): the function's `index` in the input file; row i belongs to `index[i]`
- `embedding` (float16, n x 896): L2-normalised vector
- `key` (str): `n:`+hashNorm, `t:`+hash, or `s:`+sha256 of the text, to join with the JSON
- `n_tokens` (int32): tokens of the function text
- `n_chunks` (int16): 1 = embedded whole; more = longer than the window, mean of overlapping chunks

Functions without any text are left out (counted in `manifest.json`); empty or broken bundle files are
listed there under `bundles_skipped`.
