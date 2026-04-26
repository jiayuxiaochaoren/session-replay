import html
import json
from datetime import datetime
from typing import Any


FILE_MUTATION_TOOLS = {"patch", "write_file", "edit_file", "apply_patch"}
FILE_RESULT_KEYS = {"path", "file", "filepath", "file_path"}


def _normalize_id(value: Any, fallback: str) -> str:
    if value is None or value == "":
        return fallback
    return str(value)


def _parse_timestamp(value: str | float | int | None) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value)
        except (OverflowError, OSError, ValueError):
            return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def _duration_ms(start: str | float | int | None, end: str | float | int | None) -> int | None:
    start_dt = _parse_timestamp(start)
    end_dt = _parse_timestamp(end)
    if not start_dt or not end_dt:
        return None
    return int((end_dt - start_dt).total_seconds() * 1000)


def _safe_json_loads(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text:
        return value
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return value


def _stringify_content(value: Any) -> str:
    parsed = _safe_json_loads(value)
    if isinstance(parsed, dict):
        if isinstance(parsed.get("error"), str):
            return parsed["error"]
        if isinstance(parsed.get("message"), str):
            return parsed["message"]
        if isinstance(parsed.get("status"), str):
            return f"status={parsed['status']}"
        return json.dumps(parsed, ensure_ascii=False)
    if isinstance(parsed, list):
        return json.dumps(parsed, ensure_ascii=False)
    return str(parsed)


def _tool_name(call: dict[str, Any]) -> str:
    function = call.get("function") or {}
    return function.get("name") or call.get("name") or "unknown_tool"


def _tool_args(call: dict[str, Any]) -> Any:
    function = call.get("function") or {}
    return _safe_json_loads(function.get("arguments") or call.get("arguments") or {})


def _detect_retry(text: str) -> bool:
    lowered = text.lower()
    return "retry" in lowered or "retrying" in lowered or "try again" in lowered


def _detect_error_content(content: Any) -> bool:
    parsed = _safe_json_loads(content)
    if isinstance(parsed, dict):
        if parsed.get("error"):
            return True
        status = str(parsed.get("status", "")).lower()
        if status in {"error", "failed", "failure"}:
            return True
    text = _stringify_content(content).lower()
    return "error" in text or "failed" in text or "traceback" in text


def _assistant_summary(content: Any) -> str:
    text = _stringify_content(content).strip()
    if len(text) <= 140:
        return text
    return text[:137] + "..."


def _count_lines(value: str) -> int:
    if not value:
        return 0
    return len(value.splitlines()) or 1


def _tool_path(args: Any, fallback: str = "target") -> str:
    if not isinstance(args, dict):
        return fallback
    path = args.get("path")
    if isinstance(path, str) and path:
        return path
    return fallback


def _tool_pattern(args: Any) -> str | None:
    if not isinstance(args, dict):
        return None
    pattern = args.get("pattern")
    if isinstance(pattern, str) and pattern:
        return pattern
    return None


def _tool_call_reason(tool_name: str, args: Any) -> str:
    if tool_name == "search_files":
        return "The agent decided to inspect repository structure before changing files."
    if tool_name == "read_file":
        target = _find_file_path({}, args) or "the target file"
        return f"The agent needed the current contents of {target} before making the next decision."
    if tool_name in FILE_MUTATION_TOOLS:
        target = _find_file_path({}, args) or "the target file"
        return f"The agent was ready to change {target} to move the task forward."
    if tool_name == "terminal":
        return "The agent needed a live command result to verify the next step."
    return f"The agent decided to use {tool_name or 'a tool'} to move the mission forward."


def _humanize_tool_call(tool_name: str, args: Any) -> str:
    if tool_name == "search_files":
        target = _tool_path(args, ".")
        pattern = _tool_pattern(args)
        if pattern:
            return f"Searching {target} for {pattern}"
        return f"Searching {target}"
    if tool_name == "read_file":
        target = _find_file_path({}, args) or "target file"
        return f"Reading {target}"
    if tool_name in FILE_MUTATION_TOOLS:
        target = _find_file_path({}, args) or "target file"
        return f"Updating {target}"
    if tool_name == "terminal":
        return "Running command in terminal"
    if tool_name == "browser_navigate":
        return "Opening target page"
    if tool_name == "browser_click":
        return "Interacting with page controls"
    if tool_name == "browser_type":
        return "Typing into page input"
    return f"Calling {tool_name}"


def _humanize_tool_result(tool_name: str | None, parsed_result: Any, is_error: bool, args: Any | None = None) -> str:
    if is_error:
        if tool_name == "patch":
            return f"Patch failed: {_stringify_content(parsed_result)}"
        if tool_name:
            return f"{tool_name} failed: {_stringify_content(parsed_result)}"
        return _stringify_content(parsed_result)

    if tool_name == "search_files":
        target = _tool_path(args, ".")
        if isinstance(parsed_result, dict):
            files = parsed_result.get("files")
            if isinstance(files, list) and files:
                first = str(files[0])
                return f"Found {len(files)} files under {target}, including {first}"
        return f"Repository scan completed under {target}"
    if tool_name == "read_file":
        target = _find_file_path(parsed_result, args) or "target file"
        if isinstance(parsed_result, dict):
            content = parsed_result.get("content")
            if isinstance(content, str) and content:
                return f"Read {_count_lines(content)} lines from {target}"
        return f"File contents loaded from {target}"
    if tool_name in FILE_MUTATION_TOOLS:
        return "File update applied successfully"
    if tool_name == "terminal":
        return "Command finished successfully"
    if isinstance(parsed_result, dict) and isinstance(parsed_result.get("status"), str):
        return f"Completed with status={parsed_result['status']}"
    if tool_name:
        return f"{tool_name} completed successfully"
    return _stringify_content(parsed_result)


def _build_stage_copy(event: dict[str, Any]) -> dict[str, str]:
    event_type = event.get("type")
    title = event.get("title") or "Step"
    summary = event.get("summary") or ""
    tool_name = event.get("tool_name") or ""
    file_path = event.get("file_path") or ""

    if event_type == "user_message":
        return {
            "kicker": "Mission Input",
            "headline": title,
            "why": "This mission starts from the user goal that the agent is trying to satisfy.",
            "action": "User submitted the objective.",
            "observation": summary,
            "result": "Mission context captured.",
        }
    if event_type == "agent_intent":
        return {
            "kicker": "Agent Intent",
            "headline": title,
            "why": summary,
            "action": "The agent committed to the next move.",
            "observation": "This message frames the upcoming tool activity.",
            "result": "The next execution step is now clear.",
        }
    if event_type == "tool_call":
        args = event.get("args")
        return {
            "kicker": "Action",
            "headline": title,
            "why": _tool_call_reason(tool_name, args),
            "action": summary,
            "observation": "Waiting for tool output.",
            "result": "Execution is in progress.",
        }
    if event_type == "tool_result":
        return {
            "kicker": "Observation",
            "headline": title,
            "why": f"This is the observed output from {tool_name or 'the tool'}.",
            "action": f"Tool output received from {tool_name or 'tool'}.",
            "observation": summary,
            "result": "The agent learned enough to continue with the next file operation." if tool_name in {"search_files", "read_file"} else "The agent can continue with grounded evidence.",
        }
    if event_type == "file_change":
        return {
            "kicker": "File Change",
            "headline": title,
            "why": "The mission required a concrete artifact update.",
            "action": f"Modified {file_path or 'target file'}.",
            "observation": summary,
            "result": "Project state has changed.",
        }
    if event_type == "error":
        return {
            "kicker": "Failure",
            "headline": title,
            "why": f"The previous {tool_name or 'tool'} step did not complete successfully.",
            "action": "Execution produced an error state.",
            "observation": summary,
            "result": "Recovery or retry is needed.",
        }
    if event_type == "retry":
        return {
            "kicker": "Recovery",
            "headline": title,
            "why": "The agent detected a failure and is adapting the plan.",
            "action": summary,
            "observation": "A retry path has been initiated.",
            "result": "The mission continues instead of stopping.",
        }
    if event_type == "final_answer":
        return {
            "kicker": "Final Answer",
            "headline": title,
            "why": "The mission has reached its terminal output.",
            "action": "The agent delivered the final response.",
            "observation": summary,
            "result": "Mission replay is complete.",
        }
    return {
        "kicker": "Replay Step",
        "headline": title,
        "why": summary,
        "action": summary,
        "observation": summary,
        "result": summary,
    }


def _is_final_assistant(index: int, messages: list[dict[str, Any]]) -> bool:
    current = messages[index]
    if current.get("role") != "assistant":
        return False
    for later in messages[index + 1 :]:
        if later.get("role") == "assistant":
            return False
    return True


def _find_file_path(parsed_result: Any, args: Any) -> str | None:
    if isinstance(parsed_result, dict):
        for key in FILE_RESULT_KEYS:
            value = parsed_result.get(key)
            if isinstance(value, str) and value:
                return value
    if isinstance(args, dict):
        for key in FILE_RESULT_KEYS:
            value = args.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _build_file_change_event(msg: dict[str, Any], pending: dict[str, Any], parsed_result: Any, duration_ms: int | None) -> dict[str, Any] | None:
    tool_name = _tool_name(pending.get("call", {})) if pending else None
    args = _tool_args(pending.get("call", {})) if pending else None
    file_path = _find_file_path(parsed_result, args)
    if tool_name not in FILE_MUTATION_TOOLS or not file_path:
        return None
    diff = None
    if isinstance(parsed_result, dict):
        for key in ("diff", "patch", "changes"):
            if isinstance(parsed_result.get(key), str):
                diff = parsed_result.get(key)
                break
    return {
        "id": f"{_normalize_id(msg.get('id'), 'file-change')}-file",
        "timestamp": msg.get("timestamp"),
        "type": "file_change",
        "title": "File Change",
        "summary": f"Updated {file_path}",
        "status": "success",
        "tool_call_id": _normalize_id(msg.get("tool_call_id"), "unknown-tool-call"),
        "tool_name": tool_name,
        "file_path": file_path,
        "diff": diff,
        "duration_ms": duration_ms,
        "raw": parsed_result,
    }


def _find_main_bottleneck(events: list[dict[str, Any]]) -> str | None:
    results = [event for event in events if event.get("type") in {"tool_result", "error", "file_change"} and event.get("duration_ms") is not None]
    if not results:
        return None
    slowest = max(results, key=lambda event: event.get("duration_ms") or 0)
    tool_name = slowest.get("tool_name") or slowest.get("title") or "unknown_tool"
    seconds = (slowest.get("duration_ms") or 0) / 1000
    return f"{tool_name} took {seconds:.1f}s"


def _mission_label(status: str, errors: int, retries: int, files_changed: int) -> str:
    if status == "completed_with_retries":
        return "Completed with recoveries"
    if errors:
        return "Completed with visible issues"
    if files_changed:
        return "Completed cleanly"
    if retries:
        return "Completed after retries"
    return "Completed cleanly"


def _build_graph(events: list[dict[str, Any]]) -> dict[str, Any]:
    nodes = []
    edges = []
    previous_id = None
    last_tool_call_id = None

    for index, event in enumerate(events):
        event_id = event.get("id") or f"event-{index}"
        event_type = event.get("type")
        lane = "flow"
        if event_type in {"user_message", "agent_intent", "final_answer"}:
            lane = "narrative"
        elif event_type in {"retry", "error"}:
            lane = "recovery"
        elif event_type in {"tool_call", "tool_result", "file_change"}:
            lane = "tools"

        node = {
            "id": event_id,
            "label": event.get("title") or event_type or f"Step {index + 1}",
            "type": event_type,
            "status": event.get("status"),
            "lane": lane,
            "summary": event.get("summary"),
        }
        nodes.append(node)

        if previous_id is not None:
            edges.append(
                {
                    "id": f"edge-{previous_id}-{event_id}",
                    "source": previous_id,
                    "target": event_id,
                    "kind": "flow",
                }
            )

        if event_type == "tool_call":
            last_tool_call_id = event_id
        elif event_type in {"tool_result", "error", "file_change"} and event.get("tool_call_id"):
            source_id = event.get("tool_call_id") or last_tool_call_id
            if source_id:
                edges.append(
                    {
                        "id": f"edge-tool-{source_id}-{event_id}",
                        "source": source_id,
                        "target": event_id,
                        "kind": "tool_chain",
                    }
                )
        elif event_type == "retry" and previous_id is not None:
            edges.append(
                {
                    "id": f"edge-recovery-{previous_id}-{event_id}",
                    "source": previous_id,
                    "target": event_id,
                    "kind": "recovery",
                }
            )

        previous_id = event_id
    return {"nodes": nodes, "edges": edges}


def parse_messages_to_replay(messages: list[dict[str, Any]], session_id: str | None = None) -> dict[str, Any]:
    events: list[dict[str, Any]] = []
    pending_calls: dict[str, dict[str, Any]] = {}
    retries = 0
    errors = 0
    tool_calls = 0
    files_changed = 0
    first_ts = messages[0].get("timestamp") if messages else None
    last_ts = messages[-1].get("timestamp") if messages else None

    for index, msg in enumerate(messages):
        role = msg.get("role")
        timestamp = msg.get("timestamp")
        content = msg.get("content")

        if role == "user":
            event = {
                "id": _normalize_id(msg.get("id"), f"user-{index}"),
                "timestamp": timestamp,
                "type": "user_message",
                "title": "User Request",
                "summary": _stringify_content(content),
                "status": "success",
                "token_count": msg.get("token_count"),
                "raw": msg,
            }
            event["stage"] = _build_stage_copy(event)
            events.append(event)
            continue

        if role == "assistant":
            text = _stringify_content(content)
            assistant_event_id = _normalize_id(msg.get("id"), f"assistant-{index}")
            if _detect_retry(text):
                retries += 1
                retry_event = {
                    "id": f"{assistant_event_id}-retry",
                    "timestamp": timestamp,
                    "type": "retry",
                    "title": "Retry",
                    "summary": _assistant_summary(text),
                    "status": "retrying",
                    "raw": msg,
                }
                retry_event["stage"] = _build_stage_copy(retry_event)
                events.append(retry_event)
            event_type = "final_answer" if _is_final_assistant(index, messages) else "agent_intent"
            title = "Final Answer" if event_type == "final_answer" else "Agent Intent"
            event = {
                "id": assistant_event_id,
                "timestamp": timestamp,
                "type": event_type,
                "title": title,
                "summary": _assistant_summary(text),
                "status": "success",
                "token_count": msg.get("token_count"),
                "raw": msg,
            }
            event["stage"] = _build_stage_copy(event)
            events.append(event)
            for call in msg.get("tool_calls") or []:
                call_id = _normalize_id(call.get("id"), f"tool-call-{index}-{tool_calls}")
                tool_calls += 1
                pending_calls[call_id] = {"call": call, "timestamp": timestamp}
                tool_name = _tool_name(call)
                args = _tool_args(call)
                event = {
                    "id": call_id,
                    "timestamp": timestamp,
                    "type": "tool_call",
                    "title": tool_name,
                    "summary": _humanize_tool_call(tool_name, args),
                    "status": "running",
                    "tool_call_id": call_id,
                    "tool_name": tool_name,
                    "args": args,
                    "token_count": msg.get("token_count"),
                    "raw": call,
                }
                event["stage"] = _build_stage_copy(event)
                events.append(event)
            continue

        if role == "tool":
            call_id = _normalize_id(msg.get("tool_call_id"), f"tool-call-missing-{index}")
            pending = pending_calls.get(call_id, {})
            parsed_result = _safe_json_loads(content)
            is_error = _detect_error_content(content)
            duration_ms = _duration_ms(pending.get("timestamp"), timestamp)
            tool_name = _tool_name(pending.get("call", {})) if pending else None
            event = {
                "id": _normalize_id(msg.get("id"), f"tool-result-{index}"),
                "timestamp": timestamp,
                "type": "error" if is_error else "tool_result",
                "title": "Tool Error" if is_error else "Tool Observation",
                "summary": _humanize_tool_result(tool_name, parsed_result, is_error, _tool_args(pending.get("call", {})) if pending else None),
                "status": "failed" if is_error else "success",
                "tool_call_id": call_id,
                "tool_name": tool_name,
                "duration_ms": duration_ms,
                "token_count": msg.get("token_count"),
                "raw": parsed_result,
            }
            if is_error:
                errors += 1
            event["stage"] = _build_stage_copy(event)
            events.append(event)
            file_change_event = _build_file_change_event(msg, pending, parsed_result, duration_ms)
            if file_change_event:
                file_change_event["stage"] = _build_stage_copy(file_change_event)
                files_changed += 1
                events.append(file_change_event)
            continue

    duration_ms = _duration_ms(first_ts, last_ts) or 0
    status = "completed"
    if errors and retries:
        status = "completed_with_retries"
    elif errors:
        status = "completed_with_errors"

    mission_label = _mission_label(status, errors, retries, files_changed)
    summary = {
        "status": status,
        "mission_label": mission_label,
        "total_steps": len(events),
        "tool_calls": tool_calls,
        "errors": errors,
        "retries": retries,
        "files_changed": files_changed,
        "duration_ms": duration_ms,
        "duration_label": f"{duration_ms / 1000:.1f}s",
        "main_bottleneck": _find_main_bottleneck(events),
        "current_step_index": len(events) if events else 0,
        "completion_ratio": 1 if events else 0,
        "mission_title": events[0].get("summary") if events else mission_label,
    }

    return {
        "session_id": session_id or "unknown-session",
        "events": events,
        "summary": summary,
        "graph": _build_graph(events),
    }


def export_replay_html(replay: dict[str, Any]) -> str:
    summary = replay.get("summary", {})
    graph = replay.get("graph", {})
    events = replay.get("events", [])
    selected = events[0] if events else {}
    stage = selected.get("stage", {}) if isinstance(selected, dict) else {}

    items = []
    file_changes = []
    for index, event in enumerate(events):
        items.append(
            "<li class='event status-%s'><div class='step-index'>Step %s</div><div class='meta'>%s · %s</div><div class='title'>%s</div><div class='summary'>%s</div></li>"
            % (
                html.escape(str(event.get("status") or "unknown")),
                index + 1,
                html.escape(str(event.get("timestamp") or "")),
                html.escape(str(event.get("type") or "")),
                html.escape(str(event.get("title") or "")),
                html.escape(str(event.get("summary") or "")),
            )
        )
        if event.get("type") == "file_change":
            file_changes.append(
                "<li><strong>%s</strong><pre>%s</pre></li>"
                % (
                    html.escape(str(event.get("file_path") or "unknown file")),
                    html.escape(str(event.get("diff") or "No diff available")),
                )
            )
    graph_nodes = []
    for node in graph.get("nodes", []):
        graph_nodes.append(
            "<div class='graph-node status-%s'><div class='graph-type'>%s</div><div class='graph-label'>%s</div></div>"
            % (
                html.escape(str(node.get("status") or "unknown")),
                html.escape(str(node.get("type") or "step")),
                html.escape(str(node.get("label") or "Untitled")),
            )
        )
    return f"""<!doctype html>
<html>
<head>
  <meta charset='utf-8' />
  <title>Session Replay {html.escape(str(replay.get('session_id', '')))}</title>
  <style>
    body {{ background:#09111f; color:#e6eef8; font-family:Inter,Arial,sans-serif; margin:0; padding:24px; }}
    .hero {{ display:grid; grid-template-columns: 1.2fr .8fr; gap:24px; margin-bottom:24px; }}
    .layout {{ display:grid; grid-template-columns: 340px 1fr; gap:24px; margin-bottom:24px; }}
    .panel {{ background:#101a2f; border:1px solid #22304d; border-radius:16px; padding:16px; box-shadow:0 0 30px rgba(0,0,0,.18); }}
    .timeline {{ list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:12px; }}
    .event {{ padding:12px; border-radius:12px; background:#0d1528; border-left:4px solid #5ab2ff; }}
    .replay-stage {{ background:linear-gradient(180deg, rgba(17, 28, 52, 0.96) 0%, rgba(11, 20, 38, 0.96) 100%); border:1px solid #22304d; border-radius:18px; padding:18px; box-shadow: inset 0 0 42px rgba(99, 179, 255, 0.08); }}
    .graph {{ display:flex; flex-wrap:wrap; gap:10px; }}
    .graph-node {{ min-width:140px; padding:10px 12px; border-radius:12px; background:#0d1528; border:1px solid #20304c; }}
    .graph-type,.summary-label,.stage-label,.step-index {{ font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#90a2bf; margin-bottom:4px; }}
    .graph-label,.summary-value {{ font-weight:700; }}
    .status-failed {{ border-left-color:#ff6b6b; }}
    .status-retrying {{ border-left-color:#ffb454; }}
    .status-success {{ border-left-color:#4cd964; }}
    .status-running {{ border-left-color:#5ab2ff; }}
    .meta {{ font-size:12px; color:#95a4bf; margin-bottom:4px; }}
    .title {{ font-weight:700; margin-bottom:6px; }}
    .summary {{ white-space:pre-wrap; }}
    .summary-grid {{ display:grid; grid-template-columns: repeat(2, minmax(120px, 1fr)); gap:10px; }}
    .summary-card, .stage-card {{ padding:12px; background:#0d1528; border-radius:12px; border:1px solid #20304c; }}
    .stage-grid {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin-top:16px; }}
    .hero-chip {{ display:inline-block; margin:8px 8px 0 0; padding:8px 12px; border-radius:999px; border:1px solid rgba(99,179,255,.24); background:rgba(7,16,29,.4); color:#dce8fb; font-size:12px; }}
    .progress-track {{ margin:8px 0; height:10px; border-radius:999px; background:rgba(7,16,29,.75); overflow:hidden; border:1px solid rgba(99,179,255,.16); }}
    .progress-fill {{ height:100%; width:100%; background:linear-gradient(90deg, #45b0ff 0%, #42d392 100%); box-shadow:0 0 18px rgba(69,176,255,.32); }}
    code {{ background:#0b1324; padding:2px 6px; border-radius:6px; }}
    pre {{ white-space:pre-wrap; overflow:auto; background:#08111f; padding:10px; border-radius:10px; }}
  </style>
</head>
<body>
  <div class='hero'>
    <div class='panel'>
      <div class='summary-label'>Session Control</div>
      <h1>{html.escape(str(summary.get('mission_title') or summary.get('mission_label') or 'Session Replay'))}</h1>
      <div>Session: <code>{html.escape(str(replay.get('session_id', '')))}</code></div>
      <div>Status: <strong>{html.escape(str(summary.get('status', 'unknown')))}</strong></div>
      <div>Session Label: <strong>{html.escape(str(summary.get('mission_label') or ''))}</strong></div>
      <div>Bottleneck: <strong>{html.escape(str(summary.get('main_bottleneck') or 'n/a'))}</strong></div>
      <div><span class='hero-chip'>Current step: 1 / {summary.get('total_steps', 0)}</span><span class='hero-chip'>Replay Stage</span><span class='hero-chip'>Export HTML</span></div>
      <div style='margin-top:14px'>
        <div class='summary-label'>Session Progress</div>
        <div class='progress-track'><div class='progress-fill'></div></div>
        <div>{int((summary.get('completion_ratio') or 1) * 100)}% complete</div>
      </div>
    </div>
    <div class='panel'>
      <h2>Session Summary</h2>
      <div class='summary-grid'>
        <div class='summary-card'><div class='summary-label'>Total steps</div><div class='summary-value'>{summary.get('total_steps', 0)}</div></div>
        <div class='summary-card'><div class='summary-label'>Tool calls</div><div class='summary-value'>{summary.get('tool_calls', 0)}</div></div>
        <div class='summary-card'><div class='summary-label'>Errors</div><div class='summary-value'>{summary.get('errors', 0)}</div></div>
        <div class='summary-card'><div class='summary-label'>Retries</div><div class='summary-value'>{summary.get('retries', 0)}</div></div>
        <div class='summary-card'><div class='summary-label'>Files changed</div><div class='summary-value'>{summary.get('files_changed', 0)}</div></div>
        <div class='summary-card'><div class='summary-label'>Duration</div><div class='summary-value'>{html.escape(str(summary.get('duration_label', '0s')))}</div></div>
      </div>
    </div>
  </div>
  <div class='layout'>
    <div class='panel'>
      <h2>Timeline</h2>
      <ol class='timeline'>{''.join(items)}</ol>
    </div>
    <div class='replay-stage'>
      <div class='summary-label'>Replay Stage</div>
      <h2>{html.escape(str(stage.get('headline') or selected.get('title') or 'Step'))}</h2>
      <div class='meta'>{html.escape(str(selected.get('timestamp') or ''))} · {html.escape(str(selected.get('status') or 'unknown'))}</div>
      <div class='summary'>{html.escape(str(selected.get('summary') or ''))}</div>
      <div class='stage-grid'>
        <div class='stage-card'><div class='stage-label'>Why this step</div><div>{html.escape(str(stage.get('why') or ''))}</div></div>
        <div class='stage-card'><div class='stage-label'>Action</div><div>{html.escape(str(stage.get('action') or ''))}</div></div>
        <div class='stage-card'><div class='stage-label'>Observation</div><div>{html.escape(str(stage.get('observation') or ''))}</div></div>
        <div class='stage-card'><div class='stage-label'>Result</div><div>{html.escape(str(stage.get('result') or ''))}</div></div>
      </div>
    </div>
  </div>
  <div class='panel' style='margin-bottom:24px'>
    <h2>Session Graph</h2>
    <div class='graph'>{''.join(graph_nodes)}</div>
  </div>
  <div class='panel'>
    <h2>File Changes</h2>
    <ul>{''.join(file_changes) if file_changes else '<li>No file changes detected</li>'}</ul>
  </div>
</body>
</html>"""
