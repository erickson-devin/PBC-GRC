# Offline install (flash drive, no internet on the host)

For a host that cannot reach the internet or the image registry: an air-gapped enclave, or a customer site that does not
get registry access. A release is turned into a **bundle** on a connected machine, carried over on approved media, and
loaded on the target. Nothing on the target reaches the network. A host with internet access can instead pull the image
as in `docs/GO_LIVE_CHECKLIST.md`; both end in the same installation.

The bundle holds release artefacts only: container images, the compose files, checksums and this guide. It never holds a
filled-in `.env`, passwords, service tokens or customer data, so it is not CUI. The drive that carries it is still
removable media under the site's media protection rules (CMMC MP.L2-3.8.7 / 3.8.8): use a drive the site has approved
and scanned.

## 1. Build the bundle (connected Linux machine with Docker)

Any Linux host with Docker Engine, the compose plugin, `gzip` and `sha256sum` (an Unraid server works). If the image is
private, log in to the registry first with a read-only token: `docker login ghcr.io`.

```bash
git clone https://github.com/erickson-devin/PBC-GRC.git && cd PBC-GRC
git checkout v0.4.0
scripts/build-offline-bundle.sh --tag v0.4.0
```

Options: `--with-ai` adds the pinned Ollama image; `--ollama-models /path/to/models` also adds a model store (the folder
mounted at `/root/.ollama` on a machine where `ollama pull llama3.2:3b` has run); `--no-exporter` leaves out the scanner
exporter; `--out DIR` chooses the output folder (default `./offline-bundle-v0.4.0`).

The script refuses to run when the checkout's `package.json` version differs from `--tag` or the release files have local
changes, so the compose files always match the images. It writes:

| File | What it is |
| --- | --- |
| `images.tar.gz` | the app, PostgreSQL and (with `--with-ai`) Ollama images |
| `IMAGES.txt` | each image's tag in the bundle, its image ID and the pinned reference it came from |
| `offline.env` | the image settings compose needs on the target (`IMAGE_TAG`, `POSTGRES_IMAGE`, `OLLAMA_IMAGE_TAG`) |
| `docker-compose.yml`, `.env.example`, `nginx.conf`, `LICENSE`, `docker/postgres/` | the release's compose files |
| `offline-load.sh` | the loader for the target |
| `INSTALL.md` | this guide |
| `exporter/` | the scanner exporter (source, README) and `wheelhouse/` with its wheel and pure-Python dependencies |
| `ollama-models.tar.gz` | the model store, only with `--ollama-models` |
| `SHA256SUMS` | checksums of every file above |

Copy the whole folder to the drive. Record the SHA-256 of `SHA256SUMS` itself
(`sha256sum SHA256SUMS`) somewhere other than the drive, for example in the delivery note, so the receiver can check the
checksums file was not swapped too.

Why the images are retagged: a compose file that pins an image by digest may not recognise that image after `docker save`
and `docker load`, depending on the engine's image store. The script saves each pinned image under a plain tag pointing
at the same content (`postgres:16-alpine-pbc-<digest prefix>`), `offline.env` tells compose to use it, and the loader
checks each loaded image's ID against `IMAGES.txt`.

## 2. Load it on the target

Needs Docker Engine with the compose plugin, `gzip` and `sha256sum`. Copy the bundle folder to where the installation will
live (for example `/opt/pbc-grc`), then:

```bash
cd /opt/pbc-grc
./offline-load.sh
```

It checks every file against `SHA256SUMS`, loads the images, verifies each image, creates `.env` from `.env.example`
on a first install (mode 0600), writes the three image settings into it, creates the evidence folder (`EVIDENCE_DIR`,
default `./data/evidence`) owned by uid 1000, the app's user, and, on a first install, generates the secrets (see
section 3). It checks each image by its ID, or by its layer fingerprint where the engine numbers images differently
(Docker's containerd image store gives the same image another ID than the classic store). A mismatch stops it before
anything runs.

With the AI profile and a model store in the bundle, unpack the models where `OLLAMA_MODELS_DIR` points (default: the
named volume; on Unraid the host folder you set):

```bash
mkdir -p /mnt/user/appdata/singularity/ollama-models
tar -C /mnt/user/appdata/singularity/ollama-models -xzf ollama-models.tar.gz
```

## 3. Configure

On a first install `offline-load.sh` has already generated `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `LOCAL_AUTH_SECRET`
and `MFA_ENCRYPTION_KEY` (64 random hex characters each, written only to `.env` and never printed). On an upgrade it keeps
the existing `.env` and never replaces a secret. Review `.env` (it stays on the host; never copy it back to the drive):
the host paths if the defaults do not suit, and the proxy settings. `docs/GO_LIVE_CHECKLIST.md` section 2 lists every
setting; leave the three image lines `offline-load.sh` wrote as they are. If you change `EVIDENCE_DIR`, run `./offline-load.sh` again
(it keeps `.env` and its secrets) so the new folder is created for uid 1000.

## 4. Start

```bash
docker compose up -d --pull never
```

`--pull never` makes Docker stop with an error if an image is missing instead of trying the internet. Add `--profile ai`
for Ollama. Then continue with `docs/GO_LIVE_CHECKLIST.md` section 4 (first start) and section 5 (verify from outside).

## 5. Exporter on a scanner host (optional)

On the host that runs the exporter (Python 3.11 or later, Linux or Windows), from the bundle's `exporter/` folder:

```bash
python3 -m venv .venv
.venv/bin/pip install --no-index --find-links wheelhouse pbc-vm-exporter
```

(On Windows: `.venv\Scripts\pip`.) Configuration and scheduling are in `exporter/README.md` and
`docs/SCANNER_INTEGRATIONS.md`. The exporter talks only to the PBC-GRC HTTPS address and the scanner on the local network.

## 6. Upgrades

Build a bundle for the new release, carry it over, copy it **over** the existing installation folder (the `.env` and the
data folders are not in the bundle and are kept), and run:

```bash
./offline-load.sh
docker compose up -d --pull never
```

The loader keeps the existing `.env` and replaces only the three image lines. Take the backup in
`docs/GO_LIVE_CHECKLIST.md` section 7 first; rolling back is the previous bundle plus that backup.

## 7. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `offline-load: a file does not match SHA256SUMS` | the copy is damaged or changed: copy the bundle again and compare `sha256sum SHA256SUMS` with the delivery note |
| `image ... does not match the release` | the loaded image is not the bundled one: do not start; rebuild the bundle |
| `image ... has ID ..., expected ...; this bundle predates layer fingerprints` | the bundle was built by an older `build-offline-bundle.sh` and this engine numbers images differently (containerd image store): rebuild the bundle with the current script |
| `docker compose up` says an image was not found / tries to pull | the image lines in `.env` are missing or edited: run `./offline-load.sh` again, then compare `docker compose config --images` with the first column of `IMAGES.txt` |
| the app keeps restarting; its log says `The evidence directory ... is not readable and writable ... (uid 1000, EACCES)` | the evidence folder belongs to another user (Docker creates a missing one as root): `sudo chown -R 1000:1000` on it (`EVIDENCE_DIR`, default `./data/evidence`), or run `./offline-load.sh` again as root, then `docker compose up -d --pull never` |
| PostgreSQL starts but the app cannot log in on a first install | `docker/postgres/` was not next to `docker-compose.yml` when the database volume was created: see `docs/ON_PREM_DATABASE.md` "Existing data volume" |
