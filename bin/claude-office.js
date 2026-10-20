#!/usr/bin/env node
// Claude Code 세션 기록(~/.claude/projects/*/*.jsonl)을 tail해서 SSE(/events)로 브라우저에 보낸다.
// 세션 기록은 도구가 끝난 뒤에 쓰이므로, 실행 중인 도구는 훅(bin/hook.js)이 남기는 live.jsonl 로 먼저 잡는다.
// 같은 훅 기록의 Stop·PermissionRequest·AskUserQuestion 은 SSE 'cue' 이벤트로 보내 브라우저가 효과음을 낸다.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)) || process.env.PORT || 4747);
const noOpen = args.includes('--no-open');
const HOME = os.homedir();
const ROOT = path.join(HOME, '.claude', 'projects');
// 데스크톱 앱 Cowork 세션은 세션마다 따로 둔 설정 폴더에 기록한다.
const COWORK = path.join(HOME, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
const LIVE = path.join(HOME, '.claude-office', 'live.jsonl');
const GONE_FILE = path.join(HOME, '.claude-office', 'gone.json'); // 퇴근한 세션 id -> 퇴근 시각. 서버를 다시 켜도 휴게실로 돌아오지 않게 남긴다
const PUBLIC = path.join(__dirname, '..', 'public');
const POLL_MS = 250;
const DISCOVER_MS = 3000;
const SUBSCAN_MS = 1000;
const RECENT_MS = 6 * 3600 * 1000;
const ACTIVE_MS = 90 * 1000;
const STALE_MS = 30 * 60 * 1000; // 이보다 오래 소식이 없는 실행 중 도구·서브에이전트는 끝난 것으로 본다
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

const ROOM_BY_TOOL = (name) => {
  if (/^(Read|Grep|Glob|LS)$/.test(name)) return 'library';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'dev';
  if (/^(Bash|BashOutput|KillShell|Monitor)$/.test(name)) return 'server';
  if (/^(WebSearch|WebFetch)$/.test(name) || name.startsWith('mcp__')) return 'info';
  if (/^(TodoWrite|Task.*|Agent|ExitPlanMode|EnterPlanMode)$/.test(name)) return 'meeting';
  if (name === 'AskUserQuestion') return 'desk';
  return 'dev';
};

// 퇴근: SessionEnd 훅(/exit·/clear·터미널 종료)이나 화면의 퇴근 버튼. 그 뒤에 새 메시지가 오면(재개) 다시 출근한다.
let gone = {};
try { gone = JSON.parse(fs.readFileSync(GONE_FILE, 'utf8')); } catch { /* 처음 */ }
for (const [id, t] of Object.entries(gone)) if (Date.now() - t > RECENT_MS) delete gone[id];
const saveGone = () => { try { fs.writeFileSync(GONE_FILE, JSON.stringify(gone)); } catch { /* 표시용이라 무시 */ } };

const sessions = new Map(); // file -> state
const byId = new Map(); // session id -> state
const log = [];
let dirty = true;

const clip = (s, n = 60) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const summarize = (name, input = {}) => {
  if (name === 'Bash') return clip(`Bash ${input.description || String(input.command || '').split('\n')[0]}`, 70);
  const v = input.file_path || input.path || input.pattern || input.query || input.url || input.description || '';
  const base = /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(name) ? path.basename(String(v)) : v;
  return clip(base ? `${name} ${base}` : name, 70);
};
const resultText = (c) => (typeof c.content === 'string' ? c.content : (Array.isArray(c.content) && c.content[0] && c.content[0].text) || '');

function pushLog(s, text) {
  log.unshift({ t: Date.now(), who: s.short, text: clip(text, 90) });
  if (log.length > 40) log.pop();
}

function addSub(s, key, type, desc, t) {
  if (s.subs.has(key)) return s.subs.get(key);
  const sub = { type: type || 'general', desc: clip(desc, 40), t: t || Date.now() };
  s.subs.set(key, sub);
  pushLog(s, `서브에이전트 출근: ${sub.type}`);
  dirty = true;
  return sub;
}
function dropSub(s, key) {
  if (!s.subs.has(key)) return;
  pushLog(s, `퇴근합니다! ${s.subs.get(key).type}`);
  s.subs.delete(key);
  s.doneSubs.add(key);
  dirty = true;
}

function dismiss(s, t, why) {
  if (s.gone) return;
  s.gone = t;
  s.running.clear();
  for (const key of [...s.subs.keys()]) dropSub(s, key);
  gone[s.id] = t;
  saveGone();
  pushLog(s, `퇴근합니다! (${why})`);
  dirty = true;
}
function rehire(s) {
  s.gone = 0;
  delete gone[s.id];
  saveGone();
  pushLog(s, '다시 출근했습니다');
}

function handle(s, obj) {
  if (obj.isSidechain) return;
  if (s.gone && (obj.type === 'user' || obj.type === 'assistant') && Date.parse(obj.timestamp) > s.gone + 1000) rehire(s);
  if (obj.cwd) s.cwd = obj.cwd;
  if (obj.type === 'ai-title' && obj.aiTitle) { s.aiTitle = clip(obj.aiTitle, 40); dirty = true; return; }
  if (obj.type === 'custom-title' && obj.customTitle) { s.customTitle = clip(obj.customTitle, 40); dirty = true; return; }
  const ts = Date.parse(obj.timestamp) || Date.now();
  const content = obj.message && obj.message.content;
  if (obj.type === 'assistant' && Array.isArray(content)) {
    s.last = Math.max(s.last, ts);
    for (const c of content) {
      if (c.type === 'thinking') {
        s.bubble = { kind: 'think', text: '고민 중…' };
      } else if (c.type === 'text' && c.text.trim()) {
        s.bubble = { kind: 'say', text: clip(c.text, 80) };
      } else if (c.type === 'tool_use') {
        s.tools.set(c.id, c.name);
        if (/^(Task|Agent)$/.test(c.name) && !s.doneSubs.has(c.id)) addSub(s, c.id, c.input && c.input.subagent_type, c.input && c.input.description, ts);
        if (s.live.has(c.id)) continue; // 훅이 시작 시점에 이미 반영했다
        s.tool = c.name;
        s.room = ROOM_BY_TOOL(c.name);
        s.bubble = { kind: 'tool', text: summarize(c.name, c.input) };
        pushLog(s, s.bubble.text);
      }
    }
  } else if (obj.type === 'user') {
    s.last = Math.max(s.last, ts);
    const prompt = typeof content === 'string' ? content
      : Array.isArray(content) && !content.some((c) => c.type === 'tool_result') ? content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : null;
    if (prompt != null && !obj.isMeta) {
      if (!s.title && prompt && !prompt.startsWith('<')) s.title = clip(prompt, 40);
      s.bubble = { kind: 'think', text: '고민 중…' };
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        s.running.delete(c.tool_use_id);
        // 백그라운드 서브에이전트는 띄우자마자 결과가 돌아온다. 퇴근은 subagents/*.meta.json 의 finished 로 판단한다.
        if (s.subs.has(c.tool_use_id) && !/^Async agent launched/.test(resultText(c))) dropSub(s, c.tool_use_id);
        if (c.is_error) {
          s.bubble = { kind: 'error', text: clip(resultText(c), 70) || '도구 실패' };
          pushLog(s, `실패: ${s.bubble.text}`);
        }
      }
    }
  }
  dirty = true;
}

