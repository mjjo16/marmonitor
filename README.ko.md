<p align="center">
  <img src="docs/banner-ansi.png" alt="marmonitor" width="640">
</p>

<p align="center">
  <strong>Claude Code, Codex, Gemini를 위한 tmux 상태바 모니터 — AI 코딩 세션을 실시간으로 추적하세요</strong>
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

tmux에서 여러 AI 코딩 에이전트를 동시에 실행하는 것은 이제 일상이 되었습니다 — Claude Code가 백엔드를 리팩토링하고, Codex가 다른 패널에서 테스트를 작성하고, Gemini가 문서를 검토합니다. 하지만 세션이 늘어날수록 같은 문제에 부딪힙니다:

- 패널로 전환했더니 에이전트가 10분째 `allow` 승인을 기다리고 있었다
- 방금 작업하던 Codex 세션이 어느 윈도우에 있는지 기억나지 않는다
- 여러 세션에서 토큰을 얼마나 소모했는지 알 수 없다

**이를 위한 대시보드가 없습니다.** 패널을 하나하나 돌아가며 직접 확인해야 합니다.

**marmonitor**가 이 문제를 해결합니다. tmux.conf에 한 줄만 추가하면, 상태바가 머신에서 실행 중인 모든 AI 세션의 실시간 컨트롤 패널이 됩니다.

<p align="center">
  <img src="docs/use_sample.png" alt="marmonitor tmux 상태바" width="640">
  <br>
  <em>에이전트 수, 단계 뱃지, 번호가 매겨진 어텐션 필 — 모두 tmux 상태바에 표시됩니다</em>
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

**계측 불필요** — API 키, 에이전트 플러그인, 코드 변경 없이 사용 가능합니다. marmonitor는 외부에서 로컬 프로세스 정보와 세션 파일을 읽습니다. 시작하려면 두 개의 명령어만 실행하세요: `npm install -g marmonitor` 그리고 `marmonitor setup tmux`.

> **tmux + AI 멀티세션 워크플로우를 위해 만들었습니다.** 매일 5개 이상의 AI 코딩 세션을 다양한 프로젝트에서 실행한다면, marmonitor는 컨텍스트 전환을 추측에서 상태바 한 번 확인으로 바꿔줍니다.

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

`marmonitor`를 업그레이드한 뒤에는 다음 명령으로 tmux 연동 업데이트 경로를 확인하세요:

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

설치가 완료되면 tmux 상태바에 AI 세션 뱃지가 자동으로 표시됩니다. 추가로 제공되는 기능:

| 단축키 | 동작 |
|--------|------|
| `prefix + a` | 어텐션 팝업 — 검토할 세션 선택 |
| `prefix + j` | 점프 팝업 — 이동할 세션 선택 |
| `prefix + m` | 독 — 컴팩트 모니터 패널 |
| `Option+1~5` | 어텐션 세션 #1~5로 바로 이동 |

CLI 명령어:

```bash
marmonitor status       # 전체 세션 목록
marmonitor attention    # 입력이 필요한 세션 확인
marmonitor watch        # 실시간 전체 화면 모니터
marmonitor help         # 모든 명령어 및 옵션
```

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
| `[Idle]` | 프로세스 활성 상태이나 최근 활동 없음 |
| `[Stalled]` | 장기간 활동 없음 |
| `[Dead]` | 세션 파일은 있지만 프로세스가 종료됨 |
| `[Unmatched]` | AI 프로세스는 발견되었지만 매칭되는 세션 없음 |

## tmux 플러그인

[marmonitor-tmux](https://github.com/mjjo16/marmonitor-tmux) 플러그인이 tmux 설정을 자동으로 처리합니다:

- 에이전트 뱃지와 어텐션 필이 포함된 2번째 상태 라인
- 팝업, 점프, 독 키 바인딩
- Option+1~5 다이렉트 점프

모든 설정은 `@marmonitor-*` 옵션을 통해 커스터마이징 가능합니다. 자세한 내용은 [플러그인 README](https://github.com/mjjo16/marmonitor-tmux)를 참조하세요.

## 설정

설정 파일은 다음 순서로 탐색됩니다 (먼저 발견되는 것이 적용):

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
- **네트워크 미사용** — 외부 연결 없이 모든 데이터가 로컬에 유지됩니다
- **보수적인 기본값** — 모든 연동 기능은 옵트인 방식입니다
- **tmux 우선** — WezTerm/iTerm2 네이티브 지원은 현재 일시 중단 상태입니다

## 기여하기

설정, 커밋 규칙, PR 가이드라인은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요. 아키텍처 세부사항은 [ARCHITECTURE.md](ARCHITECTURE.md)를 확인하세요.

## 알려진 제한사항

- 패널 점프 기능은 tmux가 필요합니다
- WezTerm / iTerm2 네이티브 바 지원은 현재 일시 중단 상태이며, tmux가 지원되는 표면입니다
- Gemini 권한 감지는 Ink TUI 아키텍처로 인해 제한적입니다
- 단계 감지는 휴리스틱 기반으로, 에이전트별 정확도가 다를 수 있습니다
- macOS 우선 개발이며, Linux 지원은 미테스트 상태입니다

## 라이선스

[MIT](LICENSE) — MJ JO
