#!/usr/bin/env python3
"""Configure and verify credentials for the Ergouzi image skill."""

from __future__ import annotations

import argparse
import getpass
import os
import sys

from client import (
    DEFAULT_BASE_URL,
    ApiError,
    ClientError,
    Credentials,
    api_json,
    load_credentials,
    normalize_base_url,
    save_credentials,
)


def verify(credentials: Credentials) -> None:
    api_json(credentials, "GET", "/customer/v1/models", timeout=30)
    print("Verified Ergouzi API access.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify current configuration")
    parser.add_argument("--from-env", action="store_true", help="Save an Ergouzi API key from the environment")
    parser.add_argument("--base-url", default="", help="Gateway URL override")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.check:
            verify(load_credentials())
            return 0

        if args.from_env:
            api_key = os.getenv("ERGOUZI_MEDIA_API_KEY", "").strip() or os.getenv(
                "ERGOUZI_API_KEY", ""
            ).strip()
            if not api_key:
                raise ClientError("ERGOUZI_MEDIA_API_KEY or ERGOUZI_API_KEY is not set")
        else:
            api_key = getpass.getpass("Ergouzi API key: ").strip()
            if not api_key:
                raise ClientError("API key cannot be empty")

        base_url = normalize_base_url(
            args.base_url
            or os.getenv("ERGOUZI_MEDIA_BASE_URL", "")
            or os.getenv("ERGOUZI_BASE_URL", "")
            or DEFAULT_BASE_URL
        )
        credentials = Credentials(base_url=base_url, api_key=api_key)
        verify(credentials)
        path = save_credentials(credentials)
        print(f"Saved Ergouzi credentials to {path}")
        return 0
    except (ApiError, ClientError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
