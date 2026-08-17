from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
IMAGE_DIR = ROOT / "skills" / "ergouzi-image-gen"
VIDEO_DIR = ROOT / "skills" / "ergouzi-video-gen"
ALL_MODELS = [
    "ergouzi/e-image",
    "ergouzi/e-image-edit",
    "ergouzi/e-image-ideogram",
    "ergouzi/e-image-try-on",
    "ergouzi/e-image-upscale",
    "ergouzi/e-video",
    "ergouzi/e-video-animate",
    "ergouzi/e-video-avatar",
    "ergouzi/e-video-replace",
]


class MockState:
    def __init__(self) -> None:
        self.polls: dict[str, int] = {}
        self.requests: list[tuple[str, str, str]] = []
        self.submitted_inputs: list[dict[str, object]] = []
        self.transient_submit_keys: list[str] = []


class MockHandler(BaseHTTPRequestHandler):
    server: "MockServer"

    def log_message(self, format: str, *args: object) -> None:
        return

    def _record(self) -> None:
        self.server.state.requests.append(
            (self.command, self.path, self.headers.get("Authorization", ""))
        )

    def _json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self._record()
        if self.path == "/customer/v1/models":
            results = []
            for model_id in ALL_MODELS:
                owner, name = model_id.split("/", 1)
                results.append({"owner": owner, "name": name})
            self._json(200, {"results": results})
            return
        if self.path.startswith("/customer/v1/predictions/"):
            task_id = self.path.rsplit("/", 1)[-1]
            model = "ergouzi/e-video" if "video" in task_id else "ergouzi/e-image"
            if task_id == "task_external":
                self._json(
                    200,
                    {
                        "id": task_id,
                        "model": model,
                        "status": "succeeded",
                        "output": f"http://127.0.0.1:{self.server.external_port}/external.bin",
                    },
                )
                return
            if task_id == "task_insecure_redirect":
                self._json(
                    200,
                    {
                        "id": task_id,
                        "model": model,
                        "status": "succeeded",
                        "output": "/customer/v1/assets/insecure_redirect",
                    },
                )
                return
            if task_id == "task_video_bad_output":
                self._json(
                    200,
                    {
                        "id": task_id,
                        "model": "ergouzi/e-video",
                        "status": "succeeded",
                        "output": "/customer/v1/assets/image_asset",
                    },
                )
                return
            if task_id == "task_bad_signature":
                self._json(
                    200,
                    {
                        "id": task_id,
                        "model": "ergouzi/e-image",
                        "status": "succeeded",
                        "output": "/customer/v1/assets/bad_signature",
                    },
                )
                return
            if task_id == "task_list_output":
                self._json(
                    200,
                    {
                        "id": task_id,
                        "model": "ergouzi/e-image",
                        "status": "succeeded",
                        "output": ["/customer/v1/assets/image_asset"],
                    },
                )
                return
            count = self.server.state.polls.get(task_id, 0) + 1
            self.server.state.polls[task_id] = count
            if task_id == "task_cancel":
                self._json(200, {"id": task_id, "model": model, "status": "starting"})
                return
            if count == 1:
                self._json(200, {"id": task_id, "model": model, "status": "processing"})
                return
            asset = "video_asset" if "video" in task_id else "image_asset"
            self._json(
                200,
                {
                    "id": task_id,
                    "model": model,
                    "status": "succeeded",
                    "output": f"/customer/v1/assets/{asset}",
                },
            )
            return
        if self.path == "/customer/v1/assets/insecure_redirect":
            self.send_response(302)
            self.send_header("Location", "http://example.com/insecure-output")
            self.end_headers()
            return
        if self.path == "/customer/v1/assets/image_asset":
            body = b"\x89PNG\r\n\x1a\nmock-image"
            content_type = "image/png"
        elif self.path == "/customer/v1/assets/video_asset":
            body = b"\x00\x00\x00\x18ftypmp42mock-video"
            content_type = "video/mp4"
        elif self.path == "/customer/v1/assets/bad_signature":
            body = b"not-an-image"
            content_type = "image/png"
        else:
            self._json(404, {"error": "not found"})
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        self._record()
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        if self.path.endswith("/predictions") and "/models/" in self.path:
            if not self.headers.get("Idempotency-Key"):
                self._json(400, {"error": "missing idempotency key"})
                return
            request = json.loads(body.decode("utf-8"))
            model_input = request.get("input")
            if not isinstance(model_input, dict):
                self._json(400, {"error": "unexpected input"})
                return
            if model_input.get("prompt") == "retry submit":
                key = self.headers.get("Idempotency-Key", "")
                self.server.state.transient_submit_keys.append(key)
                if len(self.server.state.transient_submit_keys) == 1:
                    self._json(503, {"error": "temporary"})
                    return
            self.server.state.submitted_inputs.append(model_input)
            is_video = "/e-video/" in self.path
            task_id = "task_video" if is_video else "task_image"
            model = "ergouzi/e-video" if is_video else "ergouzi/e-image"
            self._json(201, {"id": task_id, "model": model, "status": "starting"})
            return
        if self.path == "/customer/v1/predictions/task_cancel/cancel":
            self._json(
                200,
                {"id": "task_cancel", "model": "ergouzi/e-image", "status": "canceled"},
            )
            return
        self._json(404, {"error": "not found"})


