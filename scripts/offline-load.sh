#!/usr/bin/env bash
# offline-load.sh: run on the target host, from inside an offline bundle made by scripts/build-offline-bundle.sh.
#
# Checks every file against SHA256SUMS, loads the images, proves each loaded image is the pinned release content (by the
# image ID recorded when the bundle was built, or by the layer fingerprint where this engine numbers images differently),
# adds the bundle's image settings to .env and, on a first install, generates its secrets. It never reaches the network
# and never prints a secret. INSTALL.md is the full procedure.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "offline-load: $*" >&2; exit 1; }
command -v docker >/dev/null || die "docker is required"
command -v sha256sum >/dev/null || die "sha256sum is required"

echo "1/5 checking files against SHA256SUMS"
sha256sum --check --quiet SHA256SUMS || die "a file does not match SHA256SUMS: the bundle is damaged or was changed"

echo "2/5 loading images"
gunzip -c images.tar.gz | docker load

# The engine's image ID depends on its image store (classic: config digest; containerd: manifest digest), the layer diff
# IDs do not: the fingerprint is the hash of those IDs, one per line, as computed by build-offline-bundle.sh.
echo "3/5 checking images"
while read -r plain id layers _ref; do
  [ -n "$plain" ] || continue
  got="$(docker image inspect --format '{{.Id}}' "$plain" 2>/dev/null)" || die "image $plain is not present after loading"
  if [ "$got" = "$id" ]; then
    echo "  ok  $plain"
    continue
  fi
  if [[ "$layers" =~ ^[0-9a-f]{64}$ ]]; then
    have="$(docker image inspect --format '{{range .RootFS.Layers}}{{println .}}{{end}}' "$plain" | sha256sum | cut -d' ' -f1)"
    [ "$have" = "$layers" ] || die "image $plain does not match the release (layers $have, expected $layers)"
    echo "  ok  $plain (layers match; this engine numbers images differently)"
  else
    die "image $plain has ID $got, expected $id; this bundle predates layer fingerprints, so the difference is likely this engine's containerd image store: rebuild the bundle with a newer build-offline-bundle.sh"
  fi
done < IMAGES.txt

echo "4/5 image settings for docker compose"
# A first install starts .env from the example; an upgrade keeps the existing .env and only replaces the image settings.
fresh=0
if [ ! -f .env ]; then
  cp .env.example .env
  fresh=1
fi
chmod 0600 .env
while IFS='=' read -r key value; do
  [ -n "$key" ] || continue
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
  echo "  $key=$value"
done < offline.env

echo "5/5 secrets"
# Only a first install gets new secrets: on an upgrade a new database password would not match the existing volume and a
# new MFA_ENCRYPTION_KEY would break the existing MFA enrolments. Values go to .env only and are never printed.
for key in POSTGRES_PASSWORD APP_DB_PASSWORD LOCAL_AUTH_SECRET MFA_ENCRYPTION_KEY; do
  current="$(grep -m1 "^${key}=" .env | cut -d= -f2- | sed 's/[[:space:]]\{1,\}#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//' || true)"
  if [ -n "$current" ]; then
    echo "  $key already set"
  elif [ "$fresh" = 1 ]; then
    if command -v openssl >/dev/null; then
      secret="$(openssl rand -hex 32)"
    else
      secret="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    fi
    sed -i "/^#\? *${key}=/d" .env
    echo "${key}=${secret}" >> .env
    echo "  $key generated"
  elif [ "$key" != MFA_ENCRYPTION_KEY ]; then
    echo "  warning: $key is blank in the existing .env and must be set by hand" >&2
  fi
done

echo
echo "Loaded. Review .env (INSTALL.md, section 3: host paths, proxy settings), then start with"
echo "  docker compose up -d --pull never"
