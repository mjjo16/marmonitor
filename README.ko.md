<p align="center">
  <img src="docs/banner-ansi.png" alt="marmonitor" width="640">
</p>

<p align="center">
  <strong>Claude Code · Codex · Gemini용 tmux 상태바 모니터 — AI 코딩 세션을 실시간으로 추적하세요</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/marmonitor"><img src="https://img.shields.io/npm/v/marmonitor" alt="npm version"></a>
  <a href="https://github.com/mjjo16/marmonitor/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/marmonitor" alt="license"></a>
  <img src="https://img.shields.io/node/v/marmonitor" alt="node version">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="platform">
</p>

<p align="center">
  <a href="README.md">English</a> | <b>한국어</b>
</p>

---

## 왜 marmonitor인가?

tmux에서 여러 AI 코딩 에이전트를 동시에 실행하는 건 이제 일상입니다 — Claude Code가 백엔드를 리팩토링하고, Codex가 다른 패널에서 테스트를 작성하고, Gemini가 문서를 검토합니다. 하지만 세션이 늘어날수록 같은 문제에 부딪힙니다:

- 패널로 전환했더니 에이전트가 10분째 `allow` 승인을 기다리고 있었다
- 방금 작업하던 Codex 세션이 어느 윈도우에 있는지 기억나지 않는다
- 여러 세션에서 토큰을 얼마나 소모했는지 알 수 없다

**이걸 보여주는 대시보드가 없습니다.** 패널을 하나하나 돌아가며 직접 확인해야 합니다.

**marmonitor**가 이 문제를 해결합니다. tmux.conf에 한 줄만 추가하면, 상태바가 로컬 머신에서 실행 중인 모든 AI 세션을 실시간으로 보여주는 컨트롤 패널이 됩니다.

<p align="center">
  <img src="docs/use_sample.png" alt="marmonitor tmux 상태바" width="640">
  <br>
  <em>에이전트 수, 단계 뱃지, 번호 붙은 어텐션 필 — 모두 tmux 상태바에서 확인할 수 있습니다</em>
</p>

### 주요 기능

**tmux 상태바** — 터미널 하단에 항상 표시:
- 에이전트 수 (`Cl 12`, `Cx 2`, `Gm 1`) — 실행 중인 세션 수
- 단계 알림 (`⏳ 1`, `🤔 2`, `🔧 1`) — 주의가 필요한 세션
- 번호 필 (`1 ⏳Cl my-project allow`, `2 •Cx api-server 6m`) — `Option+1~5`로 세션 바로 이동

**어텐션 우선순위** — 입력이 필요한 세션이 먼저 표시:
- ⏳ `permission` (승인 대기)이 항상 #1 — 승인이 필요합니다
- 🤔 `thinking` (AI 응답 중)이 #2 — 곧 결과가 나옵니다
- 이후 최근 활성 세션 순으로 정렬

**빠른 이동** — `Option+1`을 누르면 #1 어텐션 세션의 tmux 패널로 바로 이동합니다. 윈도우를 뒤질 필요가 없습니다.

**전체 상태 확인** — `marmonitor status`로 모든 정보 확인:

<p align="center">
  <img src="docs/use_status_sample.png" alt="marmonitor status 출력" width="640">
  <br>
  <em>모든 세션의 상태, 토큰, 단계, CPU/MEM, 워커 프로세스 트리</em>
</p>

**에이전트 수정 불필요** — API 키, 플러그인, 코드 변경 없이 바로 쓸 수 있습니다. marmonitor는 외부에서 로컬 프로세스 정보와 세션 파일을 읽습니다. 명령어 두 개만 실행하면 됩니다: `npm install -g marmonitor`, `marmonitor setup tmux`.

> **tmux + AI 멀티세션 워크플로우에 맞춰 만들었습니다.** 매일 5개 이상의 AI 코딩 세션을 여러 프로젝트에서 실행한다면, marmonitor가 컨텍스트 전환을 추측에서 상태바 한 번 확인으로 바꿔줍니다.

<details>
<summary><h3>🔩 내부 구조: 에이전트 세션 바인딩</h3></summary>

### 문제

