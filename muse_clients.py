"""Client for Muse Wonder, Muse Spark (Meta + Baseten) and a six-judge UI council.

Secrets are read at runtime from C:\\Users\\prabo\\.research-companion\\.env or a
git-ignored .env next to this file. Keys are never logged or put in errors.
"""
import base64
import json
import mimetypes
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx

HERE = pathlib.Path(__file__).resolve().parent
SHARED_ENV = pathlib.Path.home() / ".research-companion" / ".env"
DEFAULT_MODAL_CLI = r"C:\Users\prabo\CS_projects\Meta_AI_Hackathon\.claude\council\modal-venv\Scripts\modal.exe"


def _load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv(HERE / ".env")
_load_dotenv(SHARED_ENV)

BASETEN_URL = "https://inference.baseten.co/v1/chat/completions"
WONDER_MODEL = "muse-wonder-1.0"
SPARK_MODEL = "muse-spark-1.3"
SPARK_BASETEN_MODEL = "meta-models/muse-spark-open-1026"
RETRY_STATUS = (429, 500, 502, 503, 504)

MODAL_JUDGES = {
    "Kimi K3": ("https://prabodh12341--ep-ui-council-kimi-server.us-west.modal.direct", "moonshotai/Kimi-K3"),
    "Qwen3.8-Max VL Thinking": ("https://prabodh12341--ep-ui-council-qwen-server.us-west.modal.direct", "Qwen/Qwen3.8-Max-VL-Thinking"),
    "GLM 5.3 Flash": ("https://prabodh12341--ep-ui-council-glm-server.us-west.modal.direct", "zai-org/GLM-5.3-Flash"),
    "DeepSeek V4.1 Flash": ("https://prabodh12341--ep-ui-council-deepseek-server.us-west.modal.direct", "deepseek-ai/DeepSeek-V4.1-Flash"),
}


class MetaAuthError(RuntimeError):
    """Meta API returned 401 (key expired). Stop and tell the user."""


def _env(name):
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"missing environment variable {name}")
    return v


def _meta_base():
    return os.environ.get("MUSE_API_BASE", "https://api.meta.ai/v1").rstrip("/")


def _meta_headers():
    return {"Authorization": f"Bearer {_env('MUSE_API_KEY')}"}


class _Resp:
    def __init__(self, status, text):
        self.status_code, self.text = status, text

    def json(self):
        return json.loads(self.text)


def _modal_cli():
    cli = os.environ.get("MODAL_CLI") or DEFAULT_MODAL_CLI
    return cli if pathlib.Path(cli).exists() else shutil.which("modal")


def _post(url, payload, headers, timeout, use_modal_curl=False):
    if not use_modal_curl:
        r = httpx.post(url, json=payload, headers=headers, timeout=timeout)
        return _Resp(r.status_code, r.text)
    cli = _modal_cli()
    if not cli:
        raise RuntimeError("Modal judge needs MODAL_PROXY_KEY/SECRET or the Modal CLI (set MODAL_CLI)")
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(payload, f)
    try:
        p = subprocess.run(
            [cli, "curl", "-s", "-X", "POST", url,
             "-H", "Content-Type: application/json",
             "-H", f"Modal-Routing-Affinity-Key: {uuid.uuid4()}",
             "--max-time", str(int(timeout)), "--data-binary", f"@{f.name}",
             "-w", "\n%{http_code}"],
            capture_output=True, text=True, encoding="utf-8", timeout=timeout + 60)
    finally:
        pathlib.Path(f.name).unlink(missing_ok=True)
    body, _, code = p.stdout.rstrip().rpartition("\n")
    if not code.isdigit():
        raise RuntimeError(f"modal curl failed: {(p.stderr or p.stdout)[-300:]}")
    return _Resp(int(code), body)


