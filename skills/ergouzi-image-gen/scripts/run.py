#!/usr/bin/env python3
"""Run and resume Ergouzi image prediction tasks."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

from client import (
    ApiError,
    ClientError,
    Credentials,
    api_json,
    download_outputs,
    load_credentials,
)
from media import LOCAL_FILE_KEY, resolve_media_inputs


ALLOWED_MODELS = {
    "ergouzi/e-image",
    "ergouzi/e-image-edit",
    "ergouzi/e-image-ideogram",
    "ergouzi/e-image-try-on",
    "ergouzi/e-image-upscale",
}
PROMPT_MODELS = ALLOWED_MODELS - {"ergouzi/e-image-upscale"}
DEFAULT_OUTPUT_DIR = "output/ergouzi-image-gen"
TERMINAL_STATUSES = {"succeeded", "failed", "canceled", "unknown"}
TRANSIENT_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
MAX_INPUT_BYTES = 4 * 1024 * 1024


class PredictionTimeout(ClientError):
    def __init__(self, task_id: str):
        super().__init__(f"Prediction timed out; resume task {task_id} with the status command")
        self.task_id = task_id


def _print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _model_path(model: str) -> str:
    if model not in ALLOWED_MODELS:
        raise ClientError(f"Unsupported image model: {model}")
    owner, name = model.split("/", 1)
    return f"/customer/v1/models/{quote(owner, safe='')}/{quote(name, safe='')}/predictions"


def _media_argument(value: str) -> Any:
    if value.startswith(("https://", "data:")):
        return value
    return {LOCAL_FILE_KEY: value}


def _read_input(args: argparse.Namespace) -> dict[str, Any]:
    value: dict[str, Any] = {}
    if args.input_file:
        if args.input_file == "-":
            raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        else:
            path = Path(args.input_file).expanduser()
            if path.stat().st_size > MAX_INPUT_BYTES:
                raise ClientError("Input JSON exceeds 4 MiB")
            raw = path.read_bytes()
    elif args.input_json:
        raw = args.input_json.encode("utf-8")
    else:
        raw = b""
    if raw:
        if len(raw) > MAX_INPUT_BYTES:
            raise ClientError("Input JSON exceeds 4 MiB")
        try:
            decoded = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ClientError("Input must be a UTF-8 JSON object") from error
        if not isinstance(decoded, dict):
            raise ClientError("Input must be a JSON object")
        value.update(decoded)
    if args.prompt is not None and args.model not in PROMPT_MODELS:
        raise ClientError(f"--prompt is not valid for {args.model}")
    if args.prompt is not None:
        value["prompt"] = args.prompt
    if args.image:
        if args.model == "ergouzi/e-image-edit":
            value["images"] = [_media_argument(item) for item in args.image]
        elif args.model == "ergouzi/e-image-upscale" and len(args.image) == 1:
            value["image"] = _media_argument(args.image[0])
        else:
            raise ClientError(f"--image is not valid for {args.model}")
    for argument, field in (
        (args.person_image, "person_image"),
        (args.reference_pose, "reference_pose"),
    ):
        if argument:
            if args.model != "ergouzi/e-image-try-on":
                raise ClientError(f"--{field.replace('_', '-')} is only valid for ergouzi/e-image-try-on")
            value[field] = _media_argument(argument)
    if args.garment_image:
        if args.model != "ergouzi/e-image-try-on":
            raise ClientError("--garment-image is only valid for ergouzi/e-image-try-on")
        value["garment_images"] = [_media_argument(item) for item in args.garment_image]
    if "hf_api_token" in value:
        raise ClientError("hf_api_token is not accepted; use the configured Ergouzi API key")
    value = resolve_media_inputs(args.model, value)
    expanded = json.dumps(value, ensure_ascii=False).encode("utf-8")
    if len(expanded) > MAX_INPUT_BYTES:
        raise ClientError("Expanded input JSON exceeds 4 MiB")
    return value


def _output_path(value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value).expanduser().resolve()
    if path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
        raise ClientError("Image output path must end in .jpg, .jpeg, .png, or .webp")
    if path.exists():
        raise ClientError(f"Output file already exists: {path}")
    return path


def _receipt_path(output_dir: Path, task_id: str) -> Path:
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", task_id)
    return output_dir / f"{safe_id}.json"


def _write_receipt(
    output_dir: Path,
    task_id: str,
    model: str,
    status: str,
    files: list[Path] | None = None,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = _receipt_path(output_dir, task_id)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(
            {
                "task_id": task_id,
                "model": model,
                "status": status,
                "files": [str(item) for item in files or []],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
    return path.resolve()


def _task_status(payload: dict[str, Any]) -> str:
    return str(payload.get("status", "")).strip().lower()


def _fetch(task_id: str) -> dict[str, Any]:
    credentials = load_credentials()
    payload, _ = api_json(
        credentials,
        "GET",
        f"/customer/v1/predictions/{quote(task_id, safe='')}",
    )
    return payload


def _poll(task_id: str, timeout_seconds: int, poll_interval: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    delay = poll_interval
    last_status = ""
    while time.monotonic() < deadline:
        try:
            payload = _fetch(task_id)
        except ApiError as error:
            if error.status is not None and error.status not in TRANSIENT_STATUS_CODES:
                raise
            time.sleep(min(delay, max(0.0, deadline - time.monotonic())))
            delay = min(delay * 1.5, 10.0)
            continue
        status = _task_status(payload)
        if status != last_status:
            print(f"Task {task_id}: {status or 'pending'}", file=sys.stderr)
            last_status = status
        if status in TERMINAL_STATUSES:
            return payload
        time.sleep(min(delay, max(0.0, deadline - time.monotonic())))
        delay = min(delay * 1.5, 10.0)
    raise PredictionTimeout(task_id)


def _submit(model: str, model_input: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
    credentials = load_credentials()
    delay = 0.5
    for attempt in range(3):
        try:
            payload, _ = api_json(
                credentials,
                "POST",
                _model_path(model),
                {"input": model_input},
                {"Idempotency-Key": idempotency_key},
            )
            return payload
        except ApiError as error:
            retryable = error.status is None or error.status in TRANSIENT_STATUS_CODES
            if not retryable or attempt == 2:
                raise
            time.sleep(delay)
            delay *= 2
    raise ClientError("Prediction submission failed")


def _complete(
    payload: dict[str, Any],
    output_dir: Path,
    download: bool,
    output_path: Path | None = None,
) -> tuple[dict[str, Any], int]:
    credentials = load_credentials()
    task_id = str(payload.get("id", ""))
    model = str(payload.get("model", ""))
    status = _task_status(payload)
    files = (
        download_outputs(
            credentials,
            payload.get("output"),
            output_dir,
            output_path=output_path,
            expected_media_types=frozenset({"image/jpeg", "image/png", "image/webp"}),
        )
        if download and status == "succeeded"
        else []
    )
    receipt = _write_receipt(output_dir, task_id, model, status, files)
    result: dict[str, Any] = {
        "task_id": task_id,
        "model": model,
        "status": status,
        "files": [str(path) for path in files],
        "receipt": str(receipt),
    }
    if payload.get("error"):
        result["error"] = payload["error"]
    if not files and payload.get("output") is not None:
        result["output"] = payload["output"]
    return result, 0 if status == "succeeded" else 2


def _predict(args: argparse.Namespace) -> int:
    output_path = _output_path(args.output)
    model_input = _read_input(args)
    idempotency_key = f"ergouzi-skill-{uuid.uuid4()}"
    payload = _submit(args.model, model_input, idempotency_key)
    task_id = str(payload.get("id", ""))
    if not task_id.startswith("task_"):
        raise ClientError("Prediction response does not contain a local task_* ID")
    output_dir = output_path.parent if output_path else Path(args.output_dir).expanduser().resolve()
    receipt = _write_receipt(output_dir, task_id, args.model, _task_status(payload))
    print(f"Task created: {task_id}; receipt: {receipt}", file=sys.stderr)
    if args.no_wait:
        _print_json(
            {
                "task_id": task_id,
                "model": args.model,
                "status": _task_status(payload),
                "receipt": str(receipt),
            }
        )
        return 0
    completed = _poll(task_id, args.timeout_seconds, args.poll_interval)
    result, exit_code = _complete(completed, output_dir, not args.no_download, output_path)
    _print_json(result)
    return exit_code


def _status(args: argparse.Namespace) -> int:
    payload = (
        _poll(args.task_id, args.timeout_seconds, args.poll_interval)
        if args.wait
        else _fetch(args.task_id)
    )
    output_path = _output_path(args.output)
    output_dir = output_path.parent if output_path else Path(args.output_dir).expanduser().resolve()
    result, exit_code = _complete(payload, output_dir, args.download, output_path)
    _print_json(result)
    return exit_code if _task_status(payload) in TERMINAL_STATUSES else 0


def _cancel(args: argparse.Namespace) -> int:
    credentials = load_credentials()
    payload, _ = api_json(
        credentials,
        "POST",
        f"/customer/v1/predictions/{quote(args.task_id, safe='')}/cancel",
    )
    _print_json(
        {
            "task_id": str(payload.get("id", args.task_id)),
            "model": str(payload.get("model", "")),
            "status": _task_status(payload),
        }
    )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    predict = subparsers.add_parser("predict", help="Submit, poll, and download a task")
    predict.add_argument("--model", required=True, choices=sorted(ALLOWED_MODELS))
    predict.add_argument("--prompt")
    source = predict.add_mutually_exclusive_group()
    source.add_argument(
        "--input-file", help="UTF-8 JSON object (BOM accepted), or - for stdin"
    )
    source.add_argument("--input-json", help="Inline JSON object")
    predict.add_argument("--image", action="append", default=[], help="Local path or HTTPS URL")
    predict.add_argument("--person-image", help="Try-on person image path or HTTPS URL")
    predict.add_argument("--garment-image", action="append", default=[], help="Try-on garment path or HTTPS URL")
    predict.add_argument("--reference-pose", help="Try-on pose path or HTTPS URL")
    predict.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    predict.add_argument("--output", help="Exact .jpg, .jpeg, .png, or .webp output path")
    predict.add_argument("--timeout-seconds", type=int, default=1200)
    predict.add_argument("--poll-interval", type=float, default=2.0)
    predict.add_argument("--no-wait", action="store_true")
    predict.add_argument("--no-download", action="store_true")
    predict.set_defaults(handler=_predict)

    status = subparsers.add_parser("status", help="Read or resume a task")
    status.add_argument("--task-id", required=True)
    status.add_argument("--wait", action="store_true", help="Poll until the task finishes")
    status.add_argument("--download", action="store_true")
    status.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    status.add_argument("--output", help="Exact .jpg, .jpeg, .png, or .webp output path")
    status.add_argument("--timeout-seconds", type=int, default=1200)
    status.add_argument("--poll-interval", type=float, default=2.0)
    status.set_defaults(handler=_status)

    cancel = subparsers.add_parser("cancel", help="Cancel a task")
    cancel.add_argument("--task-id", required=True)
    cancel.set_defaults(handler=_cancel)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if getattr(args, "timeout_seconds", 1) <= 0:
        print("Error: --timeout-seconds must be positive", file=sys.stderr)
        return 1
    if getattr(args, "poll_interval", 1.0) <= 0:
        print("Error: --poll-interval must be positive", file=sys.stderr)
        return 1
    try:
        return args.handler(args)
    except PredictionTimeout as error:
        _print_json({"task_id": error.task_id, "status": "timeout", "error": str(error)})
        return 3
    except (ApiError, ClientError, OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Interrupted; use the printed task ID with the status command.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
