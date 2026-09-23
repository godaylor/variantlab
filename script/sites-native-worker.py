"""D1 lease / R2 transport for VariantLab's existing Rust/native renderer.

Only stdlib; no listening port, database credentials, local public tunnel or Redis.
Never logs original names, signed URLs, request payloads or credentials.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ORIGIN = os.environ["VARIANTLAB_SITES_ORIGIN"].rstrip("/")
SECRET = os.environ["RENDER_WORKER_SECRET"]
parsed = urllib.parse.urlparse(ORIGIN)
if parsed.scheme != "https" and not (parsed.scheme == "http" and (parsed.hostname in ("127.0.0.1", "localhost") or (os.environ.get("VARIANTLAB_NATIVE_TEST") == "1" and parsed.hostname == "host.docker.internal"))):
    raise ValueError("HTTPS site origin required")
if parsed.path not in ("", "/") or parsed.username or len(SECRET) < 32:
    raise ValueError("Invalid worker configuration")
MAX_BYTES = 1024 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError("worker_redirect_denied")


opener = urllib.request.build_opener(NoRedirect)


def request(path, job=None, data=None, method="POST", raw=None):
    headers = {"Authorization": "Bearer " + SECRET, "User-Agent": "VariantLab-Native-Worker/1.0"}
    if job:
        headers.update({"x-render-owner": job["owner"], "x-render-claim": job["claim_token"]})
    payload = None
    if raw is not None:
        payload = raw
        headers.update({"content-type": "application/octet-stream", "x-content-sha256": hashlib.sha256(raw).hexdigest()})
    elif data is not None:
        payload = json.dumps(data).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(ORIGIN + "/api/variantlab/worker/" + path, data=payload, headers=headers, method=method)
    return opener.open(req, timeout=25)


def api(path, job=None, data=None, **kwargs):
    with request(path, job, {} if data is None else data, **kwargs) as response:
        value = response.read(2 * 1024 * 1024 + 1)
        if len(value) > 2 * 1024 * 1024:
            raise ValueError("response_limit")
        return json.loads(value)


def heartbeat(job, phase, progress):
    value = api(job["id"] + "/heartbeat", job, {"phase": phase, "progress_milli": progress})
    if value["cancelled"]:
        raise ValueError("job_cancelled")


def execute(job):
    # TemporaryDirectory owns just this attempt; originals are never deleted.
    with tempfile.TemporaryDirectory(prefix="variantlab-render-") as temporary:
        root = Path(temporary)
        (root / "manifest.json").write_text(json.dumps(job["manifest"]), encoding="utf-8")
        environment = {"PATH": "/opt/ffmpeg/bin:/usr/local/bin:/usr/bin:/bin", "VARIANTLAB_RENDER_DIR": temporary, "VARIANTLAB_MODE": "render-plan-file"}
        plan = subprocess.run(["variantlab-connected"], env=environment, check=True, capture_output=True, timeout=30)
        plan = json.loads(plan.stdout)
        assets = plan["assets"]
        total = 0
        for asset in assets:
            if len(asset) != 64 or any(c not in "0123456789abcdef" for c in asset):
                raise ValueError("asset_hash_invalid")
            heartbeat(job, "preparing", 100)
            digest = hashlib.sha256()
            last_beat = time.monotonic()
            with request(job["id"] + "/original/" + asset, job, method="GET") as response, (root / asset).open("wb") as output:
                while chunk := response.read(65536):
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise ValueError("native_input_budget_exceeded")
                    digest.update(chunk)
                    output.write(chunk)
                    if time.monotonic() - last_beat > 10:
                        heartbeat(job, "preparing", 150)
                        last_beat = time.monotonic()
            if digest.hexdigest() != asset:
                raise ValueError("source_checksum_mismatch")
        heartbeat(job, "rendering", 300)
        environment["VARIANTLAB_MODE"] = "render-file"
        process = subprocess.Popen(["variantlab-connected"], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            deadline = time.monotonic() + 1830
            while process.poll() is None:
                if time.monotonic() > deadline:
                    raise ValueError("render_timeout")
                time.sleep(2)
                heartbeat(job, "rendering", 500)
            if process.returncode != 0:
                raise ValueError("native_render_failed")
        finally:
            if process.poll() is None:
                (root / "cancel").touch()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    import signal
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        output = root / "output.webm"
        length = output.stat().st_size
        if not 0 < length <= MAX_BYTES:
            raise ValueError("artifact_limits")
        heartbeat(job, "verifying", 820)
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", str(output)], env={"PATH": environment["PATH"]}, check=True, capture_output=True, timeout=30)
        streams = json.loads(probe.stdout)["streams"]
        if len(streams) != 1 or streams[0].get("codec_name") != "vp9" or streams[0].get("width") != plan["width"] or streams[0].get("height") != plan["height"]:
            raise ValueError("artifact_probe_mismatch")
        digest = hashlib.sha256()
        with output.open("rb") as stream:
            if stream.read(4) != bytes.fromhex("1a45dfa3"):
                raise ValueError("artifact_type")
            stream.seek(0)
            while chunk := stream.read(65536):
                digest.update(chunk)
        session = api(job["id"] + "/artifact", job, {"sha256": digest.hexdigest(), "byte_length": length})
        part_size = session["part_size_bytes"]
        if part_size != 8 * 1024 * 1024:
            raise ValueError("upload_contract")
        with output.open("rb") as stream:
            number = 1
            while chunk := stream.read(part_size):
                heartbeat(job, "persisting", 900)
                api(job["id"] + "/parts/" + str(number), job, method="PUT", raw=chunk)
                number += 1
        heartbeat(job, "persisting", 950)
        receipt = api(job["id"] + "/complete", job)
        if not receipt["committed"] or receipt["sha256"] != digest.hexdigest():
            raise ValueError("artifact_receipt_mismatch")


def main():
    while True:
        job = None
        try:
            job = api("claim")["job"]
            if job:
                execute(job)
                print("Render artifact committed", flush=True)
            elif os.environ.get("VARIANTLAB_WORKER_ONCE") == "1":
                return
            else:
                time.sleep(5)
        except Exception:
            if job:
                try:
                    api(job["id"] + "/fail", job)
                except Exception:
                    pass  # Lost leases are recovered durably by the next claim.
            print("Render worker will retry; provider details withheld", flush=True)
            if os.environ.get("VARIANTLAB_WORKER_ONCE") == "1":
                raise SystemExit(1)
            time.sleep(5)
        if job and os.environ.get("VARIANTLAB_WORKER_ONCE") == "1":
            return


if __name__ == "__main__":
    main()
