/* 기도방 (Firestore). 처음 "기도"를 열 때만 app.js 가 동적으로 불러온다.
   - 슈퍼관리자(SUPER_ADMIN_EMAIL): 모든 기도방의 모든 권한 + 관리자 관리(prayerAdmins 문서로 관리자 권한을 부여·편집·삭제)
   - 관리자(prayerAdmins 에 등록된 계정): 기도방 만들기(CSV·빈 방), 그리고 자기가 만들었거나 구성원인 기도방의 관리(이름·초대·삭제·모든 기도제목 편집) + 사용자 기능
   - 사용자: 초대받은 기도방에서 기도제목 검색·게시·편집
   - 데이터: prayerRooms/{방} {name, members[], memberNames{}, ...} 와 prayerRooms/{방}/prayers/{기도} (규칙: scripts/firestore.rules)
   - 사용자·외부 텍스트는 textContent/createElement 로만 넣는다 (innerHTML 미사용) */

/** 슈퍼관리자 (scripts/firestore.rules 의 isSuper() 와 같은 값). 모든 기도방의 모든 권한을 갖고 관리자 권한을 부여한다.
    일반 관리자 목록은 코드가 아니라 Firestore 의 prayerAdmins/{이메일} 문서로 관리한다 */
export const SUPER_ADMIN_EMAIL = 'manbygod@gmail.com';
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

/**
 * 직접 입력한 날짜 검사·정리: 비어 있으면 {ok, value:''}.
 * 숫자 8자리(20251003)나 구분 기호 형식(2025-10-03, 2025-1-3, 2025/10/03, 2025.10.03)을 받아 항상 'YYYY-MM-DD' 로 바꿔 돌려준다.
 * 연도 두 자리·7자리처럼 해석이 갈리는 입력과 실제 없는 날짜(2025-02-30)는 {ok:false, error}
 */
export function parseDayInput(text) {
  const s = String(text).trim();
  if (!s) return { ok: true, value: '' };
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s) ?? /^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\.?$/.exec(s);
  if (!m) return { ok: false, error: '날짜는 연-월-일 형식으로 입력하세요. 숫자만 입력해도 됩니다. (예: 20251003 또는 2025-10-03)' };
  const day = parsePostedDate(`${m[1]}-${m[2]}-${m[3]}`);
  if (!day) return { ok: false, error: '없는 날짜입니다. 연-월-일을 다시 확인하세요.' };
  return { ok: true, value: day };
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

