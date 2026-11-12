/* 기도방 (Firestore). 처음 "기도"를 열 때만 app.js 가 동적으로 불러온다.
   - 관리자(ADMIN_EMAIL): 기도방 만들기(CSV)·관리(이름·초대·삭제) + 사용자 기능
   - 사용자: 초대받은 기도방에서 기도제목 검색·게시·편집
   - 데이터: prayerRooms/{방} {name, members[], memberNames{}, ...} 와 prayerRooms/{방}/prayers/{기도} (규칙: scripts/firestore.rules)
   - 사용자·외부 텍스트는 textContent/createElement 로만 넣는다 (innerHTML 미사용) */

export const ADMIN_EMAIL = 'manbygod@gmail.com';
export const CSV_HEADER = ['게시자', '게시일', '기도 제목', '기도 응답'];
/** 크기 상한. scripts/firestore.rules 와 맞춘다 */
export const LIMITS = { fileBytes: 1024 * 1024, rows: 2000, name: 40, author: 40, content: 5000, members: 200 };

/* ================= 순수 함수 ================= */
/** 파일 바이트 → 글자. UTF-8 이 아니면 한글 엑셀의 기본 CSV 인코딩(CP949, euc-kr)으로 읽는다 */
export function decodeBytes(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('euc-kr').decode(buf); }
}

/** CSV(RFC 4180) → {rows, lines, unclosed}. 큰따옴표 안의 쉼표·줄바꿈·"" 를 처리, 빈 줄은 건너뜀. lines[i] = i번째 레코드가 시작한 줄 번호 */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  const lines = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    row.push(field);
    if (row.some((c) => c.trim() !== '')) { rows.push(row); lines.push(rowLine); }
    row = [];
    field = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else { if (c === '\n') line++; field += c; }
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else field += c;
  }
  const unclosed = quoted;
  if (field !== '' || row.length) endRow();
  return { rows, lines, unclosed };
}

/** '2025/06/28' · '2025-6-8' · '2025.06.28' → 'YYYY-MM-DD' (실제 있는 날짜만), 아니면 null */
export function parsePostedDate(s) {
  const m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\.?$/.exec(String(s).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const squash = (s) => String(s).replace(/\s+/g, '');
const MAX_SHOWN = 30;

/**
 * 파싱된 CSV 를 기도방 스키마(게시자, 게시일, 기도 제목, 기도 응답)로 검증.
 * → {prayers:[{author, postedOn, content, response}], errors:[사유 문장]} — errors 가 비어 있어야 만들 수 있다
 */
export function validatePrayerCsv({ rows, lines, unclosed }) {
  const errors = [];
  if (unclosed) errors.push('큰따옴표(")가 닫히지 않은 곳이 있습니다. 여러 줄이거나 쉼표가 들어간 내용은 "..." 로 묶어야 하고, 내용 속 큰따옴표는 "" 로 씁니다.');
  if (!rows.length) { errors.push('파일에 내용이 없습니다.'); return { prayers: [], errors }; }
  const head = rows[0].map(squash);
  if (head.length < CSV_HEADER.length || CSV_HEADER.some((c, i) => squash(c) !== head[i]) || head.slice(CSV_HEADER.length).some(Boolean)) {
    errors.push(`첫 줄(머리글)이 기도방 형식과 다릅니다. 필요: ${CSV_HEADER.join(',')} / 현재: ${rows[0].join(',')}`);
    return { prayers: [], errors };
  }
  if (rows.length - 1 > LIMITS.rows) errors.push(`기도제목이 ${rows.length - 1}건입니다. 한 기도방에는 최대 ${LIMITS.rows}건까지 담을 수 있습니다.`);
  const prayers = [];
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    let r = rows[i];
    if (r.length > CSV_HEADER.length && r.slice(CSV_HEADER.length).every((c) => c.trim() === '')) r = r.slice(0, CSV_HEADER.length);
    const where = `${lines[i]}번째 줄`;
    if (r.length !== CSV_HEADER.length) { errors.push(`${where}: 칸이 ${r.length}개입니다 (4개 필요). 쉼표가 들어간 내용은 큰따옴표로 묶어야 합니다.`); continue; }
    const author = r[0].trim();
    const content = r[2].replace(/\r\n?/g, '\n').trim();
    const response = r[3].replace(/\r\n?/g, '\n').trim();
    if (!author && !r[1].trim() && !response && BULLET_ONLY.test(content)) { skipped++; continue; } // 엑셀 서식만 남은 빈 줄 (",,ㅇ ," 등)은 건너뜀
    const postedOn = parsePostedDate(r[1]);
    const bad = [];
    if (!author) bad.push('게시자가 비어 있습니다');
    else if (author.length > LIMITS.author) bad.push(`게시자가 ${LIMITS.author}자를 넘습니다`);
    if (!postedOn) bad.push(`게시일 "${r[1].trim()}" 을(를) 날짜로 읽을 수 없습니다 (예: 2025/06/28)`);
    if (!content) bad.push('기도 제목이 비어 있습니다');
    else if (content.length > LIMITS.content) bad.push(`기도 제목이 ${LIMITS.content}자를 넘습니다`);
    if (response.length > LIMITS.content) bad.push(`기도 응답이 ${LIMITS.content}자를 넘습니다`);
    if (bad.length) errors.push(`${where}: ${bad.join(', ')}.`);
    else prayers.push({ author, postedOn, content, response });
  }
  if (!errors.length && !prayers.length) errors.push('기도제목 행이 없습니다. 머리글 아래에 한 줄 이상 있어야 합니다.');
  return { prayers, errors, skipped };
}

const BULLET_ONLY = /^[ㅇ·•*\-\s]*$/;

/** 'YYYY-MM-DD' → 그날 정오(로컬)의 ISO 시각. 날짜만 아는 가져온 기도의 수정일시로 쓰며, 정오라 시간대가 달라도 같은 날로 읽힌다 */
export const dayToTimestamp = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toISOString();
};
const pad2 = (n) => String(n).padStart(2, '0');
/** ISO 시각 → 로컬 'YYYY-MM-DD' (표시·날짜 검색용. 저장하지 않고 필요할 때 계산) */
export const dayOf = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * DB 기도제목 문서의 필드 (모든 기도방이 같은 스키마):
 * 게시자(author), 지메일(authorEmail), 기도제목 마지막 수정일시(contentUpdatedAt), 기도제목(content),
 * 기도응답 마지막 수정일시(responseUpdatedAt, 응답이 없으면 ''), 기도응답(response)
 */
export const PRAYER_FIELDS = ['author', 'authorEmail', 'contentUpdatedAt', 'content', 'responseUpdatedAt', 'response'];
export function newPrayerDoc({ author, authorEmail = '', content, response = '' }, at) {
  return { author, authorEmail, contentUpdatedAt: at, content, responseUpdatedAt: response ? at : '', response };
}

/** 고친 내용 → 저장할 필드만. 기도제목이 바뀌면 그 수정일시를, 기도응답이 바뀌면 그 수정일시를 now 로 (바뀐 것이 없으면 null) */
export function editPatch(p, { content, response }, now, email) {
  const patch = {};
  if (content !== p.content) { patch.content = content; patch.contentUpdatedAt = now; }
  if (response !== p.response) { patch.response = response; patch.responseUpdatedAt = response ? now : ''; }
  return Object.keys(patch).length ? { ...patch, authorEmail: email } : null;
}

