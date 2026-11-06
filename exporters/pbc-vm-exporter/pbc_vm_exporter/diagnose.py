"""Turns a connection error or an HTTP status into a short code and a plain-English hint.

Pure: no network, no configuration and no secrets. The hint is fixed text; it never echoes the exception text or the URL.
The same table is in the README and docs/SCANNER_INTEGRATIONS.md (Troubleshooting) and in src/data/telemetry/exporterSetup.ts.
"""

import re
from typing import Iterable

TARGETS = ("indexer", "manager", "pbc")

_CA_VARIABLE = {"indexer": "WAZUH_CA_BUNDLE", "manager": "WAZUH_CA_BUNDLE", "pbc": "PBC_CA_BUNDLE"}
_STATUS_RE = re.compile(r"HTTP (\d{3})")

HINT_REFUSED_INDEXER = (
    "nothing is listening at that address: on the Wazuh host the indexer may be bound to 127.0.0.1 only; set "
    "network.host in /etc/wazuh-indexer/opensearch.yml (a list such as [127.0.0.1, <LAN IP>]) and restart "
    "wazuh-indexer, or check the firewall for port 9200"
)
HINT_REFUSED_MANAGER = (
    "nothing is listening at that address: check WAZUH_API_URL (the manager API listens on port 55000) and the firewall"
)
HINT_REFUSED_PBC = "nothing is listening at that address: check PBC_URL, that PBC-GRC is running, and the firewall"
HINT_TIMEOUT = (
    "the connection timed out: a firewall is probably dropping traffic from this host to that address and port "
    "(indexer 9200, manager API 55000, PBC-GRC 443); open the port from this host"
)
HINT_READ_TIMEOUT = "the server accepted the connection but did not answer in time: raise EXPORT_TIMEOUT_SECONDS"
HINT_DNS = "the host name does not resolve from this machine: check the spelling, DNS, or use the IP address"
HINT_SAN_MISMATCH = (
    "the certificate does not cover the host name or IP in the URL: use a name the certificate lists (check with "
    "openssl s_client ... | openssl x509 -noout -text, Subject Alternative Name), or reissue it with that IP"
)
HINT_CA_INDEXER = "set WAZUH_CA_BUNDLE to the indexer root CA (/etc/wazuh-indexer/certs/root-ca.pem on the Wazuh host)"
HINT_CA_MANAGER = "set WAZUH_CA_BUNDLE to the CA that signed the Wazuh manager API certificate"
HINT_CA_PBC = "set PBC_CA_BUNDLE to the CA that signed the PBC-GRC certificate"
HINT_INDEXER_401 = (
    "the indexer (port 9200) uses its own internal users from the OpenSearch security plugin, not Wazuh manager API "
    "users; create the user with the security plugin (see docs/SCANNER_INTEGRATIONS.md)"
)
HINT_INDEXER_403 = (
    "the user is known but its role lacks read access on the vulnerability index: map a role with read on "
    "wazuh-states-vulnerabilities-* to this user in the indexer security plugin"
)
HINT_INDEXER_404 = (
    "index_not_found: vulnerability detection is probably off in Wazuh, or WAZUH_INDEXER_INDEX is the wrong index name"
)
HINT_MANAGER_401 = (
    "the manager API rejected WAZUH_API_USER / WAZUH_API_PASSWORD: these are Wazuh manager API (RBAC) users, not indexer users"
)
HINT_PORT_INDEXER = (
    "WAZUH_INDEXER_URL points at port 55000, which is the Wazuh manager API; the exporter reads the indexer on port 9200"
)
HINT_PORT_MANAGER = (
    "WAZUH_API_URL points at port 9200, which is the Wazuh indexer; the manager API listens on port 55000"
)
HINT_PBC_INSECURE = (
    "PBC-GRC saw plain http: serve the app over HTTPS, and set TRUST_PROXY on the server when a reverse proxy "
    "terminates TLS (vm_insecure_transport)"
)
HINT_PBC_401 = "the service token is wrong, expired or revoked: create a new one in PBC-GRC (API tokens) and paste it"
HINT_PBC_403 = "the token lacks the vm:ingest scope (insufficient_scope)"
HINT_INSECURE_FLAG = (
    "PBC_ALLOW_INSECURE_TRANSPORT is set but every URL is https: remove it, it only silences a safety check"
)


