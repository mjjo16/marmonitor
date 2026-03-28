# WezTerm PoC

`marmonitor`의 WezTerm status bar PoC 예제입니다.

## 사용 방법

1. WezTerm 설정 파일을 만든다.
2. 아래 내용을 `~/.wezterm.lua`에 복사하거나, 이 예제 파일을 `dofile()`로 불러온다.

```lua
local marmonitor = dofile(os.getenv("HOME") .. "/Documents/mjjo/marmonitor/examples/wezterm/marmonitor-status.lua")
return marmonitor
```

또는 예제 내용을 직접 붙여넣어도 됩니다.

## 동작 방식

- WezTerm `update-status` 이벤트를 사용
- `update-status`는 5초마다 호출되지만, 예제 adapter 내부에서 15초 TTL 캐시를 사용해 `node bin/marmonitor.js --statusline --statusline-format wezterm-pills` subprocess를 매 tick 다시 띄우지 않음
- `marmonitor --statusline` 자체도 5초 TTL 파일 캐시를 사용하므로, 짧은 시간 내 반복 호출 시 `scanAgents()`를 다시 돌지 않고 마지막 렌더 결과를 재사용
- 결과를 `agent badge / alert badge / activity detail` segment로 파싱
- tmux 하단 bar와 같은 정보 순서로 left/right status에 표시
- tab/status bar를 하단으로 이동
- 탭 표시를 숨기고 plain bar만 남겨 global persistent bar처럼 사용

## 주의

- 이 예제는 PoC입니다.
- 현재는 adapter TTL + statusline 파일 캐시로 subprocess/scan 비용을 줄였지만, 장기적으로는 공통 snapshot 계층이 들어가면 더 좋아집니다.
- 프로젝트 경로가 `~/Documents/mjjo/marmonitor`라고 가정합니다.
