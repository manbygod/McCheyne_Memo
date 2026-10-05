# 맥체인 성경읽기

맥체인 읽기표로 매일 말씀을 읽고, 구절을 선택해 복사·메모·공유하는 바닐라 JS 웹앱.

## 실행 방법
빌드 불필요. `file://` 로 열면 `fetch`가 막히므로 로컬 서버로 실행합니다.

```bash
cd McCheyne
python -m http.server 8000      # 또는: npx serve .
# http://localhost:8000
```

## 기능
- 날짜별 4트랙 읽기 목록(일부 장은 절 범위 표기) → 장 클릭 시 본문 (한국어 개역한글/English BSB 선택)
- 구절 클릭(복수, Shift+클릭으로 범위) → 음영 + 왼쪽 세로선, 복사 / 메모
- 본문에서 메모가 연결된 절은 번호가 배지로 표시되고, 클릭하면 그 절의 메모를 모두 보여 줍니다
- 메모: 다른 책·장의 말씀까지 한 구절씩 추가·제거(책/장/절 선택 + 본문 미리보기), 레이블 복수 선택, 레이블 추가/삭제, 수정, 읽기 팝업(PDF 저장과 같은 내용), 삭제(첫 줄만 보여 주는 confirm)
- 게시판: 한 페이지 4건씩 페이지 이동, 작성일 desc / 검색(단어·레이블·구절) 시 수정일 desc
- 공유: Web Share API(카카오톡·메시지·메일), 미지원 시 클립보드 복사
- 다운로드: TXT, PDF(인쇄 → "PDF로 저장"), 전체 또는 검색 결과, JSON 내보내기/가져오기

## ⚠️ 알아둘 점
### 성경 본문 저작권
개역개정(대한성서공회)과 NIV 1984(Biblica)는 아직 저작권 보호 대상이라 저장소에 포함하지 않았습니다.
- **한국어: 개역한글판(1961)** — 저작재산권 보호기간이 만료(2012~)된 공유 저작물로, `data/bible/ko/<bookId>.json`(66권, 31,101절)에 번들되어 있습니다.
  출처: [crizin/bible-db](https://github.com/crizin/bible-db)의 개역한글 데이터(원출처 대한성서공회, holybible.or.kr). 형식: `{ "1": ["1절", "2절"], "2": [...] }`.
  인격권(동일성유지·성명표시)에 따라 **본문을 임의로 고치지 말고** "성경전서 개역한글판 (대한성서공회)"로 출처를 표기하세요 (앱의 본문 화면에 표기됨).
- **English: Berean Standard Bible (BSB)** — 2023-04-30 공유 저작물로 공개된 현대 영어 번역으로, `data/bible/en/<bookId>.json`(66권)에 번들되어 있습니다.
  출처: [bereanbible.com](https://bereanbible.com) 공식 텍스트(`bsb.txt`) — "This text of God's Word has been dedicated to the public domain."
  원문에서 사본에 없는 절(예: 마 17:21, 행 8:37)은 빈 문자열로 두어 절 번호를 유지하며, 화면에는 표시하지 않습니다.
  개역한글과는 일부 장(삼상 30, 시 72, 아 6, 고후 13, 요삼 1)의 절 구분이 다릅니다. 메모는 작성한 언어의 절 번호를 저장합니다.
- NIV는 저작권 보호 대상이라 번들하지 않습니다 (NIV 1984는 현재 합법적으로 열람 가능한 온라인 사이트도 없음).

### 읽기표
`data/plan.json`은 2026 맥체인 성경 읽기표(365일 × 4트랙)입니다.
형식: `days["2026-01-01"] = [{book, chapter, chapter2?, verse1?, verse2?} × 4]` (`book`은 `data/books.json`의 `id`).
다른 해에는 월-일로 대응하며 2/29는 2/28과 같습니다. 이전 근사값 플랜(`"MM-DD"` 문자열 형식, `scripts/gen-data.js`로 생성)도 앱이 읽을 수 있습니다.

### 메모 저장 위치
정적 사이트는 `data/` 에 파일을 쓸 수 없으므로:
1. 메모는 브라우저 localStorage에 저장
2. `JSON 내보내기` → `data/memos.json`에 커밋하면 초기 데이터(시드)로 사용, `JSON 가져오기`로 병합
3. **Firebase 동기화 (Google 로그인)**: `data/firebase-config.json`(웹 앱 설정, 공개되어도 안전)이 있으면 헤더에 "Google 로그인"이 나타납니다.
   로그인하면 메모가 `users/{uid}/memos`에 저장되어 같은 계정의 모든 기기와 동기화됩니다 (최신 수정 우선, 삭제도 동기화).
   로그아웃하면 공용 PC 보호를 위해 이 기기의 메모를 지웁니다 (클라우드에는 남음). 설정 파일이 없으면 로컬 전용입니다.

#### Firebase 설정 체크리스트 (콘솔에서 직접)
- [ ] Firestore Database 생성 (완료됨: mccheyne-7bd03)
- [ ] **Firestore → 규칙**에 `scripts/firestore.rules` 내용을 붙여넣고 게시 (본인 메모만 읽기/쓰기). 이 규칙이 없으면 로그인해도 저장이 거부됩니다.
- [ ] **Authentication → 로그인 방법**에서 Google 사용 설정
- [ ] **Authentication → 설정 → 승인된 도메인**에 배포 주소(`<user>.github.io`) 추가 (`localhost`는 기본 포함)

메모 스키마: `id, content, lang, passages[{bookId, chapter, verses[], text}], labels[], createdAt, updatedAt` (한 메모에 여러 책·장의 말씀 가능, 이전 단일 구절 형식은 불러올 때 자동 변환)

## GitHub Pages 배포 메모
1. 저장소 루트에 `index.html`, `style.css`, `app.js`, `data/` 를 push (`McCheyne` 폴더 내용이 저장소 루트가 되게)
2. Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)`
3. `https://<user>.github.io/<repo>/` 에서 확인. 모든 경로가 상대경로라 하위 경로에서도 동작
4. `data/firebase-config.json`은 올리지 않으면 로컬 모드로 동작 (404는 무시됨)
5. 공유(Web Share)는 HTTPS 필요 — Pages는 기본 HTTPS

## 파일 구조
```
index.html  style.css  app.js
data/       books.json plan.json labels.json memos.json bible/ko/
scripts/    gen-data.js
CLAUDE.md  skills.md  README.md
```
