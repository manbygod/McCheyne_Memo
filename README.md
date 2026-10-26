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
- 다운로드: TXT, PDF(글꼴을 내장한 텍스트 PDF — 선택·복사·검색·스크린리더 낭독 가능), 전체 또는 검색 결과

## ⚠️ 알아둘 점
### 성경 본문 저작권
개역개정(대한성서공회)과 NIV 1984(Biblica)는 아직 저작권 보호 대상이라 저장소에 포함하지 않았습니다.
- **한국어: 개역한글판(1961)** — 저작재산권 보호기간이 만료(2012~)된 공유 저작물로, `data/bible/ko/<bookId>.json`(66권, 31,101절)에 번들되어 있습니다.
  출처: [crizin/bible-db](https://github.com/crizin/bible-db)의 개역한글 데이터(원출처 대한성서공회, holybible.or.kr). 형식: `{ "1": ["1절", "2절"], "2": [...] }`.
  인격권(동일성유지·성명표시)에 따라 **본문을 임의로 고치지 말고** "성경전서 개역한글판 (대한성서공회)"로 출처를 표기하세요 (앱의 본문 화면에 표기됨).
- **개역개정·NIV(선택, 이 기기에만)** — 성경 화면의 "개역개정 파일 가져오기"·"NIV 파일 가져오기"로 본인이 가진 본문을 불러오면 브라우저 IndexedDB에만 저장되고 저장소·서버로는 전송되지 않습니다.
  형식은 책 ID를 키로 한 단일 JSON 파일 `{ "gen": { "1": ["1절", …], … }, "exo": {…} }`(각 책의 값은 개역한글 `<bookId>.json`과 같고 장 수가 책 정보와 일치해야 함)이며, 일부 책만 담아도 되고 다시 가져오면 들어 있는 책만 덮어씁니다. 가져온 뒤 상단 언어에서 "한국어 (개역개정, 이 기기)" 또는 "English (NIV, 이 기기)"를 고릅니다. NIV 파일도 같은 형식이며 절 본문만 영어입니다.
  예) 개역개정: `{ "gen": { "1": ["1절 본문", "2절 본문"], "2": […] }, "exo": {…} }`, NIV: `{ "gen": { "1": ["verse 1", "verse 2"], "2": […] } }`. 책 ID는 `data/books.json`의 `id`(예: gen, mat)이고, 66권 전체 또는 일부를 담을 수 있습니다.
  가져온 개역개정 본문으로 쓴 메모에는 그 구절 본문이 포함되므로, 로그인(클라우드 동기화) 중이면 메모와 함께 본인 계정 저장소에 올라갑니다.
