# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Laya — local structured-decision engine (laya-serve, HTTP /v1/systemone).
# Internal image: the orchestrator calls it over the cluster network only.
#
# Build context = this directory:
#   docker build -t oao/laya:0.3.9-oao.1 infra/docker/laya
#
# Pins:
#   - base image by digest (python:3.11.16-slim-bookworm);
#   - laya[serve]==0.3.9 — 0.3.8 is not published on PyPI; upstream describes
#     0.3.9 as a packaging release with no code or checkpoint change from 0.3.8
#     (see docs/LAYA.md §version). Override LAYA_VERSION for an internal mirror;
#   - every Python dependency through constraints.txt;
#   - PyTorch CPU by default. CUDA: --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu126
#     (cu130 / cu132 also exist for torch 2.14.0) — untested here, see docs/LAYA.md.
#
# Runtime guarantees (relied on by docker-compose.yml and infra/helm):
#   - non-root, uid/gid 10001;
#   - read-only root filesystem compatible: writes only /tmp (and /models when
#     the download helper fills it);
#   - offline by default (HF_HUB_OFFLINE=1): the server never downloads. The
#     weights come from /models (volume / PVC) filled explicitly by
#     /opt/laya-tools/download-models.py, or are baked with BAKE_MODELS;
#   - no API key in the image: LAYA_API_KEY is injected at run time.
# ---------------------------------------------------------------------------
ARG PYTHON_IMAGE=python:3.11.16-slim-bookworm@sha256:a36c24f9cbdf4fd0f52d67f0823eeac19c2028c637cecc392d97f980d4fec56b

# ---- build: a self-contained virtualenv --------------------------------------
FROM ${PYTHON_IMAGE} AS build
ARG LAYA_VERSION=0.3.9
ARG TORCH_VERSION=2.14.0
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN python -m venv /opt/laya
COPY constraints.txt /tmp/constraints.txt
# 1) torch alone, from the selected PyTorch index (CPU by default). --no-deps:
#    its dependencies are resolved in step 2 against the constraints.
RUN --mount=type=cache,id=laya-pip,target=/root/.cache/pip \
    /opt/laya/bin/pip install --no-deps --index-url "${TORCH_INDEX_URL}" "torch==${TORCH_VERSION}"
# 2) laya[serve] and everything else from PyPI (or PIP_INDEX_URL), pinned by
#    constraints.txt; torch is already satisfied and is not replaced.
RUN --mount=type=cache,id=laya-pip,target=/root/.cache/pip \
    /opt/laya/bin/pip install --index-url "${PIP_INDEX_URL}" --constraint /tmp/constraints.txt "laya[serve]==${LAYA_VERSION}" \
 && /opt/laya/bin/pip check \
 && /opt/laya/bin/python -c "import laya.serve, fastapi, uvicorn; print('laya', laya.__version__)"

# ---- runtime -----------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
ARG PYTHON_IMAGE
ARG LAYA_VERSION=0.3.9
ARG VERSION=0.3.9-oao.1
ARG REVISION=unknown
ARG CREATED=unknown
# Comma list of checkpoints to bake into the image (hermetic environments only;
# needs network access to HF_ENDPOINT at build time). Empty = no weights.
ARG BAKE_MODELS=
ARG HF_ENDPOINT=
LABEL org.opencontainers.image.title="oao-laya" \
      org.opencontainers.image.description="Laya structured-decision engine (laya-serve) for the Outlook AI Orchestrator — internal use" \
      org.opencontainers.image.vendor="Northbridge Capital" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.name="${PYTHON_IMAGE}" \
      io.oao.laya.version="${LAYA_VERSION}"

ENV PATH=/opt/laya/bin:${PATH} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    HF_HOME=/models/huggingface \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_PRELOAD=1 \
    LAYA_MODELS=english,multilingual \
    LAYA_LOG_LEVEL=info

RUN groupadd --system --gid 10001 laya \
 && useradd --system --uid 10001 --gid 10001 --home-dir /tmp --shell /usr/sbin/nologin laya \
 && mkdir -p /models/huggingface \
 && chown -R 10001:10001 /models

COPY --from=build --chown=root:root /opt/laya /opt/laya
COPY --chown=root:root --chmod=0755 download-models.py /opt/laya-tools/download-models.py

USER 10001:10001
RUN if [ -n "${BAKE_MODELS}" ]; then \
      HF_ENDPOINT="${HF_ENDPOINT:-https://huggingface.co}" LAYA_MODELS="${BAKE_MODELS}" python /opt/laya-tools/download-models.py; \
    fi

WORKDIR /tmp
EXPOSE 8000

# No curl in the image: the standard library is enough. Long start period: the
# checkpoints are loaded (not downloaded) before the server listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=5 \
  CMD ["python", "-c", "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('LAYA_PORT','8000'), timeout=4).status == 200 else 1)"]

CMD ["laya-serve"]
