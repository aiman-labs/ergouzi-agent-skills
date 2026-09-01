#!/usr/bin/env python3
"""Shared standard-library client for Ergouzi asynchronous model tasks."""

from __future__ import annotations

import errno
import http.client
import ipaddress
import json
import os
import re
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import (
    HTTPHandler,
    HTTPRedirectHandler,
    HTTPSHandler,
    ProxyHandler,
    Request,
    build_opener,
)


DEFAULT_BASE_URL = "https://ergouzi.life"
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 1800


class ClientError(RuntimeError):
    """Public client failure with secrets removed."""


class ApiError(ClientError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Credentials:
    base_url: str
    api_key: str


def config_path() -> Path:
    override = os.getenv("ERGOUZI_CONFIG_FILE", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        root = Path(os.getenv("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        root = Path(os.getenv("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "ergouzi" / "credentials.json"


def normalize_base_url(value: str) -> str:
    raw = value.strip().rstrip("/")
    if raw.endswith("/v1"):
        raw = raw[:-3]
    parsed = urlparse(raw)
    if (
        not parsed.scheme
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ClientError("Ergouzi base URL must be an absolute URL without query or fragment")
    local = parsed.hostname in {"127.0.0.1", "::1", "localhost"}
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise ClientError("Ergouzi base URL must use HTTPS (HTTP is allowed only for localhost)")
    if parsed.path not in {"", "/"}:
        raise ClientError("Ergouzi base URL must not contain a path")
    return raw


def load_credentials() -> Credentials:
    saved: dict[str, Any] = {}
    path = config_path()
    if path.exists():
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ClientError(f"Unable to read Ergouzi config: {path}") from error
    if not isinstance(saved, dict):
        raise ClientError(f"Ergouzi config must contain a JSON object: {path}")
    for field in ("base_url", "api_key"):
        if field in saved and not isinstance(saved[field], str):
            raise ClientError(f"Ergouzi config field {field} must be a string: {path}")
    saved_base_url = saved.get("base_url", "").strip()
    saved_api_key = saved.get("api_key", "").strip()
    base_url = (
        os.getenv("ERGOUZI_MEDIA_BASE_URL", "").strip()
        or saved_base_url
        or os.getenv("ERGOUZI_BASE_URL", "").strip()
        or DEFAULT_BASE_URL
    )
    api_key = (
        os.getenv("ERGOUZI_MEDIA_API_KEY", "").strip()
        or saved_api_key
        or os.getenv("ERGOUZI_API_KEY", "").strip()
    )
    if not api_key:
        raise ClientError("Ergouzi API key is not configured; run scripts/configure.py")
    return Credentials(normalize_base_url(base_url), api_key)


def save_credentials(credentials: Credentials) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(
            {"base_url": credentials.base_url, "api_key": credentials.api_key},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    if os.name != "nt":
        temporary.chmod(0o600)
    os.replace(temporary, path)
    if os.name != "nt":
        path.chmod(0o600)
    return path


def _origin(value: str) -> tuple[str, str, int | None]:
    parsed = urlparse(value)
    scheme = parsed.scheme.lower()
    port = parsed.port
    if port is None and scheme in {"http", "https"}:
        port = 443 if scheme == "https" else 80
    return scheme, (parsed.hostname or "").lower(), port


def _redact(value: str, secret: str) -> str:
    return value.replace(secret, "[redacted]") if secret else value


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _is_first_party_hostname(hostname: str) -> bool:
    normalized = hostname.rstrip(".").lower()
    return normalized == "ergouzi.life" or normalized.endswith(".ergouzi.life")


def _is_reserved_dns_mapping(address: str) -> bool:
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    return isinstance(parsed, ipaddress.IPv4Address) and parsed in ipaddress.ip_network(
        "198.18.0.0/15"
    )


def _resolve_download_addresses(
    value: str,
    allow_local_http: bool = False,
    allow_reserved_first_party: bool = False,
) -> tuple[str, ...]:
    try:
        parsed = urlparse(value)
        hostname = (parsed.hostname or "").lower()
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as error:
        raise ClientError("Output URL is malformed") from error
    if not hostname or parsed.username or parsed.password:
        raise ClientError("Output URL must be absolute and must not contain credentials")

    local = hostname in {"127.0.0.1", "::1", "localhost"}
    allowed_local_http = allow_local_http and parsed.scheme == "http" and local
    if parsed.scheme != "https" and not allowed_local_http:
        raise ClientError("Output URL must use HTTPS")
    if hostname.endswith(".local") and not allowed_local_http:
        raise ClientError("Output URL must not target a local or non-public address")

    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        try:
            infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        except OSError as error:
            raise ClientError(f"Unable to resolve output hostname: {hostname}") from error
        addresses = tuple(dict.fromkeys(info[4][0] for info in infos if info[4]))
    else:
        addresses = (str(literal),)

    if not addresses:
        raise ClientError(f"Unable to resolve output hostname: {hostname}")
    non_public = []
    for address in addresses:
        try:
            if not ipaddress.ip_address(address).is_global:
                non_public.append(address)
        except ValueError as error:
            raise ClientError("Output URL resolved to an invalid address") from error
    reserved_first_party = (
        allow_reserved_first_party
        and _is_first_party_hostname(hostname)
        and bool(non_public)
        and all(_is_reserved_dns_mapping(address) for address in addresses)
    )
    if non_public and not (allowed_local_http or reserved_first_party):
        raise ClientError("Output URL must not target a local or non-public address")
    return addresses


def _validate_download_url(
    value: str,
    allow_local_http: bool = False,
    allow_reserved_first_party: bool = False,
) -> None:
    _resolve_download_addresses(value, allow_local_http, allow_reserved_first_party)


def _connect_pinned(addresses: tuple[str, ...], port: int, timeout: float, source_address):
    last_error: OSError | None = None
    for address in addresses:
        try:
            connection = socket.create_connection((address, port), timeout, source_address)
            try:
                connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError as error:
                if error.errno != errno.ENOPROTOOPT:
                    connection.close()
                    raise
            return connection
        except OSError as error:
            last_error = error
    if last_error is not None:
        raise last_error
    raise OSError("No output addresses available")


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, *, addresses: tuple[str, ...], **kwargs):
        super().__init__(host, **kwargs)
        self._addresses = addresses

    def connect(self):
        self.sock = _connect_pinned(self._addresses, self.port, self.timeout, self.source_address)
        if self._tunnel_host:
            self._tunnel()


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, *, addresses: tuple[str, ...], **kwargs):
        super().__init__(host, **kwargs)
        self._addresses = addresses

    def connect(self):
        self.sock = _connect_pinned(self._addresses, self.port, self.timeout, self.source_address)
        if self._tunnel_host:
            self._tunnel()
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


class _PinnedHTTPHandler(HTTPHandler):
    def __init__(self, allow_local_http: bool, allow_reserved_first_party: bool):
        super().__init__()
        self.allow_local_http = allow_local_http
        self.allow_reserved_first_party = allow_reserved_first_party

    def http_open(self, request):
        addresses = _resolve_download_addresses(
            request.full_url, self.allow_local_http, self.allow_reserved_first_party
        )
        return self.do_open(
            lambda host, **kwargs: _PinnedHTTPConnection(host, addresses=addresses, **kwargs),
            request,
        )


class _PinnedHTTPSHandler(HTTPSHandler):
    def __init__(self, allow_local_http: bool, allow_reserved_first_party: bool):
        super().__init__()
        self.allow_local_http = allow_local_http
        self.allow_reserved_first_party = allow_reserved_first_party

    def https_open(self, request):
        addresses = _resolve_download_addresses(
            request.full_url, self.allow_local_http, self.allow_reserved_first_party
        )
        return self.do_open(
            lambda host, **kwargs: _PinnedHTTPSConnection(host, addresses=addresses, **kwargs),
            request,
            context=self._context,
        )


class _SafeDownloadRedirect(HTTPRedirectHandler):
    def __init__(self, allow_local_http: bool = False, allow_reserved_first_party: bool = False):
        super().__init__()
        self.allow_local_http = allow_local_http
        self.allow_reserved_first_party = allow_reserved_first_party

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            _validate_download_url(
                redirected.full_url,
                self.allow_local_http,
                self.allow_reserved_first_party,
            )
            if _origin(req.full_url) != _origin(redirected.full_url):
                redirected.remove_header("Authorization")
        return redirected


def api_json(
    credentials: Credentials,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 120,
) -> tuple[dict[str, Any], int]:
    if not path.startswith("/"):
        raise ClientError("API path must start with /")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request_headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {credentials.api_key}",
        "User-Agent": "ergouzi-media-skill/1.0",
    }
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)
    request = Request(
        credentials.base_url + path,
        data=body,
        headers=request_headers,
        method=method,
    )
    try:
        with build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
            raw = response.read(MAX_JSON_BYTES + 1)
            if len(raw) > MAX_JSON_BYTES:
                raise ApiError("Ergouzi API response exceeds the JSON limit", response.status)
            if not raw:
                return {}, response.status
            parsed = json.loads(raw.decode("utf-8"))
            if not isinstance(parsed, dict):
                raise ApiError("Ergouzi API returned a non-object JSON response", response.status)
            return parsed, response.status
    except HTTPError as error:
        detail = error.read(65536).decode("utf-8", errors="replace")
        detail = _redact(detail, credentials.api_key).strip()
        raise ApiError(f"Ergouzi API returned HTTP {error.code}: {detail}", error.code) from error
    except URLError as error:
        raise ApiError(f"Ergouzi API request failed: {error.reason}") from error
    except OSError as error:
        detail = _redact(str(error), credentials.api_key)
        raise ApiError(f"Ergouzi API request failed: {detail}") from error
    except json.JSONDecodeError as error:
        raise ApiError("Ergouzi API returned invalid JSON") from error


def _extension(content_type: str, source_url: str) -> str:
    media_type = content_type.split(";", 1)[0].strip().lower()
    known = {
        "image/avif": ".avif",
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
    }
    if media_type in known:
        return known[media_type]
    suffix = Path(urlparse(source_url).path).suffix.lower()
    return suffix if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix) else ".bin"


def _available_path(directory: Path, index: int, suffix: str) -> Path:
    candidate = directory / f"result-{index}{suffix}"
    version = 2
    while candidate.exists():
        candidate = directory / f"result-{index}-v{version}{suffix}"
        version += 1
    return candidate


def _remove_partial(path: Path | None, created: bool) -> None:
    if path is None or not created:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def download_outputs(
    credentials: Credentials,
    output: Any,
    output_dir: Path,
    output_path: Path | None = None,
    expected_media_types: frozenset[str] | None = None,
) -> list[Path]:
    if not isinstance(output, str):
        raise ClientError("Completed prediction output must be a single URL")
    parsed_output = urlparse(output)
    if not (output.startswith("/") or parsed_output.scheme in {"http", "https"}):
        raise ClientError("Completed prediction output must be a single URL")
    output_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    for index, source in enumerate([output], start=1):
        target_url = urljoin(credentials.base_url + "/", source)
        base = urlparse(credentials.base_url)
        allow_local_http = base.scheme == "http" and base.hostname in {
            "127.0.0.1",
            "::1",
            "localhost",
        }
        allow_reserved_first_party = _is_first_party_hostname(base.hostname or "")
        _validate_download_url(target_url, allow_local_http, allow_reserved_first_party)
        headers = {"Accept": "*/*", "User-Agent": "ergouzi-media-skill/1.0"}
        if _origin(target_url) == _origin(credentials.base_url):
            headers["Authorization"] = f"Bearer {credentials.api_key}"
        request = Request(target_url, headers=headers, method="GET")
        deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
        for attempt in range(3):
            destination = None
            destination_created = False
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ClientError("Output download exceeded the 30-minute time limit")
                opener = build_opener(
                    ProxyHandler({}),
                    _SafeDownloadRedirect(allow_local_http, allow_reserved_first_party),
                    _PinnedHTTPHandler(allow_local_http, allow_reserved_first_party),
                    _PinnedHTTPSHandler(allow_local_http, allow_reserved_first_party),
                )
                with opener.open(request, timeout=min(300.0, remaining)) as response:
                    length = response.headers.get("Content-Length")
                    if length and int(length) > MAX_OUTPUT_BYTES:
                        raise ClientError("Generated output exceeds the 2 GiB download limit")
                    content_type = response.headers.get("Content-Type", "")
                    media_type = content_type.split(";", 1)[0].strip().lower()
                    if expected_media_types and media_type not in expected_media_types:
                        raise ClientError(
                            f"Generated output has unexpected content type: {media_type or 'unknown'}"
                        )
                    suffix = _extension(content_type, target_url)
                    if output_path is not None:
                        destination = output_path.expanduser().resolve()
                        if destination.suffix.lower() not in _compatible_suffixes(media_type):
                            raise ClientError(
                                f"Output path extension does not match {media_type or 'the response'}"
                            )
                        destination.parent.mkdir(parents=True, exist_ok=True)
                    else:
                        destination = _available_path(output_dir, index, suffix)
                    written = 0
                    try:
                        with destination.open("xb") as handle:
                            destination_created = True
                            while True:
                                chunk = response.read(1024 * 1024)
                                if not chunk:
                                    break
                                written += len(chunk)
                                if written > MAX_OUTPUT_BYTES:
                                    raise ClientError("Generated output exceeds the 2 GiB download limit")
                                handle.write(chunk)
                                if time.monotonic() >= deadline:
                                    raise ClientError("Output download exceeded the 30-minute time limit")
                        detected_media_type = _detect_download_media_type(destination)
                        if detected_media_type != media_type:
                            raise ClientError(
                                "Generated output content does not match its declared media type"
                            )
                    except BaseException:
                        _remove_partial(destination, destination_created)
                        raise
                    saved.append(destination.resolve())
                    break
            except HTTPError as error:
                if error.code in TRANSIENT_STATUS_CODES and attempt < 2:
                    time.sleep(min(0.5 * (2**attempt), max(0.0, deadline - time.monotonic())))
                    continue
                raise ClientError(f"Output download returned HTTP {error.code}") from error
            except (OSError, URLError) as error:
                _remove_partial(destination, destination_created)
                if attempt < 2 and time.monotonic() < deadline:
                    time.sleep(min(0.5 * (2**attempt), max(0.0, deadline - time.monotonic())))
                    continue
                reason = getattr(error, "reason", str(error))
                raise ClientError(f"Output download failed: {reason}") from error
    return saved


def _compatible_suffixes(media_type: str) -> set[str]:
    if media_type == "image/jpeg":
        return {".jpg", ".jpeg"}
    suffix = _extension(media_type, "")
    return {suffix} if suffix != ".bin" else set()


def _detect_download_media_type(path: Path) -> str:
    with path.open("rb") as handle:
        data = handle.read(512)
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "video/mp4"
    return ""
