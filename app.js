'use strict';

/* ================= 설정 ================= */
const KEYS = { memos: 'mccheyne.memos.v1', labels: 'mccheyne.labels.v1', lang: 'mccheyne.lang', deleted: 'mccheyne.deleted.v1' };
// 본문은 공유 저작물만 번들: ko = 개역한글(1961), en = Berean Standard Bible (모두 data/bible/<lang>/<bookId>.json)
const BIBLE_FILE = (lang, id) => `data/bible/${lang}/${id}.json`;
const CREDITS = {
  ko: '성경전서 개역한글판 (대한성서공회, 1961)',
  en: 'Berean Standard Bible (BSB, Public Domain)',
};

/* ================= 순수 함수 ================= */
const pad = (n) => String(n).padStart(2, '0');

/** 로컬 날짜 → 'YYYY-MM-DD' (ISO 8601 날짜) */
const toISODate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 'YYYY-MM-DD' ± days */
function shiftISODate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return toISODate(new Date(y, m - 1, d + days));
}

/** 플랜 키. 연도 키 플랜('YYYY-MM-DD')은 월-일로 대응하고 2/29 는 2/28 과 동일, 'MM-DD' 플랜은 그대로 */
const planKey = (iso, plan) => {
  const md = iso.slice(5) === '02-29' && plan.year ? '02-28' : iso.slice(5);
  return plan.year ? `${plan.year}-${md}` : md;
};

/** 'gen.1' 또는 {book,chapter,...} → {book,chapter,...} */
const normalizeReading = (r) => {
  if (typeof r !== 'string') return r;
  const [book, chapter] = r.split('.');
  return { book, chapter: Number(chapter) };
};

/** {book,chapter,chapter2?,verse1?,verse2?} → '레위기 2-3' / '스가랴 13:2-9' */
function formatReading(r, book, lang) {
  const name = bookName(book, lang);
  const { chapter: c, chapter2: c2, verse1: v1, verse2: v2 } = r;
  if (v1 !== undefined) return c2 ? `${name} ${c}:${v1}-${c2}:${v2}` : `${name} ${c}:${v1}-${v2}`;
  return c2 ? `${name} ${c}-${c2}` : `${name} ${c}`;
}