function ingest(s, text) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { handle(s, JSON.parse(line)); } catch { /* 쓰는 중인 마지막 줄 */ }
  }
}

function readSlice(file, start, len) {
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, len, start);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

function track(file, st) {
  const id = path.basename(file, '.jsonl');
  const s = {
    file, id, short: id.slice(0, 6), project: path.basename(path.dirname(file)), cwd: '',
    title: '', room: 'dev', tool: '', bubble: null, last: 0,
    tools: new Map(), subs: new Map(), doneSubs: new Set(), agentKey: new Map(), metaSeen: new Map(),
    live: new Set(), running: new Map(), offset: 0, rest: '', gone: gone[id] || 0,
  };
  sessions.set(file, s);
  byId.set(id, s);
  // 처음 보는 파일은 마지막 128KB만 읽어서 현재 상태를 복원한다.
  const start = Math.max(0, st.size - 128 * 1024);
  let text = readSlice(file, start, st.size - start);
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  s.offset = st.size;
  if (start > 0) scanTitle(s, readSlice(file, 0, Math.min(start, 256 * 1024)));
  scanSubs(s, true);
  ingest(s, text);
  // 활동 시각은 메시지 타임스탬프로 잡는다. 메시지가 없는 파일만 수정 시각을 쓴다.
  if (!s.last) s.last = st.mtimeMs;
}

