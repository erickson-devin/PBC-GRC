"""Pushes Wazuh vulnerability state to PBC-GRC (POST /api/v1/vm/ingest)."""

# Both values must match the server's patterns (server/vm/ingest.schema.json: exporter.name / exporter.version).
__version__ = "0.1.0"
EXPORTER_NAME = "pbc-vm-exporter"