주요 AI 코딩 에이전트 중 외부 세션 조회 API를 제공하는 것은 없습니다. `claude sessions list` 같은 명령어도, 세션 상태 변경 웹훅도 존재하지 않습니다. 실시간 토큰 사용량, phase, `lastResponseAt`을 표시하려면 marmonitor는 각 에이전트의 내부 데이터 포맷을 직접 읽고 해석해야 합니다 — 에이전트마다 포맷이 완전히 다르고, 공식 문서도 없으며, 언제든 바뀔 수 있습니다.

하지만 더 어려운 문제는 파일 파싱이 아닙니다. **실행 중인 OS 프로세스를 올바른 세션 파일에 안정적으로 연결하고, 세션이 변화하는 동안에도 그 연결을 유지하는 것**입니다.

### 바인딩이 어려운 이유

"에이전트 프로세스를 찾아 가장 최신 세션 파일을 읽는다"는 단순한 접근은 실제 환경에서 자주 깨집니다:

- **Claude Code의 `/clear`** — `/clear` 실행 시 PID는 그대로인 채로 새 session UUID와 새 JSONL 파일이 생성됩니다. 재매핑 없이는 이전 파일을 계속 읽어 토큰과 `lastResponseAt`이 frozen 상태로 표시됩니다.
- **Stale PID 메타데이터** — Claude는 `~/.claude/sessions/{pid}.json`에 현재 session ID를 기록하지만, `/clear` 직후에는 이 파일이 새 세션을 반영하지 못하고 잠시 지연되는 구간이 있습니다.
- **같은 cwd의 다중 세션** — 동일 프로젝트 디렉터리에서 두 Claude 세션을 실행하면, mtime 기반 파일 선택이 조용히 잘못된 JSONL을 잡아 한 세션의 활동이 다른 세션에 귀속됩니다.
- **지연된 파일 생성** — 프로세스가 처음 감지될 시점에 세션 파일이 아직 디스크에 없을 수 있어, 파일이 생성될 때까지 잠정적(provisional) 바인딩을 유지하다 승격해야 합니다.

이 중 하나라도 실패하면 하위 메트릭 전체가 오염됩니다 — 토큰 사용량, phase 감지, `lastResponseAt` 모두 바인딩된 파일에서 읽기 때문입니다.

### 바인딩 파이프라인

감지된 모든 에이전트 프로세스에 대해 marmonitor는 다섯 단계를 순서대로 처리합니다:

```
PID
 └─ Identity Resolver   → session identity (sessionId 또는 thread index)
     └─ File Binding     → session file 경로 (direct 또는 provisional)
         └─ Reconciliation → stale/clear 보정
             └─ Binding Cache    → 인메모리, 현재 바인딩만 유지
                 └─ Binding History  → 디스크 registry, 세션별 누적 이력
```

에이전트별 처리 방식:

| | Identity Resolver | File Binding | Reconciliation |
|--|--|--|--|
| **Claude Code** | `~/.claude/sessions/{pid}.json` → `sessionId` | `{sessionId}.jsonl` (direct) 또는 mtime 근접도 매칭 (provisional) | `chooseStaleSessionOverride()` — `/clear` 및 stale 메타 감지 |
| **Codex** | `cwd + processStartedAt`를 SQLite thread index와 매칭 | `pid + processStartedAt` 키의 binding registry를 통해 rollout JSONL 또는 SQLite row | binding registry TTL 기반 freshness 보정 |
| **Gemini** | `cwd` → `~/.gemini/tmp/` 하위 project dir 탐색 | mtime 기준 최신 `chats/session-*.json` | 경량 — 프로젝트 디렉터리당 단일 활성 세션 |

### 왜 중요한가

바인딩 레이어가 상태바에 표시되는 숫자의 신뢰성을 결정합니다. `direct` 바인딩은 세션 메타데이터로 파일 경로가 확인된 상태 — 근거 없이는 교체되지 않습니다. `provisional` 바인딩은 direct 파일이 확인될 때까지 유지되다 자동으로 승격됩니다. Reconciliation은 특정 조건(mtime 격차, 메타데이터 확인, 활성 파일 가드)이 충족될 때만 override를 실행하며, 매 스캔마다 재판단하지 않습니다.

이 설계 덕분에 marmonitor는 `/clear`, 재시작, 같은 프로젝트의 병렬 세션처럼 단순한 모니터가 조용히 틀린 데이터로 fallback하는 상황에서도 올바르게 추적할 수 있습니다.

</details>

## 지원 에이전트