// 긴 세션은 첫 질문이 꼬리 128KB 밖에 있으므로, 앞부분에서 제목만 따로 찾는다.
function scanTitle(s, text) {
  for (const line of text.split('\n')) {
    if (s.title) return;
    if (!line.includes('"type":"user"')) continue;
    try {
      const obj = JSON.parse(line);
      const c = obj.message && obj.message.content;
      const prompt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
      if (!obj.isMeta && !obj.isSidechain && prompt && !prompt.startsWith('<')) s.title = clip(prompt, 40);
    } catch { /* 잘린 마지막 줄 */ }
  }
}

// 서브에이전트 기록은 <세션ID>/subagents/agent-<agentId>.jsonl(+.meta.json)에 따로 쌓인다.
function scanSubs(s, initial) {
  const dir = path.join(path.dirname(s.file), s.id, 'subagents');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    const m = /^agent-(.+)\.meta\.json$/.exec(f);
    if (!m) continue;
    const agentId = m[1];
    let meta, mst, jst;
    try {
      mst = fs.statSync(path.join(dir, f));
      const seen = s.metaSeen.get(agentId);
      meta = seen && seen.mtime === mst.mtimeMs ? seen.meta : JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      s.metaSeen.set(agentId, { mtime: mst.mtimeMs, meta, jmtime: seen && seen.jmtime });
    } catch { continue; }
    const key = meta.toolUseId || agentId;
    s.agentKey.set(agentId, key);
    const jfile = path.join(dir, `agent-${agentId}.jsonl`);
    try { jst = fs.statSync(jfile); } catch { jst = mst; }
    if (meta.finished || now - jst.mtimeMs > STALE_MS) {
      if (initial) s.doneSubs.add(key); else dropSub(s, key);
      continue;
    }
    if (s.doneSubs.has(key)) continue; // 퇴근 버튼으로 내보낸 서브에이전트
    const sub = addSub(s, key, meta.agentType, meta.description, jst.mtimeMs);
    sub.agent = agentId;
    const seen = s.metaSeen.get(agentId);
    if (seen.jmtime !== jst.mtimeMs) { seen.jmtime = jst.mtimeMs; tailSub(sub, jfile, jst.size); }
  }
}

// 훅이 없는 환경(Cowork 등)에서도 서브에이전트가 무엇을 하는지 보이도록 기록 끝부분의 마지막 도구를 읽는다.
function tailSub(sub, file, size) {
  if (sub.hookT && Date.now() - sub.hookT < 5000) return;
  const start = Math.max(0, size - 32 * 1024);
  let text;
  try { text = readSlice(file, start, size - start); } catch { return; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"tool_use"')) continue;
    try {
      const obj = JSON.parse(lines[i]);
      const c = (obj.message.content || []).filter((x) => x.type === 'tool_use').pop();
      if (!c) continue;
      sub.room = ROOM_BY_TOOL(c.name);
      sub.bubble = { kind: 'tool', text: summarize(c.name, c.input) };
      dirty = true;
      return;
    } catch { /* 잘린 줄 */ }
  }
}

function readNew(s, st) {
  if (st.size < s.offset) { s.offset = 0; s.rest = ''; }
  if (st.size === s.offset) return;
  const text = s.rest + readSlice(s.file, s.offset, st.size - s.offset);
  s.offset = st.size;
  const cut = text.lastIndexOf('\n');
  s.rest = text.slice(cut + 1);
  ingest(s, text.slice(0, cut + 1));
}

