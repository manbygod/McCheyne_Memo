# CLAUDE.md — 맥체인 성경읽기

## 프로젝트
맥체인 읽기표에 따라 매일 말씀을 읽고, 구절을 선택해 복사/메모/공유하는 정적 웹앱 (GitHub Pages 배포).

## 디렉터리 규약
- 프론트 3종은 루트에: `index.html`, `style.css`, `app.js` (중첩 폴더 금지, 첫 화면은 `/`)
- 데이터는 `data/` 안에만 (`books.json`, `plan.json`, `labels.json`, `memos.json`, `bible/ko/*.json`)
- 문서는 루트: `CLAUDE.md`, `skills.md`, `README.md`
- 생성 스크립트는 `scripts/` (`node scripts/gen-data.js`)

## 코딩 규칙
### 1) HTML — 시맨틱·접근성 우선
- 시맨틱 요소(header/nav/main/section/dialog/fieldset) 우선, div/span 남용 금지
- 모든 입력은 `label[for]`, 아이콘/모호한 버튼은 `aria-label`
- 포커스 링 제거 금지 (`:focus-visible` 유지), 동적 상태는 `aria-live`/`aria-pressed`/`aria-current`

### 2) CSS — BEM, CSS 변수, mobile-first
- 클래스는 BEM (`block__element--modifier`), ID/태그 선택자로 스타일링 금지
- 색·간격·폰트는 `:root` 변수로, 다크 모드는 변수 재정의
- 기본 스타일은 모바일, 확장은 `min-width` 미디어쿼리

### 3) JS — 이벤트 위임, 순수 함수, 날짜 ISO
- 클릭은 `document` 단일 리스너 + `data-action` 위임
- 계산/포맷/필터/정렬은 부수효과 없는 순수 함수로 분리 (DOM·저장소 접근과 분리)
- 날짜는 ISO 8601: 날짜 `YYYY-MM-DD`, 시각 `toISOString()` 저장, 표시 때만 로케일 변환

### 4) 비기능
- 보안: 사용자/외부 텍스트는 `textContent`/`createElement`로만 삽입 (`innerHTML` 금지), 외부 응답 검증, 가져온 JSON 스키마 검사
- 성능: 불필요한 `innerHTML`/전체 재렌더 최소화, 선택 토글은 클래스만 변경, 본문은 캐시

## 데이터/저작권
- 성경 본문은 공유 저작물만 번들: 영어 Berean Standard Bible(BSB), 한국어 개역한글(1961, 대한성서공회 — 본문 변경 금지, 출처 표기). 개역개정·NIV 본문은 저장소에 넣지 않는다.
- 메모 스키마: `id, content, lang, passages[{bookId, chapter, verses[], text}], labels[], createdAt, updatedAt` (한 메모에 여러 책·장의 말씀 가능, 이전 단일 구절 형식은 불러올 때 자동 변환) (최초 작성 시 `updatedAt == createdAt`)
- 정렬: 목록은 `createdAt` desc, 검색 결과는 `updatedAt` desc

## 작업 방식
- 변경 후 로컬 서버로 실행해 확인 (`python -m http.server`)
- 의존성 추가 금지 원칙 (빌드 없는 바닐라 JS). 필요 시 CDN 사용 이유를 README에 기록