/** CSV 한 칸: 쉼표·큰따옴표·줄바꿈이 있으면 "..." 로 묶고 안의 "는 "" 로. 엑셀에서 수식으로 실행될 수 있는 시작(= + @, 붙어 있는 -)은 앞에 ' 를 붙여 막는다 */
export function csvCell(value) {
  let s = String(value ?? '').replace(/\r\n?/g, '\n');
  if (/^[=+@]/.test(s) || /^-\S/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 기도제목 → CSV 글. 가져오기와 같은 4칸(게시자,게시일,기도 제목,기도 응답)이라 내보낸 파일을 그대로 다시 가져올 수 있다.
 * 게시일은 기도제목 마지막 수정일시의 날짜(YYYY-MM-DD), 오래된 것부터. 한글 엑셀이 바로 열도록 앞에 BOM 을 붙인다
 */
export function prayersToCsv(prayers) {
  const rows = [...prayers].sort((a, b) => a.contentUpdatedAt.localeCompare(b.contentUpdatedAt) || a.author.localeCompare(b.author, 'ko'))
    .map((p) => [p.author, dayOf(p.contentUpdatedAt), p.content, p.response].map(csvCell).join(','));
  return `﻿${[CSV_HEADER.join(','), ...rows].join('\r\n')}\r\n`;
}

/** 내보낼 파일 이름: '기도방 이름_YYYY-MM-DD.csv' (파일 이름에 쓸 수 없는 글자는 뺌) */
export const exportFileName = (roomName, day) => `${String(roomName).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || '기도방'}_${day}.csv`;

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

/** 기도제목 한 건의 본문 줄들 (게시자·게시일·기도제목·기도응답). 이모지마다 글자 이름을 함께 적어, 이모지를 읽지 못하는 곳(스크린리더 등)에서도 뜻이 통하게 한다 */
function prayerLines(p, weekday) {
  const out = [`👤 게시자: ${p.author}`, `📅 게시일: ${formatDay(p.postedOn, weekday)}`, '', '📝 기도제목', p.content];
  if (p.response) out.push('', `🌿 기도응답 · ${formatDay(dayOf(p.responseUpdatedAt || p.contentUpdatedAt), weekday)}`, p.response);
  return out;
}

/**
 * 복사·공유할 글 (카카오톡 등 글자만 전달되는 곳에서 보기 좋게 이모지로 꾸밈).
 * 한 건이면 카드 한 장 모양, 여러 건이면 "📌 1/3" 번호와 구분선으로 건마다 나눈다
 */
export function prayerText(p, roomName, weekday) {
  return prayersText([p], roomName, weekday);
}

export const DIVIDER = '━━━━━━━━━━';
export function prayersText(list, roomName, weekday) {
  if (list.length === 1) {
    const [p] = list;
    return [`🙏 ${roomName} 기도제목`, '', ...prayerLines(p, weekday), '', p.response ? '🙌 응답에 함께 감사해 주세요.' : '🙏 함께 기도해 주세요.'].join('\n');
  }
  const out = [`🙏 ${roomName} 기도제목 모음`, `📋 모두 ${list.length}건`, ''];
  list.forEach((p, i) => out.push(DIVIDER, `📌 ${i + 1}/${list.length}`, ...prayerLines(p, weekday), ''));
  out.push(DIVIDER, '', '🙏 함께 기도해 주세요.');
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
  return {
    id, name: d.name, members: d.members.filter((e) => typeof e === 'string'), createdBy: typeof d.createdBy === 'string' ? d.createdBy : '',
    memberNames: Object.fromEntries(Object.entries(names).filter(([, v]) => typeof v === 'string')),
  };
}

/** 이 계정이 그 기도방의 관리자 기능을 쓸 수 있는가. role = {superAdmin, admin}.
    슈퍼관리자는 모든 방, 관리자는 자기가 만들었거나 구성원인 방만, 그 밖에는 불가 */
export const managesRoom = (room, email, role = {}) =>
  !!room && !!email && (!!role.superAdmin || (!!role.admin && (room.createdBy === email || room.members.includes(email))));

/** prayerAdmins 문서 → {email, name} 또는 null */
export function cleanAdmin(id, d) {
  if (!d || typeof d.name !== 'string') return null;
  return {
    id, email: typeof d.email === 'string' ? d.email : id, name: d.name,
    createdBy: typeof d.createdBy === 'string' ? d.createdBy : '', createdAt: typeof d.createdAt === 'string' ? d.createdAt : '',
  };
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
    mode: 'search', rooms: null, role: null, admins: null, editAdmin: null, roomId: '', prayers: [], loadedAt: 0, results: [], kind: 'search',
    authors: new Set(), period: 'all', from: '', to: '', editing: new Set(), pending: null, invitees: [], editMember: null, prayersRoom: '',
  };
  const MODES = [['search', '검색'], ['post', '게시'], ['edit', '편집']];
  const ADMIN_MODES = [['create', '기도방 만들기'], ['manage', '기도방 관리']];
  const SUPER_MODES = [['admins', '관리자 관리']]; // 슈퍼관리자에게만
  const nowISO = () => new Date().toISOString();

  const me = () => {
    const u = user();
    return u?.email ? { uid: u.uid, email: u.email, name: u.name } : null;
  };
  const isSuper = () => !!S.role?.superAdmin;
  const isAdmin = () => !!S.role?.admin; // 기도방을 만들 수 있는 계정 (슈퍼관리자 포함)
  /** 목록에 보이는 기도방: 슈퍼관리자는 모든 방, 관리자는 자기가 관리하는 방(만들었거나 구성원), 일반 사용자는 초대받은 방 */
  const roomsOf = () => S.rooms ?? [];
  const roomById = (id) => roomsOf().find((r) => r.id === id);
  const myName = (room) => room?.memberNames?.[nameKey(me().email)] ?? '';
  const isMineIn = (p) => isMine(p, me().email, myName(roomById(S.roomId)));
  /** 관리자 기능을 쓸 수 있는 기도방인가 (내가 만들었거나 구성원인 방, 관리자 계정일 때만) */
  const canManage = (room) => managesRoom(room, me()?.email, S.role ?? {});
  const manageHere = () => canManage(roomById(S.roomId)); // 지금 선택한 기도방
  /** 카드에서 편집·삭제할 수 있는가. 편집 화면은 누구든 내 기도제목만, 검색 화면은 내 기도제목이거나 내가 관리하는 기도방의 모든 기도제목 */
  const canEdit = (p) => isMineIn(p) || (S.kind === 'search' && manageHere());
  /** 게시자 선택 칸은 검색 화면에만 (편집 화면은 누구든 내 기도제목만) */
  const withAuthors = (kind) => kind === 'search';
  const say = (msg) => { $('#prayer-status').textContent = ''; setTimeout(() => { $('#prayer-status').textContent = msg; }, 50); };
  const panel = () => $('#prayer-panel');
  const fx = () => fb();

  /* ---- Firestore ---- */
  /** 내 권한: 슈퍼관리자는 코드의 계정, 관리자는 prayerAdmins/{내 이메일} 문서가 있을 때 (규칙이 자기 문서만 읽게 허용) */
  async function loadRole() {
    const email = me().email;
    if (email === SUPER_ADMIN_EMAIL) { S.role = { superAdmin: true, admin: true }; return; }
    const { db, fs } = fx();
    const snap = await fs.getDoc(fs.doc(db, 'prayerAdmins', email));
    S.role = { superAdmin: false, admin: snap.exists() };
  }
  /** 목록에 보이는 기도방: 슈퍼관리자는 모든 방, 관리자는 자기가 구성원이거나 만든 방(= 관리하는 방), 일반 사용자는 초대받은 방.
      관리하지 않는 방은 목록에 나오지 않고, 규칙도 같은 범위만 읽게 허용한다 */
  async function loadRooms() {
    const { db, fs } = fx();
    const col = fs.collection(db, 'prayerRooms');
    const email = me().email;
    const snaps = isSuper()
      ? [await fs.getDocs(col)]
      : await Promise.all([
        fs.getDocs(fs.query(col, fs.where('members', 'array-contains', email))),
        ...(isAdmin() ? [fs.getDocs(fs.query(col, fs.where('createdBy', '==', email)))] : []),
      ]);
    const byId = new Map();
    for (const snap of snaps) for (const d of snap.docs) { const r = cleanRoom(d.id, d.data()); if (r) byId.set(r.id, r); }
    S.rooms = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  async function loadAdmins() {
    const { db, fs } = fx();
    const snap = await fs.getDocs(fs.collection(db, 'prayerAdmins'));
    S.admins = snap.docs.map((d) => cleanAdmin(d.id, d.data())).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  /** 기도방의 기도제목을 모두 읽어 돌려줌 (화면 상태는 건드리지 않음) */
  async function fetchPrayers(roomId) {
    const { db, fs } = fx();
    const snap = await fs.getDocs(fs.collection(db, 'prayerRooms', roomId, 'prayers'));
    return snap.docs.map((d) => cleanPrayer(d.id, d.data())).filter(Boolean);
  }
  async function loadPrayers(roomId) {
    S.prayers = await fetchPrayers(roomId);
    S.prayersRoom = roomId; // S.prayers 가 어느 기도방의 것인지 (메뉴를 옮겨도 선택한 방과 맞는지 확인용)
    S.loadedAt = Date.now();
  }
  const invalidate = () => { S.rooms = null; };

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
    const list = [...MODES, ...(isAdmin() ? ADMIN_MODES : []), ...(isSuper() ? SUPER_MODES : [])];
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
    try {
      if (!S.role) await loadRole(); // 권한을 알아야 어떤 메뉴·기도방을 보여 줄지 정해진다
      if (!S.rooms) await loadRooms();
      if (S.mode === 'admins' && isSuper() && !S.admins) await loadAdmins();
    } catch (e) { console.error('[prayer]', e); $('#prayer-modes').hidden = true; note.textContent = explainError(e); mount(panel()); return; }
    if (!isAdmin() && (S.mode === 'create' || S.mode === 'manage')) S.mode = 'search'; // 권한이 없는 화면에 머물지 않게 (메뉴 표시 전에 바로잡음)
    if (!isSuper() && S.mode === 'admins') S.mode = 'search';
    renderModes();
    renderPanel();
  }

  function renderPanel() {
    const m = S.mode;
    if (!isAdmin() && (m === 'create' || m === 'manage')) S.mode = 'search';
    if (!isSuper() && m === 'admins') S.mode = 'search';
    if (S.mode === 'create') renderCreate();
    else if (S.mode === 'manage') renderManage();
    else if (S.mode === 'admins') renderAdmins();
    else if (roomsOf().length === 0) { mount(panel(), h('p', { class: 'view__note' }, '초대받은 기도방이 없습니다.')); say('초대받은 기도방이 없습니다.'); }
    else if (S.mode === 'post') renderPost();
    else renderQuery(S.mode);
  }

  /* ---- 검색·편집 ---- */
  function renderQuery(kind) {
    S.kind = kind;
    if (S.roomId && !roomsOf().some((r) => r.id === S.roomId)) S.roomId = '';
    const periodRow = h('fieldset', { class: 'prayer-fieldset', id: 'prayer-period', hidden: !S.roomId }, // 기도방을 고르기 전에는 숨김
      h('legend', { class: 'field__label', id: 'prayer-period-legend' }, periodLegend(kind)),
      [['all', '전체'], ['range', '기간 선택'], ['recent', '최근 게시 (마지막으로 올린 날짜)']].map(([v, label]) =>
        h('label', { class: 'check' }, h('input', { type: 'radio', name: 'prayer-period', value: v, checked: S.period === v, 'data-prayer-field': 'period' }), ` ${label}`)),
      h('div', { class: 'prayer-range', id: 'prayer-range', hidden: S.period !== 'range' },
        datePick('prayer-from', '시작일', S.from, 'from'),
        datePick('prayer-to', '종료일', S.to, 'to')));
    mount(panel(), h('form', { class: 'prayer-form', 'data-prayer-form': 'query', role: 'search' },
      roomSelect('prayer-room', roomsOf(), S.roomId),
      h('div', { id: 'prayer-authors' }), // 검색, 또는 내가 관리하는 방의 편집일 때만 채워짐
      periodRow,
      h('button', { type: 'submit', class: 'btn btn--primary', id: 'prayer-query-submit' }, queryButtonText(kind))),
    h('div', { class: 'prayer-bulk', id: 'prayer-bulk', role: 'group', 'aria-label': '검색한 기도제목 전체', hidden: true },
      h('button', { type: 'button', class: 'btn', id: 'prayer-copy-all', 'data-action': 'prayer-copy-all' }),
      h('button', { type: 'button', class: 'btn', id: 'prayer-share-all', 'data-action': 'prayer-share-all' })),
    h('ul', { class: 'prayer-list', id: 'prayer-results', tabindex: '-1', 'aria-label': '검색한 기도제목' }));
    renderAuthors();
    if (S.results.length && S.resultsKind === kind) renderResults();
    if (S.roomId && S.prayersRoom !== S.roomId) loadRoomPrayers(); // 메뉴를 옮겨 와서 방은 선택돼 있지만 기도제목은 아직 없을 때
  }

  /** 편집 화면의 문구: 내가 관리하는 방이면 모든 기도제목, 아니면 내 기도제목만 */
  const periodLegend = (kind) => (kind === 'edit' ? '내가 게시한 날짜' : '기도제목 게시 날짜');
  const queryButtonText = (kind) => (kind === 'edit' ? '내 기도제목 검색' : '검색');
  function syncQueryLabels() {
    const legend = $('#prayer-period-legend');
    if (legend) legend.textContent = periodLegend(S.kind);
    const btn = $('#prayer-query-submit');
    if (btn) btn.textContent = queryButtonText(S.kind);
  }

  /** 선택된 기도방의 기도제목을 불러와 게시자 선택을 채운다 */
  async function loadRoomPrayers() {
    const roomId = S.roomId;
    try {
      await loadPrayers(roomId);
      if (S.roomId !== roomId) return; // 그 사이 다른 방을 골랐으면 버림
      S.authors = new Set(authorsOf(S.prayers));
      renderAuthors();
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); }
  }

  function renderAuthors() {
    const box = $('#prayer-authors');
    if (!box) return;
    if (!S.roomId || !withAuthors(S.kind)) { mount(box); return; }
    const names = authorsOf(S.prayers);
    const lead = []; // (검색 화면에는 안내 문구 없음)
    if (S.prayersRoom !== S.roomId) { mount(box, ...lead, h('p', { class: 'view__note' }, '기도제목을 불러오는 중입니다...')); return; }
    if (!names.length) { mount(box, ...lead, h('p', { class: 'view__note' }, '이 기도방에는 아직 기도제목이 없습니다.')); return; }
    const all = names.every((n) => S.authors.has(n));
    mount(box, ...lead, h('fieldset', { class: 'prayer-fieldset' },
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
    syncQueryLabels(); // 내가 관리하는 방인지에 따라 편집 화면의 문구가 달라짐
    if (!roomId) { renderAuthors(); return; }
    try {
      await loadPrayers(roomId);
      S.authors = new Set(authorsOf(S.prayers));
      renderAuthors();
      say(`${roomById(roomId)?.name ?? ''} 기도방을 선택했습니다. 기도제목 ${S.prayers.length}건.`);
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); }
  }

  async function runQuery() {
    if (!S.roomId) { toast('기도방을 선택하세요.'); $('#prayer-room')?.focus(); return; }
    const kind = S.kind;
    if (S.period === 'range') { // 직접 입력한 날짜는 형식을 검사한다 (연-월-일, 실제 있는 날짜)
      const a = readDate('prayer-from');
      const b = readDate('prayer-to');
      if (!a.ok || !b.ok) { toast(!a.ok ? `시작일: ${a.error}` : `종료일: ${b.error}`); $(!a.ok ? '#prayer-from' : '#prayer-to')?.focus(); return; }
      S.from = a.value;
      S.to = b.value;
      if (S.from && S.to && S.from > S.to) { toast('시작일이 종료일보다 늦습니다.'); $('#prayer-from')?.focus(); return; }
    }
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
      : h('li', { class: 'view__note' }, S.resultsKind === 'edit' ? '조건에 맞는 내 기도제목이 없습니다.' : '조건에 맞는 기도제목이 없습니다.'));
    syncBulk();
  }

  /** 결과가 2건 이상일 때만 "결과 전체 복사·공유" 버튼을 보이고, 건수를 글자에 반영 */
  function syncBulk() {
    const box = $('#prayer-bulk');
    if (!box) return;
    const n = S.results.length;
    box.hidden = n < 2;
    if (n < 2) return;
    $('#prayer-copy-all').textContent = `결과 ${n}건 전체 복사`;
    $('#prayer-share-all').textContent = `결과 ${n}건 전체 공유`;
  }
  const resultsText = () => prayersText(S.results, roomById(S.roomId)?.name ?? '', weekday);

  /* ---- 카드 ---- */
  function card(p) {
    const mine = canEdit(p);
    const editing = S.editing.has(p.id);
    const who = `${p.author} ${p.postedOn}`;
    const btn = (action, label, extra = {}) => h('button', { type: 'button', class: `btn${extra.danger ? ' btn--danger' : ''}${extra.primary ? ' btn--primary' : ''}`, 'data-action': action, 'data-id': p.id, 'aria-label': `${who} 기도제목 ${label}` }, label);
    const contentDay = formatDay(p.postedOn, weekday);
    const responseDay = p.response ? formatDay(dayOf(p.responseUpdatedAt || p.contentUpdatedAt), weekday) : '';
    // "기도제목 2026-09-12(토)", "기도응답 2026-09-12(토)": 눈에 띄는 라벨 + 날짜 (날짜는 이름 옆이 아니라 각 내용 옆)
    const label = (title, day, htmlFor) => h(htmlFor ? 'label' : 'p', { class: 'prayer-card__label', for: htmlFor },
      h('span', { class: 'prayer-card__label-title' }, title), day ? h('span', { class: 'prayer-card__label-date' }, day) : null);
    return h('li', { class: `prayer-card${editing ? ' prayer-card--editing' : ''}`, 'data-id': p.id },
      // 제목에는 이름만 보이고, 같은 사람의 카드를 제목 이동으로 구분할 수 있도록 날짜는 화면에서만 숨김
      h('h3', { class: 'prayer-card__head' }, h('span', { class: 'prayer-card__author' }, p.author), h('span', { class: 'visually-hidden' }, `, ${contentDay} 게시`)),
      editing
        ? [
          label('기도제목', contentDay, `pc-${p.id}`),
          h('textarea', { class: 'field__control', id: `pc-${p.id}`, rows: '6', maxlength: String(LIMITS.content), 'data-field': 'content' }, p.content),
          label('기도응답', responseDay, `pr-${p.id}`),
          h('textarea', { class: 'field__control', id: `pr-${p.id}`, rows: '4', maxlength: String(LIMITS.content), 'data-field': 'response' }, p.response),
          h('p', { class: 'view__note' }, '기도제목을 고치면 게시 날짜가, 기도응답을 고치면 기도응답 날짜가 오늘로 바뀝니다.'),
        ]
        : [
          label('기도제목', contentDay),
          h('p', { class: 'prayer-card__body' }, p.content),
          // h() 는 배열을 한 단계만 펼치므로 중첩 배열 대신 펼쳐서 넣는다
          ...(p.response ? [label('기도응답', responseDay), h('p', { class: 'prayer-card__body prayer-card__body--response' }, p.response)] : []),
        ],
      h('div', { class: 'prayer-card__actions' },
        btn('prayer-copy', '복사'), btn('prayer-share', '공유'),
        // "편집"은 어디서나 같다: 누르면 그 카드가 입력칸으로 바뀌고 포커스가 그리로 간다
        mine && !editing ? btn('prayer-edit', '편집') : null,
        mine && editing ? [btn('prayer-save', '저장', { primary: true }), btn('prayer-close', '닫기')] : null,
        mine ? btn('prayer-delete', '삭제', { danger: true }) : null)); // 검색 결과 카드에도 삭제 (복사·공유·편집 옆)
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
    else syncBulk(); // 남은 건수가 바뀌면 전체 복사·공유 버튼 글자도 맞춤
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
  /**
   * 날짜 입력: 직접 입력(연-월-일, 형식 검사) + 달력 아이콘 버튼. 달력은 아이콘 버튼을 눌렀을 때만 열린다.
   * 브라우저의 날짜 칸은 표시 형식(mm/dd/yyyy)을 바꿀 수 없고 칸을 누르면 달력이 열려 버려서,
   * 글 입력칸과 달력 전용 날짜 입력(화면에 보이지 않고 아이콘 버튼이 showPicker 로 여는 것)으로 나눈다
   */
  function datePick(id, label, value, fieldName) {
    return h('div', { class: 'prayer-field' },
      h('label', { class: 'field__label', for: id }, label),
      h('span', { class: 'date-pick' },
        h('input', { class: 'date-pick__text', type: 'text', id, value, inputmode: 'numeric', maxlength: '10', autocomplete: 'off', placeholder: 'YYYY-MM-DD', 'aria-describedby': `${id}-hint`, 'data-prayer-field': fieldName }),
        h('button', { type: 'button', class: 'date-pick__button', 'data-action': 'prayer-date-pick', 'data-target': id, 'aria-label': `${label} 달력 열기` }, calendarIcon()),
        h('input', { class: 'date-pick__native', type: 'date', id: `${id}-native`, tabindex: '-1', 'aria-hidden': 'true', 'data-prayer-field': `${fieldName}-native`, 'data-target': id })),
      h('p', { class: 'date-pick__hint', id: `${id}-hint` }, '연-월-일, 숫자만 입력해도 됩니다 (예: 20251003)'),
      h('p', { class: 'date-pick__error', id: `${id}-error`, role: 'alert' }));
  }
  /** 날짜 칸의 오류 표시를 갱신 (role=alert 라 스크린리더가 바로 읽음) */
  function setDateError(id, message) {
    const input = $(`#${id}`);
    const err = $(`#${id}-error`);
    if (!input || !err) return;
    err.textContent = message;
    if (message) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `${id}-hint ${id}-error`); } else { input.removeAttribute('aria-invalid'); input.setAttribute('aria-describedby', `${id}-hint`); }
  }
  /** 날짜 칸을 읽어 형식을 검사 → {ok, value}. 잘못이면 오류를 표시 */
  function readDate(id) {
    const el = $(`#${id}`);
    const r = parseDayInput(el?.value ?? '');
    setDateError(id, r.ok ? '' : r.error);
    if (r.ok && el && el.value !== r.value) { el.value = r.value; r.changed = true; } // 20251003 같은 입력은 칸에도 2025-10-03 으로 정리해 보여 줌
    return r;
  }

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
    const rooms = roomsOf().filter(canManage); // 관리자는 자기가 관리하는 방만, 슈퍼관리자는 모든 방
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
    const room = roomsOf().filter(canManage).find((r) => r.id === S.manageId);
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
        h('button', { type: 'button', class: 'btn btn--danger', 'data-action': 'prayer-room-delete' }, '기도방 삭제'),
        // 삭제 오른쪽. 설명은 화면에는 숨기고 스크린리더에만 읽힘
        h('button', { type: 'button', class: 'btn', id: 'prayer-export', 'data-action': 'prayer-export', 'aria-describedby': 'prayer-export-note' }, 'CSV로 내보내기'),
        h('p', { class: 'visually-hidden', id: 'prayer-export-note' }, '이 기도방의 기도제목을 가져오기와 같은 형식(게시자, 게시일, 기도 제목, 기도 응답)의 CSV 파일로 저장합니다.')));
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

  const manageRoom = () => roomsOf().filter(canManage).find((r) => r.id === S.manageId);

  async function saveRoom(patch, okMsg, focusSel) {
    const room = manageRoom();
    if (!room) return;
    try {
      const { db, fs } = fx();
      await fs.updateDoc(fs.doc(db, 'prayerRooms', room.id), { ...patch, updatedAt: nowISO() });
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
    Object.assign(room, patch);
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

  /* ---- 관리자 관리 (슈퍼관리자) ---- */
  function renderAdmins() {
    const admins = S.admins ?? [];
    mount(panel(),
      h('p', { class: 'view__note' }, `슈퍼관리자(${SUPER_ADMIN_EMAIL})는 모든 기도방의 모든 권한을 가지며 이 목록에 없습니다. 여기에 등록한 관리자는 기도방을 만들 수 있고, 자기가 만들었거나 구성원으로 들어간 기도방만 관리합니다.`),
      h('h3', { class: 'prayer-subtitle', id: 'prayer-admins-title' }, `관리자 (${admins.length}명)`),
      h('ul', { class: 'prayer-members', 'aria-labelledby': 'prayer-admins-title' },
        admins.length ? admins.map((a) => (a.email === S.editAdmin ? adminEditRow(a) : adminRow(a))) : h('li', { class: 'view__note' }, '등록된 관리자가 없습니다.')),
      h('form', { class: 'prayer-form prayer-invite', 'data-prayer-form': 'admin-add' },
        h('h3', { class: 'prayer-subtitle' }, '관리자 추가'),
        inviteFields('prayer-newadmin')));
  }

  function adminRow(a) {
    const who = `${a.name} ${a.email}`;
    return h('li', { class: 'prayer-members__item' },
      h('span', { class: 'prayer-members__email' }, `${a.name} (${a.email})`),
      h('span', { class: 'prayer-members__actions' },
        h('button', { type: 'button', class: 'btn', 'data-action': 'prayer-admin-edit', 'data-email': a.email, 'aria-label': `${who} 관리자 정보 편집` }, '편집'),
        h('button', { type: 'button', class: 'btn btn--danger', 'data-action': 'prayer-admin-remove', 'data-email': a.email, 'aria-label': `${who} 관리자 권한 삭제` }, '삭제')));
  }

  function adminEditRow(a) {
    return h('li', { class: 'prayer-members__item prayer-members__item--editing' },
      h('form', { class: 'prayer-invite__row', 'data-prayer-form': 'admin-edit' },
        field('지메일 계정', h('input', { class: 'field__control', type: 'email', id: 'prayer-admin-edit-email', value: a.email, autocomplete: 'off', inputmode: 'email', required: true }), 'prayer-admin-edit-email'),
        field('이름', h('input', { class: 'field__control', type: 'text', id: 'prayer-admin-edit-name', value: a.name, maxlength: String(LIMITS.author), autocomplete: 'off', required: true }), 'prayer-admin-edit-name'),
        h('button', { type: 'submit', class: 'btn btn--primary' }, '저장'),
        h('button', { type: 'button', class: 'btn', 'data-action': 'prayer-admin-edit-cancel', 'data-email': a.email }, '취소')));
  }

  const editAdminBtn = (email) => document.querySelector(`[data-action="prayer-admin-edit"][data-email="${email}"]`);

  async function addAdmin() {
    const r = parseInvitee($('#prayer-newadmin-email').value, $('#prayer-newadmin-name').value);
    if (r.error) { toast(r.error); $(r.error.startsWith('이름') ? '#prayer-newadmin-name' : '#prayer-newadmin-email').focus(); return; }
    const { email, name } = r.member;
    if (email === SUPER_ADMIN_EMAIL) { toast('슈퍼관리자는 이미 모든 권한이 있습니다.'); return; }
    const known = (S.admins ?? []).find((a) => a.email === email);
    const now = nowISO();
    try {
      const { db, fs } = fx();
      const ref = fs.doc(db, 'prayerAdmins', email);
      if (known) await fs.updateDoc(ref, { name, updatedAt: now });
      else await fs.setDoc(ref, { email, name, createdBy: me().email, createdAt: now, updatedAt: now });
      await loadAdmins();
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
    renderAdmins();
    $('#prayer-newadmin-email')?.focus();
    toast(known ? `이미 관리자입니다. ${email} 계정의 이름을 바꿨습니다.` : `${name}(${email}) 님에게 관리자 권한을 부여했습니다.`);
  }

  async function saveAdminEdit() {
    const old = S.editAdmin;
    const cur = (S.admins ?? []).find((a) => a.email === old);
    if (!cur) return;
    const r = parseInvitee($('#prayer-admin-edit-email').value, $('#prayer-admin-edit-name').value);
    if (r.error) { toast(r.error); $(r.error.startsWith('이름') ? '#prayer-admin-edit-name' : '#prayer-admin-edit-email').focus(); return; }
    const { email, name } = r.member;
    if (email === SUPER_ADMIN_EMAIL) { toast('슈퍼관리자 계정은 관리자 목록에 넣을 수 없습니다.'); $('#prayer-admin-edit-email').focus(); return; }
    if (email !== old && S.admins.some((a) => a.email === email)) { toast('이미 관리자로 등록된 계정입니다.'); $('#prayer-admin-edit-email').focus(); return; }
    if (email !== old && !window.confirm(`관리자 계정을 ${old} → ${email} 으로 바꿀까요?\n\n새 계정이 관리자가 되고, ${old} 계정의 관리자 권한은 사라집니다.\n그 계정이 만든 기도방의 "만든 사람"은 새 계정으로 옮기지만, 기도방 구성원 목록과 올린 기도제목의 지메일은 그대로입니다.`)) return;
    const now = nowISO();
    let moved = 0;
    try {
      const { db, fs } = fx();
      if (email === old) await fs.updateDoc(fs.doc(db, 'prayerAdmins', old), { name, updatedAt: now });
      else {
        const batch = fs.writeBatch(db);
        batch.set(fs.doc(db, 'prayerAdmins', email), { email, name, createdBy: cur.createdBy || me().email, createdAt: cur.createdAt || now, updatedAt: now });
        batch.delete(fs.doc(db, 'prayerAdmins', old));
        await batch.commit();
        const rooms = await fs.getDocs(fs.query(fs.collection(db, 'prayerRooms'), fs.where('createdBy', '==', old)));
        for (let i = 0; i < rooms.docs.length; i += 400) {
          const b = fs.writeBatch(db);
          rooms.docs.slice(i, i + 400).forEach((d) => b.update(d.ref, { createdBy: email }));
          await b.commit();
        }
        moved = rooms.docs.length;
        invalidate();
      }
      S.editAdmin = null;
      await loadAdmins();
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
    renderAdmins();
    editAdminBtn(email)?.focus();
    toast(email === old ? `${name}(${email}) 정보를 저장했습니다.` : `관리자 계정을 ${email} 으로 바꿨습니다.${moved ? ` 만든 기도방 ${moved}개의 만든 사람도 옮겼습니다.` : ''}`);
  }

  /** 선택한 기도방의 기도제목을 최신 상태로 읽어 CSV 파일로 저장 (관리하는 방에서만 이 화면에 들어올 수 있음) */
  async function exportCsv() {
    const room = manageRoom();
    if (!room) return;
    const btn = $('#prayer-export');
    if (btn) btn.disabled = true;
    try {
      const prayers = await fetchPrayers(room.id);
      const url = URL.createObjectURL(new Blob([prayersToCsv(prayers)], { type: 'text/csv;charset=utf-8' }));
      const a = h('a', { href: url, download: exportFileName(room.name, today()) });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(prayers.length ? `"${room.name}" 기도제목 ${prayers.length}건을 CSV로 내보냈습니다.` : `"${room.name}" 기도방에 기도제목이 없어 머리글만 내보냈습니다.`);
    } catch (e) { console.error('[prayer]', e); toast(explainError(e)); } finally { if (btn) { btn.disabled = false; btn.focus(); } }
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
    'prayer-mode': async (el) => {
      S.mode = el.dataset.mode;
      S.editMember = null; S.editAdmin = null; S.results = []; S.editing.clear();
      if (S.mode === 'search' || S.mode === 'edit') { // 상단 버튼으로 들어올 때는 조건을 "전체"로 되돌린다 (결과는 비워지므로 조건만 남지 않게). 기도방 선택은 유지
        S.period = 'all'; S.from = ''; S.to = '';
        S.authors = new Set(authorsOf(S.prayers));
      }
      await render(); $('#prayer-modes [aria-pressed="true"]')?.focus(); },
    'prayer-copy': (el) => { const p = prayerById(el.dataset.id); if (p) copyText(prayerText(p, roomById(S.roomId)?.name ?? '', weekday)); },
    'prayer-share': (el) => { const p = prayerById(el.dataset.id); if (p) shareText(prayerText(p, roomById(S.roomId)?.name ?? '', weekday)); },
    'prayer-copy-all': () => { if (S.results.length) copyText(resultsText(), `기도제목 ${S.results.length}건을 복사했습니다.`); },
    'prayer-share-all': () => { if (S.results.length) shareText(resultsText()); },
    'prayer-edit': (el) => { const p = prayerById(el.dataset.id); if (p) { S.editing.add(p.id); replaceCard(p, 'prayer-save'); cardEl(p.id)?.querySelector('[data-field="content"]')?.focus(); } },
    'prayer-close': (el) => { const p = prayerById(el.dataset.id); if (p) { S.editing.delete(p.id); replaceCard(p, 'prayer-edit'); } },
    'prayer-save': (el) => saveCard(el.dataset.id),
    'prayer-delete': (el) => deleteCard(el.dataset.id),
    'prayer-member-edit': (el) => { S.editMember = el.dataset.email; renderManageDetail(); $('#prayer-edit-email')?.focus(); },
    'prayer-member-edit-cancel': (el) => {
      S.editMember = null;
      renderManageDetail();
      document.querySelector(`[data-action="prayer-member-edit"][data-email="${el.dataset.email}"]`)?.focus();
    },
    'prayer-export': () => exportCsv(),
    'prayer-date-pick': (el) => { // 달력 아이콘 버튼을 눌렀을 때만 달력을 연다
      const native = $(`#${el.dataset.target}-native`);
      const cur = parseDayInput($(`#${el.dataset.target}`).value);
      native.value = cur.ok ? cur.value : '';
      try { native.showPicker(); } catch { toast('이 브라우저에서는 달력을 열 수 없습니다. 날짜를 직접 입력하세요.'); }
    },
    'prayer-create-empty': () => doCreate($('#prayer-create-form'), { empty: true }),
    'prayer-admin-edit': (el) => { S.editAdmin = el.dataset.email; renderAdmins(); $('#prayer-admin-edit-email')?.focus(); },
    'prayer-admin-edit-cancel': (el) => { S.editAdmin = null; renderAdmins(); editAdminBtn(el.dataset.email)?.focus(); },
    'prayer-admin-remove': async (el) => {
      const a = (S.admins ?? []).find((x) => x.email === el.dataset.email);
      if (!a || !window.confirm(`${a.name}(${a.email}) 님의 관리자 권한을 삭제할까요?\n\n그 계정이 만든 기도방과 구성원 자격은 그대로 남고, 슈퍼관리자만 그 기도방을 관리할 수 있게 됩니다.`)) return;
      try {
        const { db, fs } = fx();
        await fs.deleteDoc(fs.doc(db, 'prayerAdmins', a.email));
        await loadAdmins();
      } catch (e) { console.error('[prayer]', e); toast(explainError(e)); return; }
      renderAdmins();
      $('#prayer-newadmin-email')?.focus();
      toast(`${a.name}(${a.email}) 님의 관리자 권한을 삭제했습니다.`);
    },
    'prayer-invite-remove': (el) => {
      S.invitees = S.invitees.filter((m) => m.email !== el.dataset.email);
      renderInvitees();
      toast(`${el.dataset.email} 초대를 취소했습니다.`);
      $('#prayer-invite-email')?.focus();
    },
    'prayer-member-remove': (el) => {
      const room = manageRoom();
      const email = el.dataset.email;
      if (!room) return;
      const selfWarn = email === me().email && room.createdBy !== me().email ? '\n내 계정이라서, 삭제하면 이 기도방을 더 이상 관리할 수 없게 됩니다.' : '';
      if (!window.confirm(`${email} 계정의 "${room.name}" 접근 권한을 삭제할까요?${selfWarn}`)) return;
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
      Object.assign(S, { rooms: null, role: null, admins: null, editAdmin: null, roomId: '', prayers: [], prayersRoom: '', results: [], pending: null, invitees: [], editMember: null, manageId: '' });
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
      if (kind === 'admin-add') return addAdmin();
      if (kind === 'admin-edit') return saveAdminEdit();
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
      else if (f === 'from' || f === 'to') { // 직접 입력: 칸을 벗어나거나 Enter 를 누르면 YYYY-MM-DD 로 정리해 반영, 형식이 틀리면 오류 표시
        const r = readDate(`prayer-${f}`);
        if (r.ok) {
          S[f] = r.value;
          if (r.changed && r.value) say(`${f === 'from' ? '시작일' : '종료일'} ${r.value}로 입력했습니다.`);
        }
      }
      else if (f === 'from-native' || f === 'to-native') { // 달력에서 고른 날짜를 입력칸에 채움
        const name = f.replace('-native', '');
        const input = $(`#${el.dataset.target}`);
        input.value = el.value;
        S[name] = el.value;
        setDateError(el.dataset.target, '');
        say(`${name === 'from' ? '시작일' : '종료일'} ${el.value} 선택`);
        input.focus();
      }
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