// 훅 기록(live.jsonl)
let liveOffset = 0;
let liveRest = '';
try { liveOffset = fs.statSync(LIVE).size; } catch { /* 아직 훅이 한 번도 안 불렸다 */ }

// 효과음 신호: 답변을 마치면 done, 사용자 입력을 기다리면(AskUserQuestion·권한 요청) ask.
// AskUserQuestion 은 PreToolUse 와 PermissionRequest 가 함께 올 수 있어 같은 신호는 2초 안에 한 번만 보낸다.
const lastCue = new Map(); // session id -> { kind, t }
function cueOf(r) {
  if (r.agent) return null;
  if (r.ev === 'Stop') return { kind: 'done', text: '답변 완료' };
  if (r.ev === 'PermissionRequest') return r.tool === 'AskUserQuestion' ? { kind: 'ask', text: '질문이 있어요' } : { kind: 'ask', text: `권한 요청: ${r.tool}` };
  if (r.ev === 'PreToolUse' && r.tool === 'AskUserQuestion') return { kind: 'ask', text: '질문이 있어요' };
  return null;
}
function cue(r) {
  const c = cueOf(r);
  if (!c) return;
  const prev = lastCue.get(r.sid);
  if (prev && prev.kind === c.kind && r.t - prev.t < 2000) return;
  lastCue.set(r.sid, { kind: c.kind, t: r.t });
  const s = byId.get(r.sid);
  if (s) { pushLog(s, c.text); dirty = true; }
  const data = `event: cue\ndata: ${JSON.stringify({ kind: c.kind, sid: r.sid, text: c.text, title: s ? (s.customTitle || s.aiTitle || s.title || s.short) : '' })}\n\n`;
  for (const cl of clients) cl.write(data);
}

function applyLive(r) {
  cue(r);
  const s = byId.get(r.sid);
  if (r.ev === 'SessionEnd' && !r.agent) {
    if (s) dismiss(s, r.t, '세션 종료'); else { gone[r.sid] = r.t; saveGone(); }
    return;
  }
  if (!s) return;
  if (s.gone && r.ev === 'PreToolUse' && r.t > s.gone + 1000) rehire(s);
  s.last = Math.max(s.last, r.t);
  const sum = /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(r.tool) ? path.basename(r.sum) : r.sum;
  const text = clip(sum ? `${r.tool} ${sum}` : r.tool, 70);
  if (r.agent) {
    let key = s.agentKey.get(r.agent);
    if (!key) { scanSubs(s); key = s.agentKey.get(r.agent); }
    const sub = key && s.subs.get(key);
    if (r.ev === 'SubagentStop') { if (key) dropSub(s, key); return; }
    if (!sub) return; // 제목 생성 같은 내부 보조 에이전트
    if (r.ev === 'PreToolUse') { sub.room = ROOM_BY_TOOL(r.tool); sub.bubble = { kind: 'tool', text }; sub.hookT = r.t; }
    dirty = true;
    return;
  }
  if (r.ev === 'PreToolUse') {
    if (s.tools.has(r.id)) return; // 세션 기록이 먼저 도착했다(이미 끝난 도구)
    s.live.add(r.id);
    s.running.set(r.id, r.t);
    s.tool = r.tool;
    s.room = ROOM_BY_TOOL(r.tool);
    s.bubble = { kind: 'tool', text };
    pushLog(s, text);
    if (/^(Task|Agent)$/.test(r.tool) && r.id) addSub(s, r.id, r.st, r.sum, r.t);
  } else if (r.ev === 'PostToolUse' || r.ev === 'PostToolUseFailure') {
    s.running.delete(r.id);
  }
  dirty = true;
}

