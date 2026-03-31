성능 벤치마크 가이드

목적
- scanner/statusline 성능 변경을 감각이 아니라 재현 가능한 숫자로 비교한다.
- `JSONL 파싱 비용`과 `실제 tmux statusline 실행 비용`을 같은 숫자로 뭉개지 않고 분리해서 본다.

왜 벤치마크를 둘로 나눴는가
- `Codex synthetic benchmark`는 재현 가능한 fixture 기반 측정이다.
  - JSONL 크기, 파일 수, cache 상태를 통제할 수 있다.
  - tmux, `lsof`, `pidusage`, 실제 세션 혼합도는 반영하지 않는다.
- `Statusline live benchmark`는 현재 tmux/runtime 환경에서 실제 `--statusline` 경로를 측정한다.
  - 실제 병목을 잘 드러낸다.
  - 대신 호스트 스펙, 활성 pane 수, 세션 수, TTL 설정에 따라 숫자가 달라진다.
- 따라서 같은 `40-file`이라는 표현만으로는 성능을 설명할 수 없다.

재현 가능한 synthetic benchmark
- 명령
  - `npm run bench:codex-index`
  - JSON 출력: `npm run bench:codex-index -- --json`
- 스크립트
  - [scripts/bench-codex-index.mjs](/Users/jaewankim/Desktop/jaewan-develop/marmonitor/scripts/bench-codex-index.mjs)
- 기본 동작
  - temp 디렉터리에 결정적인 40-file fixture를 생성한다.
  - 두 fixture profile을 측정한다.
    - `heavy`: 긴 tail과 큰 JSONL을 가진 세션
    - `compact`: 더 짧고 작은 세션
  - 두 cache scenario를 측정한다.
    - `cold_empty_caches`
    - `warm_file_cache`
- 출력 항목
  - current commit
  - baseline ref commit
  - CPU model / logical CPU count / RAM
  - fixture file count / repeat count
  - profile별 full/light timing 요약

실제 statusline live benchmark
- 명령
  - `npm run bench:statusline-live`
  - JSON 출력: `npm run bench:statusline-live -- --json`
- 스크립트
  - [scripts/bench-statusline-live.mjs](/Users/jaewankim/Desktop/jaewan-develop/marmonitor/scripts/bench-statusline-live.mjs)
- 기본 동작
  - 모든 marmonitor cache를 비우고 `cold`를 측정한다.
  - 즉시 한 번 더 실행해서 `warm`을 측정한다.
  - `snapshot-*`, `statusline-*`만 지우고 `forced-miss`를 2회 측정한다.
- 출력 항목
  - current commit
  - baseline ref commit
  - CPU model / logical CPU count / RAM
  - tmux session 수 / pane 수
  - 현재 agent 수
  - runtime config에서 읽은 TTL 값
  - `MARMONITOR_PERF` 단계별 timing

현재 예시 측정
- synthetic benchmark
  - 측정 명령: `node scripts/bench-codex-index.mjs --json`
  - 측정 시점 commit: `b26bdf5ffcfae05f42a8bd6ec4f704a3b010949b`
  - baseline commit: `6f04e60c4605db77586dc7a73a2e4bfe8814d8d6`
  - host: `Apple M3 Max`, `14` logical CPU, `36GB RAM`
  - 결과 요약
    - `heavy / cold_empty_caches`: full avg `20.9ms`, light avg `4.6ms`
    - `compact / cold_empty_caches`: full avg `5.6ms`, light avg `3.4ms`
    - `warm_file_cache`: full/light 모두 약 `1ms`
- live statusline benchmark
  - 측정 명령: `node scripts/bench-statusline-live.mjs --json`
  - 측정 시점 commit: `b26bdf5ffcfae05f42a8bd6ec4f704a3b010949b`
  - baseline commit: `6f04e60c4605db77586dc7a73a2e4bfe8814d8d6`
  - host: `Apple M3 Max`, `14` logical CPU, `36GB RAM`
  - tmux: `3` sessions, `7` panes
  - agents: `37`
  - TTL: `snapshot=10000ms`, `statusline=10000ms`, `stdout=10000ms`
  - 결과 요약
    - `cold`: `1413.3ms`
    - `warm`: `66.1ms`
    - `forced-miss`: `550.1ms`, `118.4ms`

검토 순서
1. `npm run bench:codex-index -- --json`로 fixture 기반 숫자를 캡처한다.
2. 실제 tmux 세션 안에서 `npm run bench:statusline-live -- --json`를 실행한다.
3. PR이나 이슈에는 두 결과를 함께 적되, fixture profile과 runtime 환경을 같이 적는다.

대안 검토
- `tests/perf.benchmark.mjs`로 넣는 대안도 있었지만, CI 테스트와 host-dependent live benchmark를 섞으면 flaky해진다.
- repo에 고정 fixture JSONL을 넣는 대안도 있었지만, 생성형 fixture가 더 작고 profile 조정이 쉽다.
- 라이브 벤치마크를 내부 함수 import 기반으로 만드는 대안도 있었지만, spawn 비용과 실제 CLI cache 경로를 놓치게 된다.

주의
- synthetic 비율과 live 비율을 직접 비교하면 안 된다.
- authoritative한 숫자는 문서의 고정 값이 아니라 스크립트 출력이다.
- 문서의 예시 값은 해석 예시일 뿐이고, 최종 비교는 항상 같은 명령을 다시 실행해서 얻은 JSON 출력으로 해야 한다.
