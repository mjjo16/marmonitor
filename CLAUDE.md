# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**marmonitor** — 로컬에서 돌아가는 AI 코딩 에이전트(Claude Code, Codex, Gemini)의 세션·토큰·phase·tmux 위치를 외부에서 관찰하는 도구. 마멋이 굴 입구에서 경계 서듯이 감시한다.

- 배포: `marmonitor` (npm, macOS/Linux). 진입점은 `bin/marmonitor.js` (CLI), `bin/daemon.js` (백그라운드 데몬).
- 패시브 옵저버: 외부 API/플러그인 없이 OS 프로세스와 에이전트별 로컬 세션 파일만 읽는다.

## Project Management (문서 연동)

기획·검토·로드맵·로컬 이슈는 별도 경로에서 관리:

```
~/.ai/projects/mjjo/works/work_mjjo_marmonitor/
├── README.md, prd.md, feasibility.md, agent-data-spec.md, roadmap.md, ...
├── issues.md            <- 인덱스 (OPEN/IN_PROGRESS/DONE 테이블)
└── issues/
    ├── RULES.md         <- 이슈 작성/운영 규칙 (양식, 작성자 표기, 처리 이력)
    ├── NNN-slug.md      <- 개별 이슈 파일 (시리얼 번호)
    └── G001~G00N        <- GitHub 연동 그룹 이슈
```

리뷰 결과·작업 분담·후속 트랙은 위 `issues/`의 개별 파일로 분리. 본 레포의 `.worklog/`는 세션 로그(`activity.md`, `sessions/`)만 보관하고 이슈 파일은 두지 않는다.

## High-level Architecture

0.2.0부터 **데몬 + 스냅샷** 모델이다. CLI는 거의 모두 stateless reader.

```
bin/daemon.js  ──▶  src/scanner/daemon-entry.ts ─▶ runDaemonLoop()
                       │
                       │ light scan (default 2s)  : ps-list + pidusage + 캐시 enrich
                       │ heavy scan (30s)         : Claude/Codex/Gemini jsonl·sqlite 풀 파싱
                       │
                       ├─ $TMPDIR/marmonitor/daemon-snapshot.json (statusline 소비자)
                       ├─ $TMPDIR/marmonitor/alerts-snapshot.json
                       ├─ ~/.config/marmonitor/session-registry.json
                       ├─ ~/.config/marmonitor/codex-binding-registry.json
                       ├─ ~/.config/marmonitor/activity-log/YYYY-MM-DD.jsonl
                       └─ ~/.config/marmonitor/alerts.log

bin/marmonitor.js ─▶ src/cli.ts ─▶ readDaemonSnapshot() ─▶ src/output/* render
```

핵심 불변식:
- **싱글 데이몬**: `start`는 ps-list로 중복 체크 후 fork. `stop`은 SIGTERM → 2s wait → SIGKILL.
- **fail-safe**: `ps`/`lsof`/`tmux`/file IO 모든 외부 호출은 try/catch + 캐시 쓰기 실패 무시. guard는 fail-open(`{"decision":"allow"}`).
- **statusline TTL 캐시**: `$TMPDIR/marmonitor/statusline-<format>-<limit>-<width>.txt`. `tmux-badges`는 active panePid를 첫 줄에 박아 active 창이 바뀌면 즉시 invalidate.

## Code Layout

