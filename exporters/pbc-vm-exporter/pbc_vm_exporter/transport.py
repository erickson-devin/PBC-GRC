"""HTTP session factory shared by the Wazuh readers and the PBC-GRC client."""

import requests

from . import __version__


def make_session(proxy_url: str | None = None) -> requests.Session:
    """A session that ignores the environment.

    trust_env=False means no proxies from HTTP(S)_PROXY, no .netrc credentials and no REQUESTS_CA_BUNDLE /
    CURL_CA_BUNDLE, so the environment cannot route payloads off the box or change certificate checks.

    `proxy_url` is the one explicit exception: an enclave egress proxy for a vendor cloud session (ACTION1_PROXY_URL,
    S1_PROXY_URL). It is never given to the PBC-GRC session.
    """
    session = requests.Session()
    session.trust_env = False
    if proxy_url:
        session.proxies = {"http": proxy_url, "https": proxy_url}
    session.headers["User-Agent"] = f"pbc-vm-exporter/{__version__}"
    return session
