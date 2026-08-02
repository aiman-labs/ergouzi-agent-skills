#!/usr/bin/env python3
"""Validate and resolve Ergouzi video model media inputs."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from client import ClientError


LOCAL_FILE_KEY = "$local_file"
MAX_EXPANDED_INPUT_BYTES = 4 * 1024 * 1024
MAX_LOCAL_MEDIA_BYTES = 3 * 1024 * 1024
IMAGE_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
AUDIO_TYPES = frozenset({"audio/flac", "audio/mpeg", "audio/wav"})
VIDEO_TYPES = frozenset({"video/mp4"})


@dataclass(frozen=True)
class MediaField:
    types: frozenset[str]
    multiple: bool = False


@dataclass(frozen=True)
class PreparedMedia:
    path: Path
    media_type: str


MODEL_MEDIA_FIELDS = {
    "ergouzi/e-video": {
        "image": MediaField(IMAGE_TYPES),
        "last_frame_image": MediaField(IMAGE_TYPES),
        "audio": MediaField(AUDIO_TYPES),
    },
    "ergouzi/e-video-animate": {
        "image": MediaField(IMAGE_TYPES),
        "video": MediaField(VIDEO_TYPES),
    },
    "ergouzi/e-video-avatar": {
        "image": MediaField(IMAGE_TYPES),
        "audio": MediaField(AUDIO_TYPES),
    },
    "ergouzi/e-video-replace": {
        "video": MediaField(VIDEO_TYPES),
        "images": MediaField(IMAGE_TYPES, multiple=True),
    },
}


class MediaResolver:
    def prepare(self, value: Any, field: MediaField) -> Any:
        if field.multiple:
            if not isinstance(value, list):
                raise ClientError("Media field must be an array")
            return [self._prepare_one(item, field.types) for item in value]
        return self._prepare_one(value, field.types)

    def _prepare_one(self, value: Any, allowed_types: frozenset[str]) -> str | PreparedMedia:
        if isinstance(value, str):
            return validate_media_reference(value, allowed_types)
        if not isinstance(value, dict) or set(value) != {LOCAL_FILE_KEY}:
            raise ClientError("Media input must be an HTTPS URL, data URI, or $local_file object")
        source = value[LOCAL_FILE_KEY]
        if not isinstance(source, str) or not source.strip():
            raise ClientError(f"{LOCAL_FILE_KEY} must contain a local file path")
        path = Path(source).expanduser().resolve()
        if not path.is_file():
            raise ClientError(f"Local media file does not exist: {path}")
        size = path.stat().st_size
        if size == 0:
            raise ClientError(f"Local media file is empty: {path}")
        if size > MAX_LOCAL_MEDIA_BYTES:
            raise ClientError(
                "Local media is too large for the 4 MiB API request; use an HTTPS URL"
            )
        media_type = detect_media_type(path)
        if media_type not in allowed_types:
            raise ClientError(f"Unsupported media type for this field: {media_type or path.suffix}")
        return PreparedMedia(path, media_type)

    def encode_local(self, value: Any) -> Any:
        if isinstance(value, PreparedMedia):
            encoded = base64.b64encode(value.path.read_bytes()).decode("ascii")
            return f"data:{value.media_type};base64,{encoded}"
        if isinstance(value, list):
            return [self.encode_local(item) for item in value]
        if isinstance(value, dict):
            return {key: self.encode_local(item) for key, item in value.items()}
        return value


def resolve_media_inputs(
    model: str, model_input: dict[str, Any]
) -> dict[str, Any]:
    fields = MODEL_MEDIA_FIELDS[model]
    resolved = dict(model_input)
    resolver = MediaResolver()
    for name, field in fields.items():
        if name in resolved:
            resolved[name] = resolver.prepare(resolved[name], field)
    if contains_local_placeholder(resolved):
        raise ClientError(f"{LOCAL_FILE_KEY} is only allowed in documented media fields")
    resolved = resolver.encode_local(resolved)
    if len(json.dumps(resolved, ensure_ascii=False).encode("utf-8")) > MAX_EXPANDED_INPUT_BYTES:
        raise ClientError(
            "Expanded input exceeds the 4 MiB API request limit; use HTTPS URLs for media"
        )
    return resolved


def validate_media_reference(value: str, allowed_types: frozenset[str]) -> str:
    parsed = urlparse(value)
    if parsed.scheme == "https" and parsed.netloc:
        return value
    if value.startswith("data:"):
        header = value.split(",", 1)[0]
        media_type = header[5:].split(";", 1)[0].lower()
        if media_type in allowed_types and ";base64" in header.lower():
            return value
    raise ClientError("Media input must use HTTPS or a supported base64 data URI")


def detect_media_type(path: Path) -> str:
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
    if data.startswith(b"fLaC"):
        return "audio/flac"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data.startswith(b"ID3") or (
        len(data) >= 2 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0
    ):
        return "audio/mpeg"
    return ""


def contains_local_placeholder(value: Any) -> bool:
    if isinstance(value, dict):
        if set(value) == {LOCAL_FILE_KEY}:
            return True
        return any(contains_local_placeholder(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_local_placeholder(item) for item in value)
    return False