/** 오류 목록을 화면용으로 줄임 (너무 길면 앞부분만) */
export const limitErrors = (errors, max = MAX_SHOWN) => (errors.length > max ? [...errors.slice(0, max), `… 외 ${errors.length - max}건`] : errors);

/** 'KT 기도노트.csv' → 'KT 기도노트' */
export const fileBaseName = (name) => String(name).replace(/\.[^./\\]+$/, '').trim();

export const nameKey = (email) => email.replace(/\./g, ','); // Firestore 맵 키로 쓰기 위해 점을 바꿈 (규칙에서도 같은 방식)
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** 초대 한 명: 지메일 계정 + 이름(필수) → {member:{email, name}} 또는 {error} */
export function parseInvitee(emailText, nameText) {
  const email = String(emailText).trim().toLowerCase();
  const name = String(nameText).trim().replace(/\s+/g, ' ');
  if (!EMAIL.test(email)) return { error: '지메일 계정 형식이 아닙니다. (예: hong@gmail.com)' };
  if (!name) return { error: '이름을 입력하세요.' };
  if (name.length > LIMITS.author) return { error: `이름은 ${LIMITS.author}자 이내로 입력하세요.` };
  return { member: { email, name } };
}

const byRecent = (a, b) => b.contentUpdatedAt.localeCompare(a.contentUpdatedAt) || a.author.localeCompare(b.author, 'ko');

/**
 * 기도제목 고르기: authors(Set, 없으면 전체 게시자) · period({kind:'all'|'range'|'recent', from, to}).
 * 'recent' 는 게시자마다 마지막으로 올린 날짜의 기도제목. 게시일 최신순
 */
export function selectPrayers(prayers, { authors = null, period = { kind: 'all' } } = {}) {
  let list = authors ? prayers.filter((p) => authors.has(p.author)) : [...prayers];
  if (period.kind === 'range') {
    list = list.filter((p) => (!period.from || p.postedOn >= period.from) && (!period.to || p.postedOn <= period.to));
  } else if (period.kind === 'recent') {
    const latest = new Map();
    for (const p of list) if (!latest.has(p.author) || p.postedOn > latest.get(p.author)) latest.set(p.author, p.postedOn);
    list = list.filter((p) => p.postedOn === latest.get(p.author));
  }
  return list.sort(byRecent);
}

export const authorsOf = (prayers) => [...new Set(prayers.map((p) => p.author))].sort((a, b) => a.localeCompare(b, 'ko'));

/** 내 기도제목인가: 이메일이 있으면 이메일로, 가져온 기도(이메일 없음)는 초대 때 적어 둔 내 이름과 같을 때 */
export const isMine = (p, email, name) => (p.authorEmail ? p.authorEmail === email : !!name && p.author === name);

export const formatDay = (iso, weekday) => `${iso}(${weekday(iso)})`;

/** 복사·공유할 글 */
export function prayerText(p, roomName, weekday) {
  const out = [`[${roomName}] 기도제목`, `게시자: ${p.author}`, `게시일: ${formatDay(p.postedOn, weekday)}`, '', p.content];
  if (p.response) out.push('', `기도응답 ${formatDay(dayOf(p.responseUpdatedAt || p.contentUpdatedAt), weekday)}`, p.response);
  return out.join('\n');
}

const isTimestamp = (s) => typeof s === 'string' && s !== '' && !Number.isNaN(Date.parse(s));
/** Firestore 문서 → 쓸 수 있는 기도제목, 아니면 null. postedOn(게시 날짜)은 저장하지 않고 기도제목 수정일시에서 계산 */
export function cleanPrayer(id, d) {
  if (!d || typeof d.author !== 'string' || typeof d.content !== 'string' || !isTimestamp(d.contentUpdatedAt)) return null;
  return {
    id, author: d.author, authorEmail: typeof d.authorEmail === 'string' ? d.authorEmail : '',
    contentUpdatedAt: d.contentUpdatedAt, postedOn: dayOf(d.contentUpdatedAt), content: d.content,
    responseUpdatedAt: isTimestamp(d.responseUpdatedAt) ? d.responseUpdatedAt : '', response: typeof d.response === 'string' ? d.response : '',
  };
}

export function cleanRoom(id, d) {
  if (!d || typeof d.name !== 'string' || !Array.isArray(d.members)) return null;
  const names = d.memberNames && typeof d.memberNames === 'object' ? d.memberNames : {};
  return { id, name: d.name, members: d.members.filter((e) => typeof e === 'string'), memberNames: Object.fromEntries(Object.entries(names).filter(([, v]) => typeof v === 'string')) };
}

/** 권한 오류 등을 사용자 안내로 */
export function explainError(e) {
  const code = e?.code ?? '';
  if (code.includes('permission-denied')) return '권한이 없습니다. (초대받은 계정인지 확인하세요. 관리자는 Firebase 콘솔에 최신 Firestore 규칙(scripts/firestore.rules)이 게시되었는지 확인하세요.)';
  if (code.includes('unavailable') || code.includes('network')) return '네트워크 오류입니다. 연결을 확인하고 다시 시도하세요.';
  return `처리하지 못했습니다. (${code || '알 수 없는 오류'})`;
}

