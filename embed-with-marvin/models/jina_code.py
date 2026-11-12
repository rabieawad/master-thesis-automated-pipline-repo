"""jinaai/jina-code-embeddings-0.5b (model card: https://huggingface.co/jinaai/jina-code-embeddings-0.5b).

- Qwen2.5-Coder-0.5B fine-tune, 896-dim vectors (Matryoshka: 64/128/256/512/896), up to 32,768 tokens
- last-token pooling, left padding, bfloat16, flash-attention 2 recommended but optional
- needs transformers >= 4.53 and torch >= 2.7.1; licence CC BY-NC 4.0 (non-commercial, fine for research)
- inputs carry a task instruction. We compare code with code, and both the library functions and the
  website functions must be embedded the same way, so every function gets the code2code document prefix.
"""
from __future__ import annotations

from .hf_base import HFEmbedder

# The model's task prompts (config_sentence_transformers.json, "prompts").
JINA_CODE_PROMPTS = {
    "nl2code_query": "Find the most relevant code snippet given the following query:\n",
    "nl2code_document": "Candidate code snippet:\n",
    "code2code_query": "Find an equivalent code snippet given the following code snippet:\n",
    "code2code_document": "Candidate code snippet:\n",
    "code2nl_query": "Find the most relevant comment given the following code snippet:\n",
    "code2nl_document": "Candidate comment:\n",
    "code2completion_query": "Find the most relevant completion given the following start of code snippet:\n",
    "code2completion_document": "Candidate completion:\n",
    "qa_query": "Find the most relevant answer given the following question:\n",
    "qa_document": "Candidate answer:\n",
}


class JinaCode05B(HFEmbedder):
    name = "jina-code-0.5b"
    hf_id = "jinaai/jina-code-embeddings-0.5b"
    dim = 896
    max_tokens = 32768
    pooling = "last"
    padding_side = "left"
    prefix = JINA_CODE_PROMPTS["code2code_document"]

    def __init__(self, prompt_name: str | None = None, **kw):
        if prompt_name is not None:
            kw["prefix"] = JINA_CODE_PROMPTS[prompt_name]
        super().__init__(**kw)
