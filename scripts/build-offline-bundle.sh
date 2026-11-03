#!/usr/bin/env bash
# scripts/build-offline-bundle.sh
#
# Builds an offline install bundle of a PBC-GRC release, for a host with no internet access (an air-gapped enclave, or a
# customer site that does not get registry access): the container images saved to one file, the files Docker Compose
# needs, checksums, and a loader that verifies everything on the target. docs/OFFLINE_INSTALL.md is the guide.
#
# Run it on a Linux machine with Docker and internet access, from a checkout of the release tag:
#
#     git checkout v0.3.0
#     scripts/build-offline-bundle.sh --tag v0.3.0 [--with-ai] [--ollama-models DIR] [--no-exporter] [--out DIR]
#
#   --tag v0.3.0          the release to bundle (the image tag ghcr.io/erickson-devin/pbc-grc:v0.3.0). Required.
#   --with-ai             also bundle the pinned Ollama image (the "ai" profile).
#   --ollama-models DIR   also bundle an Ollama model store (the folder mounted at /root/.ollama, after `ollama pull`).
#   --no-exporter         leave out the scanner exporter and its Python wheels.
#   --out DIR             where to write the bundle (default ./offline-bundle-<tag>).
#
# What it never puts in the bundle: a filled-in .env, passwords, service tokens or any customer data. The bundle holds
# only release artefacts, so it is not CUI; the drive that carries it is still removable media under the site's rules.
#
# Why images are retagged: a compose file that pins an image by digest (postgres:16-alpine@sha256:...) may not recognise
# that image after `docker save` / `docker load`, depending on the engine's image store. Each pinned image is therefore
# saved under a plain tag that points at the same content, offline.env tells compose to use those tags, and IMAGES.txt
# records each image's ID and its layer fingerprint so the loader can prove the loaded content is the pinned content.
# Both are needed because the engine's image ID depends on its image store (classic: the config digest; containerd:
# the manifest digest), so the same image has a different ID on a host with the other store. The layer diff IDs do not
# depend on the store, and the fingerprint is their hash.
set -euo pipefail

TAG=""
OUT=""
WITH_AI=0
MODELS_DIR=""
WITH_EXPORTER=1
APP_REPO="ghcr.io/erickson-devin/pbc-grc"
# Build-time helper for the exporter wheels; it is not shipped in the bundle.
PY_IMAGE="python:3.11-slim"

die() { echo "build-offline-bundle: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --with-ai) WITH_AI=1; shift ;;
    --ollama-models) MODELS_DIR="${2:-}"; shift 2 ;;
    --no-exporter) WITH_EXPORTER=0; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--tag must be a release tag like v0.3.0"
command -v docker >/dev/null || die "docker is required"
command -v sha256sum >/dev/null || die "sha256sum is required"
[ -n "$MODELS_DIR" ] && { [ -d "$MODELS_DIR" ] || die "--ollama-models: $MODELS_DIR is not a directory"; WITH_AI=1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f docker-compose.yml ] || die "run this from a PBC-GRC checkout (docker-compose.yml not found)"

