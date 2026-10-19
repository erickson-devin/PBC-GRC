import json
from pathlib import Path

import pytest
from requests.structures import CaseInsensitiveDict

FIXTURES = Path(__file__).resolve().parent / "fixtures"
EXPORTER_DIR = Path(__file__).resolve().parents[1]
SERVER_SCHEMA = Path(__file__).resolve().parents[3] / "server" / "vm" / "ingest.schema.json"
TOKEN = "pbcvm_" + "A1_-" * 10 + "abc"  # 6 + 43 characters
assert len(TOKEN) == 49


def load_fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeResponse:
    def __init__(self, status: int = 200, data=None, headers=None):
        self.status_code = status
        self._data = data
        self.headers = CaseInsensitiveDict(headers or {})
        self.text = json.dumps(data) if data is not None else ""

    def json(self):
        if self._data is None:
            raise ValueError("no body")
        return self._data


class FakeSession:
    """Replays a scripted list, or asks `handler(method, url, kwargs)`. Entries are (status, json[, headers]) or exceptions."""

    def __init__(self, script=None, handler=None):
        self.script = list(script or [])
        self.handler = handler
        self.calls: list[dict] = []
        self.trust_env = False

    def _do(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        item = self.handler(method, url, kwargs) if self.handler else self.script.pop(0)
        if isinstance(item, BaseException) or (isinstance(item, type) and issubclass(item, BaseException)):
            raise item
        if isinstance(item, FakeResponse):
            return item
        status, data, *rest = item
        return FakeResponse(status, data, rest[0] if rest else None)

    def post(self, url, **kwargs):
        return self._do("POST", url, **kwargs)

    def get(self, url, **kwargs):
        return self._do("GET", url, **kwargs)

    def delete(self, url, **kwargs):
        return self._do("DELETE", url, **kwargs)

    def request(self, method, url, **kwargs):
        return self._do(method.upper(), url, **kwargs)


class Sleeps:
    def __init__(self):
        self.calls: list[float] = []

    def __call__(self, seconds):
        self.calls.append(seconds)


@pytest.fixture
def sleeps():
    return Sleeps()


def valid_payload() -> dict:
    """Copied from tests/vmIngestSchema.test.ts (the VALID fixture)."""
    return {
        "source": {"kind": "WAZUH", "label": "wazuh-prod"},
        "exporter": {"name": "pbc-wazuh-exporter", "version": "1.0.0"},
        "collected_at": "2026-10-18T12:00:00Z",
        "hosts": [
            {
                "agent_id": "001",
                "hostname": "web-01",
                "ip": "10.0.0.5",
                "mac": "aa:bb:cc:dd:ee:ff",
                "os": {"name": "Ubuntu", "version": "22.04"},
                "findings": [
                    {
                        "vuln_id": "CVE-2024-12345",
                        "title": "Example",
                        "severity": "HIGH",
                        "cvss_v3": 7.5,
                        "package": {"name": "openssl", "version": "3.0.1", "fixed_version": "3.0.2"},
                        "detected_at": "2026-10-17T00:00:00.123Z",
                        "published_at": None,
                        "refs": ["https://example.com/a", "http://example.com/b"],
                    }
                ],
            }
        ],
    }