- **English: Berean Standard Bible (BSB)** — 2023-04-30 공유 저작물로 공개된 현대 영어 번역으로, `data/bible/en/<bookId>.json`(66권)에 번들되어 있습니다.
  출처: [bereanbible.com](https://bereanbible.com) 공식 텍스트(`bsb.txt`) — "This text of God's Word has been dedicated to the public domain."
  원문에서 사본에 없는 절(예: 마 17:21, 행 8:37)은 빈 문자열로 두어 절 번호를 유지하며, 화면에는 표시하지 않습니다.
  개역한글과는 일부 장(삼상 30, 시 72, 아 6, 고후 13, 요삼 1)의 절 구분이 다릅니다. 메모는 작성한 언어의 절 번호를 저장합니다.
- NIV는 저작권 보호 대상이라 번들하지 않습니다 (NIV 1984는 현재 합법적으로 열람 가능한 온라인 사이트도 없음).

### PDF 글꼴 (Noto Sans KR 부분집합)
PDF는 이미지가 아니라 진짜 글자로 만들며, `fonts/NotoSansKR-subset.ttf`(+ 글리프 지표 `NotoSansKR-subset.json`)를 PDF 만들 때 불러와, **실제로 쓰인 글자만** 다시 잘라 PDF에 내장합니다.
- 글꼴: [Noto Sans KR](https://fonts.google.com/noto/specimen/Noto+Sans+KR) Regular(400), SIL OFL 1.1 (`fonts/LICENSE-NotoSansKR.txt`). 굵은 글씨는 같은 글꼴에 윤곽선을 덧그려 표현합니다.
- 포함 글자: KS X 1001(한글 2,350자·기호, 한자 제외) + ASCII·라틴·문장부호 + 개역한글·BSB 본문과 `data/memos.json`에 쓰인 글자. 글꼴에 없는 글자는 PDF에서 `?`로, 이모지는 빠집니다.
- 다시 만들 때(개발용, 앱 실행에는 불필요): `pip install fonttools` 후 `python scripts/gen-pdf-font.py <NotoSansKR[wght].ttf 경로>`

### 읽기표
`data/plan.json`은 2026 맥체인 성경 읽기표(365일 × 4트랙)입니다.
형식: `days["2026-01-01"] = [{book, chapter, chapter2?, verse1?, verse2?} × 4]` (`book`은 `data/books.json`의 `id`).
다른 해에는 월-일로 대응하며 2/29는 2/28과 같습니다. 이전 근사값 플랜(`"MM-DD"` 문자열 형식, `scripts/gen-data.js`로 생성)도 앱이 읽을 수 있습니다.

### 메모 저장 위치
정적 사이트는 `data/` 에 파일을 쓸 수 없으므로:
1. 메모는 브라우저 localStorage에 저장
2. `data/memos.json`에 메모 배열을 넣어 커밋하면 초기 데이터(시드)로 사용되어 기존 메모와 병합됩니다. (앱에는 JSON 내보내기/가져오기 버튼이 없으며, 필요할 때 Claude로 브라우저 저장소의 메모를 JSON으로 꺼내거나 이 파일에 추가합니다.)
3. **Firebase 동기화 (Google 로그인)**: `data/firebase-config.json`(웹 앱 설정, 공개되어도 안전)이 있으면 헤더에 "Google 로그인"이 나타납니다.
   로그인하면 메모가 `users/{uid}/memos`에 저장되어 같은 계정의 모든 기기와 동기화됩니다 (최신 수정 우선, 삭제도 동기화). 레이블 목록은 빈 레이블까지 포함해 `users/{uid}/meta/labels`에 한 문서로 저장되며 더 최근에 바꾼 쪽이 이깁니다.
   로그아웃하면 공용 PC 보호를 위해 이 기기의 메모를 지웁니다 (클라우드에는 남음). 설정 파일이 없으면 로컬 전용입니다.

#### Firebase 설정 체크리스트 (콘솔에서 직접)
- [ ] Firestore Database 생성 (완료됨: mccheyne-7bd03)
- [ ] **Firestore → 규칙**에 `scripts/firestore.rules` 내용을 붙여넣고 게시 (본인 메모만 읽기/쓰기). 이 규칙이 없으면 로그인해도 저장이 거부됩니다.
- [ ] **Authentication → 로그인 방법**에서 Google 사용 설정
- [ ] **Authentication → 설정 → 승인된 도메인**에 배포 주소(`<user>.github.io`) 추가 (`localhost`는 기본 포함)

### AI 질문 (Gemini 챗봇)
로그인하면 헤더에 "AI 질문"이 나타납니다. 본문(지금 읽는 장 / 선택한 날짜의 읽기표)과, 켜 둔 경우 내 메모를 참고해 질문에 답합니다.
- **구조**: 서버 코드 없음. 브라우저 → Firebase AI Logic → Gemini Developer API. 프로젝트는 **Spark(무료) 요금제를 유지**하세요. 결제(Cloud Billing)를 연결하면 무료 한도 보호가 사라집니다.
- **대화는 저장하지 않습니다.** 새로고침·로그아웃하면 사라집니다. 하루 질문 횟수(30회)는 브라우저 안의 보조 한도라 서버가 강제하지 않습니다. 실제 상한은 Gemini 무료 구간의 프로젝트 할당량이며, 다 쓰면 챗봇만 일시적으로 멈춥니다.
- **보내는 데이터**: 질문, 참고 본문(번들된 개역한글·BSB만. 가져온 개역개정·NIV는 보내지 않음), "내 메모를 참고해서 답하기"를 켠 경우 관련 메모 최대 20개(12,000자, 메모에 붙은 성경 본문은 제외). 메모 옵션은 창을 열 때마다 꺼집니다. 무료 구간은 입력 내용이 서비스 개선에 쓰일 수 있다고 알려져 있으니 [Gemini API 약관](https://ai.google.dev/gemini-api/terms)을 확인하세요.
- **외부 의존(CDN)**: `chat.js`가 처음 열릴 때 `https://www.gstatic.com/firebasejs/11.10.0/`의 `firebase-ai.js`(와 App Check 사용 시 `firebase-app-check.js`)를 불러옵니다. 기존 로그인·동기화는 10.12.2를 쓰므로, 챗봇은 같은 설정으로 별도 Firebase 앱(`mccheyne-ai`)을 만들어 씁니다. 빌드·npm 의존성은 없습니다.

#### AI 질문 설정 체크리스트 (콘솔에서 직접)
- [ ] **Firebase 콘솔 → AI Logic → 시작하기 → Gemini Developer API** 선택 (Spark 유지)
- [ ] **App Check**: Google Cloud에서 reCAPTCHA 키(웹, 점수 기반, 도메인에 배포 주소·`localhost`)를 만들고, Firebase 콘솔 App Check에서 앱에 **Fraud Defense(reCAPTCHA Enterprise)** 로 같은 사이트 키를 등록한 뒤, `data/firebase-config.json`에 `"recaptchaEnterpriseSiteKey": "<사이트 키>"`를 추가하고 AI Logic을 시행(enforce)으로 설정. (예전 v3 키는 `"recaptchaSiteKey"`로 지원.) 키가 없으면 App Check 없이 동작하지만 외부 호출을 막지 못합니다. 비밀 키는 저장소에 넣지 않습니다.
- [ ] **AI Logic → 설정**에서 사용자별 분당 요청 한도를 낮게 설정
- [ ] (선택) `data/firebase-config.json`의 `"chatModel"`로 모델 이름 변경 (기본 `gemini-flash-lite-latest`. 더 큰 모델을 쓰려면 여기서 교체하되, 무료 구간에서 응답이 오지 않는 모델이 있으니 먼저 시험하세요)

메모 스키마: `id, content, lang, passages[{bookId, chapter, verses[], text}], labels[], createdAt, updatedAt` (한 메모에 여러 책·장의 말씀 가능, 이전 단일 구절 형식은 불러올 때 자동 변환)

## GitHub Pages 배포 메모
1. 저장소 루트에 `index.html`, `style.css`, `app.js`, `chat.js`, `data/` 를 push (`McCheyne` 폴더 내용이 저장소 루트가 되게)
2. Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)`
3. `https://<user>.github.io/<repo>/` 에서 확인. 모든 경로가 상대경로라 하위 경로에서도 동작
4. `data/firebase-config.json`은 올리지 않으면 로컬 모드로 동작 (404는 무시됨)
5. 공유(Web Share)는 HTTPS 필요 — Pages는 기본 HTTPS

## 폰트
영어 본문은 Literata(The Literata Project Authors, SIL OFL 1.1)를 `fonts/`에 직접 번들합니다 (latin 서브셋, 가변 폰트). CDN을 쓰지 않아 외부 요청이 없고 오프라인에서도 동작합니다. 라이선스: `fonts/LICENSE-Literata.txt`

## 파일 구조
```
index.html  style.css  app.js  chat.js
data/       books.json plan.json labels.json memos.json bible/ko/
fonts/      Literata-*.woff2 LICENSE-Literata.txt
scripts/    gen-data.js
CLAUDE.md  skills.md  README.md
```
