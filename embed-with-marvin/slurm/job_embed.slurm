#!/bin/bash
# ============================================================================
# SLURM job: embed the function archives in $EMBED_ROOT/input/ as a named, resumable run.
#
# ONCE, before the first job (on a login node):  bash slurm/setup_env.sh
#
# SUBMIT FROM THE embedding/ FOLDER (everything after the script name goes to "embed.py run"):
#   sbatch slurm/job_embed.slurm --model jina-code-0.5b                          # all archives in input/
#   sbatch slurm/job_embed.slurm --model jina-code-0.5b --run trial1 --files part1.tgz part2.tgz
#   sbatch slurm/job_embed.slurm --model jina-code-0.5b --sample 0.01            # timing test first
#
# Folders: $EMBED_ROOT (default ~/embed_runs)/input/ for your .tgz files,
#          $EMBED_ROOT/output/<run>/ for results (<name>.embeddings.tgz per input archive).
# Other root:  EMBED_ROOT=/path/to/folder sbatch slurm/job_embed.slurm --model ...
#
# If the job reaches its time limit it saves its work 5 minutes before and stops; submit the same
# command again to continue. Check progress:  python embed.py status --run <run>
# MONITOR:  squeue --me    and    tail -f embed_<jobid>.log
# ============================================================================
#SBATCH --job-name=embed
#SBATCH --partition=sgpu_long
#SBATCH --account=ag_ifi_martini
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=08:00:00
#SBATCH --signal=B:USR1@300
#SBATCH --output=embed_%j.log
#SBATCH --error=embed_%j.log

set -euo pipefail
export SLURM_EXPORT_ENV=ALL

# Where the code is: the folder you submitted from (embedding/), or its parent if you submitted from slurm/
CODE_DIR="${CODE_DIR:-$SLURM_SUBMIT_DIR}"
[[ -f "$CODE_DIR/embed.py" ]] || CODE_DIR="$(dirname "$CODE_DIR")"
export EMBED_ROOT="${EMBED_ROOT:-$HOME/embed_runs}"
ENV_DIR="${ENV_DIR:-$HOME/envs/embed}"
ENV_PY="$ENV_DIR/bin/python"

echo "Job $SLURM_JOB_ID on $(hostname) at $(date)"
echo ">>> root=$EMBED_ROOT  args: $*"

echo ">>> Preflight checks"
test -x "$ENV_PY"            || { echo "ERROR: no environment at $ENV_DIR. Create it once with: bash slurm/setup_env.sh"; exit 1; }
test -f "$CODE_DIR/embed.py" || { echo "ERROR: embed.py not found in $CODE_DIR; submit from the embedding/ folder"; exit 1; }
test -d "$EMBED_ROOT/input"  || { echo "ERROR: input folder $EMBED_ROOT/input does not exist; create it and put your .tgz files there"; exit 1; }

module load Miniforge3
source activate "$ENV_DIR"
export HF_HUB_DISABLE_XET=1
export HF_HOME="${HF_HOME_DIR:-${TMPDIR:-/tmp}/hf_cache_$SLURM_JOB_ID}"   # set HF_HOME_DIR to keep downloads
export TOKENIZERS_PARALLELISM=true
WORK_DIR="${TMPDIR:-/tmp}/embed_$SLURM_JOB_ID"   # node-local: archives are extracted here
mkdir -p "$HF_HOME" "$WORK_DIR"

"$ENV_PY" -c "import torch, transformers, numpy; assert torch.cuda.is_available(), 'no GPU visible'; print('torch', torch.__version__, 'transformers', transformers.__version__, 'gpu', torch.cuda.get_device_name(0))" \
    || { echo "ERROR: environment or GPU check failed"; exit 1; }
echo ">>> Preflight OK"
nvidia-smi

# Run in the background so the time-limit warning (USR1) can be passed on to Python, which then saves and stops.
"$ENV_PY" "$CODE_DIR/embed.py" run --workdir "$WORK_DIR" "$@" &
PID=$!
trap 'echo ">>> time limit near: asking embed.py to save and stop"; kill -USR1 $PID 2>/dev/null || true' USR1
set +e
wait $PID; STATUS=$?
while kill -0 $PID 2>/dev/null; do wait $PID; STATUS=$?; done   # wait again after the trap interrupted it
set -e

rm -rf "$WORK_DIR"
if [[ $STATUS -eq 3 ]]; then
    echo ">>> Stopped before the end. Submit the same command again to continue."
elif [[ $STATUS -ne 0 ]]; then
    echo ">>> embed.py failed with exit code $STATUS"
fi
echo "Job $SLURM_JOB_ID finished at $(date)"
exit $STATUS