/* ================= 모듈 본체 ================= */
export function createPrayer(deps) {
  const { $, h, mount, toast, fb, user, copyText, shareText, weekday, today } = deps;
  const S = {
    mode: 'search', rooms: null, allRooms: null, roomId: '', prayers: [], loadedAt: 0, results: [], kind: 'search',
    authors: new Set(), period: 'all', from: '', to: '', editing: new Set(), pending: null, invitees: [], editMember: null, prayersRoom: '',
  };
  const MODES = [['search', '검색'], ['post', '게시'], ['edit', '편집']];
  const ADMIN_MODES = [['create', '기도방 만들기'], ['manage', '기도방 관리']];
  const nowISO = () => new Date().toISOString();

  const me = () => {
    const u = user();
    return u?.email ? { uid: u.uid, email: u.email, name: u.name } : null;
  };
  const isAdmin = () => me()?.email === ADMIN_EMAIL;
  const roomsOf = () => S.rooms ?? [];
  const roomById = (id) => [...roomsOf(), ...(S.allRooms ?? [])].find((r) => r.id === id);
  const myName = (room) => room?.memberNames?.[nameKey(me().email)] ?? '';
  const isMineIn = (p) => isMine(p, me().email, myName(roomById(S.roomId)));
  /** 편집·삭제할 수 있는가: 내 기도제목이거나 관리자 */
  const canEdit = (p) => isAdmin() || isMineIn(p);
  /** 게시자 선택 칸을 보이는가: 검색, 그리고 모든 기도제목을 다루는 관리자의 편집 */
  const withAuthors = (kind) => kind === 'search' || isAdmin();
  const say = (msg) => { $('#prayer-status').textContent = ''; setTimeout(() => { $('#prayer-status').textContent = msg; }, 50); };
  const panel = () => $('#prayer-panel');
  const fx = () => fb();

  /* ---- Firestore ---- */
  async function loadRooms() {
    const { db, fs } = fx();
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'prayerRooms'), fs.where('members', 'array-contains', me().email)));
    S.rooms = snap.docs.map((d) => cleanRoom(d.id, d.data())).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  async function loadAllRooms() {
    const { db, fs } = fx();
    const snap = await fs.getDocs(fs.collection(db, 'prayerRooms'));
    S.allRooms = snap.docs.map((d) => cleanRoom(d.id, d.data())).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  async function loadPrayers(roomId) {
    const { db, fs } = fx();
    const snap = await fs.getDocs(fs.collection(db, 'prayerRooms', roomId, 'prayers'));
    S.prayers = snap.docs.map((d) => cleanPrayer(d.id, d.data())).filter(Boolean);
    S.prayersRoom = roomId; // S.prayers 가 어느 기도방의 것인지 (메뉴를 옮겨도 선택한 방과 맞는지 확인용)
    S.loadedAt = Date.now();
  }
  const invalidate = () => { S.rooms = null; S.allRooms = null; };

  /* ---- 공통 조각 ---- */
  function field(label, control, id) {
    return h('div', { class: 'prayer-field' }, h('label', { class: 'field__label', for: id }, label), control);
  }
  function roomSelect(id, rooms, value) {
    return field('기도방', h('select', { class: 'field__control', id, 'data-prayer-field': 'room' },
      h('option', { value: '' }, '기도방을 선택하세요'),
      rooms.map((r) => h('option', { value: r.id, selected: r.id === value }, r.name))), id);
  }
  function showNotice(title, summary, items = []) {
    $('#prayer-dialog-title').textContent = title;
    $('#prayer-dialog-summary').textContent = summary;
    mount($('#prayer-dialog-list'), items.map((t) => h('li', { class: 'result-list__item--warn' }, t)));
    $('#prayer-dialog').showModal();
  }

  /* ---- 화면 뼈대 ---- */
  function renderModes() {
    const box = $('#prayer-modes');
    const list = [...MODES, ...(isAdmin() ? ADMIN_MODES : [])];
    mount(box, list.map(([m, label]) => h('button', {
      type: 'button', class: `btn${S.mode === m ? ' btn--primary' : ''}`, 'data-action': 'prayer-mode', 'data-mode': m, 'aria-pressed': S.mode === m ? 'true' : 'false',
    }, label)));
    box.hidden = false;
  }

  async function render() {
    const note = $('#prayer-note');
    if (!me()) {
      $('#prayer-modes').hidden = true;
      mount(panel());
      note.textContent = fb() ? '기도 기능은 Google 로그인 후 사용할 수 있습니다. 위쪽의 "Google 로그인" 버튼을 눌러 주세요.' : '클라우드에 연결하는 중입니다. 잠시 후 다시 확인해 주세요.';
      return;
    }
    note.textContent = '';
    renderModes();
    try {
      if (S.mode === 'manage' && isAdmin()) { if (!S.allRooms) await loadAllRooms(); } else if (!S.rooms) await loadRooms();
    } catch (e) { console.error('[prayer]', e); note.textContent = explainError(e); mount(panel()); return; }
    renderPanel();
  }

  function renderPanel() {
    const m = S.mode;
    if (!isAdmin() && (m === 'create' || m === 'manage')) S.mode = 'search';
    if (S.mode === 'create') renderCreate();
    else if (S.mode === 'manage') renderManage();
    else if (roomsOf().length === 0) { mount(panel(), h('p', { class: 'view__note' }, '초대받은 기도방이 없습니다.')); say('초대받은 기도방이 없습니다.'); }
    else if (S.mode === 'post') renderPost();
    else renderQuery(S.mode);
  }

  /* ---- 검색·편집 ---- */
  function renderQuery(kind) {
    S.kind = kind;
    if (S.roomId && !roomsOf().some((r) => r.id === S.roomId)) S.roomId = '';
    const periodRow = h('fieldset', { class: 'prayer-fieldset', id: 'prayer-period', hidden: !S.roomId }, // 기도방을 고르기 전에는 숨김
      h('legend', { class: 'field__label' }, kind === 'edit' && !isAdmin() ? '내가 게시한 날짜' : '기도제목 게시 날짜'),
      [['all', '전체'], ['range', '기간 선택'], ['recent', '최근 게시 (마지막으로 올린 날짜)']].map(([v, label]) =>
        h('label', { class: 'check' }, h('input', { type: 'radio', name: 'prayer-period', value: v, checked: S.period === v, 'data-prayer-field': 'period' }), ` ${label}`)),
      h('div', { class: 'prayer-range', id: 'prayer-range', hidden: S.period !== 'range' },
        datePick('prayer-from', '시작일', S.from, 'from'),
        datePick('prayer-to', '종료일', S.to, 'to')));
    mount(panel(), h('form', { class: 'prayer-form', 'data-prayer-form': 'query', role: 'search' },
      kind === 'edit' && isAdmin() ? h('p', { class: 'view__note' }, '관리자는 기도방의 모든 기도제목을 편집·삭제할 수 있습니다.') : null,
      roomSelect('prayer-room', roomsOf(), S.roomId),
      withAuthors(kind) ? h('div', { id: 'prayer-authors' }) : null,
      periodRow,
      h('button', { type: 'submit', class: 'btn btn--primary' }, kind === 'edit' && !isAdmin() ? '내 기도제목 검색' : '검색')),
    h('ul', { class: 'prayer-list', id: 'prayer-results', tabindex: '-1', 'aria-label': '검색한 기도제목' }));
    if (withAuthors(kind)) renderAuthors();
    if (S.results.length && S.resultsKind === kind) renderResults();
    if (S.roomId && S.prayersRoom !== S.roomId) loadRoomPrayers(); // 메뉴를 옮겨 와서 방은 선택돼 있지만 기도제목은 아직 없을 때
  }

  /** 선택된 기도방의 기도제목을 불러와 게시자 선택을 채운다 */
  async function loadRoomPrayers() {
    const roomId = S.roomId;
    try {
      await loadPrayers(roomId);
      if (S.roomId !== roomId) return; // 그 사이 다른 방을 골랐으면 버림
      S.authors = new Set(authorsOf(S.prayers));
      if (withAuthors(S.kind)) renderAuthors();
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); }
  }

  function renderAuthors() {
    const box = $('#prayer-authors');
    if (!box) return;
    const names = authorsOf(S.prayers);
    if (!S.roomId) { mount(box); return; }
    if (S.prayersRoom !== S.roomId) { mount(box, h('p', { class: 'view__note' }, '기도제목을 불러오는 중입니다...')); return; }
    if (!names.length) { mount(box, h('p', { class: 'view__note' }, '이 기도방에는 아직 기도제목이 없습니다.')); return; }
    const all = names.every((n) => S.authors.has(n));
    mount(box, h('fieldset', { class: 'prayer-fieldset' },
      h('legend', { class: 'field__label' }, '기도 게시자 (복수 선택 가능)'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: all, 'data-prayer-field': 'author-all' }), ' 전체'),
      h('div', { class: 'prayer-authors' }, names.map((n) =>
        h('label', { class: 'check' }, h('input', { type: 'checkbox', value: n, checked: S.authors.has(n), 'data-prayer-field': 'author' }), ` ${n}`)))));
  }

  async function selectRoom(roomId) {
    S.roomId = roomId;
    S.results = [];
    S.editing.clear();
    mount($('#prayer-results') ?? document.createDocumentFragment());
    S.prayers = [];
    S.prayersRoom = '';
    const period = $('#prayer-period');
    if (period) period.hidden = !roomId;
    if (!roomId) { renderAuthors(); return; }
    try {
      await loadPrayers(roomId);
      S.authors = new Set(authorsOf(S.prayers));
      if (withAuthors(S.kind)) renderAuthors();
      say(`${roomById(roomId)?.name ?? ''} 기도방을 선택했습니다. 기도제목 ${S.prayers.length}건.`);
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); }
  }

  async function runQuery() {
    if (!S.roomId) { toast('기도방을 선택하세요.'); $('#prayer-room')?.focus(); return; }
    const kind = S.kind;
    if (S.period === 'range' && S.from && S.to && S.from > S.to) { toast('시작일이 종료일보다 늦습니다.'); $('#prayer-from')?.focus(); return; }
    try {
      if (Date.now() - S.loadedAt > 30000) await loadPrayers(S.roomId); // 다른 사람이 새로 올린 기도제목 반영
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
    let base = S.prayers;
    if (withAuthors(kind)) {
      if (!S.authors.size) { toast('기도 게시자를 선택하세요.'); return; }
      base = base.filter((p) => S.authors.has(p.author));
    } else base = base.filter(isMineIn); // 일반 사용자의 편집: 내 기도제목만
    S.results = selectPrayers(base, { period: { kind: S.period, from: S.from, to: S.to } });
    S.resultsKind = kind;
    renderResults();
    say(S.results.length ? `기도제목 ${S.results.length}건을 찾았습니다.` : '조건에 맞는 기도제목이 없습니다.');
  }

  function renderResults() {
    const ul = $('#prayer-results');
    if (!ul) return;
    mount(ul, S.results.length
      ? S.results.map(card)
      : h('li', { class: 'view__note' }, S.resultsKind === 'edit' && !isAdmin() ? '조건에 맞는 내 기도제목이 없습니다.' : '조건에 맞는 기도제목이 없습니다.'));
  }

  /* ---- 카드 ---- */
  function card(p) {
    const mine = canEdit(p);
    const editing = S.editing.has(p.id);
    const who = `${p.author} ${p.postedOn}`;
    const btn = (action, label, extra = {}) => h('button', { type: 'button', class: `btn${extra.danger ? ' btn--danger' : ''}${extra.primary ? ' btn--primary' : ''}`, 'data-action': action, 'data-id': p.id, 'aria-label': `${who} 기도제목 ${label}` }, label);
    return h('li', { class: `prayer-card${editing ? ' prayer-card--editing' : ''}`, 'data-id': p.id },
      h('h3', { class: 'prayer-card__head' }, h('span', { class: 'prayer-card__author' }, p.author), ' ', h('span', { class: 'prayer-card__date' }, formatDay(p.postedOn, weekday))),
      editing
        ? [
          h('label', { class: 'field__label', for: `pc-${p.id}` }, '기도제목'),
          h('textarea', { class: 'field__control', id: `pc-${p.id}`, rows: '6', maxlength: String(LIMITS.content), 'data-field': 'content' }, p.content),
          h('label', { class: 'field__label', for: `pr-${p.id}` }, '기도응답'),
          h('textarea', { class: 'field__control', id: `pr-${p.id}`, rows: '4', maxlength: String(LIMITS.content), 'data-field': 'response' }, p.response),
          h('p', { class: 'view__note' }, '기도제목을 고치면 게시 날짜가, 기도응답을 고치면 기도응답 날짜가 오늘로 바뀝니다.'),
        ]
        : [
          h('p', { class: 'prayer-card__label' }, '기도제목'),
          h('p', { class: 'prayer-card__body' }, p.content),
          // h() 는 배열을 한 단계만 펼치므로 중첩 배열 대신 펼쳐서 넣는다
          ...(p.response ? [h('p', { class: 'prayer-card__label' }, `기도응답 ${formatDay(dayOf(p.responseUpdatedAt || p.contentUpdatedAt), weekday)}`), h('p', { class: 'prayer-card__body prayer-card__body--response' }, p.response)] : []),
        ],
      h('div', { class: 'prayer-card__actions' },
        btn('prayer-copy', '복사'), btn('prayer-share', '공유'),
        mine && !editing ? (S.kind === 'edit' ? btn('prayer-edit', '편집') : btn('prayer-goto-edit', '편집')) : null,
        mine && editing ? [btn('prayer-save', '저장', { primary: true }), btn('prayer-close', '닫기')] : null,
        mine && S.kind === 'edit' ? btn('prayer-delete', '삭제', { danger: true }) : null));
  }

  const prayerById = (id) => S.results.find((p) => p.id === id) ?? S.prayers.find((p) => p.id === id);
  const cardEl = (id) => document.querySelector(`.prayer-card[data-id="${CSS.escape(id)}"]`);
  const replaceCard = (p, focusAction) => {
    const old = cardEl(p.id);
    if (!old) return;
    const next = card(p);
    old.replaceWith(next);
    next.querySelector(`[data-action="${focusAction}"]`)?.focus();
  };

  async function saveCard(id) {
    const p = prayerById(id);
    const el = cardEl(id);
    if (!p || !el) return;
    const content = el.querySelector('[data-field="content"]').value.replace(/\r\n?/g, '\n').trim();
    const response = el.querySelector('[data-field="response"]').value.replace(/\r\n?/g, '\n').trim();
    if (!content) { toast('기도제목을 입력하세요.'); el.querySelector('[data-field="content"]').focus(); return; }
    // 내 기도제목이면 지메일을 내 계정으로 채우고, 관리자가 남의 기도제목을 고칠 때는 원래 게시자의 지메일을 그대로 둔다
    const patch = editPatch(p, { content, response }, nowISO(), isMineIn(p) ? me().email : p.authorEmail);
    if (!patch) { S.editing.delete(id); replaceCard(p, 'prayer-edit'); toast('바뀐 내용이 없습니다.'); return; }
    try {
      const { db, fs } = fx();
      await fs.updateDoc(fs.doc(db, 'prayerRooms', S.roomId, 'prayers', id), patch);
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
    Object.assign(p, patch, { postedOn: dayOf(patch.contentUpdatedAt ?? p.contentUpdatedAt) });
    S.editing.delete(id);
    replaceCard(p, 'prayer-edit');
    toast(patch.contentUpdatedAt ? '저장했습니다. 게시 날짜를 오늘로 바꿨습니다.' : '저장했습니다. 기도응답 날짜를 오늘로 바꿨습니다.');
  }

  async function deleteCard(id) {
    const p = prayerById(id);
    if (!p || !window.confirm(`${p.author} ${p.postedOn} 기도제목을 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      const { db, fs } = fx();
      await fs.deleteDoc(fs.doc(db, 'prayerRooms', S.roomId, 'prayers', id));
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
    S.prayers = S.prayers.filter((x) => x.id !== id);
    S.results = S.results.filter((x) => x.id !== id);
    S.editing.delete(id);
    cardEl(id)?.remove();
    if (!S.results.length) renderResults();
    $('#prayer-results')?.focus();
    toast('삭제했습니다.');
    say(`삭제했습니다. 남은 기도제목 ${S.results.length}건.`);
  }

  /* ---- 게시 ---- */
  function renderPost() {
    if (S.roomId && !roomsOf().some((r) => r.id === S.roomId)) S.roomId = '';
    if (!S.roomId && roomsOf().length === 1) S.roomId = roomsOf()[0].id; // 기도방이 하나뿐이면 미리 선택
    mount(panel(), h('form', { class: 'prayer-form', 'data-prayer-form': 'post' },
      roomSelect('prayer-room', roomsOf(), S.roomId),
      field('게시자', h('input', { class: 'field__control', type: 'text', id: 'prayer-author', maxlength: String(LIMITS.author), required: true, autocomplete: 'off', value: defaultAuthor(roomById(S.roomId)), 'data-prayer-field': 'author-name' }), 'prayer-author'),
      h('p', { class: 'prayer-date' }, `게시 날짜: ${formatDay(today(), weekday)} (자동 입력)`),
      field('기도제목', h('textarea', { class: 'field__control', id: 'prayer-content', rows: '8', maxlength: String(LIMITS.content), required: true }), 'prayer-content'),
      h('button', { type: 'submit', class: 'btn btn--primary' }, '게시')));
  }

  /** 게시자 기본값: 그 기도방에 등록된 내 이름. 방을 고르기 전에는 어느 방에서든 등록된 내 이름, 없으면 Google 계정 이름 */
  const defaultAuthor = (room) => (room ? myName(room) : roomsOf().map(myName).find(Boolean)) || me().name.slice(0, LIMITS.author);

  async function doPost() {
    const roomId = $('#prayer-room').value;
    const ta = $('#prayer-content');
    const authorEl = $('#prayer-author');
    const author = authorEl.value.trim().replace(/\s+/g, ' ');
    const content = ta.value.replace(/\r\n?/g, '\n').trim();
    if (!roomId) { toast('기도방을 선택하세요.'); $('#prayer-room').focus(); return; }
    if (!author) { toast('게시자 이름을 입력하세요.'); authorEl.focus(); return; }
    if (!content) { toast('기도제목을 입력하세요.'); ta.focus(); return; }
    S.roomId = roomId;
    const room = roomById(roomId);
    const doc = newPrayerDoc({ author, authorEmail: me().email, content }, nowISO());
    try {
      const { db, fs } = fx();
      await fs.addDoc(fs.collection(db, 'prayerRooms', roomId, 'prayers'), doc);
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
    ta.value = '';
    S.loadedAt = 0;
    toast(`${room?.name ?? '기도방'}에 게시했습니다.`);
    ta.focus();
  }

  /* ---- 기도방 만들기 (관리자) ---- */
  function renderCreate() {
    // 초대 입력은 별도 form(Enter 로 기도방이 만들어지지 않게)이고, 만들기 버튼은 form 속성으로 아래쪽에서 만들기 form 에 연결
    mount(panel(),
      h('form', { class: 'prayer-form', id: 'prayer-create-form', 'data-prayer-form': 'create' },
        h('p', { class: 'view__note' }, '기도 내용이 담긴 CSV 파일(첫 줄: 게시자,게시일,기도 제목,기도 응답)을 이 기기에서 불러와 만들 수 있습니다. 파일 없이 내용이 빈 기도방으로 만들 수도 있습니다. 형식은 README에 있습니다.'),
        field('CSV 파일', h('input', { class: 'field__control', type: 'file', id: 'prayer-file', accept: '.csv,text/csv', 'data-prayer-field': 'file' }), 'prayer-file'),
        h('p', { class: 'view__note', id: 'prayer-file-info', 'aria-live': 'polite' }, S.pending ? `${S.pending.fileName}: 기도제목 ${S.pending.prayers.length}건 확인` : ''),
        field('기도방 이름', h('input', { class: 'field__control', type: 'text', id: 'prayer-name', maxlength: String(LIMITS.name), required: true, autocomplete: 'off', value: S.pending?.defaultName ?? '', 'data-prayer-field': 'name' }), 'prayer-name'),
        field('내 이름 (관리자, CSV의 같은 이름 게시자의 기도제목이 내 것으로 연결됩니다)', h('input', { class: 'field__control', type: 'text', id: 'prayer-admin-name', maxlength: String(LIMITS.author), required: true, autocomplete: 'off', value: defaultAuthor(null) }), 'prayer-admin-name')),
      h('form', { class: 'prayer-form prayer-invite', 'data-prayer-form': 'invite-add' },
        h('h3', { class: 'prayer-subtitle', id: 'prayer-invite-title' }, '기도방에 초대할 사람'),
        h('p', { class: 'view__note' }, '지메일 계정과 이름을 입력해 한 명씩 추가하세요. 이름이 CSV의 게시자와 같으면 그 기도제목이 그 사람의 것으로 연결됩니다. 나(관리자)는 위에 입력한 이름으로 자동 포함됩니다.'),
        inviteFields('prayer-invite'),
        h('ul', { class: 'prayer-members', id: 'prayer-invitees', 'aria-labelledby': 'prayer-invite-title' })),
      h('div', { class: 'form__actions form__actions--start' },
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'prayer-create-csv', form: 'prayer-create-form' }, 'CSV로 기도방 만들기'),
        h('button', { type: 'button', class: 'btn', id: 'prayer-create-empty', 'data-action': 'prayer-create-empty' }, '빈 기도방 만들기')));
    renderInvitees();
  }

  const NO_DATE = '연-월-일';
  const calendarIcon = () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'date-pick__icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M8 3v3m8-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13H4V6a1 1 0 0 1 1-1Z');
    svg.append(path);
    return svg;
  };
  /** 날짜 선택: 브라우저의 기본 표시(mm/dd/yyyy 등)는 바꿀 수 없어, 'YYYY-MM-DD' 글자 위에 투명한 날짜 입력을 겹친다 (오늘 화면과 같은 방식) */
  function datePick(id, label, value, fieldName) {
    return h('div', { class: 'prayer-field' },
      h('label', { class: 'field__label', for: id }, label),
      h('span', { class: 'date-pick' },
        h('span', { class: `date-pick__text${value ? '' : ' date-pick__text--empty'}`, id: `${id}-text`, 'aria-hidden': 'true' }, value || NO_DATE),
        calendarIcon(),
        h('input', { class: 'date-pick__input', type: 'date', id, value, 'data-prayer-field': fieldName })));
  }
  const showPickedDate = (el) => {
    const text = $(`#${el.id}-text`);
    text.textContent = el.value || NO_DATE;
    text.classList.toggle('date-pick__text--empty', !el.value);
  };

  /** 지메일 계정 + 이름 입력칸과 추가 버튼 (id 접두사로 화면마다 구분) */
  function inviteFields(prefix) {
    return h('div', { class: 'prayer-invite__row' },
      field('지메일 계정', h('input', { class: 'field__control', type: 'email', id: `${prefix}-email`, autocomplete: 'off', inputmode: 'email', placeholder: 'hong@gmail.com', required: true }), `${prefix}-email`),
      field('이름', h('input', { class: 'field__control', type: 'text', id: `${prefix}-name`, autocomplete: 'off', maxlength: String(LIMITS.author), placeholder: '홍길동', required: true }), `${prefix}-name`),
      h('button', { type: 'submit', class: 'btn' }, '추가'));
  }

  function renderInvitees() {
    const ul = $('#prayer-invitees');
    if (!ul) return;
    mount(ul, S.invitees.length
      ? S.invitees.map((m) => h('li', { class: 'prayer-members__item' },
        h('span', { class: 'prayer-members__email' }, `${m.name} (${m.email})`),
        h('button', { type: 'button', class: 'btn btn--danger', 'data-action': 'prayer-invite-remove', 'data-email': m.email, 'aria-label': `${m.name} ${m.email} 초대 취소` }, '삭제')))
      : h('li', { class: 'view__note' }, '아직 추가한 사람이 없습니다.'));
  }

  /** 초대 한 명 추가(같은 계정이면 이름만 바꿈). 반환: 'added' | 'renamed' | 오류 문장 */
  function addInvitee(list, emailEl, nameEl) {
    const r = parseInvitee(emailEl.value, nameEl.value);
    if (r.error) { toast(r.error); (r.error.startsWith('이름') ? nameEl : emailEl).focus(); return r.error; }
    const i = list.findIndex((m) => m.email === r.member.email);
    if (i >= 0) { list[i] = r.member; return 'renamed'; }
    if (list.length >= LIMITS.members) { toast(`초대는 최대 ${LIMITS.members}명까지 가능합니다.`); return '한도'; }
    list.push(r.member);
    return 'added';
  }

  async function onFile(input) {
    const [file] = input.files;
    if (!file) return;
    const info = $('#prayer-file-info');
    S.pending = null;
    info.textContent = '';
    if (file.size > LIMITS.fileBytes) { input.value = ''; showNotice('기도방을 만들 수 없습니다', `파일이 너무 큽니다. (${Math.round(file.size / 1024)}KB, 최대 ${LIMITS.fileBytes / 1024}KB)`); return; }
    let v;
    try { v = validatePrayerCsv(parseCsv(decodeBytes(await file.arrayBuffer()))); } catch { input.value = ''; showNotice('기도방을 만들 수 없습니다', '파일을 읽지 못했습니다. CSV 파일인지 확인하세요.'); return; }
    if (v.errors.length) {
      input.value = '';
      showNotice('기도방을 만들 수 없습니다', `"${file.name}" 이(가) 기도방 형식(게시자,게시일,기도 제목,기도 응답)에 맞지 않습니다. 아래 사유를 고친 뒤 다시 불러오세요. (오류 ${v.errors.length}건)`, limitErrors(v.errors));
      return;
    }
    const base = fileBaseName(file.name).slice(0, LIMITS.name);
    const nameInput = $('#prayer-name');
    if (!nameInput.value.trim() || nameInput.value === S.lastDefault) nameInput.value = base;
    S.lastDefault = base;
    S.pending = { fileName: file.name, prayers: v.prayers, defaultName: base };
    const days = v.prayers.map((p) => p.postedOn).sort();
    info.textContent = `${file.name}: 기도제목 ${v.prayers.length}건 확인 (게시자 ${authorsOf(v.prayers).length}명, ${days[0]} ~ ${days.at(-1)})${v.skipped ? `, 내용 없는 빈 줄 ${v.skipped}개는 건너뜀` : ''}`;
  }

  /** 기도방 만들기. empty 이면 CSV 없이 내용이 빈 기도방 (스키마는 같고 기도제목만 없음) */
  async function doCreate(form, { empty = false } = {}) {
    const name = $('#prayer-name').value.trim();
    if (!empty && !S.pending) { toast('먼저 CSV 파일을 불러오세요. 파일 없이 만들려면 "빈 기도방 만들기"를 누르세요.'); $('#prayer-file').focus(); return; }
    if (!name) { toast('기도방 이름을 입력하세요.'); $('#prayer-name').focus(); return; }
    if (empty && S.pending && !window.confirm(`불러온 CSV 파일(${S.pending.fileName})은 사용하지 않고 빈 기도방으로 만들까요?`)) return;
    const admin = parseInvitee(me().email, $('#prayer-admin-name').value);
    if (admin.error) { toast(admin.error); $('#prayer-admin-name').focus(); return; }
    const members = [admin.member, ...S.invitees.filter((m) => m.email !== me().email)]; // 관리자 본인은 이름과 함께 항상 포함
    const buttons = [$('#prayer-create-csv'), $('#prayer-create-empty')].filter(Boolean);
    const setBusy = (busy) => buttons.forEach((b) => { b.disabled = busy; });
    setBusy(true);
    const now = nowISO();
    const { db, fs } = fx();
    const roomRef = fs.doc(fs.collection(db, 'prayerRooms'));
    try {
      await fs.setDoc(roomRef, {
        name, members: members.map((m) => m.email),
        memberNames: Object.fromEntries(members.filter((m) => m.name).map((m) => [nameKey(m.email), m.name])),
        createdBy: me().email, createdAt: now, updatedAt: now,
      });
      const rows = empty ? [] : S.pending.prayers;
      const emailByName = new Map(members.filter((m) => m.name).map((m) => [m.name, m.email])); // 초대할 때 적은 이름이 게시자와 같으면 지메일을 채움
      for (let i = 0; i < rows.length; i += 400) {
        const batch = fs.writeBatch(db);
        for (const p of rows.slice(i, i + 400)) {
          batch.set(fs.doc(fs.collection(roomRef, 'prayers')), newPrayerDoc({ ...p, authorEmail: emailByName.get(p.author) ?? '' }, dayToTimestamp(p.postedOn)));
        }
        await batch.commit();
      }
    } catch (e) {
      console.error('[prayer]', e);
      try { await removeRoom(roomRef.id); } catch { /* 정리 실패는 무시 */ }
      setBusy(false);
      toast(`기도방을 만들지 못했습니다. ${explainError(e)}`);
      return;
    }
    const count = empty ? 0 : S.pending.prayers.length;
    S.pending = null;
    S.invitees = [];
    S.lastDefault = '';
    invalidate();
    S.mode = 'manage';
    S.manageId = roomRef.id;
    toast(empty ? `"${name}" 빈 기도방을 만들었습니다. 초대 ${members.length}명.` : `"${name}" 기도방을 만들었습니다. 기도제목 ${count}건, 초대 ${members.length}명.`);
    await render();
  }

  /* ---- 기도방 관리 (관리자) ---- */
  function renderManage() {
    const rooms = S.allRooms ?? [];
    if (!rooms.length) { mount(panel(), h('p', { class: 'view__note' }, '만든 기도방이 없습니다. "기도방 만들기"에서 CSV 파일로 만드세요.')); return; }
    if (!rooms.some((r) => r.id === S.manageId)) S.manageId = '';
    mount(panel(),
      field('편집할 기도방', h('select', { class: 'field__control', id: 'prayer-manage-room', 'data-prayer-field': 'manage-room' },
        h('option', { value: '' }, '기도방을 선택하세요'),
        rooms.map((r) => h('option', { value: r.id, selected: r.id === S.manageId }, r.name))), 'prayer-manage-room'),
      h('div', { id: 'prayer-manage-detail' }));
    renderManageDetail();
  }

  function renderManageDetail() {
    const box = $('#prayer-manage-detail');
    const room = (S.allRooms ?? []).find((r) => r.id === S.manageId);
    if (!room) { mount(box); return; }
    mount(box,
      h('form', { class: 'prayer-form', 'data-prayer-form': 'rename' },
        field('기도방 이름', h('input', { class: 'field__control', type: 'text', id: 'prayer-rename', maxlength: String(LIMITS.name), required: true, value: room.name, autocomplete: 'off' }), 'prayer-rename'),
        h('button', { type: 'submit', class: 'btn btn--primary' }, '이름 저장')),
      h('h3', { class: 'prayer-subtitle', id: 'prayer-members-title' }, `접근 권한이 있는 계정 (${room.members.length}명)`),
      h('ul', { class: 'prayer-members', 'aria-labelledby': 'prayer-members-title' }, room.members.map((email) => (email === S.editMember ? memberEditRow(room, email) : memberRow(room, email)))),
      h('form', { class: 'prayer-form prayer-invite', 'data-prayer-form': 'member-add' },
        h('h3', { class: 'prayer-subtitle' }, '초대할 사람 추가'),
        inviteFields('prayer-member')),
      h('div', { class: 'prayer-danger' },
        h('button', { type: 'button', class: 'btn btn--danger', 'data-action': 'prayer-room-delete' }, '이 기도방 삭제')));
  }

  function memberRow(room, email) {
    const name = room.memberNames[nameKey(email)];
    const who = name ? `${name} ${email}` : email;
    return h('li', { class: 'prayer-members__item' },
      h('span', { class: 'prayer-members__email' }, email, name ? ` (${name})` : ''),
      h('span', { class: 'prayer-members__actions' },
        h('button', { type: 'button', class: 'btn', 'data-action': 'prayer-member-edit', 'data-email': email, 'aria-label': `${who} 계정·이름 편집` }, '편집'),
        h('button', { type: 'button', class: 'btn btn--danger', 'data-action': 'prayer-member-remove', 'data-email': email, 'aria-label': `${who} 접근 권한 삭제` }, '삭제')));
  }

  /** 계정 한 줄을 지메일·이름 입력칸으로 바꾼 편집 줄 */
  function memberEditRow(room, email) {
    return h('li', { class: 'prayer-members__item prayer-members__item--editing' },
      h('form', { class: 'prayer-invite__row', 'data-prayer-form': 'member-edit' },
        field('지메일 계정', h('input', { class: 'field__control', type: 'email', id: 'prayer-edit-email', value: email, autocomplete: 'off', inputmode: 'email', required: true }), 'prayer-edit-email'),
        field('이름', h('input', { class: 'field__control', type: 'text', id: 'prayer-edit-name', value: room.memberNames[nameKey(email)] ?? '', maxlength: String(LIMITS.author), autocomplete: 'off', required: true }), 'prayer-edit-name'),
        h('button', { type: 'submit', class: 'btn btn--primary' }, '저장'),
        h('button', { type: 'button', class: 'btn', 'data-action': 'prayer-member-edit-cancel', 'data-email': email }, '취소')));
  }

  /** 초대 계정의 지메일을 바꿀 때, 그 계정으로 올린 기도제목의 지메일도 새 계정으로 옮긴다 (그래야 계속 내 기도제목으로 인식됨). 옮긴 건수를 반환 */
  async function moveAuthorEmail(roomId, from, to) {
    const { db, fs } = fx();
    const snap = await fs.getDocs(fs.collection(db, 'prayerRooms', roomId, 'prayers'));
    const mine = snap.docs.filter((d) => d.data().authorEmail === from);
    for (let i = 0; i < mine.length; i += 400) {
      const batch = fs.writeBatch(db);
      mine.slice(i, i + 400).forEach((d) => batch.update(d.ref, { authorEmail: to }));
      await batch.commit();
    }
    return mine.length;
  }

  const manageRoom = () => (S.allRooms ?? []).find((r) => r.id === S.manageId);

  async function saveRoom(patch, okMsg, focusSel) {
    const room = manageRoom();
    if (!room) return;
    try {
      const { db, fs } = fx();
      await fs.updateDoc(fs.doc(db, 'prayerRooms', room.id), { ...patch, updatedAt: nowISO() });
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
    Object.assign(room, patch);
    S.rooms = null;
    renderManage();
    toast(okMsg);
    if (focusSel) document.querySelector(focusSel)?.focus();
  }

  async function saveMemberEdit() {
    const room = manageRoom();
    const old = S.editMember;
    if (!room || !old) return;
    const r = parseInvitee($('#prayer-edit-email').value, $('#prayer-edit-name').value);
    if (r.error) { toast(r.error); $(r.error.startsWith('이름') ? '#prayer-edit-name' : '#prayer-edit-email').focus(); return; }
    const { email, name } = r.member;
    if (email !== old && room.members.includes(email)) { toast('이미 초대된 계정입니다.'); $('#prayer-edit-email').focus(); return; }
    const memberNames = { ...room.memberNames };
    delete memberNames[nameKey(old)];
    memberNames[nameKey(email)] = name;
    const members = room.members.map((m) => (m === old ? email : m));
    S.editMember = null;
    await saveRoom({ members, memberNames }, `${name}(${email}) 정보를 저장했습니다.`, `[data-action="prayer-member-edit"][data-email="${email}"]`);
    if (email === old) return;
    try {
      const n = await moveAuthorEmail(room.id, old, email);
      if (n) toast(`${name} 님의 기도제목 ${n}건의 지메일도 새 계정으로 옮겼습니다.`);
    } catch (e) { console.error('[prayer]', e); toast(`계정은 바꿨지만 기존 기도제목의 지메일을 옮기지 못했습니다. ${explainError(e)}`); }
  }

  async function removeRoom(roomId) {
    const { db, fs } = fx();
    const snap = await fs.getDocs(fs.collection(db, 'prayerRooms', roomId, 'prayers'));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = fs.writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    await fs.deleteDoc(fs.doc(db, 'prayerRooms', roomId));
  }

  /* ---- 이벤트 (app.js 가 data-prayer 영역의 이벤트를 넘겨 준다) ---- */
  const actions = {
    'prayer-mode': async (el) => { S.mode = el.dataset.mode; S.editMember = null; S.results = []; S.editing.clear(); await render(); $('#prayer-modes [aria-pressed="true"]')?.focus(); },
    'prayer-copy': (el) => { const p = prayerById(el.dataset.id); if (p) copyText(prayerText(p, roomById(S.roomId)?.name ?? '', weekday)); },
    'prayer-share': (el) => { const p = prayerById(el.dataset.id); if (p) shareText(prayerText(p, roomById(S.roomId)?.name ?? '', weekday)); },
    'prayer-edit': (el) => { const p = prayerById(el.dataset.id); if (p) { S.editing.add(p.id); replaceCard(p, 'prayer-save'); cardEl(p.id)?.querySelector('[data-field="content"]')?.focus(); } },
    'prayer-close': (el) => { const p = prayerById(el.dataset.id); if (p) { S.editing.delete(p.id); replaceCard(p, 'prayer-edit'); } },
    'prayer-save': (el) => saveCard(el.dataset.id),
    'prayer-delete': (el) => deleteCard(el.dataset.id),
    'prayer-goto-edit': async (el) => { // 검색 결과에서 내 기도제목을 편집으로: 그 게시일만 조회해 편집 상태로 연다
      const p = prayerById(el.dataset.id);
      if (!p) return;
      Object.assign(S, { mode: 'edit', period: 'range', from: p.postedOn, to: p.postedOn, results: [] });
      S.editing = new Set([p.id]);
      S.authors = new Set([p.author]); // 관리자의 편집 화면에서도 그 게시자만 조회
      await render();
      await runQuery();
      cardEl(p.id)?.querySelector('[data-field="content"]')?.focus();
    },
    'prayer-member-edit': (el) => { S.editMember = el.dataset.email; renderManageDetail(); $('#prayer-edit-email')?.focus(); },
    'prayer-member-edit-cancel': (el) => {
      S.editMember = null;
      renderManageDetail();
      document.querySelector(`[data-action="prayer-member-edit"][data-email="${el.dataset.email}"]`)?.focus();
    },
    'prayer-create-empty': () => doCreate($('#prayer-create-form'), { empty: true }),
    'prayer-invite-remove': (el) => {
      S.invitees = S.invitees.filter((m) => m.email !== el.dataset.email);
      renderInvitees();
      toast(`${el.dataset.email} 초대를 취소했습니다.`);
      $('#prayer-invite-email')?.focus();
    },
    'prayer-member-remove': (el) => {
      const room = manageRoom();
      const email = el.dataset.email;
      if (!room || !window.confirm(`${email} 계정의 "${room.name}" 접근 권한을 삭제할까요?`)) return;
      const members = room.members.filter((m) => m !== email);
      const memberNames = { ...room.memberNames };
      delete memberNames[nameKey(email)];
      saveRoom({ members, memberNames }, `${email} 계정을 삭제했습니다.`, '#prayer-manage-detail .prayer-members__item .btn, #prayer-member-add');
    },
    'prayer-room-delete': async () => {
      const room = manageRoom();
      if (!room || !window.confirm(`"${room.name}" 기도방과 안의 기도제목을 모두 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`)) return;
      try { await removeRoom(room.id); } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
      S.manageId = '';
      invalidate();
      toast(`"${room.name}" 기도방을 삭제했습니다.`);
      await render();
      $('#prayer-manage-room')?.focus();
    },
  };

  return {
    render,
    /** 로그인·로그아웃 때: 캐시를 비우고 기도 화면이 열려 있으면 다시 그림 */
    reset() {
      Object.assign(S, { rooms: null, allRooms: null, roomId: '', prayers: [], prayersRoom: '', results: [], pending: null, invitees: [], editMember: null, manageId: '' });
      S.editing.clear();
      if (location.hash.replace(/^#\/?/, '').startsWith('prayer')) render();
    },
    act: (el) => actions[el.dataset.action]?.(el),
    submit(form) {
      const kind = form.dataset.prayerForm;
      if (kind === 'query') return runQuery();
      if (kind === 'post') return doPost();
      if (kind === 'create') return doCreate(form);
      if (kind === 'rename') {
        const name = $('#prayer-rename').value.trim();
        return name ? saveRoom({ name }, '기도방 이름을 저장했습니다.', '#prayer-rename') : toast('기도방 이름을 입력하세요.');
      }
      if (kind === 'invite-add') {
        const r = addInvitee(S.invitees, $('#prayer-invite-email'), $('#prayer-invite-name'));
        if (r !== 'added' && r !== 'renamed') return undefined;
        renderInvitees();
        $('#prayer-invite-email').value = '';
        $('#prayer-invite-name').value = '';
        $('#prayer-invite-email').focus();
        toast(r === 'added' ? `초대 목록에 추가했습니다. (${S.invitees.length}명)` : '이미 있는 계정이라 이름을 바꿨습니다.');
        return undefined;
      }
      if (kind === 'member-edit') return saveMemberEdit();
      if (kind === 'member-add') {
        const room = manageRoom();
        const r = parseInvitee($('#prayer-member-email').value, $('#prayer-member-name').value);
        if (r.error) { toast(r.error); $(r.error.startsWith('이름') ? '#prayer-member-name' : '#prayer-member-email').focus(); return undefined; }
        const { email, name } = r.member;
        const known = room.members.includes(email);
        if (!known && room.members.length >= LIMITS.members) return toast(`초대는 최대 ${LIMITS.members}명까지 가능합니다.`);
        const memberNames = { ...room.memberNames, [nameKey(email)]: name };
        return saveRoom({ members: known ? room.members : [...room.members, email], memberNames }, known ? `${email} 계정의 이름을 바꿨습니다.` : `${name}(${email}) 님을 초대했습니다.`, '#prayer-member-email');
      }
      return undefined;
    },
    change(el) {
      const f = el.dataset.prayerField;
      if (f === 'room') {
        if (S.mode !== 'post') { selectRoom(el.value); return; }
        S.roomId = el.value;
        const author = $('#prayer-author');
        if (author && !author.dataset.touched) author.value = defaultAuthor(roomById(S.roomId)); // 직접 고친 이름은 유지
      } else if (f === 'author-name') el.dataset.touched = '1';
      else if (f === 'manage-room') { S.manageId = el.value; S.editMember = null; renderManageDetail(); }
      else if (f === 'period') { S.period = el.value; $('#prayer-range').hidden = S.period !== 'range'; }
      else if (f === 'from') { S.from = el.value; showPickedDate(el); }
      else if (f === 'to') { S.to = el.value; showPickedDate(el); }
      else if (f === 'author-all') {
        S.authors = el.checked ? new Set(authorsOf(S.prayers)) : new Set();
        document.querySelectorAll('[data-prayer-field="author"]').forEach((c) => { c.checked = el.checked; });
        say(el.checked ? `게시자 전체 ${S.authors.size}명 선택` : '게시자 선택 해제');
      } else if (f === 'author') {
        if (el.checked) S.authors.add(el.value); else S.authors.delete(el.value);
        const all = $('[data-prayer-field="author-all"]');
        if (all) all.checked = authorsOf(S.prayers).every((n) => S.authors.has(n));
        say(`게시자 ${S.authors.size}명 선택`); // 체크 상태만으로는 몇 명이 골라졌는지 알기 어려워 안내
      } else if (f === 'file') onFile(el);
    },
  };
}