| 에이전트 | 탐지 방식 | 세션 정보 | 단계 추적 |
|---------|----------|----------|----------|
| **Claude Code** | 네이티브 바이너리 | 토큰, 타임스탬프, 모델 | thinking, tool, permission, done |
| **Codex** | 바이너리 + cmd 폴백 | 토큰, 타임스탬프, 모델 | thinking, tool, done |
| **Gemini** | cmd 폴백 | 토큰, 타임스탬프, 모델 | thinking, tool, done |

## 설치

### 1. marmonitor 설치

```bash
npm install -g marmonitor
```

### 2. tmux 연동 설정

```bash
marmonitor setup tmux
```

[marmonitor-tmux](https://github.com/mjjo16/marmonitor-tmux) 플러그인을 `~/.tmux.conf`에 추가합니다. tmux 안에서 `prefix + I`을 눌러 활성화하세요.

`marmonitor`를 업그레이드한 뒤에는 tmux 연동도 업데이트가 필요한지 확인하세요:

```bash
marmonitor update-integration
```

`prefix + U`로 TPM 플러그인을 업데이트했는데도 클릭 동작이나 팝업 키바인딩이 이전 버전처럼 남아 있다면, 실행 중인 tmux 서버에 플러그인을 다시 적용해야 합니다:

```bash
tmux run-shell ~/.tmux/plugins/marmonitor-tmux/marmonitor.tmux
```

이 증상은 주로 기존 tmux 세션에서 플러그인을 업그레이드할 때 발생합니다. 신규 설치에서 `prefix + I`로 처음 로드하는 경우에는 보통 바로 최신 바인딩이 적용됩니다.

<details>
<summary>직접 ~/.tmux.conf에 추가하기</summary>

```bash
set -g @plugin 'mjjo16/marmonitor-tmux'
```

[tpm](https://github.com/tmux-plugins/tpm)이 필요합니다.
</details>

<details>
<summary>수동 설치 (tpm 없이)</summary>

```bash
git clone https://github.com/mjjo16/marmonitor-tmux ~/.tmux/plugins/marmonitor-tmux
```

`~/.tmux.conf`에 추가:
```bash
run-shell ~/.tmux/plugins/marmonitor-tmux/marmonitor.tmux
```
</details>

<details>
<summary>소스에서 설치 (개발용)</summary>

```bash
git clone https://github.com/mjjo16/marmonitor.git
cd marmonitor
npm install && npm run build
npm link
```
</details>

## 빠른 시작

### 데몬 시작

marmonitor는 2초마다 AI 세션을 스캔하는 백그라운드 데몬으로 실행됩니다:

```bash
marmonitor start        # 데몬 시작
marmonitor stop         # 데몬 중지
marmonitor restart      # 데몬 재시작 (예: npm 업데이트 후)
```

모든 명령어가 동작하려면 데몬이 실행 중이어야 합니다. `marmonitor setup tmux`를 실행하면 자동으로 시작됩니다.

### tmux 단축키

| 단축키 | 동작 |
|--------|------|
| `prefix + a` | 어텐션 팝업 — 검토할 세션 선택 |
| `prefix + j` | 점프 팝업 — 이동할 세션 선택 |
| `prefix + m` | 독 — 컴팩트 모니터 패널 |
| `Option+1~5` | 어텐션 세션 #1~5로 바로 이동 |
| `Option+`` | 이전 패널로 돌아가기 |

### CLI 명령어

```bash
marmonitor status       # 전체 세션 목록
marmonitor attention    # 입력이 필요한 세션 확인
marmonitor activity     # 각 세션의 활동 내역 (도구 호출 + 토큰)
marmonitor watch        # 실시간 전체 화면 모니터
marmonitor jump-back    # 마지막 점프 이전 패널로 복귀
marmonitor help         # 모든 명령어 및 옵션
```

### 활동 로그

AI 세션이 실제로 수행한 작업을 추적합니다 — 파일 편집, bash 명령어, 사용 토큰:

```bash
marmonitor activity                  # 오늘의 활동
marmonitor activity --pid 1234       # PID로 필터링
marmonitor activity --session abc    # 세션 ID로 필터링
marmonitor activity --days 3         # 최근 3일
marmonitor activity --json           # JSON 출력
```

활동 내역은 데몬이 자동으로 수집하며 `~/.config/marmonitor/activity-log/`에 저장됩니다 (7일 보관).

## 단계 아이콘

| 아이콘 | 단계 | 의미 |
|--------|------|------|
| ⏳ | `permission` | AI가 도구 승인을 요청 중 — **사용자 입력 필요** |
| 🤔 | `thinking` | AI가 응답을 생성 중 |
| 🔧 | `tool` | 승인된 도구 실행 중 |
| ✅ | `done` | 응답 완료, 다음 지시 대기 중 |

## 상태 레이블

| 레이블 | 의미 |
|--------|------|
| `[Active]` | CPU 활동 감지됨 |
| `[Idle]` | 프로세스는 살아 있지만 최근 활동 없음 |
| `[Stalled]` | 장기간 활동 없음 |
| `[Dead]` | 세션 파일은 있지만 프로세스가 종료됨 |
| `[Unmatched]` | AI 프로세스는 발견되었지만 일치하는 세션 없음 |

## tmux 플러그인

[marmonitor-tmux](https://github.com/mjjo16/marmonitor-tmux) 플러그인이 tmux 설정을 자동으로 처리합니다:

- 에이전트 뱃지와 어텐션 필이 포함된 2번째 상태 라인
- 팝업, 점프, 독 키 바인딩
- Option+1~5 다이렉트 점프

`@marmonitor-*` 옵션으로 원하는 대로 바꿀 수 있습니다. 자세한 내용은 [플러그인 README](https://github.com/mjjo16/marmonitor-tmux)를 참조하세요.

### 뱃지 스타일

`integration.tmux.badgeStyle`로 tmux 뱃지와 터미널 텍스트 출력의 스타일을 통일할 수 있습니다.

- `basic` — 기본 컬러 필
- `basic-mono` — Powerline 테두리의 단색 필
- `text` — 배경 없는 컬러 텍스트
- `text-mono` — 회색조 텍스트 전용

## 설정

다음 경로를 순서대로 찾아 먼저 발견된 파일을 적용합니다:

1. `$XDG_CONFIG_HOME/marmonitor/settings.json`
2. `~/.config/marmonitor/settings.json`
3. `~/.marmonitor.json`

```bash
# 현재 설정 파일 경로 및 값 확인
marmonitor settings-path
marmonitor settings-show

# 기본 설정 파일 생성
marmonitor settings-init --stdout
```

### 설정 예시

```json
{
  "display": {
    "attentionLimit": 10,
    "statuslineAttentionLimit": 5
  },
  "status": {
    "stalledAfterMin": 20,
    "phaseDecay": {
      "thinking": 20,
      "tool": 30,
      "permission": 0,
      "done": 5
    }
  },
  "integration": {
    "tmux": {
      "badgeStyle": "basic",
      "keys": {
        "attentionPopup": "a",
        "jumpPopup": "j",
        "dockToggle": "m",
        "directJump": ["M-1", "M-2", "M-3", "M-4", "M-5"]
      }
    }
  }
}
```

## 제거

```bash
marmonitor uninstall-integration    # tmux 설정 제거 + 상태바 복원
npm uninstall -g marmonitor         # CLI 제거
```

## 안전성

- **기본적으로 읽기 전용** — 관찰만 하며, 세션을 수정하지 않습니다
- **네트워크 미사용** — 외부로 연결하지 않으며, 모든 데이터는 로컬에 남습니다
- **보수적인 기본값** — 모든 연동 기능은 옵트인 방식입니다
- **tmux 우선** — WezTerm/iTerm2 네이티브 지원은 현재 일시 중단 상태입니다

## 변경 이력

릴리스 이력과 호환성 변경사항은 [CHANGELOG.md](CHANGELOG.md)를 참조하세요.

## 기여하기

설정, 커밋 규칙, PR 가이드라인은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요. 아키텍처 세부사항은 [ARCHITECTURE.md](ARCHITECTURE.md)를 확인하세요.

## 알려진 제한사항

- 패널 점프 기능은 tmux가 필요합니다
- WezTerm / iTerm2 네이티브 바 지원은 일시 중단 상태이며, 현재 tmux만 지원합니다
- Gemini 권한 감지는 Ink TUI 아키텍처로 인해 제한적입니다
- 단계 감지는 휴리스틱 기반으로, 에이전트별 정확도가 다를 수 있습니다
- macOS 기준으로 개발했으며, Linux에서는 아직 테스트하지 않았습니다

## 라이선스

[MIT](LICENSE) — MJ JO