function readLive() {
  let st;
  try { st = fs.statSync(LIVE); } catch { return; }
  if (st.size < liveOffset) { liveOffset = 0; liveRest = ''; }
  if (st.size === liveOffset) return;
  const text = liveRest + readSlice(LIVE, liveOffset, st.size - liveOffset);
  liveOffset = st.size;
  const cut = text.lastIndexOf('\n');
  liveRest = text.slice(cut + 1);
  for (const line of text.slice(0, cut + 1).split('\n')) {
    if (!line) continue;
    try { applyLive(JSON.parse(line)); } catch { /* 잘린 줄 */ }
  }
}

function roots() {
  const list = [ROOT];
  // local-agent-mode-sessions/<계정>/<조직>/<세션>/.claude/projects
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      if (depth === 0) { const proj = path.join(p, '.claude', 'projects'); if (fs.existsSync(proj)) list.push(proj); }
      else walk(p, depth - 1);
    }
  };
  walk(COWORK, 2);
  return list;
}

function discover() {
  const now = Date.now();
  for (const root of roots()) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const dir = path.join(root, d);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(dir, f);
        if (sessions.has(file)) continue;
        try {
          const st = fs.statSync(file);
          if (now - st.mtimeMs < RECENT_MS) track(file, st);
        } catch { /* 지워진 파일 */ }
      }
    }
  }
}

function forget(file) {
  const s = sessions.get(file);
  sessions.delete(file);
  if (s && byId.get(s.id) === s) byId.delete(s.id);
  dirty = true;
}

function poll() {
  const now = Date.now();
  readLive(); // 훅 기록을 먼저 읽어야 같은 틱에 들어온 세션 기록과 겹치지 않는다
  for (const [file, s] of sessions) {
    try {
      const st = fs.statSync(file);
      readNew(s, st);
      if (now - st.mtimeMs > RECENT_MS) forget(file);
    } catch { forget(file); }
  }
}

function snapshot() {
  const now = Date.now();
  const floors = new Map();
  for (const s of sessions.values()) {
    if (s.gone) continue;
    for (const [id, t] of s.running) if (now - t > STALE_MS) s.running.delete(id);
    const idle = now - s.last > ACTIVE_MS && s.running.size === 0;
    const name = (s.cwd && path.basename(s.cwd)) || s.project;
    if (!floors.has(s.project)) floors.set(s.project, { id: s.project, name, cwd: s.cwd, sessions: [], active: 0, last: 0 });
    const f = floors.get(s.project);
    if (s.cwd) { f.name = path.basename(s.cwd); f.cwd = s.cwd; }
    f.last = Math.max(f.last, s.last);
    if (!idle) f.active++;
    f.sessions.push({
      id: s.id, short: s.short, title: s.customTitle || s.aiTitle || s.title || s.short, room: idle ? 'lounge' : s.room, tool: s.tool,
      bubble: idle ? null : s.bubble, idle, last: s.last, running: s.running.size,
      subs: [...s.subs.entries()].map(([id, v]) => ({ id, type: v.type, desc: v.desc, room: v.room || null, bubble: v.bubble || null })),
    });
  }
  return { now, floors: [...floors.values()].sort((a, b) => b.last - a.last), log };
}

const clients = new Set();
function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) c.write(data);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/dismiss?')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const s = byId.get(q.get('sid'));
    if (!s) return res.writeHead(404).end();
    if (q.get('sub')) dropSub(s, q.get('sub')); else dismiss(s, Date.now(), '퇴근 버튼');
    dirty = true;
    return res.writeHead(204).end();
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html'; } catch { rel = ''; }
  const file = path.join(PUBLIC, rel);
  if (!rel || !file.startsWith(PUBLIC + path.sep)) return res.writeHead(404).end();
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `포트 ${port}이(가) 이미 사용 중입니다. 이미 실행 중이거나 'claude-office <다른포트>'로 실행하세요.` : e.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Claude Office → ${url}  (Ctrl+C로 종료)`);
  if (!noOpen) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
});

discover();
setInterval(discover, DISCOVER_MS);
setInterval(() => { for (const s of sessions.values()) scanSubs(s); }, SUBSCAN_MS);
setInterval(() => { poll(); if (dirty) { dirty = false; broadcast(); } }, POLL_MS);
setInterval(broadcast, 5000); // idle 전환 반영
