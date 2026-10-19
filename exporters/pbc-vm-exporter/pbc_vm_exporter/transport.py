"""HTTP session factory shared by the Wazuh readers and the PBC-GRC client."""

import requests

from . import __version__


def make_session() -> requests.Session:
    """A session that ignores the environment.

    trust_env=False means no proxies from HTTP(S)_PROXY, no .netrc credentials and no REQUESTS_CA_BUNDLE /
    CURL_CA_BUNDLE, so the environment cannot route payloads off the box or change certificate checks.
    """
    session = requests.Session()
    session.trust_env = False
    session.headers["User-Agent"] = f"pbc-vm-exporter/{__version__}"
    return session
