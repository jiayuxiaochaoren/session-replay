import inspect
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from fastapi import APIRouter, HTTPException, Request as FastAPIRequest
from pydantic import BaseModel, Field

_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from parser import export_replay_html, parse_messages_to_replay

router = APIRouter(tags=["session-replay"])
DEFAULT_UPSTREAM_BASE_URL = "http://127.0.0.1:9119"


class ReplayParseRequest(BaseModel):
    session_id: str = Field(default="adhoc-session")
    messages: list[dict] = Field(default_factory=list)
    replay: dict | None = None


def _resolve_authorization(request: FastAPIRequest = None) -> str | None:
    if request is None:
        return None
    return request.headers.get("authorization")



def _resolve_upstream_base_url(request: FastAPIRequest = None) -> str:
    configured = os.environ.get("HERMES_DASHBOARD_BASE_URL")
    if configured:
        return configured.rstrip("/")
    if request is not None and request.base_url:
        return str(request.base_url).rstrip("/")
    return DEFAULT_UPSTREAM_BASE_URL


def _fetch_json(path: str, authorization: str | None = None, request: FastAPIRequest = None):
    upstream_base_url = _resolve_upstream_base_url(request)
    url = f"{upstream_base_url}{path}"
    headers = {"Accept": "application/json"}
    if authorization:
        headers["Authorization"] = authorization
    request_obj = Request(url, headers=headers)
    try:
        with urlopen(request_obj, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = f"Upstream request failed: {path}"
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            if isinstance(payload, dict) and payload.get("detail"):
                detail = f"{detail} ({payload['detail']})"
        except Exception:
            pass
        raise HTTPException(status_code=exc.code, detail=detail) from exc
    except URLError as exc:
        raise HTTPException(status_code=502, detail=f"Cannot reach Hermes Dashboard upstream: {url}") from exc


def _fetch_json_with_optional_auth(path: str, request: FastAPIRequest = None):
    authorization = _resolve_authorization(request)
    kwargs = {}
    if authorization:
        kwargs["authorization"] = authorization
    if request is not None:
        signature = inspect.signature(_fetch_json)
        if "request" in signature.parameters:
            kwargs["request"] = request
    return _fetch_json(path, **kwargs)


@router.get("/health")
def health(request: FastAPIRequest = None) -> dict:
        return {"ok": True, "plugin": "session-replay", "upstream": _resolve_upstream_base_url(request)}


def _session_sort_key(session: dict) -> tuple:
    session_id = str(session.get("session_id") or session.get("id") or "")
    title = str(session.get("title") or session.get("name") or "")
    is_demo = session_id == "demo-session" or title.strip().lower() == "demo session"
    started_at = session.get("last_active") or session.get("started_at") or 0
    return (1 if is_demo else 0, -(started_at or 0), title.lower(), session_id)


@router.get("/sessions")
def list_sessions(request: FastAPIRequest = None) -> dict:
    payload = _fetch_json_with_optional_auth("/api/sessions", request)
    sessions = payload.get("sessions") if isinstance(payload, dict) else payload
    if isinstance(payload, dict) and sessions is None:
        sessions = payload.get("items") or payload.get("data")
    normalized_sessions = list(sessions or [])
    normalized_sessions.sort(key=_session_sort_key)
    return {
        "sessions": normalized_sessions,
        "source": "/api/sessions",
        "upstream": payload if isinstance(payload, dict) else None,
    }


@router.get("/sessions/{session_id:path}/messages")
def get_session_messages(session_id: str, request: FastAPIRequest = None) -> dict:
    quoted_session_id = quote(session_id, safe="")
    payload = _fetch_json_with_optional_auth(
        f"/api/sessions/{quoted_session_id}/messages",
        request,
    )
    messages = payload.get("messages") if isinstance(payload, dict) else payload
    resolved_session_id = payload.get("session_id", session_id) if isinstance(payload, dict) else session_id
    return {"session_id": resolved_session_id, "messages": messages or []}


@router.get("/sessions/{session_id:path}/replay")
def get_session_replay(session_id: str, request: FastAPIRequest = None) -> dict:
    payload = get_session_messages(session_id, request)
    replay_session_id = payload.get("session_id") or session_id
    return parse_messages_to_replay(payload["messages"], session_id=replay_session_id)


@router.post("/replay/parse")
def replay_parse(payload: ReplayParseRequest) -> dict:
    return parse_messages_to_replay(payload.messages, session_id=payload.session_id)


@router.post("/replay/export/html")
def replay_export_html(payload: ReplayParseRequest) -> dict:
    replay = payload.replay or parse_messages_to_replay(payload.messages, session_id=payload.session_id)
    return {"session_id": payload.session_id, "html": export_replay_html(replay)}