def _text(value: object) -> str:
    if isinstance(value, BaseException):
        return f"{type(value).__name__}: {value}"
    return str(value)


def _port_swapped(target: str, url: str | None) -> bool:
    if not url:
        return False
    if target == "indexer":
        return re.search(r":55000(?:/|$)", url) is not None
    if target == "manager":
        return re.search(r":9200(?:/|$)", url) is not None
    return False


def _status_of(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    match = _STATUS_RE.search(_text(value))
    return int(match.group(1)) if match else None


def classify(exc_or_status: object, target: str, url: str | None = None) -> tuple[str, str]:
    """(code, hint) for one failure; ("unknown", "") when nothing matches.

    `exc_or_status` is an exception, an HTTP status (int) or a message text such as "HTTP 403 vm_insecure_transport".
    `target` is "indexer", "manager" or "pbc". `url` is only used to spot a swapped port.
    """
    text = _text(exc_or_status)
    low = text.lower()
    if target == "indexer" and _port_swapped(target, url):
        return "port_swapped", HINT_PORT_INDEXER
    if target == "manager" and _port_swapped(target, url):
        return "port_swapped", HINT_PORT_MANAGER

    if "vm_insecure_transport" in low:
        return "insecure_transport", HINT_PBC_INSECURE
    status = _status_of(exc_or_status)
    if status is not None:
        if status == 401:
            if target == "indexer":
                return "indexer_internal_user", HINT_INDEXER_401
            if target == "manager":
                return "manager_auth", HINT_MANAGER_401
            return "token_invalid", HINT_PBC_401
        if status == 403:
            if target == "indexer":
                return "indexer_role", HINT_INDEXER_403
            if target == "pbc":
                return "insufficient_scope", HINT_PBC_403
            return "forbidden", "the manager API user is known but not allowed: check its Wazuh RBAC role"
        if status == 404:
            if target == "indexer":
                return "index_not_found", HINT_INDEXER_404
            return "not_found", ""
        return "http_" + str(status), ""

    if "ReadTimeout" in text or "read timed out" in low:
        return "read_timeout", HINT_READ_TIMEOUT
    if "IP address mismatch" in text or "Hostname mismatch" in text or "doesn't match" in text:
        return "san_mismatch", HINT_SAN_MISMATCH
    if "unable to get local issuer" in low or "self-signed certificate" in low or "self signed certificate" in low:
        hint = {"indexer": HINT_CA_INDEXER, "manager": HINT_CA_MANAGER}.get(target, HINT_CA_PBC)
        return "ca_missing", hint
    if "getaddrinfo failed" in low or "name or service not known" in low or "nodename nor servname" in low:
        return "dns", HINT_DNS
    if "connection refused" in low or "winerror 10061" in low or "errno 111" in low:
        return "refused", {"indexer": HINT_REFUSED_INDEXER, "manager": HINT_REFUSED_MANAGER}.get(target, HINT_REFUSED_PBC)
    if "ConnectTimeout" in text or "timed out" in low:
        return "timeout", HINT_TIMEOUT
    return "unknown", ""


def insecure_flag_note(allow_insecure: bool, urls: Iterable[str | None]) -> tuple[str, str] | None:
    """("insecure_flag_unneeded", hint) when PBC_ALLOW_INSECURE_TRANSPORT is set and every URL is https, else None."""
    if not allow_insecure:
        return None
    if any(u and u.lower().startswith("http://") for u in urls):
        return None
    return "insecure_flag_unneeded", HINT_INSECURE_FLAG