def _chat(url, payload, headers, timeout, label, retries=4, meta=False, use_modal_curl=False):
    """POST with retry on 429/5xx; adapts to 400s about reasoning_effort/response_format."""
    payload = dict(payload)
    last = None
    for i in range(retries + 3):
        try:
            r = _post(url, payload, headers, timeout, use_modal_curl)
        except (httpx.HTTPError, subprocess.TimeoutExpired) as e:
            last = type(e).__name__
            time.sleep(min(10 * (i + 1), 60))
            continue
        if meta and r.status_code == 401:
            raise MetaAuthError(f"{label}: HTTP 401 - Meta API key rejected/expired")
        if r.status_code in (400, 422):
            if "reasoning_effort" in r.text and "reasoning_effort" in payload:
                if payload["reasoning_effort"] != "high":
                    payload["reasoning_effort"] = "high"
                else:
                    payload.pop("reasoning_effort")
                continue
            if "response_format" in r.text and "response_format" in payload:
                payload.pop("response_format")
                continue
        if r.status_code in RETRY_STATUS:
            last = f"HTTP {r.status_code}"
            time.sleep(min(10 * (i + 1), 60))
            continue
        if r.status_code != 200:
            raise RuntimeError(f"{label}: HTTP {r.status_code} {r.text[:300]}")
        return r.json()["choices"][0]["message"].get("content") or ""
    raise RuntimeError(f"{label}: gave up after retries ({last})")


def image_part(path):
    """Content part for a screenshot/image file."""
    mime = mimetypes.guess_type(str(path))[0] or "image/png"
    b64 = base64.b64encode(pathlib.Path(path).read_bytes()).decode("ascii")
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}


def muse_wonder(messages, effort="xhigh", max_tokens=64000, timeout=40 * 60):
    """Muse Wonder 1.0 (Meta API). effort: minimal|low|medium|high|xhigh."""
    payload = {"model": WONDER_MODEL, "messages": messages,
               "max_completion_tokens": max_tokens, "reasoning_effort": effort}
    return _chat(f"{_meta_base()}/chat/completions", payload, _meta_headers(), timeout, "muse-wonder", meta=True)


def muse_spark(messages, max_tokens=4000, timeout=600):
    """Muse Spark 1.3 (Meta API)."""
    payload = {"model": SPARK_MODEL, "messages": messages,
               "max_completion_tokens": max_tokens, "reasoning_effort": "high"}
    return _chat(f"{_meta_base()}/chat/completions", payload, _meta_headers(), timeout, "Muse Spark 1.3", meta=True)


def muse_spark_baseten(messages, max_tokens=4000, timeout=600):
    """Muse Spark open model on Baseten. Auth scheme is 'Api-Key'."""
    payload = {"model": SPARK_BASETEN_MODEL, "messages": messages,
               "max_completion_tokens": max(max_tokens, 1000)}
    headers = {"Authorization": f"Api-Key {_env('BASETEN_API_KEY')}"}
    return _chat(BASETEN_URL, payload, headers, timeout, "Muse Spark (Baseten)")


def _modal_judge(name, messages, max_tokens, timeout):
    base, model = MODAL_JUDGES[name]
    url = base.rstrip("/") + "/v1/chat/completions"
    key, secret = os.environ.get("MODAL_PROXY_KEY"), os.environ.get("MODAL_PROXY_SECRET")
    proxy = bool(key and secret)
    headers = {"Modal-Key": key, "Modal-Secret": secret,
               "Modal-Routing-Affinity-Key": str(uuid.uuid4())} if proxy else {}
    payload = {"model": model, "messages": messages, "max_tokens": max_tokens, "reasoning_effort": "high"}
    return _chat(url, payload, headers, timeout, name, use_modal_curl=not proxy)


def council(messages, max_tokens=12000, timeout=900):
    """Run the six judges in parallel. Returns {judge: text or 'ERROR: ...'}."""
    jobs = {n: (lambda n=n: _modal_judge(n, messages, max_tokens, timeout)) for n in MODAL_JUDGES}
    jobs["Muse Spark 1.3 (Meta)"] = lambda: muse_spark(messages, max_tokens, timeout)
    jobs["Muse Spark (Baseten)"] = lambda: muse_spark_baseten(messages, max_tokens, timeout)
    results = {}
    with ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        futures = {n: ex.submit(fn) for n, fn in jobs.items()}
        for n, fut in futures.items():
            try:
                results[n] = fut.result()
            except Exception as e:
                results[n] = f"ERROR: {e}"
    return results