```
src/
├── cli.ts                  Commander 등록 + 모든 subcommand 액션 (1.6k LOC, 분리 예정)
├── version.ts              릴리스 버전 상수
├── process-safety.ts       uncaught/SIGINT 핸들러 헬퍼
├── types.ts                AgentSession / TokenUsage / SessionStatus / SessionPhase
│
├── scanner/                ── 도메인 코어
│   ├── index.ts            scanAgents() — 메인 파이프라인
│   ├── daemon-entry.ts     데몬 main(): config 로드 → runDaemonLoop
│   ├── daemon-loop.ts      light/heavy 두 단계 polling, snapshot/registry/activity 기록
│   ├── daemon-utils.ts     read/writeDaemonSnapshot, pid 파일
│   ├── process.ts          ps-list 결과 → agent 매칭, lsof로 cwd, ps -o lstart= 시작시간
│   ├── claude.ts           ~/.claude/projects/<encodedCwd>/<sessionId>.jsonl 파싱
│   ├── codex.ts            ~/.codex/sessions/* + SQLite 인덱스 머지
│   ├── codex-binding-registry.ts  PID×processStartedAt → thread/rollout 영속 매핑(/clear 견딤)
│   ├── codex-sqlite.ts     ~/.codex 의 SQLite threads 테이블 인덱싱
│   ├── gemini.ts           ~/.gemini/tmp/<hash>/chats/session-*.json 최신 mtime 선택
│   ├── status.ts           Active/Idle/Stalled hysteresis + stdout 휴리스틱
│   ├── session-tier.ts     hot(≤2m)/warm(≤10m)/cold 분류 → 차등 enrichment
│   ├── session-registry.ts sessionId 평생 이력 (PID 변경, 토큰 누적)
│   ├── activity-log.ts     tool_use 추출, 일별 JSONL, 7일 retention
│   ├── group.ts            부모/자식 PID 머지(워커 트리)
│   ├── cache.ts            BoundedMap LRU 인스턴스 모음 + TTL 상수
│   ├── bounded-map.ts      LRU Map
│   ├── concurrency.ts      promiseAllLimited
│   ├── perf.ts             MARMONITOR_PERF=1 일 때 perfStart/perfEnd
│   └── types.ts            ScanOptions
│
├── output/                 ── 렌더러 (text/json/statusline/dock/attention/jump)
│   ├── index.ts            printStatus / renderStatusline / printAttention / printDock 등
│   ├── utils.ts            buildAttentionItems / buildStatuslineSummary / phase decay 등 순수 함수
│   └── badge-themes.ts     basic / basic-mono / block / block-mono / text / text-mono
│
├── config/index.ts         XDG 우선 settings.json + MARMONITOR_* 환경변수 + 기본값 deep merge
│
├── guard/index.ts          Claude hook stdin → trigger 검출(dangerous_command/secret_access/...)
│                           → intervention 룰 매칭 → allow/block 결정
│
├── tmux/                   ── tmux 통합
│   ├── index.ts            list-panes, pid-tree → cwd 우선 매칭, switch-client/select-pane
│   ├── jump-anchor.ts      jump-back 앵커 (TTY 단위)
│   ├── setup.ts            ~/.tmux.conf 에 marmonitor-tmux 플러그인 추가/제거
│   └── status-click.ts     tmux 상태바 mouse range token 파싱
│
├── alerts/                 ── 알림 시스템(0.2.5+)
│   ├── store.ts            5분 dedup 버킷 in-memory 스토어
│   ├── token.ts            컨텍스트 사용량 임계치 검사 (model별 한도)
│   ├── log.ts / snapshot.ts / desktop.ts (node-notifier)
│   └── types.ts            Alert / AlertSeverity / AlertType
│
└── banner/index.ts         iTerm2 inline image / ANSI block 폴백

bin/
├── marmonitor.js           dist/cli.js dynamic import
├── daemon.js               dist/scanner/daemon-entry.js dynamic import
├── postinstall.cjs         실행 중 데몬 재시작 + update-integration --quiet
└── preuninstall.cjs        잔여 정리

tests/                      node --test 기반 *.test.mjs (25개+)
```

## Commands

