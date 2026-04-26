(function () {
  const state = {
    replay: { session_id: '', summary: {}, events: [], graph: { nodes: [], edges: [] } },
    sessions: [],
    currentSessionId: '',
    currentMessages: [],
    currentReplayExport: null,
    selectedIndex: 0,
    activeTab: 'graph',
    playing: false,
    timer: null,
    timelineFilter: 'all',
    playbackSpeed: 6,
    minPlaybackDelayMs: 650,
    maxPlaybackDelayMs: 5000,
    timelineScrollTop: 0,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function createEmptyState(title, description, bullets) {
    const empty = el('div', 'empty-state panel-surface');
    empty.append(el('div', 'empty-state-title', title));
    if (description) empty.append(el('div', 'empty-state-description', description));
    if (Array.isArray(bullets) && bullets.length) {
      const list = document.createElement('ul');
      list.className = 'empty-state-list';
      bullets.forEach(function (text) {
        const item = document.createElement('li');
        item.textContent = text;
        list.append(item);
      });
      empty.append(list);
    }
    return empty;
  }

  function getSelectedEvent() {
    return state.replay.events[state.selectedIndex] || {};
  }

  async function fetchJson(url, options) {
    const requestOptions = Object.assign({}, options || {});
    const headers = new Headers(requestOptions.headers || {});
    const dashboardToken = window.__HERMES_SESSION_TOKEN__;
    if (dashboardToken && !headers.has('Authorization')) {
      headers.set('Authorization', 'Bearer ' + dashboardToken);
    }
    requestOptions.headers = headers;
    const response = await fetch(url, requestOptions);
    if (!response.ok) {
      let detail = 'Request failed';
      try {
        const payload = await response.json();
        detail = payload.detail || detail;
      } catch (_) {}
      throw new Error(detail);
    }
    return response.json();
  }

  async function fetchSessions() {
    return fetchJson('/api/plugins/session-replay/sessions');
  }

  async function fetchSessionMessages(sessionId) {
    return fetchJson('/api/plugins/session-replay/sessions/' + encodeURIComponent(sessionId) + '/messages');
  }

  async function fetchSessionReplay(sessionId) {
    return fetchJson('/api/plugins/session-replay/sessions/' + encodeURIComponent(sessionId) + '/replay');
  }

  async function parseReplay(sessionId, messages) {
    return fetchJson('/api/plugins/session-replay/replay/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, messages }),
    });
  }

  async function exportHtml(sessionId, messages, replay) {
    return fetchJson('/api/plugins/session-replay/replay/export/html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, messages, replay }),
    });
  }

  function buildFallbackHtml() {
    const summary = state.replay.summary || {};
    const timeline = (state.replay.events || []).map(function (event) {
      return '<li><strong>' + escapeHtml(event.title || event.type || 'Step') + '</strong> — ' + escapeHtml(event.summary || '') + '</li>';
    }).join('');
    return '<!doctype html><html><head><meta charset="utf-8"><title>Session Replay</title><style>body{font-family:Inter,Arial,sans-serif;background:#09111f;color:#e6eef8;padding:24px} .panel{background:#101a2f;border:1px solid #22304d;border-radius:16px;padding:16px;margin-bottom:16px} code{background:#0b1324;padding:2px 6px;border-radius:6px}</style></head><body><div class="panel"><h1>Session Replay</h1><div>Session: <code>' + escapeHtml(state.replay.session_id || 'replay') + '</code></div><div>Status: ' + escapeHtml(summary.status || 'unknown') + '</div><div>Mission Label: ' + escapeHtml(summary.mission_label || '') + '</div></div><div class="panel"><h2>Timeline</h2><ol>' + timeline + '</ol></div></body></html>';
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function formatTokenCount(value) {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric.toLocaleString('en-US') + ' tok';
  }

  function formatDurationMs(value) {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    if (numeric >= 1000) return (numeric / 1000).toFixed(numeric >= 10000 ? 0 : 1) + 's';
    return Math.round(numeric) + 'ms';
  }

  function formatEventTimestamp(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const millis = value > 1e12 ? value : value * 1000;
      return new Date(millis).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && String(value).trim() !== '') {
      const millis = numeric > 1e12 ? numeric : numeric * 1000;
      return new Date(millis).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function buildTimelinePrimaryMeta(event) {
    const parts = [];
    const timestampLabel = formatEventTimestamp(event.timestamp);
    if (timestampLabel) parts.push('Started ' + timestampLabel);
    const durationLabel = formatDurationMs(event.duration_ms);
    if (durationLabel) parts.push('Exec ' + durationLabel);
    const tokenLabel = formatTokenCount(event.token_count);
    if (tokenLabel) parts.push(tokenLabel);
    return parts.join(' · ');
  }

  function buildRuntimeMeta(event) {
    return buildTimelinePrimaryMeta(event);
  }

  function computePlaybackDelayMs(currentEvent, nextEvent) {
    const currentTs = Date.parse(currentEvent && currentEvent.timestamp ? currentEvent.timestamp : '');
    const nextTs = Date.parse(nextEvent && nextEvent.timestamp ? nextEvent.timestamp : '');
    if (Number.isFinite(currentTs) && Number.isFinite(nextTs) && nextTs > currentTs) {
      const scaled = Math.round((nextTs - currentTs) / Math.max(state.playbackSpeed, 1));
      return Math.max(state.minPlaybackDelayMs, Math.min(state.maxPlaybackDelayMs, scaled));
    }
    const nextDuration = Number(nextEvent && nextEvent.duration_ms);
    if (Number.isFinite(nextDuration) && nextDuration > 0) {
      const scaledDuration = Math.round(nextDuration / Math.max(state.playbackSpeed, 1));
      return Math.max(state.minPlaybackDelayMs, Math.min(state.maxPlaybackDelayMs, scaledDuration));
    }
    return 1200;
  }

  function statusLabel(value) {
    if (!value) return 'unknown';
    return String(value).replace(/_/g, ' ');
  }

  function summarizeValue(value, maxLength) {
    const limit = maxLength || 240;
    if (value == null) return '';
    if (typeof value === 'string') {
      const compact = value.trim();
      if (compact.length <= limit) return compact;
      return compact.slice(0, limit - 3) + '...';
    }
    try {
      const serialized = JSON.stringify(value, null, 2);
      if (serialized.length <= limit) return serialized;
      return serialized.slice(0, limit - 3) + '...';
    } catch (_) {
      return String(value);
    }
  }

  function stringifyForClipboard(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return String(value);
    }
  }

  function parseDisplayValue(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch (_) {
        return value;
      }
    }
    return value;
  }

  function createReadableValueNode(value, depth) {
    const level = depth || 0;
    const normalized = parseDisplayValue(value);

    if (normalized == null || normalized === '') {
      return el('div', 'structured-empty', '—');
    }

    if (typeof normalized === 'string') {
      const pre = el('pre', 'detail-pre detail-pre-fixed');
      pre.textContent = normalized;
      return pre;
    }

    if (typeof normalized === 'number' || typeof normalized === 'boolean') {
      return el('div', 'structured-inline-value', String(normalized));
    }

    if (Array.isArray(normalized)) {
      const list = el('div', 'structured-view structured-array');
      if (!normalized.length) {
        list.append(el('div', 'structured-empty', 'Empty list'));
        return list;
      }
      normalized.forEach(function (item, index) {
        const row = el('div', 'structured-row');
        row.append(el('div', 'structured-key', '[' + index + ']'));
        const content = el('div', 'structured-value');
        content.append(createReadableValueNode(item, level + 1));
        row.append(content);
        list.append(row);
      });
      return list;
    }

    if (typeof normalized === 'object') {
      const entries = Object.entries(normalized);
      const wrapper = el('div', 'structured-view structured-object');
      if (!entries.length) {
        wrapper.append(el('div', 'structured-empty', 'Empty object'));
        return wrapper;
      }
      entries.forEach(function (entry) {
        const row = el('div', 'structured-row');
        row.append(el('div', 'structured-key', entry[0]));
        const content = el('div', 'structured-value');
        content.append(createReadableValueNode(entry[1], level + 1));
        row.append(content);
        wrapper.append(row);
      });
      return wrapper;
    }

    const fallback = el('pre', 'detail-pre detail-pre-fixed');
    fallback.textContent = stringifyForClipboard(normalized);
    return fallback;
  }

  function appendReadableValue(container, value) {
    container.append(createReadableValueNode(value, 0));
  }

  function parseLabeledStructuredText(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^([^\n:]{1,120}?):\s*(\{[\s\S]*\}|\[[\s\S]*\])$/);
    if (!match) return null;
    try {
      return {
        label: match[1].trim(),
        value: JSON.parse(match[2])
      };
    } catch (_) {
      return null;
    }
  }

  function appendCompactFormattedSummary(container, value) {
    const parsed = parseLabeledStructuredText(value);
    if (parsed) {
      container.append(el('div', 'graph-node-summary-lead', parsed.label + ':'));
      const pre = el('pre', 'detail-pre detail-pre-fixed summary-pretty');
      pre.textContent = stringifyForClipboard(parsed.value);
      container.append(pre);
      return;
    }

    const normalized = parseDisplayValue(value);
    if (normalized == null || normalized === '') {
      container.append(el('div', 'structured-empty', '—'));
      return;
    }

    if (typeof normalized === 'object') {
      const pre = el('pre', 'detail-pre detail-pre-fixed summary-pretty');
      pre.textContent = stringifyForClipboard(normalized);
      container.append(pre);
      return;
    }

    if (typeof normalized === 'string') {
      const pre = el('pre', 'detail-pre detail-pre-fixed summary-pretty');
      pre.textContent = normalized;
      container.append(pre);
      return;
    }

    container.append(el('div', 'structured-inline-value', String(normalized)));
  }

  function extractMessageText(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
      return raw.map(function (item) { return extractMessageText(item); }).filter(Boolean).join('\n');
    }
    if (typeof raw === 'object') {
      if (typeof raw.error === 'string') return raw.error;
      if (typeof raw.message === 'string') return raw.message;
      if (typeof raw.output === 'string') return raw.output;
      if (typeof raw.content === 'string') return raw.content;
      if (typeof raw.stderr === 'string' && raw.stderr.trim()) return raw.stderr;
      if (typeof raw.stdout === 'string' && raw.stdout.trim()) return raw.stdout;
      try {
        return JSON.stringify(raw, null, 2);
      } catch (_) {
        return String(raw);
      }
    }
    return String(raw);
  }

  function findRelatedRetry(event) {
    const currentIndex = state.replay.events.indexOf(event);
    if (currentIndex === -1) return null;
    for (let index = currentIndex + 1; index < state.replay.events.length; index += 1) {
      const candidate = state.replay.events[index];
      if (candidate.type === 'retry') return candidate;
      if (candidate.type === 'tool_result' || candidate.type === 'error' || candidate.type === 'tool_call' || candidate.type === 'file_change') continue;
      if (candidate.type === 'agent_intent' || candidate.type === 'final_answer' || candidate.type === 'user_message') break;
    }
    return null;
  }

  function normalizeErrorSignature(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[0-9]+/g, '#')
      .trim()
      .slice(0, 140) || 'unknown-error';
  }

  function diagnoseToolIssue(toolName, input, output) {
    const joined = [toolName || '', extractMessageText(input), extractMessageText(output)].join('\n').toLowerCase();
    if (joined.indexOf('date: illegal option') >= 0 || joined.indexOf('gnu date') >= 0) {
      return 'This looks like a GNU date command running in a BSD/macOS environment.';
    }
    if ((toolName || '').toLowerCase() === 'cronjob' || joined.indexOf('cronjob') >= 0 || joined.indexOf('schedule') >= 0) {
      return 'This failure likely comes from an invalid cron payload, schedule format, or unsupported delivery target.';
    }
    if ((toolName || '').toLowerCase() === 'patch' || joined.indexOf('no match found') >= 0 || joined.indexOf('failed to apply') >= 0) {
      return 'This looks like a patch anchor mismatch. Re-read the target file and apply a narrower change.';
    }
    if ((toolName || '').toLowerCase() === 'terminal') {
      return 'The terminal command failed. Inspect shell syntax, OS compatibility, and required binaries.';
    }
    if ((toolName || '').toLowerCase() === 'read_file' || (toolName || '').toLowerCase() === 'search_files') {
      return 'The inspection step did not return expected repository data. Check path and search pattern assumptions.';
    }
    return 'Inspect the raw tool output and compare it with the next recovery step.';
  }

  function parseErrorForensics(event) {
    const rawText = extractMessageText(event.raw);
    const lowered = rawText.toLowerCase();
    let errorType = 'Unknown Tool Error';
    let summary = event.summary || 'A tool call failed.';
    let likelyCause = 'Inspect the raw tool output for details.';
    let impact = 'The task may have continued with degraded reliability.';
    let recovery = 'Check later steps for retry or workaround.';
    let suggestedFix = 'Inspect the raw output and add validation before retrying the tool call.';

    if (lowered.indexOf('date: illegal option') >= 0) {
      errorType = 'Terminal Command Error';
      summary = 'Terminal command failed.';
      likelyCause = 'The command used a date option unsupported by the current OS.';
      impact = 'Time calculation or scheduling logic failed.';
      recovery = findRelatedRetry(event) ? 'A retry step appears later in the timeline.' : 'No retry was detected after this error.';
      suggestedFix = 'Use portable date syntax or detect the operating system before running the command.';
    } else if ((event.tool_name || '').toLowerCase() === 'cronjob' || lowered.indexOf('cronjob') >= 0) {
      errorType = 'Cronjob Error';
      summary = 'Cronjob creation or update failed.';
      likelyCause = 'The cronjob payload may be malformed or incompatible with the scheduler.';
      impact = 'Scheduled automation may not have been created.';
      recovery = findRelatedRetry(event) ? 'A retry step appears later in the timeline.' : 'No retry was detected after this error.';
      suggestedFix = 'Validate the cronjob payload and schedule format before creating the job.';
    } else if ((event.tool_name || '').toLowerCase() === 'patch' || lowered.indexOf('failed to apply') >= 0 || lowered.indexOf('no match found') >= 0) {
      errorType = 'File Patch Error';
      summary = 'Patch application failed.';
      likelyCause = 'The target file content no longer matched the patch anchors.';
      impact = 'Requested file updates were not applied.';
      recovery = findRelatedRetry(event) ? 'A retry step appears later in the timeline.' : 'No retry was detected after this error.';
      suggestedFix = 'Read the target file again and apply a narrower patch with stable anchor text.';
    }

    return {
      id: event.id || 'error',
      stepId: event.id || 'error',
      toolName: event.tool_name || null,
      errorType: errorType,
      summary: summary,
      likelyCause: likelyCause,
      impact: impact,
      recovery: recovery,
      suggestedFix: suggestedFix,
      normalizedMessage: normalizeErrorSignature(rawText || summary),
      raw: event.raw,
      firstSeenAt: event.timestamp,
    };
  }

  function aggregateErrorGroups() {
    const errors = state.replay.events.filter(function (event) {
      return event.status === 'failed' || event.type === 'error';
    }).map(parseErrorForensics);

    const groups = {};
    errors.forEach(function (entry) {
      const key = [entry.toolName || 'unknown', entry.errorType, entry.normalizedMessage].join('::');
      if (!groups[key]) {
        groups[key] = {
          id: key,
          errorType: entry.errorType,
          toolName: entry.toolName,
          count: 0,
          firstStepId: entry.stepId,
          firstSeenAt: entry.firstSeenAt,
          examples: [],
          likelyCause: entry.likelyCause,
          suggestedFix: entry.suggestedFix,
          impact: entry.impact,
        };
      }
      groups[key].count += 1;
      groups[key].examples.push(entry);
    });

    return Object.keys(groups).map(function (key) {
      return groups[key];
    }).sort(function (left, right) {
      if (right.count !== left.count) return right.count - left.count;
      return String(left.errorType).localeCompare(String(right.errorType));
    });
  }

  function topFailedTools() {
    const counts = {};
    state.replay.events.forEach(function (event) {
      if (event.status !== 'failed' && event.type !== 'error') return;
      const key = event.tool_name || 'unknown tool';
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.keys(counts).sort(function (left, right) {
      if (counts[right] !== counts[left]) return counts[right] - counts[left];
      return left.localeCompare(right);
    });
  }

  function buildMissionDiagnosis(summary) {
    const failedTools = topFailedTools();
    const topFailedTool = failedTools.slice(0, 2).join(' and ');
    if ((summary.errors || 0) > 0 && String(summary.status || '').indexOf('completed') >= 0) {
      return 'This session completed with visible issues. Most failures came from ' + (topFailedTool || 'tool calls') + '.';
    }
    if ((summary.errors || 0) > 0 && String(summary.status || '').indexOf('completed') === -1) {
      return 'This session did not complete successfully. The main blocker was ' + (topFailedTool || 'an error in the execution path') + '.';
    }
    if ((summary.duration_ms || 0) > 300000) {
      return 'This session completed successfully, but took longer than expected. The bottleneck was ' + (summary.main_bottleneck || 'not clearly identified') + '.';
    }
    if ((summary.files_changed || 0) === 0 && (summary.tool_calls || 0) > 0) {
      return 'This session used tools but did not modify files. It was likely an inspection, export, or scheduling task.';
    }
    return 'This session completed successfully with no visible errors.';
  }

  function eventMatchesTimelineFilter(event, filterValue) {
    if (!filterValue || filterValue === 'all') return true;
    if (filterValue === 'errors') return event.status === 'failed' || event.type === 'error';
    if (filterValue === 'tool_calls') return event.type === 'tool_call';
    if (filterValue === 'file_changes') return event.type === 'file_change';
    if (filterValue === 'retries') return event.type === 'retry';
    if (filterValue === 'long_running') return (event.duration_ms || 0) >= 4000;
    return true;
  }

  function buildTimelineFilterOptions() {
    const events = state.replay.events || [];
    return [
      ['all', 'All', events.length],
      ['errors', 'Errors', events.filter(function (event) { return eventMatchesTimelineFilter(event, 'errors'); }).length],
      ['tool_calls', 'Tool Calls', events.filter(function (event) { return eventMatchesTimelineFilter(event, 'tool_calls'); }).length],
      ['file_changes', 'File Changes', events.filter(function (event) { return eventMatchesTimelineFilter(event, 'file_changes'); }).length],
      ['retries', 'Retries', events.filter(function (event) { return eventMatchesTimelineFilter(event, 'retries'); }).length],
      ['long_running', 'Long-running', events.filter(function (event) { return eventMatchesTimelineFilter(event, 'long_running'); }).length]
    ];
  }

  function timelineAccentClass(event) {
    if (event.status === 'failed' || event.type === 'error') return 'accent-failed';
    if (event.status === 'retrying' || event.type === 'retry') return 'accent-retry';
    if (event.type === 'tool_call') return 'accent-tool';
    if (event.type === 'agent_intent' || event.type === 'final_answer') return 'accent-model';
    if (event.status === 'success' || event.type === 'tool_result' || event.type === 'file_change') return 'accent-success';
    return 'accent-normal';
  }

  function eventKindLabel(event) {
    if (event.type === 'error') return 'Failed';
    if (event.type === 'tool_call') return 'Tool Call';
    if (event.type === 'tool_result') return 'Tool Result';
    if (event.type === 'file_change') return 'File Change';
    if (event.type === 'retry') return 'Retry';
    if (event.type === 'agent_intent') return 'Intent';
    if (event.type === 'final_answer') return 'Final';
    if (event.type === 'user_message') return 'Input';
    return statusLabel(event.type || event.status || 'event');
  }

  function jumpToEventId(eventId, containers) {
    const nextIndex = state.replay.events.findIndex(function (event) { return event.id === eventId; });
    if (nextIndex === -1) return;
    state.selectedIndex = nextIndex;
    renderSummary(containers.summary);
    renderTimeline(containers.timeline, containers.detail, containers.raw, containers.graph, containers.files, containers.errors);
    renderDetail(containers.detail, containers.raw, containers.status);
    renderGraph(containers.graph);
    renderFiles(containers.files);
    renderErrors(containers.errors, containers);
  }

  async function copyTextToClipboard(text, fallbackFilename, statusNode, successMessage) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        if (statusNode) statusNode.textContent = successMessage || 'Copied to clipboard';
        return true;
      }
    } catch (_) {}
    downloadText(fallbackFilename || 'session-replay.txt', text, 'text/plain;charset=utf-8');
    if (statusNode) statusNode.textContent = 'Clipboard API unavailable. Downloaded fallback file.';
    return false;
  }

  function buildToolInspection(event) {
    const inspection = {
      id: event.id || 'tool-inspection',
      toolName: event.tool_name || 'unknown',
      status: event.status || 'unknown',
      durationMs: event.duration_ms,
      input: event.args,
      output: event.type === 'tool_call' ? null : event.raw,
      diagnosis: null,
      relatedRetryId: null,
      raw: event.raw,
    };

    if ((event.type === 'tool_result' || event.type === 'error') && !inspection.input && event.tool_call_id) {
      const toolCallEvent = state.replay.events.find(function (candidate) { return candidate.id === event.tool_call_id; });
      if (toolCallEvent && toolCallEvent.args) inspection.input = toolCallEvent.args;
    }
    if (event.type === 'tool_call' && event.tool_call_id) {
      const relatedResult = state.replay.events.find(function (candidate) {
        return candidate.tool_call_id === event.tool_call_id && (candidate.type === 'tool_result' || candidate.type === 'error');
      });
      if (relatedResult) {
        inspection.output = relatedResult.raw;
        inspection.status = relatedResult.status || inspection.status;
        inspection.durationMs = relatedResult.duration_ms != null ? relatedResult.duration_ms : inspection.durationMs;
      }
    }

    if (inspection.status === 'failed' || event.type === 'error') {
      inspection.diagnosis = diagnoseToolIssue(inspection.toolName, inspection.input, inspection.output);
      const retryEvent = findRelatedRetry(event);
      inspection.relatedRetryId = retryEvent ? retryEvent.id : null;
    }
    return inspection;
  }

  function buildMarkdownReport() {
    const summary = state.replay.summary || {};
    const diagnosis = buildMissionDiagnosis(summary);
    const errorGroups = aggregateErrorGroups();
    const highlights = (state.replay.events || []).slice(0, 8).map(function (event, index) {
      return (index + 1) + '. ' + (event.title || event.type || 'Step');
    });
    const fileChanges = state.replay.events.filter(function (event) { return event.type === 'file_change'; });
    const nextActions = [];

    if ((summary.errors || 0) > 0) {
      errorGroups.slice(0, 3).forEach(function (group) {
        if (group.suggestedFix) nextActions.push('- ' + group.suggestedFix);
      });
    }
    if ((summary.files_changed || 0) === 0) {
      nextActions.push('- Confirm whether this session was intended to inspect, export, or schedule work without editing files.');
    }
    if ((summary.retries || 0) === 0 && (summary.errors || 0) > 0) {
      nextActions.push('- Add retry handling or preflight validation for the failed path.');
    }
    if (!nextActions.length) {
      nextActions.push('- Preserve this session as a clean reference for future runs.');
    }

    return [
      '# Hermes Session Replay Report',
      '',
      '## Summary',
      '',
      '- Session: ' + (state.replay.session_id || 'unknown'),
      '- Status: ' + (summary.status || 'unknown'),
      '- Steps: ' + (summary.total_steps || 0),
      '- Tool calls: ' + (summary.tool_calls || 0),
      '- Errors: ' + (summary.errors || 0),
      '- Retries: ' + (summary.retries || 0),
      '- Files changed: ' + (summary.files_changed || 0),
      '- Duration: ' + (summary.duration_label || '0s'),
      '- Bottleneck: ' + (summary.main_bottleneck || 'n/a'),
      '',
      '## Mission Diagnosis',
      '',
      diagnosis,
      '',
      '## Timeline Highlights',
      '',
      highlights.join('\n'),
      '',
      '## Error Forensics',
      '',
      errorGroups.length ? errorGroups.map(function (group) {
        return [
          '### ' + group.errorType,
          '',
          '- Count: ' + group.count,
          '- Tool: ' + (group.toolName || 'unknown'),
          '- Likely cause: ' + (group.likelyCause || 'n/a'),
          '- Suggested fix: ' + (group.suggestedFix || 'n/a'),
        ].join('\n');
      }).join('\n\n') : 'No grouped errors detected.',
      '',
      '## File Changes',
      '',
      fileChanges.length ? fileChanges.map(function (event) {
        return '- ' + (event.file_path || 'Unknown file') + ': ' + (event.summary || 'Updated file');
      }).join('\n') : 'No file changes detected.',
      '',
      '## Recommended Next Actions',
      '',
      nextActions.join('\n')
    ].join('\n');
  }

  function renderSummary(container) {
    const summary = state.replay.summary || {};
    const currentEvent = getSelectedEvent();
    const currentStage = currentEvent.stage || {};
    const totalSteps = summary.total_steps || 0;
    const currentStep = Math.min(state.selectedIndex + 1, totalSteps || 1);
    const progressPercent = totalSteps ? Math.round((currentStep / totalSteps) * 100) : 0;
    const replayMode = state.playing ? 'Playing' : 'Paused';
    const diagnosis = buildMissionDiagnosis(summary);
    container.innerHTML = '';

    const banner = el('div', 'mission-banner panel-surface');
    const heroHeader = el('div', 'mission-hero-header');
    const heroEyebrow = el('div', 'mission-banner-kicker', 'Session Overview');
    const heroSubtitle = el('div', 'mission-banner-subtitle', 'Session ' + (state.replay.session_id || 'unknown') + ' · Step ' + currentStep + ' of ' + totalSteps + ' · ' + replayMode.toLowerCase());
    const progressBlock = el('div', 'mission-progress');
    progressBlock.append(el('div', 'mission-progress-label', 'Session Progress'));
    const progressTrack = el('div', 'mission-progress-track');
    const progressFill = el('div', 'mission-progress-fill');
    progressFill.style.width = progressPercent + '%';
    progressTrack.append(progressFill);
    progressBlock.append(progressTrack);
    progressBlock.append(el('div', 'mission-progress-value', currentStep + ' of ' + totalSteps + ' steps · ' + progressPercent + '% complete'));
    heroHeader.append(heroEyebrow, heroSubtitle, progressBlock);

    const diagnosisCard = el('div', 'mission-diagnosis-card');
    diagnosisCard.append(el('div', 'mission-diagnosis-label', 'Mission Diagnosis'));
    diagnosisCard.append(el('div', 'mission-diagnosis-text', diagnosis));
    heroHeader.append(diagnosisCard);

    const liveStage = el('div', 'mission-live-stage panel-surface-soft');
    liveStage.append(el('div', 'mission-live-label', 'Current Step'));
    liveStage.append(el('div', 'mission-live-title', currentStage.headline || currentEvent.title || 'Session step'));
    const liveSummary = el('div', 'mission-live-summary');
    appendCompactFormattedSummary(liveSummary, currentEvent.summary || currentStage.observation || currentStage.result || currentStage.action || '');
    liveStage.append(liveSummary);
    const liveMeta = el('div', 'mission-live-meta');
    liveMeta.append(el('div', 'hero-chip hero-chip-soft', 'Stage: ' + (currentStage.kicker || currentEvent.type || 'step')));
    const statusChip = el('div', 'hero-chip hero-chip-soft', 'Status: ' + (currentEvent.status || 'unknown'));
    liveMeta.append(statusChip);
    if (currentEvent.duration_ms) liveMeta.append(el('div', 'hero-chip hero-chip-soft', 'Duration: ' + formatDurationMs(currentEvent.duration_ms)));
    liveStage.append(liveMeta);

    const heroCinemaRow = el('div', 'mission-cinema-row');
    heroCinemaRow.append(heroHeader, liveStage);
    const compactMeta = el('div', 'mission-hero-meta');
    [
      'Status: ' + (summary.status || 'unknown'),
      'Label: ' + (summary.mission_label || 'n/a'),
      'Tool calls: ' + String(summary.tool_calls || 0),
      'Bottleneck: ' + (summary.main_bottleneck || 'n/a')
    ].forEach(function (label) {
      compactMeta.append(el('div', 'hero-chip', label));
    });
    banner.append(heroCinemaRow, compactMeta);
    container.append(banner);

    const cards = [
      ['Status', summary.status],
      ['Current step', currentStep + ' / ' + totalSteps],
      ['Tool calls', String(summary.tool_calls || 0)],
      ['Errors', String(summary.errors || 0)],
      ['Retries', String(summary.retries || 0)],
      ['Files changed', String(summary.files_changed || 0)],
      ['Duration', summary.duration_label],
      ['Bottleneck', summary.main_bottleneck || 'n/a'],
    ];

    cards.forEach(function (pair) {
      const value = String(pair[1] == null ? '—' : pair[1]);
      const cardClass = ['summary-card', 'panel-surface'];
      if (pair[0] === 'Status' || pair[0] === 'Bottleneck') cardClass.push('summary-card-wide');
      const valueClass = value.length > 18 ? 'summary-value summary-value-compact' : 'summary-value';
      const card = el('div', cardClass.join(' '));
      card.append(el('div', 'summary-label', pair[0]));
      card.append(el('div', valueClass, value));
      container.append(card);
    });
  }

  function renderTimeline(container, detailContainer, rawContainer, graphContainer, filesContainer, errorsContainer) {
    const previousTimelineScroll = container.querySelector('.timeline-scroll');
    if (previousTimelineScroll) state.timelineScrollTop = previousTimelineScroll.scrollTop;

    container.innerHTML = '';
    const heading = el('div', 'panel-section-heading');
    heading.append(el('div', 'panel-section-kicker', 'Timeline'));
    heading.append(el('div', 'panel-section-title', 'Timeline'));
    container.append(heading);

    const filterBar = el('div', 'timeline-filter-bar');
    buildTimelineFilterOptions().forEach(function (pair) {
      const filterButton = el('button', 'filter-chip' + (state.timelineFilter === pair[0] ? ' active' : ''));
      filterButton.type = 'button';
      filterButton.append(el('span', 'filter-chip-label', pair[1]));
      filterButton.append(el('span', 'filter-chip-count', String(pair[2])));
      filterButton.addEventListener('click', function () {
        state.timelineFilter = pair[0];
        const filteredEvents = state.replay.events.filter(function (candidate) {
          return eventMatchesTimelineFilter(candidate, state.timelineFilter);
        });
        const selectedEvent = state.replay.events[state.selectedIndex];
        if (!filteredEvents.length) {
          state.selectedIndex = 0;
        } else if (filteredEvents.indexOf(selectedEvent) === -1) {
          state.selectedIndex = state.replay.events.indexOf(filteredEvents[0]);
        }
        renderSummary(document.querySelector('.summary-grid.summary-stage'));
        renderTimeline(container, detailContainer, rawContainer, graphContainer, filesContainer, errorsContainer);
        renderDetail(detailContainer, rawContainer);
        renderGraph(graphContainer);
        renderFiles(filesContainer);
        renderErrors(errorsContainer, {
          summary: document.querySelector('.summary-grid.summary-stage'),
          timeline: container,
          detail: detailContainer,
          raw: rawContainer,
          graph: graphContainer,
          files: filesContainer,
          errors: errorsContainer
        });
      });
      filterBar.append(filterButton);
    });
    container.append(filterBar);

    const timelineScroll = el('div', 'timeline-scroll');
    timelineScroll.scrollTop = state.timelineScrollTop || 0;
    timelineScroll.addEventListener('scroll', function () {
      state.timelineScrollTop = timelineScroll.scrollTop;
    });
    container.append(timelineScroll);

    const filteredEvents = state.replay.events.filter(function (event) {
      return eventMatchesTimelineFilter(event, state.timelineFilter);
    });
    if (!filteredEvents.length) {
      timelineScroll.append(createEmptyState(
        'No timeline events in this filter',
        'The current filter hides all replay steps, so there is nothing to scrub here right now.',
        [
          'Switch back to All to inspect the full run.',
          'Keep the current filter if you only care about a narrower slice such as errors or tool calls.'
        ]
      ));
      return;
    }

    filteredEvents.forEach(function (event) {
      const index = state.replay.events.indexOf(event);
      const button = el('button', 'timeline-item panel-surface-soft status-' + (event.status || 'unknown') + ' ' + timelineAccentClass(event));
      if (index === state.selectedIndex) button.classList.add('active');
      if (index === state.selectedIndex) button.setAttribute('aria-current', 'step');
      if (index < state.selectedIndex) button.classList.add('completed');
      if (index > state.selectedIndex) button.classList.add('upcoming');

      const topRow = el('div', 'timeline-top-row');
      topRow.append(el('div', 'timeline-step-index', (event.stage && event.stage.kicker) || event.type || 'event'));
      topRow.append(el('div', 'timeline-status-badge status-badge-' + (event.status || 'unknown'), eventKindLabel(event) + ' · ' + statusLabel(event.status || 'unknown')));
      button.append(topRow);
      button.append(el('div', 'timeline-runtime', buildRuntimeMeta(event)));
      button.append(el('div', 'timeline-title', event.title || event.type));

      button.addEventListener('click', function () {
        state.timelineScrollTop = timelineScroll.scrollTop;
        state.selectedIndex = index;
        renderSummary(document.querySelector('.summary-grid.summary-stage'));
        renderTimeline(container, detailContainer, rawContainer, graphContainer, filesContainer, errorsContainer);
        renderDetail(detailContainer, rawContainer);
        renderGraph(graphContainer);
        renderFiles(filesContainer);
        renderErrors(errorsContainer, {
          summary: document.querySelector('.summary-grid.summary-stage'),
          timeline: container,
          detail: detailContainer,
          raw: rawContainer,
          graph: graphContainer,
          files: filesContainer,
          errors: errorsContainer
        });
      });
      timelineScroll.append(button);
    });
  }

  function renderToolInspector(inspection, parent, statusNode) {
    const inspector = el('section', 'tool-inspector panel-surface');
    inspector.append(el('div', 'detail-kicker', 'Tool Call Inspector'));

    const inspectorGrid = el('div', 'tool-inspector-grid');
    [
      ['Tool', inspection.toolName],
      ['Status', inspection.status],
      ['Duration', formatDurationMs(inspection.durationMs) || 'n/a'],
      ['Related retry', inspection.relatedRetryId || 'none']
    ].forEach(function (pair) {
      const item = el('div', 'tool-inspector-cell panel-surface-soft');
      item.append(el('div', 'stage-card-label', pair[0]));
      item.append(el('div', 'stage-card-value', pair[1] || '—'));
      inspectorGrid.append(item);
    });
    inspector.append(inspectorGrid);

    if (inspection.diagnosis) {
      const diagnosis = el('div', 'tool-diagnosis panel-surface-soft');
      diagnosis.append(el('div', 'stage-card-label', 'Diagnosis'));
      diagnosis.append(el('div', 'stage-card-value', inspection.diagnosis));
      inspector.append(diagnosis);
    }

    const inputBlock = el('div', 'stage-block panel-surface-soft');
    inputBlock.append(el('div', 'stage-card-label', 'Input'));
    appendReadableValue(inputBlock, inspection.input == null ? 'No input captured.' : inspection.input);
    inspector.append(inputBlock);

    const outputBlock = el('div', 'stage-block panel-surface-soft');
    outputBlock.append(el('div', 'stage-card-label', 'Output'));
    appendReadableValue(outputBlock, inspection.output == null ? 'No output captured yet.' : inspection.output);
    inspector.append(outputBlock);

    const actions = el('div', 'tool-actions');
    [
      ['Copy Input', stringifyForClipboard(inspection.input), 'tool-input.txt'],
      ['Copy Output', stringifyForClipboard(inspection.output), 'tool-output.txt'],
      ['Copy Raw JSON', stringifyForClipboard(inspection.raw), 'tool-raw.json']
    ].forEach(function (pair) {
      const button = el('button', 'secondary-button tool-action-button', pair[0]);
      button.type = 'button';
      button.addEventListener('click', function () {
        copyTextToClipboard(pair[1], pair[2], statusNode, pair[0] + ' copied');
      });
      actions.append(button);
    });
    inspector.append(actions);
    parent.append(inspector);
  }

  function renderErrorSummary(event, parent) {
    const forensic = parseErrorForensics(event);
    const card = el('section', 'error-forensics-card panel-surface');
    card.append(el('div', 'detail-kicker', 'Tool Error'));
    card.append(el('h3', 'forensics-title', forensic.errorType));

    [
      ['Summary', forensic.summary],
      ['Likely Cause', forensic.likelyCause],
      ['Impact', forensic.impact],
      ['Recovery', forensic.recovery]
    ].forEach(function (pair) {
      const row = el('div', 'forensics-row panel-surface-soft');
      row.append(el('div', 'stage-card-label', pair[0]));
      if (pair[0] === 'Summary') {
        const body = el('div', 'stage-card-value observation-body');
        appendCompactFormattedSummary(body, pair[1] || '—');
        row.append(body);
      } else {
        row.append(el('div', 'stage-card-value', pair[1] || '—'));
      }
      card.append(row);
    });

    const disclosure = document.createElement('details');
    disclosure.className = 'raw-disclosure panel-surface-soft';
    const summaryNode = document.createElement('summary');
    summaryNode.textContent = 'View Raw JSON';
    disclosure.append(summaryNode);
    appendReadableValue(disclosure, event.raw || {});
    card.append(disclosure);
    parent.append(card);
  }

  function renderDetail(container, rawContainer, statusNode) {
    const event = getSelectedEvent();
    const stage = event.stage || {};
    container.innerHTML = '';

    const hero = el('div', 'replay-stage panel-surface status-' + (event.status || 'unknown'));
    hero.append(el('div', 'detail-kicker', 'Event Details'));
    hero.append(el('h2', 'detail-title', stage.headline || event.title || 'Current Event'));
    hero.append(el('div', 'detail-meta', [formatEventTimestamp(event.timestamp), event.status || '', event.duration_ms ? 'Exec ' + formatDurationMs(event.duration_ms) : '', formatTokenCount(event.token_count)].filter(Boolean).join(' · ')));

    const pillRow = el('div', 'pill-row');
    if (event.tool_name) pillRow.append(el('div', 'pill', 'Tool: ' + event.tool_name));
    if (event.tool_call_id) pillRow.append(el('div', 'pill', 'Call ID: ' + event.tool_call_id));
    if (event.file_path) pillRow.append(el('div', 'pill', 'File: ' + event.file_path));
    if (pillRow.childNodes.length) hero.append(pillRow);

    const observation = stage.observation || event.summary || stage.result || stage.action || stage.why || '';
    const grid = el('div', 'stage-grid');
    const section = el('div', 'stage-card stage-card-transparent panel-surface-soft');
    section.append(el('div', 'stage-card-label', 'Observation'));
    const observationBody = el('div', 'stage-card-value observation-body');
    appendCompactFormattedSummary(observationBody, observation || '—');
    section.append(observationBody);
    grid.append(section);
    hero.append(grid);

    if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'error') {
      renderToolInspector(buildToolInspection(event), hero, statusNode);
    } else if (event.args) {
      const block = el('div', 'stage-block panel-surface-soft');
      block.append(el('div', 'stage-card-label', 'Tool Input'));
      appendReadableValue(block, event.args);
      hero.append(block);
    }

    if (event.type === 'error' || event.status === 'failed') {
      renderErrorSummary(event, hero);
    } else if (event.type === 'tool_result' && event.raw != null) {
      const outputValue = stringifyForClipboard(event.raw);
      if (outputValue) {
        const block = el('div', 'stage-block panel-surface-soft');
        block.append(el('div', 'stage-card-label', 'Tool Output'));
        appendReadableValue(block, event.raw);
        hero.append(block);
      }
    }

    if (event.diff) {
      const block = el('div', 'stage-block panel-surface-soft');
      block.append(el('div', 'stage-card-label', 'File Diff'));
      const diff = el('pre', 'detail-pre detail-pre-fixed diff-pre');
      diff.textContent = event.diff;
      block.append(diff);
      hero.append(block);
    }

    container.append(hero);
    rawContainer.textContent = stringifyForClipboard(event.raw || {});
  }

  function renderGraph(container) {
    container.innerHTML = '';
    const title = el('h3', 'footer-title', 'Execution Graph');
    container.append(title);

    const nodes = (state.replay.graph && state.replay.graph.nodes) || [];
    const edges = (state.replay.graph && state.replay.graph.edges) || [];
    const currentEvent = getSelectedEvent();

    const graphMeta = el('div', 'graph-meta');
    graphMeta.append(el('div', 'hero-chip', 'Nodes: ' + nodes.length));
    graphMeta.append(el('div', 'hero-chip', 'Edges: ' + edges.length));
    graphMeta.append(el('div', 'hero-chip', 'Focus: ' + (currentEvent.title || currentEvent.type || 'step')));
    container.append(graphMeta);

    const lanes = el('div', 'graph-lanes');
    const groups = [
      {
        title: 'Main Sequence',
        matcher: function (node) {
          return ['goal', 'plan', 'tools', 'narrative', 'flow'].indexOf(node.lane || 'flow') >= 0;
        }
      },
      {
        title: 'Recovery Sequence',
        matcher: function (node) {
          return ['recovery', 'build'].indexOf(node.lane || 'flow') >= 0;
        }
      },
      {
        title: 'Result Sequence',
        matcher: function (node) {
          return (node.lane || 'flow') === 'result';
        }
      }
    ];

    groups.forEach(function (group) {
      const groupNodes = nodes.filter(group.matcher);
      if (!groupNodes.length) return;

      const sectionClass = ['graph-section', 'panel-surface'];
      if (group.title === 'Main Sequence' || group.title === 'Recovery Sequence') sectionClass.push('graph-section-transparent');
      const section = el('div', sectionClass.join(' '));
      section.append(el('div', 'graph-section-title', group.title));
      const graph = el('div', 'graph-grid');

      groupNodes.forEach(function (node, index) {
        const cardClass = ['graph-node', 'panel-surface-soft', 'status-' + (node.status || 'unknown')];
        if (group.title === 'Main Sequence' || group.title === 'Recovery Sequence') cardClass.push('graph-node-transparent');
        const card = el('div', cardClass.join(' '));
        card.dataset.lane = node.lane || 'flow';
        const nodeEventIds = Array.isArray(node.event_ids) ? node.event_ids : [];
        if (currentEvent && (currentEvent.id === node.id || nodeEventIds.indexOf(currentEvent.id) >= 0)) {
          card.classList.add('active');
        }
        card.append(el('div', 'graph-node-type', (node.lane || 'flow') + ' · ' + (node.type || 'step')));
        card.append(el('div', 'graph-node-label', node.label || ('Step ' + (index + 1))));
        if (node.summary) {
          const summary = el('div', 'graph-node-summary');
          appendCompactFormattedSummary(summary, node.summary);
          card.append(summary);
        }
        card.title = [node.label || ('Step ' + (index + 1)), summarizeValue(node.summary || '', 220)].filter(Boolean).join('\n');
        graph.append(card);
        if (index < groupNodes.length - 1) {
          const next = groupNodes[index + 1];
          const edge = edges.find(function (item) { return item.source === node.id && item.target === next.id; }) || {};
          graph.append(el('div', 'graph-arrow graph-arrow-' + (edge.kind || 'flow'), edge.kind === 'recovery' ? '↺' : '→'));
        }
      });

      section.append(graph);
      lanes.append(section);
    });
    container.append(lanes);
  }

  function renderFiles(container) {
    container.innerHTML = '';
    const title = el('h3', 'footer-title', 'File Changes');
    container.append(title);
    const files = state.replay.events.filter(function (event) { return event.type === 'file_change'; });
    if (!files.length) {
      container.append(createEmptyState(
        'No file changes in this replay',
        'This session did not produce any captured file mutation output.',
        [
          'The run may have been inspection-only.',
          'The task may have focused on diagnosis, export, or planning.',
          'A file update may have failed before any diff was recorded.'
        ]
      ));
      return;
    }
    files.forEach(function (event) {
      const item = el('div', 'file-change-card panel-surface status-' + (event.status || 'unknown'));
      item.append(el('div', 'file-change-path', event.file_path || 'Unknown file'));
      item.append(el('div', 'file-change-summary', event.summary || 'Updated file'));
      const pre = el('pre', 'detail-pre diff-pre');
      pre.textContent = event.diff || 'No diff available';
      item.append(pre);
      container.append(item);
    });
  }

  function renderErrors(container, allContainers) {
    container.innerHTML = '';
    const title = el('h3', 'footer-title', 'Error Forensics');
    container.append(title);
    const groups = aggregateErrorGroups();
    if (!groups.length) {
      container.append(createEmptyState(
        'No recurring error pattern detected',
        'This replay does not contain enough failed steps to form a grouped error cluster.',
        [
          'That usually means the run was clean or failures were isolated one-offs.',
          'Use Timeline or Execution Graph if you still want to inspect individual failed steps.'
        ]
      ));
      return;
    }

    groups.forEach(function (group) {
      const card = el('div', 'error-group-card panel-surface');
      card.append(el('div', 'error-group-title', group.errorType));
      const meta = el('div', 'graph-meta');
      meta.append(el('div', 'hero-chip', 'Count: ' + group.count));
      meta.append(el('div', 'hero-chip', 'First seen: ' + (formatEventTimestamp(group.firstSeenAt) || 'n/a')));
      meta.append(el('div', 'hero-chip', 'Tool: ' + (group.toolName || 'unknown')));
      card.append(meta);

      [
        ['Likely cause', group.likelyCause],
        ['Impact', group.impact],
        ['Suggested fix', group.suggestedFix]
      ].forEach(function (pair) {
        const row = el('div', 'forensics-row panel-surface-soft');
        row.append(el('div', 'stage-card-label', pair[0]));
        row.append(el('div', 'stage-card-value', pair[1] || '—'));
        card.append(row);
      });

      const example = group.examples[0];
      const actionRow = el('div', 'tool-actions');
      const jumpButton = el('button', 'secondary-button tool-action-button', 'Jump to first occurrence');
      jumpButton.type = 'button';
      jumpButton.addEventListener('click', function () {
        jumpToEventId(group.firstStepId, allContainers);
      });
      actionRow.append(jumpButton);

      const copyRawButton = el('button', 'secondary-button tool-action-button', 'View raw / copy');
      copyRawButton.type = 'button';
      copyRawButton.addEventListener('click', function () {
        copyTextToClipboard(stringifyForClipboard(example && example.raw), 'error-raw.json', null, 'Raw JSON copied');
      });
      actionRow.append(copyRawButton);
      card.append(actionRow);
      container.append(card);
    });
  }

  function renderFooterTabs(tabbar, panels) {
    tabbar.innerHTML = '';
    [
      ['graph', 'Execution Graph'],
      ['errors', 'Errors'],
      ['files', 'File Changes'],
      ['raw', 'Raw JSON']
    ].forEach(function (pair) {
      const button = el('button', 'footer-tab' + (state.activeTab === pair[0] ? ' active' : ''), pair[1]);
      button.addEventListener('click', function () {
        state.activeTab = pair[0];
        renderFooterTabs(tabbar, panels);
      });
      tabbar.append(button);
    });
    Object.keys(panels).forEach(function (key) {
      panels[key].classList.toggle('hidden-panel', key !== state.activeTab);
    });
  }

  function stopPlayback() {
    state.playing = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function startPlayback(timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, errorsContainer, playButton) {
    stopPlayback();
    state.playing = true;
    playButton.textContent = 'Pause Replay';

    function renderCurrentStep() {
      renderSummary(document.querySelector('.summary-grid.summary-stage'));
      renderTimeline(timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, errorsContainer);
      renderDetail(detailContainer, rawContainer);
      renderGraph(graphContainer);
      renderFiles(filesContainer);
      renderErrors(errorsContainer, {
        summary: document.querySelector('.summary-grid.summary-stage'),
        timeline: timelineContainer,
        detail: detailContainer,
        raw: rawContainer,
        graph: graphContainer,
        files: filesContainer,
        errors: errorsContainer
      });
    }

    state.timer = setTimeout(function advanceReplay() {
      if (!state.playing) return;
      if (state.selectedIndex >= state.replay.events.length - 1) {
        stopPlayback();
        playButton.textContent = 'Play Replay';
        return;
      }
      const currentEvent = state.replay.events[state.selectedIndex] || {};
      const nextEvent = state.replay.events[state.selectedIndex + 1] || {};
      const playbackDelay = computePlaybackDelayMs(currentEvent, nextEvent);
      state.selectedIndex += 1;
      renderCurrentStep();
      if (state.selectedIndex >= state.replay.events.length - 1) {
        stopPlayback();
        playButton.textContent = 'Play Replay';
        return;
      }
      state.timer = window.setTimeout(advanceReplay, playbackDelay);
    }, state.minPlaybackDelayMs);
  }

  function normalizeSessions(payload) {
    const sessions = Array.isArray(payload) ? payload : payload.sessions || [];
    return sessions.map(function (session, index) {
      return {
        id: session.session_id || session.id || session.uuid || 'session-' + index,
        label: session.title || session.name || session.session_id || session.id || 'Untitled Session',
        startedAt: session.last_active || session.started_at || 0,
        raw: session,
      };
    }).sort(function (left, right) {
      if ((left.startedAt || 0) !== (right.startedAt || 0)) return (right.startedAt || 0) - (left.startedAt || 0);
      return String(left.label).localeCompare(String(right.label));
    });
  }

  function renderSessionOptions(select, filterQuery, selectedSessionId) {
    const normalizedFilter = (filterQuery || '').trim().toLowerCase();
    const activeSessionId = selectedSessionId || state.currentSessionId || '';
    select.innerHTML = '';
    const visibleSessions = normalizedFilter
      ? state.sessions.filter(function (session) {
          const haystack = [session.id, session.label].filter(Boolean).join(' ').toLowerCase();
          return haystack.indexOf(normalizedFilter) !== -1;
        })
      : state.sessions.slice();
    if (!visibleSessions.length) {
      const emptyOption = document.createElement('option');
      emptyOption.value = '__empty__';
      emptyOption.textContent = state.sessions.length ? 'No matching sessions — clear the search filter' : 'No upstream sessions found yet';
      select.append(emptyOption);
      select.value = '__empty__';
      return;
    }
    visibleSessions.forEach(function (session) {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = session.label;
      select.append(option);
    });
    const selectedValue = visibleSessions.some(function (session) { return session.id === activeSessionId; }) ? activeSessionId : visibleSessions[0].id;
    select.value = selectedValue;
  }

  function setReplay(replay, summaryContainer, timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, errorsContainer, statusNode, statusMessage) {
    state.replay = replay;
    state.currentReplayExport = replay;
    state.selectedIndex = 0;
    state.activeTab = 'graph';
    state.timelineFilter = 'all';
    state.timelineScrollTop = 0;
    renderSummary(summaryContainer);
    renderTimeline(timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, errorsContainer);
    renderDetail(detailContainer, rawContainer, statusNode);
    renderGraph(graphContainer);
    renderFiles(filesContainer);
    renderErrors(errorsContainer, {
      summary: summaryContainer,
      timeline: timelineContainer,
      detail: detailContainer,
      raw: rawContainer,
      graph: graphContainer,
      files: filesContainer,
      errors: errorsContainer
    });
    statusNode.textContent = statusMessage;
    timelineContainer.scrollTop = 0;
  }

  async function loadFromMessages(sessionId, messages, summaryContainer, timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, errorsContainer, statusNode) {
    statusNode.textContent = 'Parsing replay...';
    state.currentSessionId = sessionId;
    state.currentMessages = messages;
    state.currentReplayExport = { session_id: sessionId, messages };
    try {
      const replay = await parseReplay(sessionId, messages);
      setReplay(replay, summaryContainer, timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, errorsContainer, statusNode, 'Replay ready');
    } catch (error) {
      statusNode.textContent = error.message;
      throw error;
    }
  }

  function attach(root) {
    root.innerHTML = '';
    const shell = el('div', 'cinema-shell dashboard-plugin-shell replay-page');
    const shellHeader = el('div', 'plugin-header');
    const headerCopy = el('div', 'plugin-header-copy');
    headerCopy.append(el('div', 'plugin-eyebrow', 'Hermes Sessions'));
    headerCopy.append(el('h1', 'plugin-title', 'Session Replay'));
    headerCopy.append(el('p', 'plugin-subtitle', 'Review a session as a structured replay with timeline, retries, file changes, error forensics, and exportable artifacts.'));
    const shellMeta = el('div', 'plugin-header-meta');
    shellMeta.append(el('div', 'hero-chip hero-chip-soft', 'Source: Sessions API'));
    shellMeta.append(el('div', 'hero-chip hero-chip-soft', 'View: Replay'));
    shellHeader.append(headerCopy, shellMeta);

    const topbar = el('div', 'cinema-topbar');
    const sessionSelect = document.createElement('select');
    sessionSelect.className = 'session-select panel-surface-soft';
    const sessionInput = document.createElement('input');
    sessionInput.value = state.currentSessionId;
    sessionInput.className = 'session-input panel-surface-soft';
    sessionInput.placeholder = 'Search sessions or enter a session id';

    const refreshSessionsButton = el('button', 'ghost-button', 'Refresh Sessions');
    const playButton = el('button', 'primary-button', 'Play Replay');
    const exportJsonButton = el('button', 'secondary-button', 'Export JSON');
    const exportHtmlButton = el('button', 'secondary-button', 'Export HTML');
    const copyReportButton = el('button', 'secondary-button', 'Copy Report');
    const status = el('div', 'load-status', 'Ready');
    topbar.append(sessionSelect, sessionInput, refreshSessionsButton, playButton, exportJsonButton, exportHtmlButton, copyReportButton, status);
    const shellIntro = el('div', 'plugin-surface-note', 'Select a Hermes session to inspect the execution flow.');

    const summary = el('div', 'summary-grid summary-stage');
    const body = el('div', 'cinema-body panel-surface');
    const timeline = el('div', 'timeline-column');
    const detail = el('div', 'detail-column');
    const rawPanel = el('pre', 'raw-panel');
    body.append(timeline, detail);

    const footer = el('div', 'footer-stack');
    const footerTabs = el('div', 'footer-tabs');
    const graphPanel = el('div', 'footer-panel');
    const errorsPanel = el('div', 'footer-panel');
    const filesPanel = el('div', 'footer-panel');
    const rawWrapper = el('div', 'footer-panel');
    rawWrapper.append(el('h3', 'footer-title', 'Raw JSON'), rawPanel);
    footer.append(footerTabs, graphPanel, errorsPanel, filesPanel, rawWrapper);
    renderFooterTabs(footerTabs, { graph: graphPanel, errors: errorsPanel, files: filesPanel, raw: rawWrapper });

    async function loadInitialSession() {
      const preferredSession = state.sessions[0];
      if (!preferredSession) {
        renderSessionOptions(sessionSelect, '', '');
        status.textContent = 'No upstream sessions found';
        return;
      }
      sessionInput.value = preferredSession.id;
      renderSessionOptions(sessionSelect, '', preferredSession.id);
      await loadSelectedSession(preferredSession.id);
    }

    async function refreshSessions() {
      status.textContent = 'Loading sessions...';
      try {
        const payload = await fetchSessions();
        state.sessions = normalizeSessions(payload);
        const activeSessionId = state.currentSessionId || sessionSelect.value || sessionInput.value.trim();
        renderSessionOptions(sessionSelect, '', activeSessionId);
        status.textContent = state.sessions.length ? 'Sessions loaded from Dashboard' : 'No upstream sessions found';
      } catch (error) {
        state.sessions = [];
        renderSessionOptions(sessionSelect, '', '');
        status.textContent = error.message;
      }
    }

    async function loadSelectedSession(selectedSessionId) {
      const selected = selectedSessionId || sessionSelect.value;
      const typedSessionId = sessionInput.value.trim();
      const sessionIdToLoad = selected && selected !== '__empty__' ? selected : typedSessionId;
      const activeSessionId = sessionIdToLoad || state.currentSessionId || typedSessionId;
      renderSessionOptions(sessionSelect, '', activeSessionId);
      if (!sessionIdToLoad) {
        status.textContent = 'Enter a session id or choose a session';
        return;
      }
      sessionInput.value = sessionIdToLoad;
      status.textContent = 'Loading session replay...';
      try {
        const replay = await fetchSessionReplay(sessionIdToLoad);
        state.currentSessionId = sessionIdToLoad;
        state.currentMessages = [];
        state.currentReplayExport = { session_id: sessionIdToLoad, messages: [], replay };
        setReplay(replay, summary, timeline, detail, rawPanel, graphPanel, filesPanel, errorsPanel, status, 'Replay ready');
      } catch (replayError) {
        status.textContent = 'Loading session messages...';
        try {
          const payload = await fetchSessionMessages(sessionIdToLoad);
          await loadFromMessages(sessionIdToLoad, payload.messages || [], summary, timeline, detail, rawPanel, graphPanel, filesPanel, errorsPanel, status);
        } catch (error) {
          status.textContent = error.message;
        }
      }
    }

    sessionSelect.addEventListener('change', async function () {
      if (sessionSelect.value && sessionSelect.value !== '__empty__') {
        sessionInput.value = sessionSelect.value;
        await loadSelectedSession(sessionSelect.value);
      }
    });

    sessionInput.addEventListener('input', function () {
      const filterQuery = sessionInput.value.trim().toLowerCase();
      renderSessionOptions(sessionSelect, filterQuery, sessionInput.value.trim() || state.currentSessionId);
      if (!filterQuery) {
        renderSessionOptions(sessionSelect, '', state.currentSessionId);
        return;
      }
      if (sessionSelect.value === '__empty__') return;
      const matchingOption = Array.from(sessionSelect.options).find(function (option) {
        return option.value !== '__empty__';
      });
      sessionSelect.value = matchingOption ? matchingOption.value : '__empty__';
    });

    refreshSessionsButton.addEventListener('click', refreshSessions);
    sessionInput.addEventListener('keydown', async function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      await loadSelectedSession();
    });

    playButton.addEventListener('click', function () {
      if (!state.replay) return;
      if (state.playing) {
        stopPlayback();
        playButton.textContent = 'Play Replay';
      } else {
        playButton.textContent = 'Pause Replay';
        startPlayback(timeline, detail, rawPanel, graphPanel, filesPanel, errorsPanel, playButton);
      }
    });

    exportJsonButton.addEventListener('click', function () {
      if (!state.replay) return;
      downloadText((state.replay.session_id || 'replay') + '.json', JSON.stringify(state.replay, null, 2), 'application/json');
      status.textContent = 'JSON exported';
    });

    exportHtmlButton.addEventListener('click', async function () {
      if (!state.replay) return;
      status.textContent = 'Exporting HTML...';
      try {
        const exportPayload = state.currentReplayExport || { session_id: state.currentSessionId, messages: state.currentMessages };
        const payload = await exportHtml(exportPayload.session_id, exportPayload.messages, exportPayload.replay);
        downloadText((payload.session_id || 'replay') + '.html', payload.html, 'text/html;charset=utf-8');
        status.textContent = 'HTML exported';
      } catch (error) {
        downloadText((state.replay.session_id || 'replay') + '.html', buildFallbackHtml(), 'text/html;charset=utf-8');
        status.textContent = 'Offline HTML exported';
      }
    });

    copyReportButton.addEventListener('click', function () {
      if (!state.replay) return;
      copyTextToClipboard(buildMarkdownReport(), (state.replay.session_id || 'replay') + '.md', status, 'Markdown report copied');
    });

    shell.append(shellHeader, topbar, shellIntro, summary, body, footer);
    root.append(shell);
    refreshSessions().then(loadInitialSession).catch(function (error) {
      status.textContent = error && error.message ? error.message : 'Failed to load sessions';
    });
  }

  const pluginApi = {
    id: 'session-replay',
    name: 'Session Replay',
    mount(root) {
      attach(root);
    },
  };

  window.HermesMissionReplayPlugin = pluginApi;
  window.HermesDashboardPlugins = window.HermesDashboardPlugins || {};
  window.HermesDashboardPlugins['session-replay'] = pluginApi;
  window.HermesDashboardPlugin = pluginApi;

  if (window.__HERMES_PLUGINS__ && typeof window.__HERMES_PLUGINS__.register === 'function' && window.__HERMES_PLUGIN_SDK__) {
    const React = window.__HERMES_PLUGIN_SDK__.React;
    const useEffect = window.__HERMES_PLUGIN_SDK__.hooks.useEffect;
    const useRef = window.__HERMES_PLUGIN_SDK__.hooks.useRef;

    function MissionReplayDashboardPage() {
      const hostRef = useRef(null);

      useEffect(function () {
        if (!hostRef.current) return;
        attach(hostRef.current);
      }, []);

      return React.createElement('div', {
        ref: hostRef,
        className: 'session-replay-dashboard-plugin-root',
      });
    }

    window.__HERMES_PLUGINS__.register('session-replay', MissionReplayDashboardPage);
  }

  if (document.currentScript && document.currentScript.dataset.autoMount === 'true') {
    attach(document.body);
  }
})();