#!/usr/bin/env bash
# offline-load.sh: run on the target host, from inside an offline bundle made by scripts/build-offline-bundle.sh.
#
# Checks every file against SHA256SUMS, loads the images, proves each loaded image has the ID recorded when the bundle
# was built (so it is the pinned release content), and adds the bundle's image settings to .env. It never reaches the
# network and never prints a secret. INSTALL.md is the full procedure.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "offline-load: $*" >&2; exit 1; }
command -v docker >/dev/null || die "docker is required"
command -v sha256sum >/dev/null || die "sha256sum is required"

echo "1/4 checking files against SHA256SUMS"
sha256sum --check --quiet SHA256SUMS || die "a file does not match SHA256SUMS: the bundle is damaged or was changed"

echo "2/4 loading images"
gunzip -c images.tar.gz | docker load

echo "3/4 checking image IDs"
while read -r plain id _ref; do
  [ -n "$plain" ] || continue
  got="$(docker image inspect --format '{{.Id}}' "$plain" 2>/dev/null)" || die "image $plain is not present after loading"
  [ "$got" = "$id" ] || die "image $plain has ID $got, expected $id"
  echo "  ok  $plain"
done < IMAGES.txt

echo "4/4 image settings for docker compose"
# A first install starts .env from the example; an upgrade keeps the existing .env and only replaces the image settings.
[ -f .env ] || cp .env.example .env
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

echo
echo "Loaded. Next: fill in the secrets in .env (INSTALL.md, section 3), then start with"
echo "  docker compose up -d --pull never"