```bash
# 의존성
npm install

# 빌드 / 워치
npm run build            # tsc → dist/
npm run dev              # tsc --watch

# 품질
npm run lint             # biome check src tests
npm test                 # node --test tests/*.test.mjs
node --test tests/scanner.test.mjs    # 단일 테스트

# 실행 (데몬이 먼저 떠 있어야 함)
marmonitor start                       # 데몬 fork
marmonitor stop / restart
marmonitor status [--json]             # daemon snapshot 한방 출력
marmonitor attention [--interactive|--pid|--attention-index]
marmonitor activity [--pid|--session|--days|--lines|--order|--json]
marmonitor watch / dock                # live 갱신
marmonitor --statusline --statusline-format <compact|standard|extended|tmux-badges>
marmonitor jump-back                   # 직전 pane 복귀
marmonitor debug-phase --pid <pid>     # phase/세션/stdout/tmux/Codex binding 종합 진단
marmonitor clean [--kill] [--pid ...]  # Unmatched 프로세스 SIGTERM
marmonitor guard                       # stdin Claude hook 평가 (fail-open)
marmonitor alerts [on|off|notify on|off]
marmonitor settings-{path,show,init [--advanced]}
marmonitor setup tmux | update-integration | uninstall-integration
```

## Environment & Paths

```
~/.config/marmonitor/settings.json     XDG 우선 (legacy: ~/.marmonitor.json)
~/.config/marmonitor/{session-registry,codex-binding-registry,alerts.log}
~/.config/marmonitor/activity-log/YYYY-MM-DD.jsonl
$TMPDIR/marmonitor/{daemon.pid,daemon-snapshot.json,alerts-snapshot.json,statusline-*.txt,jump-anchors.json}
  ^ os.tmpdir() 기준. macOS는 /var/folders/.../T/marmonitor 이며 /tmp/marmonitor 가 아니다.
  데몬 생존 확인은 daemon-snapshot.json mtime 으로 한다(light interval 2s). 데몬은
  프로세스 타이틀을 marmonitor 로 바꾸므로 pgrep -f daemon.js 로는 잡히지 않는다.

MARMONITOR_CLAUDE_HOME / MARMONITOR_CODEX_HOME    경로 루트 오버라이드
MARMONITOR_CLAUDE_PROJECTS / _CLAUDE_SESSIONS / _CODEX_SESSIONS    PATH 형식 다중 경로
MARMONITOR_PERF=1                                  scan 단계별 timing 출력
```

## Adding a New Agent

1. `src/config/index.ts` DEFAULTS.agents에 `processNames` 추가.
2. `src/scanner/<agent>.ts`에 세션 파서·phase 검출 함수 작성.
3. `src/scanner/index.ts` `scanAgents()`에서 agentName 분기 추가(현재 if/else 구조 — 어댑터화 예정).
4. 필요 시 `src/types.ts`의 `RuntimeSource` union 확장, output 라벨/색상 추가.
5. tests/scanner.test.mjs 또는 전용 *.test.mjs 추가.

## Conventions

- TypeScript strict mode, ESM only (`"type": "module"`).
- Lint/format은 biome (`biome.json`). PR 전에 `npm run lint && npm test`.
- 한국어 문서, 영어 코드/주석/커밋. 커밋 메시지는 `~` 라 끝맺는 명령형(예: "exclude vscode codex app-server").
- 외부 호출은 모두 fail-safe로 감싼다. 캐시 쓰기 실패는 무시(스타일 일관).
- 새 기능을 데몬 사이클에 끼울 땐 light vs heavy 분류를 먼저 결정한다(JSONL/SQLite read는 heavy).

## Branching & Release

자세한 흐름은 `~/.claude/projects/-Users-macrent-Documents-mjjo-marmonitor/memory/project_branch_strategy.md` 참조.

- `feature/* → dev → main`. PR은 항상 `dev` 대상.
- `main`에 push되면 npm 자동 배포(OIDC Trusted Publisher). 따라서 main 직접 push는 금지.
- postinstall이 실행 중 데몬을 자동 재시작하므로 새 버전 배포 후 추가 작업 불필요.