/** [1,2,3,5,7,8] → '1-3, 5, 7-8' */
function compressRanges(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`);
    i = j + 1;
  }
  return out.join(', ');
}

const firstLine = (text) => {
  const lines = text.trim().split(/\r?\n/);
  return lines.length > 1 || lines[0].length > 60 ? `${lines[0].slice(0, 60)} ...` : lines[0];
};

const bookName = (book, lang) => (lang === 'en' ? book.en : book.ko);
const formatRef = (book, lang, chapter, verses) =>
  `${bookName(book, lang)} ${chapter}${verses?.length ? `:${compressRanges(verses)}` : ''}`;

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

const byCreatedDesc = (a, b) => b.createdAt.localeCompare(a.createdAt);
const byUpdatedDesc = (a, b) => b.updatedAt.localeCompare(a.updatedAt);

function filterMemos(memos, query, refOf) {
  const q = query.trim().toLowerCase();
  if (!q) return memos;
  return memos.filter((m) =>
    m.content.toLowerCase().includes(q) ||
    m.labels.some((l) => l.toLowerCase().includes(q)) ||
    refOf(m).toLowerCase().includes(q));
}

const fmtDateTime = (iso) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

/** 레거시 단일 구절 메모(bookId/chapter/verses/passageText) → passages 모델 */
function normalizeMemo(m) {
  const { bookId, chapter, verses, passageText, ...rest } = m;
  const passages = Array.isArray(m.passages)
    ? m.passages
    : [{ bookId, chapter, verses, text: passageText ?? '' }];
  return { ...rest, passages };
}

function isValidMemo(m, hasBook) {
  if (!m || typeof m.id !== 'string' || typeof m.content !== 'string' || !Array.isArray(m.labels) || !m.createdAt || !m.updatedAt) return false;
  const ps = Array.isArray(m.passages) ? m.passages : [m];
  return ps.length > 0 && ps.every((p) => hasBook(p.bookId) && Number.isInteger(p.chapter) && Array.isArray(p.verses));
}

/**
 * 로컬·원격 메모를 병합 (순수 함수). tombstones = {id: 삭제 시각(ISO)}.
 * - 같은 id 는 updatedAt 이 최신인 쪽, 삭제 시각이 메모 수정 시각 이상이면 삭제, 삭제 후 수정했다면 되살림
 * - toUpload: 원격에 없거나 원격보다 최신인 메모, toTomb: 원격에 아직 반영 안 된 삭제 기록
 */
function reconcile(localMemos, localTombs, remoteMemos, remoteTombs) {
  const tombs = { ...remoteTombs };
  for (const [id, t] of Object.entries(localTombs)) if (!tombs[id] || t > tombs[id]) tombs[id] = t;
  const all = new Map(remoteMemos.map((m) => [m.id, m]));
  for (const m of localMemos) {
    const cur = all.get(m.id);
    if (!cur || m.updatedAt > cur.updatedAt) all.set(m.id, m);
  }
  for (const [id, t] of Object.entries(tombs)) {
    const m = all.get(id);
    if (!m) continue;
    if (t >= m.updatedAt) all.delete(id); else delete tombs[id];
  }
  const memos = [...all.values()];
  const remoteById = new Map(remoteMemos.map((m) => [m.id, m]));
  return {
    memos,
    tombstones: tombs,
    toUpload: memos.filter((m) => remoteById.get(m.id)?.updatedAt !== m.updatedAt),
    toTomb: Object.keys(tombs).filter((id) => remoteTombs[id] !== tombs[id]),
  };
}

/** 한 장에서 메모가 연결된 절 → 그 절의 메모 목록 (Map<절, memo[]>) */
function memosByVerse(memos, bookId, chapter) {
  const map = new Map();
  for (const m of memos) {
    for (const p of m.passages) {
      if (p.bookId !== bookId || p.chapter !== chapter) continue;
      for (const v of p.verses) {
        const list = map.get(v) ?? [];
        if (!list.includes(m)) list.push(m);
        map.set(v, list);
      }
    }
  }
  return map;
}

const PAGE_SIZE = 4;

/** 목록을 페이지로 자름 (순수 함수). page 는 범위 밖이면 보정 */
function paginate(list, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { items: list.slice((current - 1) * size, current * size), page: current, pages };
}

/** 현재 페이지 주변의 페이지 번호들 (최대 span 개) */
function pageWindow(page, pages, span = 5) {
  const start = Math.max(1, Math.min(page - Math.floor(span / 2), pages - span + 1));
  return Array.from({ length: Math.min(span, pages) }, (_, i) => start + i);
}

/** 메모 한 건의 텍스트 (읽기 팝업·TXT·PDF 공통). passageRef(memo, passage) → '요한복음 3:16' */
const passageBlocks = (memo, passageRef) => memo.passages
  .map((p) => [`[${passageRef(memo, p)}]`, p.text].filter(Boolean).join('\n'))
  .join('\n\n');

function memoToText(memo, passageRef) {
  const blocks = passageBlocks(memo, passageRef);
  return [
    blocks,
    '',
    memo.content,
    memo.labels.length ? `레이블: ${memo.labels.join(', ')}` : '',
    `작성일: ${fmtDateTime(memo.createdAt)} / 수정일: ${fmtDateTime(memo.updatedAt)}`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

/** 공유용 텍스트: 말씀 구절과 메모 내용만 (레이블·날짜 제외). 메신저에서 읽기 좋은 구분선·이모지 구성 */
function memoToShareText(memo, passageRef) {
  const rule = '━━━━━━━━━━━━━━';
  const verses = memo.passages
    .map((p) => [`📖 ${passageRef(memo, p)}`, p.text].filter(Boolean).join('\n\n'))
    .join('\n\n');
  return [verses, rule, `✍️ 나의 묵상\n\n${memo.content}`].join('\n\n');
}

const memosToText =(memos, passageRef) => memos.map((m) => memoToText(m, passageRef)).join('\n\n----------------------------------------\n\n');

/* ================= 상태 ================= */
const state = {
  books: [], plan: null, labels: [], memos: [], tombstones: {}, remote: null, auth: null, user: null,
  lang: 'ko', date: toISODate(), query: '', page: 1,
  chapter: null, // {bookId, ch, verses:[{n,text}]}
  selected: new Set(),
  draft: null, // {id, lang, passages:[{bookId, chapter, verses:Set}], content, labels:Set}
};
const $ = (sel) => document.querySelector(sel);
const bookById = (id) => state.books.find((b) => b.id === id);
const passageRef = (m, p) => formatRef(bookById(p.bookId), m.lang, p.chapter, p.verses);
const refOf = (m) => m.passages.map((p) => passageRef(m, p)).join('; ');
const memoPassagesText = (m) => m.passages.map((p) => p.text).filter(Boolean).join('\n');

/* ================= DOM 헬퍼 (innerHTML 미사용) ================= */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}
const mount = (el, ...kids) => el.replaceChildren(...kids.flat());

/** 첫 번째로 존재하는 선택자의 요소로 포커스 이동 (요소가 사라진 뒤 포커스가 유실되지 않도록) */
function focusFirst(...selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) { el.focus(); return; }
  }
}

let toastTimer;
let dialogStatusTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('toast--show'), 2200);
  // 모달 대화상자가 열려 있으면 바깥의 토스트는 스크린리더가 읽지 못하므로 대화상자 안의 상태 영역에도 알림
  const inDialog = document.querySelector('dialog[open] [data-dialog-status]');
  if (inDialog) {
    inDialog.textContent = '';
    clearTimeout(dialogStatusTimer);
    dialogStatusTimer = setTimeout(() => { inDialog.textContent = msg; }, 50);
  }
}

/* ================= 저장소 (localStorage + 선택적 Firebase) ================= */
const readJSON = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const writeJSON = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('브라우저 저장소에 쓸 수 없습니다.'); }
};

async function fetchJSON(url, optional = false) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (e) {
    if (optional) return null;
    throw e;
  }
}

/** Firebase(Auth + Firestore) 초기화. 로그인 상태가 바뀌면 사용자별 저장소(users/{uid}/memos)에 연결하고 동기화 */
async function initFirebase(cfg) {
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [{ initializeApp }, A, fs] = await Promise.all([
    import(`${base}firebase-app.js`), import(`${base}firebase-auth.js`), import(`${base}firebase-firestore.js`)]);
  const app = initializeApp(cfg);
  const auth = A.getAuth(app);
  const db = fs.getFirestore(app);
  state.auth = {
    signIn: () => A.signInWithPopup(auth, new A.GoogleAuthProvider()),
    signOut: () => A.signOut(auth),
  };
  renderAuth();
  A.onAuthStateChanged(auth, async (user) => {
    state.user = user ? { uid: user.uid, name: user.displayName || user.email || '로그인됨' } : null;
    if (!user) { state.remote = null; renderAuth(); return; }
    const col = fs.collection(db, 'users', user.uid, 'memos');
    state.remote = {
      list: async () => (await fs.getDocs(col)).docs.map((d) => d.data()),
      save: (doc) => fs.setDoc(fs.doc(col, doc.id), doc), // 메모 또는 삭제 기록({id, deletedAt}) 한 문서
    };
    renderAuth();
    await syncRemote();
  });
}

const persistMemos = () => writeJSON(KEYS.memos, state.memos);
const persistTombs = () => writeJSON(KEYS.deleted, state.tombstones);
const persistLabels = () => writeJSON(KEYS.labels, state.labels);
const remoteCall = (fn) => state.remote && fn(state.remote).catch(() => toast('클라우드 동기화 실패 (이 기기에는 저장됨)'));

function upsertMemo(memo) {
  const i = state.memos.findIndex((m) => m.id === memo.id);
  if (i >= 0) state.memos[i] = memo; else state.memos.push(memo);
  delete state.tombstones[memo.id];
  persistMemos();
  persistTombs();
  remoteCall((r) => r.save(memo));
}

function deleteMemo(id) {
  state.memos = state.memos.filter((m) => m.id !== id);
  state.tombstones[id] = new Date().toISOString();
  persistMemos();
  persistTombs();
  remoteCall((r) => r.save({ id, deletedAt: state.tombstones[id] }));
}

/** 클라우드와 양방향 병합 후 변경분만 업로드 */
async function syncRemote() {
  if (!state.remote) return;
  try {
    const docs = await state.remote.list();
    const remoteTombs = Object.fromEntries(docs.filter((d) => d.deletedAt).map((d) => [d.id, d.deletedAt]));
    const r = reconcile(state.memos, state.tombstones, cleanMemos(docs.filter((d) => !d.deletedAt)), remoteTombs);
    state.memos = r.memos;
    state.tombstones = r.tombstones;
    persistMemos();
    persistTombs();
    await Promise.all([
      ...r.toUpload.map((m) => state.remote.save(m)),
      ...r.toTomb.map((id) => state.remote.save({ id, deletedAt: r.tombstones[id] })),
    ]);
    refreshViews();
    toast('클라우드와 동기화했습니다.');
  } catch { toast('클라우드 동기화 실패 (이 기기에는 저장됨)'); }
}

function refreshViews() {
  const name = parseRoute().name;
  if (name === 'memos') renderMemos();
  else if (name === 'reader' && state.chapter) renderPassage();
}

function renderAuth() {
  $('#auth-box').hidden = !state.auth;
  $('#auth-status').textContent = state.user ? state.user.name : '로컬 저장 중';
  $('#auth-button').textContent = state.user ? '로그아웃' : 'Google 로그인';
}

/** Firebase Auth 오류 코드 → 사용자 안내 (순수 함수) */
function authErrorMessage(e, host = location.hostname) {
  const code = e?.code ?? '';
  const known = {
    'auth/popup-closed-by-user': '로그인을 취소했습니다.',
    'auth/cancelled-popup-request': '로그인을 취소했습니다.',
    'auth/popup-blocked': '팝업이 차단되었습니다. 이 사이트의 팝업을 허용해 주세요.',
    'auth/unauthorized-domain': `승인되지 않은 도메인입니다. Firebase 콘솔 > Authentication > 설정 > 승인된 도메인에 ${host}을(를) 추가하세요.`,
    'auth/operation-not-allowed': 'Google 로그인이 꺼져 있습니다. Firebase 콘솔 > Authentication > 로그인 방법에서 Google을 사용 설정하세요.',
    'auth/configuration-not-found': 'Firebase Authentication이 시작되지 않았습니다. Firebase 콘솔 > Authentication에서 "시작하기"를 누르고 Google을 사용 설정하세요.',
    'auth/network-request-failed': '네트워크 오류입니다. 연결을 확인하세요.',
  };
  return known[code] ?? `로그인에 실패했습니다. (${code || '알 수 없는 오류'})`;
}

async function toggleAuth() {
  try {
    if (!state.user) { await state.auth.signIn(); return; }
    // 공용 PC 보호: 로그아웃하면 이 기기의 메모를 지움 (클라우드에는 남아 있음)
    if (!window.confirm('로그아웃하면 이 기기에 저장된 메모가 지워집니다.\n(클라우드에는 그대로 남아 있고, 다시 로그인하면 불러옵니다.)\n\n계속할까요?')) return;
    await state.auth.signOut();
    state.memos = [];
    state.tombstones = {};
    persistMemos();
    persistTombs();
    refreshViews();
    toast('로그아웃했습니다.');
  } catch (e) {
    console.error('[auth]', e);
    toast(authErrorMessage(e));
  }
}

/** 외부에서 읽은 메모 목록을 검증하고 passages 모델로 정규화 */
const cleanMemos = (list) => (Array.isArray(list) ? list : [])
  .filter((m) => isValidMemo(m, (id) => !!bookById(id)))
  .map(normalizeMemo);

/** id 기준 병합, updatedAt 이 최신인 쪽 우선 */
function mergeMemos(a, b) {
  const map = new Map(a.map((m) => [m.id, m]));
  for (const m of b) {
    const cur = map.get(m.id);
    if (!cur || m.updatedAt > cur.updatedAt) map.set(m.id, m);
  }
  return [...map.values()];
}

/* ================= 본문 로딩 ================= */
const bibleCache = new Map(); // `${lang}.${bookId}` → {장: [절 본문]}

/** → [{n, text}] — text 가 빈 절(사본에 없는 절)은 번호만 유지. 파일이 없으면 null */
async function loadChapter(bookId, ch, lang) {
  const key = `${lang}.${bookId}`;
  if (!bibleCache.has(key)) bibleCache.set(key, await fetchJSON(BIBLE_FILE(lang, bookId), true));
  const verses = bibleCache.get(key)?.[ch];
  return verses ? verses.map((text, i) => ({ n: i + 1, text })) : null;
}

/* ================= 라우팅 ================= */
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'read' && bookById(parts[1])) return { name: 'reader', bookId: parts[1], ch: Number(parts[2]) || 1 };
  if (parts[0] === 'memos') return { name: 'memos' };
  return { name: 'today' };
}

const setPageTitle = (name) => { document.title = `${name} · 맥체인 성경읽기`; };

async function route() {
  const r = parseRoute();
  for (const v of ['today', 'reader', 'memos']) $(`#view-${v}`).hidden = v !== r.name;
  if (r.name === 'today') setPageTitle('오늘의 읽기');
  else if (r.name === 'memos') setPageTitle('메모');
  document.querySelectorAll('.nav-link').forEach((a) => {
    if (a.dataset.route === (r.name === 'memos' ? 'memos' : 'today')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (r.name === 'today') renderToday();
  else if (r.name === 'memos') renderMemos();
  else await renderReader(r.bookId, r.ch);
}

/* ================= 오늘의 읽기 ================= */
function renderToday() {
  $('#date-input').value = state.date;
  const day = state.plan.days[planKey(state.date, state.plan)] ?? [];
  $('#plan-note').textContent = state.plan.source ? `맥체인 읽기표 (출처: ${state.plan.source})` : '※ 읽기표는 맥체인 4트랙 구조를 따른 근사값입니다. (README 참고)';
  mount($('#reading-list'), state.plan.tracks.map((name, i) => {
    const refs = [].concat(day[i] ?? []).map(normalizeReading); // 트랙 항목: 단일 객체 또는 배열
    return h('li', { class: 'reading-list__item' },
      h('p', { class: 'reading-list__track' }, name),
      refs.length
        ? h('div', { class: 'reading-list__links' }, refs.map((r) =>
          h('a', { class: 'btn', href: `#/read/${r.book}/${r.chapter}` }, formatReading(r, bookById(r.book), state.lang))))
        : h('span', { class: 'reading-list__empty' }, '여유일 (밀린 본문 읽기)'));
  }));
}

/* ================= 본문 보기/구절 선택 ================= */
async function renderReader(bookId, ch) {
  const book = bookById(bookId);
  state.selected.clear();
  updateSelectionBar();
  $('#reader-title').textContent = `${bookName(book, state.lang)} ${ch}장`;
  setPageTitle($('#reader-title').textContent);
  $('#passage').lang = state.lang;
  $('#reader-note').textContent = '';
  const prev = ch > 1 ? `#/read/${bookId}/${ch - 1}` : '#/';
  const next = ch < book.chapters ? `#/read/${bookId}/${ch + 1}` : '#/';
  $('#reader-prev').href = prev;
  $('#reader-next').href = next;
  mount($('#passage'), h('p', {}, '불러오는 중...'));

  let verses = null;
  try { verses = await loadChapter(bookId, ch, state.lang); } catch { /* 아래에서 안내 */ }
  if (parseRoute().name !== 'reader') return;
  if (!verses) {
    state.chapter = null;
    mount($('#passage'), h('p', { role: 'alert' }, `본문(${BIBLE_FILE(state.lang, bookId)})을 불러오지 못했습니다. file:// 이 아닌 로컬 서버(README 참고)로 실행 중인지 확인하세요.`));
    return;
  }
  state.chapter = { bookId, ch, verses };
  $('#reader-note').textContent = CREDITS[state.lang];
  renderPassage();
}

/** 본문 렌더. 메모가 연결된 절은 번호를 클릭 가능한 배지로 표시. 빈 절(사본에 없는 절)은 표시하지 않음 */
function renderPassage() {
  const { bookId, ch, verses } = state.chapter;
  const linked = memosByVerse(state.memos, bookId, ch);
  mount($('#passage'), verses.filter((v) => v.text).map((v) => {
    const count = linked.get(v.n)?.length ?? 0;
    const on = state.selected.has(v.n);
    return h('div', { class: on ? 'verse verse--selected' : 'verse', 'data-verse': v.n },
      count
        ? h('button', { type: 'button', class: 'verse__badge', 'data-action': 'verse-memos', 'data-verse': v.n, title: `메모 ${count}개`, 'aria-label': `${v.n}절에 연결된 메모 ${count}개 보기` }, v.n)
        : h('span', { class: 'verse__num' }, v.n), // 스크린리더도 절 번호를 읽을 수 있도록 숨기지 않음
      h('button', { type: 'button', class: 'verse__text', 'aria-pressed': String(on) }, v.text));
  }));
}

/** 절 번호 배지 클릭: 그 절에 연결된 메모를 모두 보여 줌 */
function openVerseMemos(n) {
  const { bookId, ch } = state.chapter;
  const list = [...(memosByVerse(state.memos, bookId, ch).get(n) ?? [])].sort(byUpdatedDesc);
  $('#verse-memos-title').textContent = `${formatRef(bookById(bookId), state.lang, ch, [n])} · 메모 ${list.length}개`;
  mount($('#verse-memos-list'), list.map((m) => h('article', { class: 'verse-memo' }, h('p', { class: 'read__text' }, memoNodes(m)))));
  $('#verse-memos-dialog').showModal();
}

let lastClicked = null;
function toggleVerse(n, range) {
  if (range && lastClicked) {
    const [a, b] = [Math.min(lastClicked, n), Math.max(lastClicked, n)];
    for (let i = a; i <= b; i++) state.selected.add(i);
  } else if (state.selected.has(n)) state.selected.delete(n);
  else state.selected.add(n);
  lastClicked = n;
  document.querySelectorAll('.verse').forEach((el) => {
    const on = state.selected.has(Number(el.dataset.verse));
    el.classList.toggle('verse--selected', on);
    el.querySelector('.verse__text').setAttribute('aria-pressed', String(on));
  });
  updateSelectionBar();
}

function updateSelectionBar() {
  const bar = $('#selection-bar');
  bar.hidden = state.selected.size === 0;
  const status = $('#selection-status'); // 항상 화면에 있는 알림 영역 (숨겨진 바 안의 live region은 읽히지 않을 수 있음)
  if (!bar.hidden && state.chapter) {
    const ref = formatRef(bookById(state.chapter.bookId), state.lang, state.chapter.ch, [...state.selected]);
    $('#selection-info').textContent = ref;
    status.textContent = `${ref} 선택됨`;
  } else status.textContent = '';
}

/** 구절 선택/메모 저장 후 사라진 버튼 대신 포커스를 둘 곳 */
const focusVerse = (n) => document.querySelector(`.verse[data-verse="${n}"] .verse__text`)?.focus();

const passageTextOf = (verses, nums) =>
  verses.filter((v) => v.text && nums.includes(v.n)).map((v) => `${v.n} ${v.text}`).join('\n');

async function copyText(text, okMsg = '복사했습니다.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch { toast('복사할 수 없습니다. 직접 선택해 복사하세요.'); }
}

function copySelection() {
  const { bookId, ch, verses } = state.chapter;
  const nums = [...state.selected].sort((a, b) => a - b);
  copyText(`${formatRef(bookById(bookId), state.lang, ch, nums)}\n${passageTextOf(verses, nums)}`);
}

/* ================= 메모 작성 다이얼로그 ================= */
const optionsOf = (values, labelOf = String) => values.map((v) => h('option', { value: v }, labelOf(v)));

function fillBookSelect(lang, bookId) {
  const group = (label, tt) => h('optgroup', { label },
    state.books.filter((b) => b.testament === tt).map((b) => h('option', { value: b.id }, bookName(b, lang))));
  const sel = $('#add-book');
  mount(sel, group(lang === 'en' ? 'Old Testament' : '구약', 'OT'), group(lang === 'en' ? 'New Testament' : '신약', 'NT'));
  sel.value = bookId;
}

let pickerToken = 0;
/** 책·장·절 선택기를 채우고 선택한 구절 본문을 미리보기로 표시. 연속 호출 시 마지막 호출만 반영 */
async function syncPicker({ chapter, verse } = {}) {
  const token = ++pickerToken;
  const bookId = $('#add-book').value;
  const book = bookById(bookId);
  const chSel = $('#add-chapter');
  mount(chSel, optionsOf(Array.from({ length: book.chapters }, (_, i) => i + 1)));
  chSel.value = Math.min(Math.max(Number(chapter ?? chSel.value) || 1, 1), book.chapters);

  let verses = null;
  try { verses = await loadChapter(bookId, Number(chSel.value), state.draft.lang); } catch { /* 아래에서 안내 */ }
  if (token !== pickerToken) return;
  const vSel = $('#add-verse');
  const readable = (verses ?? []).filter((v) => v.text);
  mount(vSel, optionsOf(readable.map((v) => v.n)));
  if (!readable.length) { $('#add-preview').textContent = '본문을 불러오지 못했습니다.'; return; }
  vSel.value = readable.some((v) => v.n === verse) ? verse : readable[0].n;
  showPreview(readable);
}

function showPreview(readable) {
  const v = readable.find((x) => x.n === Number($('#add-verse').value));
  $('#add-preview').textContent = v ? `${v.n} ${v.text}` : '';
}

async function previewSelectedVerse() {
  const d = state.draft;
  try {
    const verses = await loadChapter($('#add-book').value, Number($('#add-chapter').value), d.lang);
    showPreview((verses ?? []).filter((v) => v.text));
  } catch { $('#add-preview').textContent = ''; }
}

function openMemoDialog(draft) {
  state.draft = draft;
  const last = draft.passages.at(-1);
  $('#memo-dialog-title').textContent = draft.id ? '메모 수정' : '메모 작성';
  $('#memo-content').value = draft.content;
  fillBookSelect(draft.lang, last.bookId);
  syncPicker({ chapter: last.chapter, verse: Math.min(...last.verses) });
  renderDraft();
  $('#memo-dialog').showModal();
  $('#memo-content').focus();
}

const draftRef = (d, p) => formatRef(bookById(p.bookId), d.lang, p.chapter, [...p.verses]);

function renderDraft() {
  const d = state.draft;
  $('#memo-ref').textContent = d.passages.length ? d.passages.map((p) => draftRef(d, p)).join('; ') : '선택된 말씀이 없습니다.';
  mount($('#memo-passages'), d.passages.map((p, pi) => {
    const nums = [...p.verses].sort((a, b) => a - b);
    return h('li', { class: 'memo-passage' },
      h('div', { class: 'memo-passage__head' },
        h('strong', {}, draftRef(d, p)),
        h('button', { type: 'button', class: 'btn btn--danger', 'data-action': 'passage-remove', 'data-pi': pi, 'aria-label': `${draftRef(d, p)} 삭제` }, '삭제')),
      nums.length <= 15 && h('ul', { class: 'chips', 'aria-label': '절' }, nums.map((n) =>
        h('li', {}, h('button', { type: 'button', class: 'chip', 'data-action': 'verse-remove', 'data-pi': pi, 'data-verse': n, 'aria-label': `${n}절 제거` }, `${n}절 ×`)))));
  }));
  mount($('#memo-labels'), state.labels.map((label, i) => {
    const id = `memo-label-${i}`;
    return h('span', {},
      h('label', { class: 'check', for: id },
        h('input', { type: 'checkbox', id, name: 'label', value: label, checked: d.labels.has(label) }), label));
  }));
}

/** 선택기에서 고른 한 구절을 말씀 목록에 추가 (같은 장이면 합침, 추가한 순서 유지 — 첫 말씀이 "본문" 링크 대상) */
function addPassage() {
  const d = state.draft;
  const bookId = $('#add-book').value;
  const chapter = Number($('#add-chapter').value);
  const verse = Number($('#add-verse').value);
  if (!verse) { toast('추가할 구절을 선택하세요.'); return; }
  const found = d.passages.find((p) => p.bookId === bookId && p.chapter === chapter);
  if (found) found.verses.add(verse);
  else d.passages.push({ bookId, chapter, verses: new Set([verse]) });
  renderDraft();
  toast(`${formatRef(bookById(bookId), d.lang, chapter, [verse])} 추가`);
}

async function saveMemo(form) {
  const d = state.draft;
  if (!d.passages.length) { toast('말씀을 하나 이상 추가하세요.'); return; }
  const content = $('#memo-content').value.trim();
  if (!content) { toast('메모 내용을 입력하세요.'); return; }
  d.labels = new Set([...form.querySelectorAll('input[name="label"]:checked')].map((i) => i.value));

  const prev = d.id && state.memos.find((m) => m.id === d.id);
  const passages = await Promise.all(d.passages.map(async (p) => {
    const nums = [...p.verses].sort((a, b) => a - b);
    let text = '';
    try {
      const verses = await loadChapter(p.bookId, p.chapter, d.lang);
      text = verses ? passageTextOf(verses, nums) : '';
    } catch { /* 본문 스냅샷 없이 저장 */ }
    const old = prev?.passages.find((q) => q.bookId === p.bookId && q.chapter === p.chapter);
    return { bookId: p.bookId, chapter: p.chapter, verses: nums, text: text || old?.text || '' };
  }));

  const now = new Date().toISOString();
  const id = prev ? prev.id : newId();
  upsertMemo({
    id,
    content,
    lang: d.lang,
    passages,
    labels: [...d.labels],
    createdAt: prev ? prev.createdAt : now,
    updatedAt: now, // 최초 작성 시 createdAt 과 동일한 값
  });
  $('#memo-dialog').close();
  state.selected.clear();
  toast('메모를 저장했습니다.');
  if (parseRoute().name === 'memos') {
    renderMemos();
    const card = [...document.querySelectorAll('.memo-card')].find((c) => c.dataset.id === id);
    (card?.querySelector('button') ?? $('#search-input')).focus(); // 목록이 다시 그려져 포커스가 사라지는 것 방지
  } else if (state.chapter) {
    renderPassage(); updateSelectionBar(); // 새 메모의 절 번호 배지 반영
    focusVerse(lastClicked);
  }
}

function toggleSelectionReset() {
  state.selected.clear();
  document.querySelectorAll('.verse--selected').forEach((el) => {
    el.classList.remove('verse--selected');
    el.querySelector('.verse__text').setAttribute('aria-pressed', 'false');
  });
  updateSelectionBar();
  $('#selection-status').textContent = '선택을 해제했습니다.';
  focusVerse(lastClicked); // 눌렀던 "해제" 버튼은 바와 함께 사라지므로
}

/* ================= 메모 게시판 ================= */
const visibleMemos = () => {
  const searching = state.query.trim() !== '';
  const list = filterMemos(state.memos, state.query, refOf);
  return { searching, list: [...list].sort(searching ? byUpdatedDesc : byCreatedDesc) };
};

function renderMemos() {
  const { searching, list } = visibleMemos();
  $('#memos-summary').textContent = searching
    ? `검색 결과 ${list.length}건 (수정일 최신순)`
    : `전체 ${list.length}건 (작성일 최신순)`;
  // 페이지 크기는 PAGE_SIZE 건
  const { items, page, pages } = paginate(list, state.page);
  state.page = page;
  mount($('#board'), items.map((m) => memoCard(m, searching)));
  renderPager(page, pages);
}

function renderPager(page, pages) {
  const nav = $('#pager');
  nav.hidden = pages <= 1;
  const btn = (label, target, extra = {}) =>
    h('button', { type: 'button', class: 'btn', 'data-action': 'page-go', 'data-page': target, ...extra }, label);
  mount(nav,
    btn('‹ 이전', page - 1, { disabled: page <= 1, 'aria-label': '이전 페이지' }),
    pageWindow(page, pages).map((n) => btn(n, n, n === page
      ? { 'aria-current': 'page', 'aria-label': `${n}페이지 (현재)`, class: 'btn btn--primary' }
      : { 'aria-label': `${n}페이지` })),
    h('span', { class: 'pager__info' }, `${page} / ${pages}`),
    btn('다음 ›', page + 1, { disabled: page >= pages, 'aria-label': '다음 페이지' }));
}

function memoCard(m, full) {
  return h('li', { class: 'memo-card', 'data-id': m.id },
    h('p', { class: 'memo-card__ref', lang: m.lang }, refOf(m)),
    memoPassagesText(m) && h('p', { class: 'memo-card__verse', lang: m.lang }, full ? memoPassagesText(m) : firstLine(memoPassagesText(m))),
    h('p', { class: 'memo-card__body' }, full ? m.content : firstLine(m.content)),
    m.labels.length > 0 && h('ul', { class: 'chips', 'aria-label': '레이블' }, m.labels.map((l) => h('li', { class: 'chip' }, l))),
    h('p', { class: 'memo-card__meta' }, `작성일 ${fmtDateTime(m.createdAt)} · 수정일 ${fmtDateTime(m.updatedAt)}`),
    h('div', { class: 'memo-card__actions' },
      h('button', { type: 'button', class: 'btn', 'data-action': 'memo-read', 'aria-label': `${refOf(m)} 메모 읽기` }, '읽기'),
      h('a', { class: 'btn', href: `#/read/${m.passages[0].bookId}/${m.passages[0].chapter}`, 'aria-label': `${passageRef(m, m.passages[0])} 본문 보기` }, '본문'),
      h('button', { type: 'button', class: 'btn', 'data-action': 'memo-edit', 'aria-label': `${refOf(m)} 메모 수정` }, '수정'),
      h('button', { type: 'button', class: 'btn', 'data-action': 'memo-share', 'aria-label': `${refOf(m)} 메모 공유` }, '공유'),
      h('button', { type: 'button', class: 'btn btn--danger', 'data-action': 'memo-delete', 'aria-label': `${refOf(m)} 메모 삭제` }, '삭제')));
}

function confirmDelete(m) {
  if (window.confirm(`이 메모를 삭제할까요?\n\n${refOf(m)}\n${firstLine(m.content)}`)) {
    deleteMemo(m.id);
    renderMemos();
    toast('삭제했습니다.');
    focusFirst('#board button', '#search-input');
  }
}

/** memoToText 와 같은 내용이되, 말씀 부분에만 메모의 언어(lang)를 표시 — 스크린리더가 올바른 음성으로 읽도록 */
function memoNodes(m) {
  const blocks = passageBlocks(m, passageRef);
  return [h('span', { lang: m.lang }, blocks), memoToText(m, passageRef).slice(blocks.length)];
}

/** 읽기 팝업: PDF 저장·TXT와 같은 내용 */
function openReadDialog(m) {
  mount($('#read-text'), memoNodes(m));
  $('#read-dialog').showModal();
}

/* ================= 공유 / 다운로드 ================= */
async function shareMemo(m) {
  const text = memoToShareText(m, passageRef);
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copyText(text, '공유 기능이 없어 클립보드에 복사했습니다.');
}

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => toISODate();

function downloadTxt() {
  const { list, searching } = visibleMemos();
  if (!list.length) { toast('다운로드할 메모가 없습니다.'); return; }
  download(`mccheyne-${searching ? 'search' : 'memos'}-${stamp()}.txt`,
    new Blob(['﻿', memosToText(list, passageRef)], { type: 'text/plain;charset=utf-8' }));
}

function downloadJson() {
  download(`memos-${stamp()}.json`, new Blob([JSON.stringify(state.memos, null, 2)], { type: 'application/json' }));
}

function printPdf() {
  const { list } = visibleMemos();
  if (!list.length) { toast('저장할 메모가 없습니다.'); return; }
  mount($('#print-area'),
    h('h1', {}, '맥체인 성경읽기 메모'),
    list.map((m) => h('p', { class: 'print-area__memo' }, memoToText(m, passageRef))));
  document.body.classList.add('is-printing');
  window.addEventListener('afterprint', () => document.body.classList.remove('is-printing'), { once: true });
  window.print(); // 인쇄 대화상자에서 'PDF로 저장' 선택
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const valid = cleanMemos(data);
    state.memos = mergeMemos(state.memos, valid);
    persistMemos();
    renderMemos();
    toast(`${valid.length}건을 가져왔습니다.`);
  } catch { toast('올바른 JSON 파일이 아닙니다.'); }
}

/* ================= 레이블 관리 ================= */
function renderLabelsDialog() {
  mount($('#labels-list'), state.labels.map((l) =>
    h('li', {}, h('button', { type: 'button', class: 'chip', 'data-action': 'label-delete', 'data-label': l, 'aria-label': `레이블 ${l} 삭제` }, `${l} ×`))));
}

/* ================= 이벤트 (위임) ================= */
const actions = {
  'day-prev': () => { state.date = shiftISODate(state.date, -1); renderToday(); },
  'day-next': () => { state.date = shiftISODate(state.date, 1); renderToday(); },
  'day-today': () => { state.date = toISODate(); renderToday(); },
  'copy-selection': copySelection,
  'clear-selection': toggleSelectionReset,
  'memo-new': () => {
    const { bookId, ch } = state.chapter;
    openMemoDialog({ id: null, lang: state.lang, passages: [{ bookId, chapter: ch, verses: new Set(state.selected) }], content: '', labels: new Set() });
  },
  'passage-add': addPassage,
  'passage-remove': (el) => {
    const [p] = state.draft.passages.splice(Number(el.dataset.pi), 1);
    renderDraft();
    toast(`${draftRef(state.draft, p)} 삭제`);
    focusFirst('#memo-passages button', '#add-book');
  },
  'verse-remove': (el) => {
    const { passages } = state.draft;
    const p = passages[Number(el.dataset.pi)];
    const n = Number(el.dataset.verse);
    p.verses.delete(n);
    if (!p.verses.size) passages.splice(passages.indexOf(p), 1);
    renderDraft();
    toast(`${n}절 제거`);
    focusFirst('#memo-passages .chip', '#memo-passages button', '#add-book');
  },
  'dialog-close': (el) => el.closest('dialog').close(),
  'memo-edit': (el) => {
    const m = state.memos.find((x) => x.id === el.closest('[data-id]').dataset.id);
    openMemoDialog({
      id: m.id, lang: m.lang, content: m.content, labels: new Set(m.labels),
      passages: m.passages.map((p) => ({ bookId: p.bookId, chapter: p.chapter, verses: new Set(p.verses) })),
    });
  },
  'auth-toggle': toggleAuth,
  'page-go': (el) => {
    state.page = Number(el.dataset.page);
    renderMemos();
    $('#memos-summary').scrollIntoView({ block: 'start' });
    $('#board').querySelector('a, button')?.focus({ preventScroll: true });
  },
  'verse-memos': (el) => openVerseMemos(Number(el.dataset.verse)),
  'memo-read': (el) => openReadDialog(state.memos.find((x) => x.id === el.closest('[data-id]').dataset.id)),
  'memo-delete': (el) => confirmDelete(state.memos.find((x) => x.id === el.closest('[data-id]').dataset.id)),
  'memo-share': (el) => shareMemo(state.memos.find((x) => x.id === el.closest('[data-id]').dataset.id)),
  'dl-txt': downloadTxt,
  'dl-pdf': printPdf,
  'dl-json': downloadJson,
  'labels-open': () => { renderLabelsDialog(); $('#labels-dialog').showModal(); },
  'label-delete': (el) => {
    state.labels = state.labels.filter((l) => l !== el.dataset.label);
    persistLabels();
    renderLabelsDialog();
    if (state.draft) renderDraft();
    toast(`레이블 ${el.dataset.label} 삭제`);
    focusFirst('#labels-list button', '#label-input');
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el) { actions[el.dataset.action]?.(el); return; }
  const verse = e.target.closest('.verse');
  if (verse) toggleVerse(Number(verse.dataset.verse), e.shiftKey);
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'memo-form') { e.preventDefault(); saveMemo(e.target); }
  else if (e.target.id === 'label-form') {
    e.preventDefault();
    const input = $('#label-input');
    const name = input.value.trim();
    if (name && !state.labels.includes(name)) {
      state.labels.push(name);
      persistLabels();
      renderLabelsDialog();
      toast(`레이블 ${name} 추가`);
    } else if (name) toast('이미 있는 레이블입니다.');
    input.value = '';
  } else if (e.target.id === 'search-form') e.preventDefault();
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search-input') { state.query = e.target.value; state.page = 1; renderMemos(); }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'lang-select') {
    state.lang = e.target.value;
    try { localStorage.setItem(KEYS.lang, state.lang); } catch { /* 무시 */ }
    document.documentElement.lang = 'ko';
    route();
  } else if (e.target.id === 'add-book') {
    syncPicker({ chapter: 1 });
  } else if (e.target.id === 'add-chapter') {
    syncPicker({ chapter: Number(e.target.value) });
  } else if (e.target.id === 'add-verse') {
    previewSelectedVerse();
  } else if (e.target.id === 'date-input' && e.target.value) {
    state.date = e.target.value;
    renderToday();
  } else if (e.target.id === 'import-file' && e.target.files[0]) {
    importJson(e.target.files[0]);
    e.target.value = '';
  }
});