class MockServer(ThreadingHTTPServer):
    def __init__(self, external_port: int) -> None:
        super().__init__(("127.0.0.1", 0), MockHandler)
        self.state = MockState()
        self.external_port = external_port


class ExternalAssetHandler(BaseHTTPRequestHandler):
    server: "ExternalAssetServer"

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        self.server.authorization.append(self.headers.get("Authorization", ""))
        body = b"\x89PNG\r\n\x1a\nexternal-output"
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ExternalAssetServer(ThreadingHTTPServer):
    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), ExternalAssetHandler)
        self.authorization: list[str] = []


class MediaSkillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.external_server = ExternalAssetServer()
        cls.external_thread = threading.Thread(
            target=cls.external_server.serve_forever, daemon=True
        )
        cls.external_thread.start()
        cls.server = MockServer(cls.external_server.server_port)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.external_server.shutdown()
        cls.external_server.server_close()
        cls.external_thread.join(timeout=5)

    def environment(self, config_file: Path) -> dict[str, str]:
        env = os.environ.copy()
        env.update(
            {
                "ERGOUZI_API_KEY": "test-key",
                "ERGOUZI_BASE_URL": f"http://127.0.0.1:{self.server.server_port}",
                "ERGOUZI_CONFIG_FILE": str(config_file),
            }
        )
        return env

    def run_script(
        self,
        skill_dir: Path,
        script: str,
        args: list[str],
        config_file: Path,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(skill_dir / "scripts" / script), *args],
            cwd=ROOT,
            env=self.environment(config_file),
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )

    def run_script_bytes(
        self,
        skill_dir: Path,
        script: str,
        args: list[str],
        config_file: Path,
        stdin: bytes,
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            [sys.executable, str(skill_dir / "scripts" / script), *args],
            cwd=ROOT,
            env=self.environment(config_file),
            input=stdin,
            capture_output=True,
            timeout=15,
            check=False,
        )

    def test_clients_are_identical(self) -> None:
        image_client = (IMAGE_DIR / "scripts" / "client.py").read_bytes()
        video_client = (VIDEO_DIR / "scripts" / "client.py").read_bytes()
        self.assertEqual(image_client, video_client)

    def test_read_only_configuration_checks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "unused.json"
            for skill_dir in (IMAGE_DIR, VIDEO_DIR):
                result = self.run_script(skill_dir, "configure.py", ["--check"], config)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Verified", result.stdout)

    def test_utf8_bom_json_is_accepted_from_file_and_stdin(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cases = [
                (IMAGE_DIR, "ergouzi/e-image", {"prompt": "BOM 图片输入"}),
                (VIDEO_DIR, "ergouzi/e-video", {"prompt": "BOM 视频输入"}),
            ]
            for skill_dir, model, model_input in cases:
                raw = b"\xef\xbb\xbf" + json.dumps(model_input).encode("utf-8")
                input_file = root / f"{skill_dir.name}-bom.json"
                input_file.write_bytes(raw)
                common = [
                    "predict",
                    "--model",
                    model,
                    "--no-wait",
                    "--output-dir",
                    str(root / "output"),
                ]
                from_file = self.run_script(
                    skill_dir,
                    "run.py",
                    [*common, "--input-file", str(input_file)],
                    root / "unused.json",
                )
                self.assertEqual(from_file.returncode, 0, from_file.stderr)

                from_stdin = self.run_script_bytes(
                    skill_dir,
                    "run.py",
                    [*common, "--input-file", "-"],
                    root / "unused.json",
                    raw,
                )
                self.assertEqual(
                    from_stdin.returncode,
                    0,
                    from_stdin.stderr.decode("utf-8", errors="replace"),
                )
                self.assertEqual(self.server.state.submitted_inputs[-1], model_input)

    def test_image_prediction_status_cancel_and_download(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            config = root / "unused.json"
            result = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-image",
                    "--prompt",
                    "test prompt",
                    "--poll-interval",
                    "0.01",
                    "--timeout-seconds",
                    "5",
                    "--output-dir",
                    str(output),
                ],
                config,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["status"], "succeeded")
            self.assertTrue(Path(payload["files"][0]).is_file())
            self.assertTrue(Path(payload["receipt"]).is_file())

            status = self.run_script(
                IMAGE_DIR,
                "run.py",
                ["status", "--task-id", "task_image", "--download", "--output-dir", str(output)],
                config,
            )
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertEqual(json.loads(status.stdout)["status"], "succeeded")

            resumed = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "status",
                    "--task-id",
                    "task_resume",
                    "--wait",
                    "--download",
                    "--poll-interval",
                    "0.01",
                    "--timeout-seconds",
                    "5",
                    "--output-dir",
                    str(output),
                ],
                config,
            )
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
            self.assertEqual(json.loads(resumed.stdout)["status"], "succeeded")
            self.assertGreaterEqual(self.server.state.polls["task_resume"], 2)

            cancel = self.run_script(
                IMAGE_DIR,
                "run.py",
                ["cancel", "--task-id", "task_cancel"],
                config,
            )
            self.assertEqual(cancel.returncode, 0, cancel.stderr)
            self.assertEqual(json.loads(cancel.stdout)["status"], "canceled")

    def test_external_download_never_receives_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            status = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "status",
                    "--task-id",
                    "task_external",
                    "--download",
                    "--output-dir",
                    str(root / "output"),
                ],
                root / "unused.json",
            )
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertEqual(self.external_server.authorization[-1], "")

    def test_insecure_download_redirect_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            status = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "status",
                    "--task-id",
                    "task_insecure_redirect",
                    "--download",
                    "--output-dir",
                    str(root / "output"),
                ],
                root / "unused.json",
            )
            self.assertEqual(status.returncode, 1)
            self.assertIn("Output URL must use HTTPS", status.stderr)

    def test_production_download_rejects_non_public_address(self) -> None:
        script = (
            "import sys; "
            f"sys.path.insert(0, {str(IMAGE_DIR / 'scripts')!r}); "
            "from client import ClientError, _validate_download_url; "
            "\ntry: _validate_download_url('https://127.0.0.1/result.png')"
            "\nexcept ClientError: pass"
            "\nelse: raise SystemExit('accepted non-public output URL')"
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_prompt_is_forwarded_verbatim(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prompt = "  exact prompt\nsecond line  "
            result = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-image",
                    "--prompt",
                    prompt,
                    "--no-wait",
                    "--output-dir",
                    str(root / "output"),
                ],
                root / "unused.json",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.server.state.submitted_inputs[-1]["prompt"], prompt)

    def test_prompt_convenience_is_limited_to_real_prompt_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            before = len(self.server.state.submitted_inputs)
            cases = [
                (IMAGE_DIR, "ergouzi/e-image-upscale"),
                (VIDEO_DIR, "ergouzi/e-video-animate"),
            ]
            for skill_dir, model in cases:
                result = self.run_script(
                    skill_dir,
                    "run.py",
                    ["predict", "--model", model, "--prompt", "text", "--no-wait"],
                    root / "unused.json",
                )
                self.assertEqual(result.returncode, 1)
                self.assertIn("--prompt is not valid", result.stderr)
            self.assertEqual(len(self.server.state.submitted_inputs), before)

    def test_upstream_provider_token_is_rejected_before_submission(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            before = len(self.server.state.submitted_inputs)
            secret = "provider-secret-marker"
            result = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-image",
                    "--input-json",
                    json.dumps({"prompt": "test", "hf_api_token": secret}),
                    "--no-wait",
                ],
                root / "unused.json",
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("hf_api_token is not accepted", result.stderr)
            self.assertNotIn(secret, result.stderr)
            self.assertEqual(len(self.server.state.submitted_inputs), before)

    def test_transient_submit_reuses_idempotency_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.server.state.transient_submit_keys.clear()
            result = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-image",
                    "--prompt",
                    "retry submit",
                    "--no-wait",
                    "--output-dir",
                    str(root / "output"),
                ],
                root / "unused.json",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(self.server.state.transient_submit_keys), 2)
            self.assertEqual(len(set(self.server.state.transient_submit_keys)), 1)

    def test_local_media_placeholders_are_inlined(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "reference.png"
            content = b"\x89PNG\r\n\x1a\nlocal-reference"
            source.write_bytes(content)
            expected = "data:image/png;base64," + base64.b64encode(content).decode("ascii")
            cases = [
                (
                    IMAGE_DIR,
                    "ergouzi/e-image-edit",
                    {"prompt": "test prompt", "images": [{"$local_file": str(source)}]},
                    "images",
                ),
                (
                    VIDEO_DIR,
                    "ergouzi/e-video",
                    {"prompt": "test prompt", "image": {"$local_file": str(source)}},
                    "image",
                ),
            ]
            for skill_dir, model, model_input, field in cases:
                input_file = root / f"{skill_dir.name}.json"
                input_file.write_text(json.dumps(model_input), encoding="utf-8")
                result = self.run_script(
                    skill_dir,
                    "run.py",
                    [
                        "predict",
                        "--model",
                        model,
                        "--input-file",
                        str(input_file),
                        "--no-wait",
                        "--output-dir",
                        str(root / "output"),
                    ],
                    root / "unused.json",
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                submitted = self.server.state.submitted_inputs[-1][field]
                self.assertEqual(submitted[0] if isinstance(submitted, list) else submitted, expected)

    def test_video_prediction_download(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            result = self.run_script(
                VIDEO_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-video",
                    "--prompt",
                    "test prompt",
                    "--poll-interval",
                    "0.01",
                    "--timeout-seconds",
                    "5",
                    "--output-dir",
                    str(output),
                ],
                root / "unused.json",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(Path(payload["files"][0]).suffix, ".mp4")

    def test_oversized_local_media_requires_https_url(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "large.png"
            source.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * (3 * 1024 * 1024))
            submitted_count = len(self.server.state.submitted_inputs)
            result = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-image-edit",
                    "--prompt",
                    "preserve the subject",
                    "--image",
                    str(source),
                    "--no-wait",
                    "--output-dir",
                    str(root / "output"),
                ],
                root / "unused.json",
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("use an HTTPS URL", result.stderr)
            self.assertEqual(len(self.server.state.submitted_inputs), submitted_count)

    def test_invalid_input_is_rejected_before_submission(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "large.png"
            source.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * (3 * 1024 * 1024))
            before = len(self.server.state.submitted_inputs)
            result = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-image-edit",
                    "--image",
                    str(source),
                    "--no-wait",
                    "--output-dir",
                    str(root / "output"),
                ],
                root / "unused.json",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(len(self.server.state.submitted_inputs), before)

    def test_all_model_media_fields_accept_supported_local_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / "reference.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\nreference")
            video = root / "motion.mp4"
            video.write_bytes(b"\x00\x00\x00\x18ftypmp42motion")
            audio = root / "speech.mp3"
            audio.write_bytes(b"ID3speech")
            local_image = {"$local_file": str(image)}
            local_video = {"$local_file": str(video)}
            local_audio = {"$local_file": str(audio)}
            cases = [
                (
                    IMAGE_DIR,
                    "ergouzi/e-image-try-on",
                    {
                        "person_image": local_image,
                        "garment_images": [local_image],
                        "reference_pose": local_image,
                    },
                ),
                (IMAGE_DIR, "ergouzi/e-image-upscale", {"image": local_image}),
                (
                    VIDEO_DIR,
                    "ergouzi/e-video",
                    {
                        "prompt": "animate",
                        "image": local_image,
                        "last_frame_image": local_image,
                        "audio": local_audio,
                    },
                ),
                (
                    VIDEO_DIR,
                    "ergouzi/e-video-animate",
                    {"image": local_image, "video": local_video},
                ),
                (
                    VIDEO_DIR,
                    "ergouzi/e-video-avatar",
                    {"image": local_image, "audio": local_audio},
                ),
                (
                    VIDEO_DIR,
                    "ergouzi/e-video-replace",
                    {"video": local_video, "images": [local_image]},
                ),
            ]
            for index, (skill_dir, model, model_input) in enumerate(cases):
                with self.subTest(model=model):
                    input_file = root / f"input-{index}.json"
                    input_file.write_text(json.dumps(model_input), encoding="utf-8")
                    result = self.run_script(
                        skill_dir,
                        "run.py",
                        [
                            "predict",
                            "--model",
                            model,
                            "--input-file",
                            str(input_file),
                            "--no-wait",
                            "--output-dir",
                            str(root / "output"),
                        ],
                        root / "unused.json",
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    submitted = json.dumps(self.server.state.submitted_inputs[-1])
                    self.assertNotIn("$local_file", submitted)
                    self.assertIn("data:", submitted)

    def test_convenience_input_and_exact_output_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "reference.png"
            source.write_bytes(b"\x89PNG\r\n\x1a\nreference")
            output = root / "named-result.png"
            result = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-image-edit",
                    "--prompt",
                    "keep the composition",
                    "--image",
                    str(source),
                    "--output",
                    str(output),
                    "--poll-interval",
                    "0.01",
                    "--timeout-seconds",
                    "5",
                ],
                root / "unused.json",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())
            self.assertEqual(
                Path(json.loads(result.stdout)["files"][0]).resolve(), output.resolve()
            )

    def test_local_media_requires_a_supported_signature(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "fake.png"
            source.write_bytes(b"not-a-png")
            submitted_count = len(self.server.state.submitted_inputs)
            result = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-image-edit",
                    "--prompt",
                    "test",
                    "--image",
                    str(source),
                    "--no-wait",
                ],
                root / "unused.json",
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("Unsupported media type", result.stderr)
            self.assertEqual(len(self.server.state.submitted_inputs), submitted_count)

    def test_local_media_uses_signature_without_requiring_extension(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "reference"
            source.write_bytes(b"\x89PNG\r\n\x1a\nreference")
            result = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "predict",
                    "--model",
                    "ergouzi/e-image-upscale",
                    "--image",
                    str(source),
                    "--no-wait",
                    "--output-dir",
                    str(root / "output"),
                ],
                root / "unused.json",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(
                str(self.server.state.submitted_inputs[-1]["image"]).startswith(
                    "data:image/png;base64,"
                )
            )

    def test_output_contract_rejects_wrong_media_type_and_arrays(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wrong_type = self.run_script(
                VIDEO_DIR,
                "run.py",
                [
                    "status",
                    "--task-id",
                    "task_video_bad_output",
                    "--download",
                    "--output-dir",
                    str(root / "video"),
                ],
                root / "unused.json",
            )
            self.assertEqual(wrong_type.returncode, 1)
            self.assertIn("unexpected content type", wrong_type.stderr)

            bad_signature = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "status",
                    "--task-id",
                    "task_bad_signature",
                    "--download",
                    "--output-dir",
                    str(root / "bad-signature"),
                ],
                root / "unused.json",
            )
            self.assertEqual(bad_signature.returncode, 1)
            self.assertIn("does not match its declared media type", bad_signature.stderr)

            array_output = self.run_script(
                IMAGE_DIR,
                "run.py",
                [
                    "status",
                    "--task-id",
                    "task_list_output",
                    "--download",
                    "--output-dir",
                    str(root / "image"),
                ],
                root / "unused.json",
            )
            self.assertEqual(array_output.returncode, 1)
            self.assertIn("single URL", array_output.stderr)

    def test_z_authorization_is_present_on_local_api_and_assets(self) -> None:
        self.assertTrue(self.server.state.requests)
        self.assertTrue(
            all(auth == "Bearer test-key" for _, _, auth in self.server.state.requests)
        )


if __name__ == "__main__":
    unittest.main()
