"""Exporter errors. Each carries the process exit code the CLI returns for it."""


class ExporterError(Exception):
    exit_code = 1


class ConfigError(ExporterError):
    exit_code = 2


class WazuhReadError(ExporterError):
    exit_code = 3


class PayloadValidationError(ExporterError):
    exit_code = 4


class RejectedError(ExporterError):
    """PBC-GRC answered with a status that retrying cannot fix."""

    exit_code = 5


class TransportError(ExporterError):
    """Network failure, retries exhausted, or the server's sha256 does not match the bytes sent."""

    exit_code = 6
