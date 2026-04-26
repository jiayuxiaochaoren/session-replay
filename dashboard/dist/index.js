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
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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

  function renderSummary(container) {
    const summary = state.replay.summary;
    const currentEvent = state.replay.events[state.selectedIndex] || {};
    const currentStage = currentEvent.stage || {};
    const totalSteps = summary.total_steps || 0;
    const currentStep = Math.min(state.selectedIndex + 1, totalSteps || 1);
    const progressPercent = totalSteps ? Math.round((currentStep / totalSteps) * 100) : 0;
    const replayMode = state.playing ? 'Playing' : 'Paused';
    container.innerHTML = '';

    const banner = el('div', 'mission-banner');
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

    const liveStage = el('div', 'mission-live-stage');
    liveStage.append(el('div', 'mission-live-label', 'Current Step'));
    liveStage.append(el('div', 'mission-live-title', currentStage.headline || currentEvent.title || 'Session step'));
    liveStage.append(el('div', 'mission-live-summary', currentEvent.summary || ''));
    const liveMeta = el('div', 'mission-live-meta');
    liveMeta.append(el('div', 'hero-chip hero-chip-soft', 'Stage: ' + (currentStage.kicker || currentEvent.type || 'step')));
    liveMeta.append(el('div', 'hero-chip hero-chip-soft', 'Status: ' + (currentEvent.status || 'unknown')));
    if (currentEvent.duration_ms) liveMeta.append(el('div', 'hero-chip hero-chip-soft', 'Duration: ' + currentEvent.duration_ms + 'ms'));
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
      ['Tool calls', String(summary.tool_calls)],
      ['Errors', String(summary.errors)],
      ['Retries', String(summary.retries)],
      ['Files changed', String(summary.files_changed || 0)],
      ['Duration', summary.duration_label],
      ['Bottleneck', summary.main_bottleneck || 'n/a'],
    ];

    cards.forEach(function (pair) {
      const value = String(pair[1] == null ? '—' : pair[1]);
      const cardClass = ['summary-card'];
      if (pair[0] === 'Status' || pair[0] === 'Bottleneck') cardClass.push('summary-card-wide');
      if (pair[0] === 'Current Step') cardClass.push('summary-card-current-step');
      const valueClass = value.length > 18 ? 'summary-value summary-value-compact' : 'summary-value';
      const card = el('div', cardClass.join(' '));
      card.append(el('div', 'summary-label', pair[0]));
      card.append(el('div', valueClass, value));
      container.append(card);
    });
  }

  function timelineAccentClass(event) {
    if (event.status === 'failed' || event.type === 'error') return 'accent-failed';
    if (event.status === 'retrying' || event.type === 'retry') return 'accent-retry';
    if (event.type === 'tool_call') return 'accent-tool';
    if (event.type === 'agent_intent' || event.type === 'final_answer') return 'accent-model';
    if (event.status === 'success' || event.type === 'tool_result' || event.type === 'file_change') return 'accent-success';
    return 'accent-normal';
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

  function renderTimeline(container, detailContainer, rawContainer, graphContainer, filesContainer) {
    container.innerHTML = '';
    const heading = el('div', 'panel-section-heading');
    heading.append(el('div', 'panel-section-kicker', 'Timeline'));
    heading.append(el('div', 'panel-section-title', 'Timeline'));
    container.append(heading);
    const filterBar = el('div', 'timeline-filter-bar');
    [
      ['all', 'All Events'],
      ['errors', 'Errors'],
      ['tool_calls', 'Tool Calls'],
      ['file_changes', 'File Changes'],
      ['retries', 'Retries'],
      ['long_running', 'Long-running']
    ].forEach(function (pair) {
      const filterButton = el('button', 'filter-chip' + (state.timelineFilter === pair[0] ? ' active' : ''), pair[1]);
      filterButton.type = 'button';
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
        renderTimeline(container, detailContainer, rawContainer, graphContainer, filesContainer);
        renderDetail(detailContainer, rawContainer);
        renderGraph(graphContainer);
        renderFiles(filesContainer);
      });
      filterBar.append(filterButton);
    });
    container.append(filterBar);
    const filteredEvents = state.replay.events.filter(function (event) {
      return eventMatchesTimelineFilter(event, state.timelineFilter);
    });
    if (!filteredEvents.length) {
      container.append(el('div', 'empty-state', 'No events match the current filter.'));
      return;
    }
    filteredEvents.forEach(function (event) {
      const index = state.replay.events.indexOf(event);
      const button = el('button', 'timeline-item status-' + (event.status || 'unknown') + ' ' + timelineAccentClass(event));
      if (index === state.selectedIndex) button.classList.add('active');
      if (index === state.selectedIndex) button.setAttribute('aria-current', 'step');
      if (index < state.selectedIndex) button.classList.add('completed');
      if (index > state.selectedIndex) button.classList.add('upcoming');
      button.append(el('div', 'timeline-step-index', (event.stage && event.stage.kicker) || event.type || 'event'));
      button.append(el('div', 'timeline-runtime', buildRuntimeMeta(event)));
      button.append(el('div', 'timeline-title', event.title || event.type));
      button.addEventListener('click', function () {
        state.selectedIndex = index;
        renderSummary(document.querySelector('.summary-grid.summary-stage'));
        renderTimeline(container, detailContainer, rawContainer, graphContainer, filesContainer);
        renderDetail(detailContainer, rawContainer);
        renderGraph(graphContainer);
        renderFiles(filesContainer);
        button.scrollIntoView({ block: 'nearest' });
      });
      container.append(button);
    });
  }

  function renderDetail(container, rawContainer) {
    const event = state.replay.events[state.selectedIndex] || {};
    const stage = event.stage || {};
    container.innerHTML = '';

    const hero = el('div', 'replay-stage status-' + (event.status || 'unknown'));
    hero.append(el('div', 'detail-kicker', 'Event Details'));
    hero.append(el('h2', 'detail-title', stage.headline || event.title || 'Current Event'));
    hero.append(el('div', 'detail-meta', [formatEventTimestamp(event.timestamp), event.status || '', event.duration_ms ? 'Exec ' + formatDurationMs(event.duration_ms) : '', formatTokenCount(event.token_count)].filter(Boolean).join(' · ')));

    const summary = el('p', 'detail-summary', event.summary || '');
    hero.append(summary);

    const pillRow = el('div', 'pill-row');
    if (event.tool_name) pillRow.append(el('div', 'pill', 'Tool: ' + event.tool_name));
    if (event.tool_call_id) pillRow.append(el('div', 'pill', 'Call ID: ' + event.tool_call_id));
    if (event.file_path) pillRow.append(el('div', 'pill', 'File: ' + event.file_path));
    if (pillRow.childNodes.length) hero.append(pillRow);

    const grid = el('div', 'stage-grid');
    [
      ['Context', stage.why || event.summary || ''],
      ['Action', stage.action || event.summary || ''],
      ['Observation', stage.observation || event.summary || ''],
      ['Outcome', stage.result || event.summary || '']
    ].forEach(function (pair) {
      const section = el('div', 'stage-card');
      section.append(el('div', 'stage-card-label', pair[0]));
      section.append(el('div', 'stage-card-value', pair[1] || '—'));
      grid.append(section);
    });
    hero.append(grid);

    if (event.args) {
      const block = el('div', 'stage-block');
      block.append(el('div', 'stage-card-label', 'Tool Input'));
      const pre = el('pre', 'detail-pre detail-pre-fixed');
      pre.textContent = JSON.stringify(event.args, null, 2);
      block.append(pre);
      hero.append(block);
    }
    if (event.type === 'tool_result' || event.type === 'error') {
      const outputValue = event.raw == null ? '' : JSON.stringify(event.raw, null, 2);
      if (outputValue) {
        const block = el('div', 'stage-block');
        block.append(el('div', 'stage-card-label', 'Tool Output'));
        const pre = el('pre', 'detail-pre detail-pre-fixed');
        pre.textContent = outputValue;
        block.append(pre);
        hero.append(block);
      }
    }
    if (event.diff) {
      const block = el('div', 'stage-block');
      block.append(el('div', 'stage-card-label', 'File Diff'));
      const diff = el('pre', 'detail-pre detail-pre-fixed diff-pre');
      diff.textContent = event.diff;
      block.append(diff);
      hero.append(block);
    }

    container.append(hero);
    rawContainer.textContent = JSON.stringify(event.raw || {}, null, 2);
  }

  function renderGraph(container) {
    container.innerHTML = '';
    const title = el('h3', 'footer-title', 'Execution Graph');
    container.append(title);

    const nodes = (state.replay.graph && state.replay.graph.nodes) || [];
    const edges = (state.replay.graph && state.replay.graph.edges) || [];
    const currentEvent = state.replay.events[state.selectedIndex] || {};

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

      const section = el('div', 'graph-section');
      section.append(el('div', 'graph-section-title', group.title));
      const graph = el('div', 'graph-grid');

      groupNodes.forEach(function (node, index) {
        const card = el('div', 'graph-node status-' + (node.status || 'unknown'));
        card.dataset.lane = node.lane || 'flow';
        const nodeEventIds = Array.isArray(node.event_ids) ? node.event_ids : [];
        if (currentEvent && (currentEvent.id === node.id || nodeEventIds.indexOf(currentEvent.id) >= 0)) {
          card.classList.add('active');
        }
        card.append(el('div', 'graph-node-type', (node.lane || 'flow') + ' · ' + (node.type || 'step')));
        card.append(el('div', 'graph-node-label', node.label || ('Step ' + (index + 1))));
        if (node.summary) card.append(el('div', 'graph-node-summary', node.summary));
        card.title = [node.label || ('Step ' + (index + 1)), node.summary || ''].filter(Boolean).join('\n');
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
      container.append(el('div', 'empty-state', 'No file changes detected for this session.'));
      return;
    }
    files.forEach(function (event) {
      const item = el('div', 'file-change-card status-' + (event.status || 'unknown'));
      item.append(el('div', 'file-change-path', event.file_path || 'Unknown file'));
      item.append(el('div', 'file-change-summary', event.summary || 'Updated file'));
      const pre = el('pre', 'detail-pre diff-pre');
      pre.textContent = event.diff || 'No diff available';
      item.append(pre);
      container.append(item);
    });
  }

  function renderFooterTabs(tabbar, panels) {
    tabbar.innerHTML = '';
    [
      ['graph', 'Execution Graph'],
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

  function startPlayback(timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, playButton) {
    stopPlayback();
    state.playing = true;
    playButton.textContent = 'Pause Replay';

    function renderCurrentStep() {
      renderSummary(document.querySelector('.summary-grid.summary-stage'));
      renderTimeline(timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer);
      renderDetail(detailContainer, rawContainer);
      renderGraph(graphContainer);
      renderFiles(filesContainer);
      const activeItem = timelineContainer.querySelector('.timeline-item.active');
      if (activeItem) activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
      emptyOption.textContent = state.sessions.length ? 'No matching sessions' : 'No upstream sessions found';
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

  function setReplay(replay, summaryContainer, timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, statusNode, statusMessage) {
    state.replay = replay;
    state.currentReplayExport = replay;
    state.selectedIndex = 0;
    state.activeTab = 'graph';
    state.timelineFilter = 'all';
    renderSummary(summaryContainer);
    renderTimeline(timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer);
    renderDetail(detailContainer, rawContainer);
    renderGraph(graphContainer);
    renderFiles(filesContainer);
    statusNode.textContent = statusMessage;
    timelineContainer.scrollTop = 0;
  }

  async function loadFromMessages(sessionId, messages, summaryContainer, timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, statusNode) {
    statusNode.textContent = 'Parsing replay...';
    state.currentSessionId = sessionId;
    state.currentMessages = messages;
    state.currentReplayExport = { session_id: sessionId, messages };
    try {
      const replay = await parseReplay(sessionId, messages);
      setReplay(replay, summaryContainer, timelineContainer, detailContainer, rawContainer, graphContainer, filesContainer, statusNode, 'Replay ready');
    } catch (error) {
      statusNode.textContent = error.message;
      throw error;
    }
  }

  function attach(root) {
    root.innerHTML = '';
    const shell = el('div', 'cinema-shell dashboard-plugin-shell');
    const shellHeader = el('div', 'plugin-header');
    const headerCopy = el('div', 'plugin-header-copy');
    headerCopy.append(el('div', 'plugin-eyebrow', 'Hermes Sessions'));
    headerCopy.append(el('h1', 'plugin-title', 'Session Replay'));
    headerCopy.append(el('p', 'plugin-subtitle', 'Review a session as a structured replay with timeline, retries, file changes, and exportable artifacts.'));
    const shellMeta = el('div', 'plugin-header-meta');
    shellMeta.append(el('div', 'hero-chip hero-chip-soft', 'Source: Sessions API'));
    shellMeta.append(el('div', 'hero-chip hero-chip-soft', 'View: Replay'));
    shellHeader.append(headerCopy, shellMeta);
    const topbar = el('div', 'cinema-topbar');
    const sessionSelect = document.createElement('select');
    sessionSelect.className = 'session-select';
    const sessionInput = document.createElement('input');
    sessionInput.value = state.currentSessionId;
    sessionInput.className = 'session-input';
    sessionInput.placeholder = 'Search sessions or enter a session id';

    const refreshSessionsButton = el('button', 'ghost-button', 'Refresh Sessions');
    const playButton = el('button', 'primary-button', 'Play Replay');
    const exportJsonButton = el('button', 'secondary-button', 'Export JSON');
    const exportHtmlButton = el('button', 'secondary-button', 'Export HTML');
    const status = el('div', 'load-status', 'Ready');
    topbar.append(sessionSelect, sessionInput, refreshSessionsButton, playButton, exportJsonButton, exportHtmlButton, status);
    const shellIntro = el('div', 'plugin-surface-note', 'Select a Hermes session to inspect the execution flow.');

    const summary = el('div', 'summary-grid summary-stage');
    const body = el('div', 'cinema-body');
    const timeline = el('div', 'timeline-column');
    const detail = el('div', 'detail-column');
    const rawPanel = el('pre', 'raw-panel');
    body.append(timeline, detail);

    const footer = el('div', 'footer-stack');
    const footerTabs = el('div', 'footer-tabs');
    const graphPanel = el('div', 'footer-panel');
    const filesPanel = el('div', 'footer-panel');
    const rawWrapper = el('div', 'footer-panel');
    rawWrapper.append(el('h3', 'footer-title', 'Raw JSON'), rawPanel);
    footer.append(footerTabs, graphPanel, filesPanel, rawWrapper);
    renderFooterTabs(footerTabs, { graph: graphPanel, files: filesPanel, raw: rawWrapper });

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
        const filterQuery = sessionInput.value.trim().toLowerCase();
        renderSessionOptions(sessionSelect, filterQuery, state.currentSessionId);
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
      const activeSessionId = selectedSessionId || state.currentSessionId || sessionInput.value.trim();
      renderSessionOptions(sessionSelect, '', activeSessionId);
      const sessionIdToLoad = selected && selected !== '__empty__' ? selected : typedSessionId;
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
        setReplay(replay, summary, timeline, detail, rawPanel, graphPanel, filesPanel, status, 'Replay ready');
      } catch (replayError) {
        status.textContent = 'Loading session messages...';
        try {
          const payload = await fetchSessionMessages(sessionIdToLoad);
          await loadFromMessages(sessionIdToLoad, payload.messages || [], summary, timeline, detail, rawPanel, graphPanel, filesPanel, status);
        } catch (error) {
          status.textContent = error.message;
        }
      }
    }

    sessionSelect.addEventListener('change', async function () {
      if (sessionSelect.value && sessionSelect.value !== '__empty__') {
        sessionInput.value = sessionSelect.value;
        await loadSelectedSession();
      }
    });

    sessionInput.addEventListener('input', function () {
      const filterQuery = sessionInput.value.trim().toLowerCase();
      renderSessionOptions(sessionSelect, filterQuery, state.currentSessionId);
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
        startPlayback(timeline, detail, rawPanel, graphPanel, filesPanel, playButton);
      }
    });

    exportJsonButton.addEventListener('click', function () {
      if (!state.replay) return;
      downloadText((state.replay.session_id || 'replay') + '.json', JSON.stringify(state.replay, null, 2), 'application/json');
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