// 화면 전환 시 새 화면의 제목(h2)으로 포커스를 옮겨 스크린리더가 어디로 이동했는지 읽어 주도록 함
window.addEventListener('hashchange', () => {
  route();
  (document.querySelector('.view:not([hidden]) .view__title') ?? $('#main')).focus();
  window.scrollTo(0, 0);
});

/* ================= 시작 ================= */
async function init() {
  try {
    const [books, plan, labels, seed, fbCfg] = await Promise.all([
      fetchJSON('data/books.json'), fetchJSON('data/plan.json'), fetchJSON('data/labels.json'),
      fetchJSON('data/memos.json', true), fetchJSON('data/firebase-config.json', true),
    ]);
    Object.assign(state, { books, plan });
    state.labels = readJSON(KEYS.labels, null) ?? labels;
    state.memos = mergeMemos(cleanMemos(readJSON(KEYS.memos, [])), cleanMemos(seed));
    state.tombstones = readJSON(KEYS.deleted, {});
    persistMemos(); // 레거시 메모를 새 모델로 저장
    try { state.lang = localStorage.getItem(KEYS.lang) || 'ko'; } catch { /* 기본값 */ }
    $('#lang-select').value = state.lang;

    if (fbCfg?.projectId) initFirebase(fbCfg).catch(() => toast('Firebase 연결 실패 - 로컬 모드로 동작합니다.')); // 화면 표시를 막지 않음
  } catch {
    mount($('#main'), h('p', {}, '데이터를 불러오지 못했습니다. file:// 이 아닌 로컬 서버(README 참고)로 실행하세요.'));
    return;
  }
  route();
}

init();
