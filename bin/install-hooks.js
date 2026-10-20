#!/usr/bin/env node
// ~/.claude/settings.json 에 Claude Office 훅을 넣는다. 이미 들어 있는 이벤트는 건너뛰고, 다른 설정은 건드리지 않는다.
//   node bin/install-hooks.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.join(__dirname, 'hook.js');
const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'PermissionRequest'];
const NO_MATCHER = new Set(['Stop']); // Stop 은 matcher 를 받지 않는다

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
settings.hooks = settings.hooks || {};

const added = [];
for (const ev of EVENTS) {
  const groups = settings.hooks[ev] = settings.hooks[ev] || [];
  const has = groups.some((g) => (g.hooks || []).some((h) => (h.args || []).some((a) => a.endsWith(path.join('claude-office', 'bin', 'hook.js')) || a === HOOK)));
  if (has) continue;
  const group = { hooks: [{ type: 'command', command: process.execPath, args: [HOOK], async: true, timeout: 5 }] };
  if (!NO_MATCHER.has(ev)) group.matcher = '*';
  groups.push(group);
  added.push(ev);
}

if (!added.length) { console.log('Claude Office 훅이 이미 모두 들어 있습니다.'); process.exit(0); }
fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`${SETTINGS} 에 훅을 넣었습니다: ${added.join(', ')}`);
