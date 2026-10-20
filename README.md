# Claude Office

Claude Code 세션이 지금 무엇을 하는지 픽셀 사무실 그림으로 보여 주는 로컬 대시보드입니다.
세션마다 캐릭터가 하나씩 있고, 쓰는 도구에 따라 방을 옮겨 다닙니다.

| 방 | 도구 |
|---|---|
| 자료실 | Read · Grep · Glob |
| 개발실 | Edit · Write |
| 서버실 | Bash · Monitor |
| 정보검색실 | WebSearch · WebFetch · MCP |
| 회의실 | Agent(서브에이전트) · Plan |
| 휴게실 | 90초 넘게 쉬는 세션 |

서브에이전트는 엘리베이터로 출근해 각자 일하는 방에 앉고, 끝나면 보고한 뒤 퇴근합니다.

## 실행

Node.js 18 이상이 필요합니다. 외부 패키지는 쓰지 않습니다.

```sh
npm install -g .          # 또는 node bin/claude-office.js
claude-office             # http://127.0.0.1:4747 이 열린다
claude-office 5000        # 다른 포트
claude-office --no-open   # 브라우저를 열지 않는다
```

서버는 `127.0.0.1`에만 열리고, 이 컴퓨터의 세션 기록을 읽기만 합니다.

## 읽는 기록

- `~/.claude/projects/*/*.jsonl`: Claude Code 세션 기록(터미널·데스크톱 앱 코드 탭)
- `~/.claude/projects/*/<세션ID>/subagents/agent-*.jsonl`, `*.meta.json`: 서브에이전트 기록과 완료 여부
- `~/Library/Application Support/Claude/local-agent-mode-sessions/…/.claude/projects`: 데스크톱 앱 Cowork 세션(macOS)
- `~/.claude-office/live.jsonl`: 아래 훅이 남기는 실시간 기록

## 실시간 표시용 훅 (권장)

세션 기록은 도구가 끝난 뒤에 쓰이므로, 기록만 읽으면 오래 걸리는 Bash나 서브에이전트의 작업이 끝난 다음에야 보입니다.
`~/.claude/settings.json`에 아래 훅을 넣으면 도구가 시작될 때 바로 보입니다. 경로는 자기 환경에 맞게 바꿉니다.

```json
{
  "hooks": {
    "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/node", "args": ["/path/to/claude-office/bin/hook.js"], "async": true, "timeout": 5 }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/node", "args": ["/path/to/claude-office/bin/hook.js"], "async": true, "timeout": 5 }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/node", "args": ["/path/to/claude-office/bin/hook.js"], "async": true, "timeout": 5 }] }],
    "SubagentStart":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/node", "args": ["/path/to/claude-office/bin/hook.js"], "async": true, "timeout": 5 }] }],
    "SubagentStop":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/node", "args": ["/path/to/claude-office/bin/hook.js"], "async": true, "timeout": 5 }] }]
  }
}
```

훅은 백그라운드로 돌아 도구 실행을 늦추지 않습니다. `live.jsonl`은 2MB를 넘으면 스스로 비웁니다.
Claude Code 안에서 `/hooks`로 확인하거나 끌 수 있습니다.

## 폰트

`public/fonts/`의 [Pretendard](https://github.com/orioncactus/pretendard)와 [Galmuri](https://github.com/quiple/galmuri)는 SIL Open Font License 1.1을 따릅니다. 라이선스 전문은 같은 폴더에 있습니다.
