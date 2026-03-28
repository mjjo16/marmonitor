# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**marmonitor** - AI 에이전트 감시 & 모니터링 TUI 도구. 마멋이 굴 입구에서 경계 서듯이, 로컬에서 돌아가는 AI 에이전트(Claude Code, Codex, Gemini 등)를 감시한다.

## Project Management (문서 연동)

기획/검토/로드맵 등 프로젝트 관리 문서는 별도 경로에서 관리:

```
~/.ai/projects/mjjo/works/work_mjjo_marmonitor/
├── README.md              <- 문서 구조 가이드
├── prd.md                 <- 제품 요구사항 정의서
├── feasibility.md         <- 구현 가능성 검토 (기술 검증)
├── agent-data-spec.md     <- 에이전트별 로컬 데이터 구조 분석
├── roadmap.md             <- 구현 로드맵 (v0.1 ~ v1.0)
└── ...
```

코드 변경 시 프로젝트 관리 문서 업데이트가 필요하면 위 경로 참조.

## Code Structure

```
src/
├── cli.ts             <- CLI 엔트리포인트 (commander)
├── scanner.ts         <- AI 프로세스 탐지 + 세션 파싱
├── output.ts          <- 출력 포매터 (text, json, statusline)
└── types.ts           <- TypeScript 타입 정의
bin/
└── marmonitor.js      <- CLI 바이너리 엔트리
```

## Commands

```bash
# 의존성 설치
npm install

# 빌드
npm run build

# 실행
marmonitor status              # one-shot 텍스트 출력
marmonitor status --json       # JSON 출력
marmonitor --statusline        # tmux 상태바용 한 줄 출력
marmonitor                     # TUI 대시보드 (v0.3+)

# 개발
npm run dev                    # tsc --watch
npm test                       # node --test
npm run lint                   # eslint
```

## Architecture

- **scanner.ts**: ps-list + pidusage로 프로세스 스캔, 에이전트별 세션 데이터 파싱
- **output.ts**: 스캐너 결과를 다양한 포맷으로 출력 (chalk 컬러, json, statusline)
- **cli.ts**: commander 기반 CLI, 실행 모드 분기 (status, TUI, statusline)

에이전트 추가 시 `scanner.ts`의 `AGENT_SIGNATURES`에 탐지 규칙 추가, 필요 시 전용 파서 함수 작성.

## Key Dependencies

- `ps-list`: 프로세스 목록 조회
- `pidusage`: 프로세스별 CPU/메모리
- `systeminformation`: 시스템 리소스 (CPU, MEM, 배터리, GPU)
- `chalk`: 터미널 컬러 출력
- `commander`: CLI 파서

## Conventions

- TypeScript strict mode, ESM (type: module)
- 한국어 문서, 영어 코드/커밋
- 에이전트별 파서는 실패 시 graceful degradation (프로세스 스캔 폴백)
