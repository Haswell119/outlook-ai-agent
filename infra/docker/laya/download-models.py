#!/usr/bin/env python3
"""Explicit, one-shot download of the Laya checkpoints into HF_HOME (/models).

The inference server (`laya-serve`) always runs with HF_HUB_OFFLINE=1 and
never downloads anything. Weights reach /models through this script only:

  - docker compose, service `laya-models` (profile `laya`): first start in
    development, then a no-op while the named volume holds the checkpoints;
  - Helm, optional Job `laya.weights.download.enabled` that fills the PVC
    (point HF_ENDPOINT at an internal mirror in a closed network);
  - an internal image build that bakes the weights (build arg BAKE_MODELS).

Environment:
  LAYA_MODELS               comma list among english, multilingual, typed-decisions
                            (default: english,multilingual — what the orchestrator uses)
  LAYA_MODEL_REVISION       optional Hugging Face commit of the bundle repo to pin; the
                            cache's `main` ref is pointed at it, which is what the
                            offline server resolves
  LAYA_DOWNLOAD_CHECK_ONLY  "1": only verify the checkpoints are present (exit 3 if not)
  HF_ENDPOINT, HF_TOKEN     standard huggingface_hub variables (internal mirror, private
                            mirror token — never printed)

Mirrors the file selection of laya 0.3.9 (`laya.agent.Agent`): only
rl_agent_config.json, model.safetensors, tokenizer/* and encoder/* of each
requested checkpoint are fetched. Prints paths and sizes, nothing else.
"""
import os
import sys
from pathlib import Path

REPO = "convaiinnovations/laya"
# Checkpoint -> sub-folder of the bundle repo (laya.router.DEFAULT_MODELS, 0.3.9).
SUBFOLDERS = {"english": None, "multilingual": "multilingual", "typed-decisions": "typed-decisions"}
FILES = ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")


def requested() -> list:
    raw = os.environ.get("LAYA_MODELS", "").strip() or "english,multilingual"
    names = [n.strip() for n in raw.split(",") if n.strip()]
    unknown = [n for n in names if n not in SUBFOLDERS]
    if unknown:
        sys.exit(f"laya-models: unknown checkpoint(s) {unknown}; expected some of {sorted(SUBFOLDERS)}")
    return names


def patterns(name: str) -> list:
    sub = SUBFOLDERS[name]
    prefix = f"{sub}/" if sub else ""
    return [prefix + f for f in FILES]


def model_dir(snapshot: Path, name: str) -> Path:
    sub = SUBFOLDERS[name]
    return snapshot / sub if sub else snapshot


def complete(snapshot: Path, name: str) -> bool:
    d = model_dir(snapshot, name)
    return (d / "rl_agent_config.json").is_file() and (d / "model.safetensors").is_file() and (d / "tokenizer").is_dir()


def size_mb(d: Path) -> int:
    """Size of one checkpoint's files (the english one sits at the repo root, next to the others' folders)."""
    parts = [d / "rl_agent_config.json", d / "model.safetensors", *(d / "tokenizer").rglob("*"), *(d / "encoder").rglob("*")]
    return round(sum(p.stat().st_size for p in parts if p.is_file()) / 1_048_576)


def endpoint() -> str:
    """HF_ENDPOINT without any user-info (never print credentials)."""
    from urllib.parse import urlsplit

    u = urlsplit(os.environ.get("HF_ENDPOINT", "").strip() or "https://huggingface.co")
    return f"{u.scheme}://{u.hostname or ''}{f':{u.port}' if u.port else ''}"


def main() -> int:
    names = requested()
    check_only = os.environ.get("LAYA_DOWNLOAD_CHECK_ONLY", "").strip().lower() in ("1", "true", "yes")
    revision = os.environ.get("LAYA_MODEL_REVISION", "").strip() or None
    if not check_only:
        # The image defaults to offline; this script is the one place allowed to download.
        os.environ["HF_HUB_OFFLINE"] = "0"
        os.environ["TRANSFORMERS_OFFLINE"] = "0"
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    from huggingface_hub import snapshot_download  # imported after the environment is set

    union = [p for n in names for p in patterns(n)]
    print(f"laya-models: HF_HOME={os.environ.get('HF_HOME', '~/.cache/huggingface')} checkpoints={','.join(names)}", flush=True)

    try:
        snapshot = Path(snapshot_download(REPO, revision=revision, allow_patterns=union, local_files_only=True))
        missing = [n for n in names if not complete(snapshot, n)]
    except Exception:  # noqa: BLE001 — nothing cached yet
        snapshot, missing = None, list(names)

    if not missing:
        print(f"laya-models: already present in {snapshot} — nothing to download", flush=True)
    elif check_only:
        print(f"laya-models: missing checkpoint(s) {missing}; populate the volume first (docs/LAYA.md §weights)", file=sys.stderr)
        return 3
    else:
        print(f"laya-models: downloading {missing} from {endpoint()} (one-off)", flush=True)
        snapshot = Path(snapshot_download(REPO, revision=revision, allow_patterns=union))
        if revision:
            # The server asks for `main` (laya 0.3.9 passes no revision): point it at the pinned commit.
            refs = snapshot.parent.parent / "refs"
            refs.mkdir(parents=True, exist_ok=True)
            (refs / "main").write_text(snapshot.name)
        still = [n for n in names if not complete(snapshot, n)]
        if still:
            print(f"laya-models: download finished but {still} is incomplete in {snapshot}", file=sys.stderr)
            return 4

    # laya patches tokenizer_config.json on first load when the installed transformers needs it.
    # Do it now, while the volume is writable, so the server can mount it read-only. (Imports
    # torch: skipped in check-only mode, which must stay fast — it runs before every start.)
    fix = None
    if not check_only:
        try:
            from laya.agent import _fix_tokenizer_config as fix  # private helper of laya 0.3.9
        except Exception:  # noqa: BLE001
            fix = None
    for n in names:
        d = model_dir(snapshot, n)
        if fix is not None:
            fix(str(d))
        print(f"laya-models: {n}: {d} ({size_mb(d)} MiB) commit={snapshot.name}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
