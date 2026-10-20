#!/usr/bin/env node
// Claude Code 훅(PreToolUse·PostToolUse·SubagentStart·SubagentStop·Stop·PermissionRequest·SessionEnd)이 부르는 기록기.
// 세션 기록 파일은 도구가 끝난 뒤에야 쓰이므로, 시작 시점을 ~/.claude-office/live.jsonl 에 따로 남긴다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIVE = path.join(os.homedir(), '.claude-office', 'live.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    const h = JSON.parse(raw);
    const input = h.tool_input || {};
    const v = input.description || input.file_path || input.path || input.pattern || input.query || input.url || String(input.command || '').split('\n')[0] || '';
    const rec = {
      t: Date.now(),
      ev: h.hook_event_name,
      sid: h.session_id,
      agent: h.agent_id || '',
      atype: h.agent_type || '',
      tool: h.tool_name || '',
      id: h.tool_use_id || '',
      sum: String(v).replace(/\s+/g, ' ').trim().slice(0, 80),
      st: input.subagent_type || '',
      cwd: h.cwd || '',
    };
    try { if (fs.statSync(LIVE).size > MAX_BYTES) fs.truncateSync(LIVE, 0); } catch { /* 첫 기록 */ }
    fs.appendFileSync(LIVE, JSON.stringify(rec) + '\n');
  } catch { /* 대시보드용 기록이라 실패해도 도구 실행을 막지 않는다 */ }
});
