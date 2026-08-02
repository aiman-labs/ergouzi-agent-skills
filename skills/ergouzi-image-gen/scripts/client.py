#!/usr/bin/env python3
"""Shared standard-library client for Ergouzi asynchronous model tasks."""

from __future__ import annotations

import ipaddress
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_BASE_URL = "https://ergouzi.life"
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024


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
    if not parsed.scheme or not parsed.hostname or parsed.query or parsed.fragment:
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
    saved_base_url = str(saved.get("base_url", "")).strip()
    saved_api_key = str(saved.get("api_key", "")).strip()
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
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), parsed.port


def _redact(value: str, secret: str) -> str:
    return value.replace(secret, "[redacted]") if secret else value


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _validate_download_url(value: str, allow_local_http: bool = False) -> None:
    parsed = urlparse(value)
    hostname = (parsed.hostname or "").lower()
    local = hostname in {"127.0.0.1", "::1", "localhost"}
    try:
        non_public_ip = not ipaddress.ip_address(hostname).is_global
    except ValueError:
        non_public_ip = False
    if (local or non_public_ip or hostname.endswith(".local")) and not allow_local_http:
        raise ClientError("Output URL must not target a local or non-public address")
    if parsed.scheme != "https" and not (
        allow_local_http and parsed.scheme == "http" and local
    ):
        raise ClientError("Output URL must use HTTPS")


class _SafeDownloadRedirect(HTTPRedirectHandler):
    def __init__(self, allow_local_http: bool = False):
        super().__init__()
        self.allow_local_http = allow_local_http

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            _validate_download_url(redirected.full_url, self.allow_local_http)
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
        _validate_download_url(target_url, allow_local_http)
        headers = {"Accept": "*/*", "User-Agent": "ergouzi-media-skill/1.0"}
        if _origin(target_url) == _origin(credentials.base_url):
            headers["Authorization"] = f"Bearer {credentials.api_key}"
        request = Request(target_url, headers=headers, method="GET")
        try:
            with build_opener(_SafeDownloadRedirect(allow_local_http)).open(
                request, timeout=300
            ) as response:
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
                        while True:
                            chunk = response.read(1024 * 1024)
                            if not chunk:
                                break
                            written += len(chunk)
                            if written > MAX_OUTPUT_BYTES:
                                raise ClientError("Generated output exceeds the 2 GiB download limit")
                            handle.write(chunk)
                    detected_media_type = _detect_download_media_type(destination)
                    if detected_media_type != media_type:
                        raise ClientError(
                            "Generated output content does not match its declared media type"
                        )
                except Exception:
                    destination.unlink(missing_ok=True)
                    raise
                saved.append(destination.resolve())
        except HTTPError as error:
            raise ClientError(f"Output download returned HTTP {error.code}") from error
        except URLError as error:
            raise ClientError(f"Output download failed: {error.reason}") from error
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