# The checkout should be the release: compose, the init script and nginx.conf come from it.
PKG_VERSION="$(tr -d '\r' < package.json | sed -n 's/^  "version": "\([^"]*\)".*/\1/p' | head -n 1)"
if [ "v$PKG_VERSION" != "$TAG" ]; then
  die "package.json says version $PKG_VERSION but --tag is $TAG: check out the release tag first (git checkout $TAG)"
fi
if command -v git >/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain --untracked-files=no -- docker-compose.yml docker nginx.conf .env.example LICENSE exporters 2>/dev/null)" ]; then
    die "the release files have local changes; bundle from a clean checkout of $TAG"
  fi
fi

OUT="${OUT:-$ROOT/offline-bundle-$TAG}"
[ -e "$OUT" ] && die "$OUT already exists; remove it or pass --out"
mkdir -p "$OUT"

# ---------------------------------------------------------------- images
# The exact references compose would use for this release (the required secrets get placeholders: they are only read
# for interpolation here and never written anywhere).
PROFILE_ARGS=()
[ "$WITH_AI" = 1 ] && PROFILE_ARGS=(--profile ai)
mapfile -t REFS < <(
  env -u POSTGRES_IMAGE -u OLLAMA_IMAGE_TAG \
    IMAGE_TAG="$TAG" POSTGRES_PASSWORD=placeholder APP_DB_PASSWORD=placeholder LOCAL_AUTH_SECRET=placeholder \
    docker compose --env-file /dev/null "${PROFILE_ARGS[@]}" config --images | sort -u
)
[ "${#REFS[@]}" -ge 2 ] || die "docker compose listed fewer images than expected: ${REFS[*]:-none}"

: > "$OUT/IMAGES.txt"
: > "$OUT/offline.env"
SAVE=()
for ref in "${REFS[@]}"; do
  echo "pulling $ref"
  docker pull --quiet "$ref" >/dev/null
  id="$(docker image inspect --format '{{.Id}}' "$ref")"
  layers="$(docker image inspect --format '{{range .RootFS.Layers}}{{println .}}{{end}}' "$ref" | sha256sum | cut -d' ' -f1)"
  if [[ "$ref" == *@sha256:* ]]; then
    # name:tag@sha256:digest -> name:tag-pbc-<first 12 hex of the digest>, a plain tag that survives save / load
    name_tag="${ref%@*}"
    digest="${ref#*@sha256:}"
    plain="${name_tag}-pbc-${digest:0:12}"
    docker tag "$ref" "$plain"
    case "$name_tag" in
      postgres:*) echo "POSTGRES_IMAGE=$plain" >> "$OUT/offline.env" ;;
      ollama/ollama:*) echo "OLLAMA_IMAGE_TAG=${plain#ollama/ollama:}" >> "$OUT/offline.env" ;;
      *) die "no compose override is known for the pinned image $ref" ;;
    esac
  else
    plain="$ref"
  fi
  printf '%s  %s  %s  %s\n' "$plain" "$id" "$layers" "$ref" >> "$OUT/IMAGES.txt"
  SAVE+=("$plain")
done
echo "IMAGE_TAG=$TAG" >> "$OUT/offline.env"

echo "saving ${#SAVE[@]} image(s)"
docker save "${SAVE[@]}" | gzip -1 > "$OUT/images.tar.gz"

# ---------------------------------------------------------------- compose files
cp docker-compose.yml .env.example nginx.conf LICENSE "$OUT/"
mkdir -p "$OUT/docker/postgres"
cp docker/postgres/*.sh "$OUT/docker/postgres/"
chmod 0755 "$OUT/docker/postgres/"*.sh
cp docs/OFFLINE_INSTALL.md "$OUT/INSTALL.md"
cp scripts/offline-load.sh "$OUT/offline-load.sh"
chmod 0755 "$OUT/offline-load.sh"

# ---------------------------------------------------------------- Ollama model store (optional)
if [ -n "$MODELS_DIR" ]; then
  echo "archiving the Ollama model store"
  tar -C "$MODELS_DIR" -czf "$OUT/ollama-models.tar.gz" .
fi

# ---------------------------------------------------------------- exporter (optional)
if [ "$WITH_EXPORTER" = 1 ]; then
  echo "building the exporter wheel and its dependencies"
  mkdir -p "$OUT/exporter/wheelhouse"
  # The exporter as source (README, LICENSE, samples) for reference, without a local venv or caches
  tar -C exporters/pbc-vm-exporter --exclude=.venv --exclude=__pycache__ --exclude=.pytest_cache --exclude='*.egg-info' \
    --exclude=build -cf - . | tar -C "$OUT/exporter" -xf -
  # One wheel for the exporter (pure Python) and pure-Python wheels of its dependencies, so the target installs with
  # pip --no-index on Linux or Windows. Built in a throwaway container; nothing is installed on this machine.
  docker run --rm -v "$ROOT/exporters/pbc-vm-exporter:/src:ro" -v "$OUT/exporter/wheelhouse:/w" "$PY_IMAGE" sh -ec '
    cp -r /src /tmp/src && rm -rf /tmp/src/.venv /tmp/src/build /tmp/src/*.egg-info
    pip wheel --quiet --no-deps --wheel-dir /w /tmp/src
    pip download --quiet --dest /w --only-binary=:all: --platform any --python-version 3.11 --implementation py requests
  '
fi

# ---------------------------------------------------------------- checksums
( cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )

echo
echo "Bundle written to $OUT"
du -sh "$OUT" | sed 's/^/  size: /'
echo "  images:"
sed 's/^/    /' "$OUT/IMAGES.txt"
echo "Copy the whole folder to the target and follow INSTALL.md (start with ./offline-load.sh)."
