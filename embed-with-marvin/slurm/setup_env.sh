#!/bin/bash
# Run ONCE on a Marvin login node to create the Python environment used by job_embed.slurm:
#   bash slurm/setup_env.sh
# jina-code-embeddings needs torch >= 2.7.1 and transformers >= 4.53, newer than the old "refinement" env,
# so this makes a separate env at ~/envs/embed (change ENV_DIR to put it elsewhere).
set -euo pipefail
ENV_DIR="${ENV_DIR:-$HOME/envs/embed}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

module load Miniforge3
conda create -y -p "$ENV_DIR" python=3.11
source activate "$ENV_DIR"
pip install --upgrade pip
pip install -r "$HERE/requirements.txt"

# Optional, faster attention on the A100s. It compiles for a long time if no prebuilt wheel matches;
# the code works without it (it falls back to PyTorch's sdpa attention).
#   pip install flash-attn --no-build-isolation

python -c "import torch, transformers; print('torch', torch.__version__, 'transformers', transformers.__version__)"
echo "Environment ready: $ENV_DIR"
