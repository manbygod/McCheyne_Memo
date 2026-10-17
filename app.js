'use strict';

/* ================= 설정 ================= */
const KEYS = { memos: 'mccheyne.memos.v1', labels: 'mccheyne.labels.v1', lang: 'mccheyne.lang', deleted: 'mccheyne.deleted.v1', labelsAt: 'mccheyne.labelsAt.v1' };
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

/** 터치 이동량 → 'prev'(오른쪽으로 쓸기) | 'next'(왼쪽으로 쓸기) | null. 가로로 충분히 길고 세로 스크롤과 구분될 때만 */
function swipeDirection(dx, dy, minDist = 60) {
  if (Math.abs(dx) < minDist || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx > 0 ? 'prev' : 'next';
}

const firstLine = (text) => {
  const lines = text.trim().split(/\r?\n/);
  return lines.length > 1 || lines[0].length > 60 ? `${lines[0].slice(0, 60)} ...` : lines[0];
};

const bookName = (book, lang) => (lang === 'en' ? book.en : book.ko);
const formatRef = (book, lang, chapter, verses) =>
  `${bookName(book, lang)} ${chapter}${verses?.length ? `:${compressRanges(verses)}` : ''}`;

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

/** 레이블 가나다순 (영문은 한글보다 앞) */
/** 목록에 없지만 메모에 붙어 있는 레이블을 목록에 더한다. 추가할 것이 없으면 같은 배열을 돌려준다. (순수 함수) */
function labelsWithMemos(labels, memos) {
  const known = new Set(labels);
  const extra = [];
  for (const m of memos) for (const l of m.labels) if (!known.has(l)) { known.add(l); extra.push(l); }
  return extra.length ? [...labels, ...extra] : labels;
}

/** 클라우드 레이블 문서({labels, updatedAt})가 쓸 만한 모양인지 */
const isLabelsDoc = (d) => !!d && Array.isArray(d.labels) && isIsoDate(d.updatedAt)
  && d.labels.length <= MEMO_LIMITS.labelList && d.labels.every((l) => typeof l === 'string' && l && l.length <= MEMO_LIMITS.label);

/**
 * 로컬·클라우드 레이블 목록을 병합 (순수 함수). 목록 전체를 updatedAt 이 최신인 쪽이 이긴다.
 * 돌려주는 at 은 채택한 목록의 시각, upload 는 클라우드에 올려야 하는지.
 */
function mergeLabels(local, localAt, remote, now) {
  if (!remote) return { labels: local, at: localAt || now, upload: true };
  if (remote.updatedAt > localAt) return { labels: remote.labels, at: remote.updatedAt, upload: false };
  return { labels: local, at: localAt, upload: localAt > remote.updatedAt };
}

const sortLabels = (labels) => [...labels].sort((a, b) => a.localeCompare(b, 'ko'));

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

/** 외부(가져오기·클라우드) 메모의 크기 상한. scripts/firestore.rules 와 맞춘다. */
const MEMO_LIMITS = { id: 128, text: 20000, labels: 50, labelList: 500, label: 100, passages: 50, verses: 200, date: 40 };

const isIsoDate = (s) => typeof s === 'string' && s.length <= MEMO_LIMITS.date && !Number.isNaN(Date.parse(s));
const isPassage = (p) => Number.isInteger(p.chapter) && p.chapter >= 1 && Array.isArray(p.verses)
  && p.verses.length >= 1 && p.verses.length <= MEMO_LIMITS.verses && p.verses.every((n) => Number.isInteger(n) && n >= 1);

/** 메모로 쓸 수 없는 이유 (문제가 없으면 null). 순수 함수 */
function memoProblem(m, hasBook) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return '메모 형식이 아님';
  if (typeof m.id !== 'string' || !m.id) return 'id 없음';
  if (m.id.length > MEMO_LIMITS.id || m.id.includes('/')) return 'id 형식 오류';
  if (typeof m.content !== 'string') return '내용(content) 없음';
  if (m.content.length > MEMO_LIMITS.text) return '내용이 너무 김';
  if (!Array.isArray(m.labels)) return '레이블 목록(labels) 없음';
  if (m.labels.length > MEMO_LIMITS.labels || m.labels.some((l) => typeof l !== 'string' || l.length > MEMO_LIMITS.label)) return '레이블 형식 오류';
  if (!isIsoDate(m.createdAt) || !isIsoDate(m.updatedAt)) return '작성·수정 일시 없음 또는 형식 오류';
  if (m.lang !== undefined && m.lang !== 'ko' && m.lang !== 'en') return '언어(lang) 값 오류';
  const ps = Array.isArray(m.passages) ? m.passages : [m];
  if (!ps.length) return '구절 정보 없음';
  if (ps.length > MEMO_LIMITS.passages) return '구절이 너무 많음';
  if (ps.some((p) => !p || typeof p !== 'object' || !hasBook(p.bookId))) return '알 수 없는 책(bookId)';
  if (ps.some((p) => !isPassage(p))) return '장·절 정보 오류';
  if (ps.some((p) => [p.text, p.passageText].some((t) => t !== undefined && (typeof t !== 'string' || t.length > MEMO_LIMITS.text)))) return '구절 본문 형식 오류';
  return null;
}

const isValidMemo = (m, hasBook) => memoProblem(m, hasBook) === null;

/**
 * 가져온 메모 목록을 현재 메모와 비교해 결과를 요약 (순수 함수).
 * 같은 id 는 updatedAt 이 더 최신인 쪽만 반영하고, 같거나 오래된 것은 '변경 없음'으로 센다.
 */
function summarizeImport(raw, existing, hasBook) {
  const problems = new Map();
  const valid = [];
  for (const m of raw) {
    const why = memoProblem(m, hasBook);
    if (why) problems.set(why, (problems.get(why) ?? 0) + 1);
    else valid.push(normalizeMemo(m));
  }
  const unique = mergeMemos([], valid); // 파일 안의 같은 id 는 최신 하나만
  const before = new Map(existing.map((m) => [m.id, m]));
  const merged = mergeMemos(existing, unique);
  const after = new Map(merged.map((m) => [m.id, m]));
  const added = unique.filter((m) => !before.has(m.id)).length;
  const updated = unique.filter((m) => before.has(m.id) && after.get(m.id) === m).length;
  return {
    total: raw.length, added, updated,
    unchanged: unique.length - added - updated,
    duplicates: valid.length - unique.length,
    invalid: [...problems],
    merged, ids: unique.map((m) => m.id),
  };
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
    '',
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

/** 그날 읽기표(트랙별 항목)의 장 목록 → 'bookId:chapter' 키 집합 (chapter2가 있으면 범위 전체) */
function readingChapterKeys(day) {
  const keys = new Set();
  for (const r of [].concat(day).flat().filter(Boolean).map(normalizeReading)) {
    for (let ch = r.chapter; ch <= (r.chapter2 ?? r.chapter); ch++) keys.add(`${r.book}:${ch}`);
  }
  return keys;
}

/** 그날 읽기표의 장에 말씀이 하나라도 걸린 메모, 수정일 최신순 */
const memosForReadings = (memos, day) => {
  const keys = readingChapterKeys(day);
  return memos
    .filter((m) => m.passages.some((p) => keys.has(`${p.bookId}:${p.chapter}`)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

/** 선택한 날짜의 읽기표 장들에 기록된 메모 */
const memosOfDay = (iso) => memosForReadings(state.memos, state.plan.days[planKey(iso, state.plan)] ?? []);

/** 문장을 maxWidth 안에 들어가도록 줄바꿈 (공백 우선, 공백이 없으면 글자 단위). measure(text) → 너비 */
function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    let lastSpace = -1;
    for (const ch of para) {
      if (line && measure(line + ch) > maxWidth) {
        if (ch !== ' ' && lastSpace > 0) {
          lines.push(line.slice(0, lastSpace).trimEnd());
          line = line.slice(lastSpace + 1);
        } else {
          lines.push(line);
          line = '';
        }
        lastSpace = -1;
        if (ch === ' ') continue;
      }
      if (ch === ' ') lastSpace = line.length;
      line += ch;
    }
    lines.push(line);
  }
  return lines;
}

/** 카드(줄 목록 {lh}[])들을 페이지에 배치. 한 페이지에 안 들어가는 카드는 줄 단위로 나눠 다음 페이지로 이어 감 */
function paginateCards(cards, { firstTop, top, bottom, pad = 14, gap = 12 }) {
  const pages = [[]];
  let y = firstTop;
  for (const card of cards) {
    let rest = card;
    while (rest.length) {
      const avail = bottom - y - 2 * pad;
      let n = 0;
      let used = 0;
      while (n < rest.length && used + rest[n].lh <= avail) used += rest[n++].lh;
      if (n === 0) {
        if (y !== top) { pages.push([]); y = top; continue; }
        n = 1;
        used = rest[0].lh;
      }
      pages.at(-1).push({ y, h: used + 2 * pad, items: rest.slice(0, n) });
      y += used + 2 * pad + gap;
      rest = rest.slice(n);
      if (rest.length) { pages.push([]); y = top; }
    }
  }
  return pages;
}

/** 페이지 내용(그리기 명령)과 내장 글꼴로 PDF 파일 바이트 생성 (외부 라이브러리 없이).
 *  contents: 페이지별 내용 스트림 문자열. fnt: {font: 글꼴 지표, used: Map(글리프 번호→글자), fontFile: 잘라낸 TTF, packed: deflate한 TTF|null, title}.
 *  글꼴은 CIDFontType2 + Identity-H(글자코드=글리프 번호)로 내장하고, ToUnicode로 복사·검색·스크린리더 낭독에 쓰일 글자를 알려 준다. */
function buildPdf(contents, fnt, pageW = 595, pageH = 842) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;
  const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); len += b.length; };
  const begin = (n) => { offsets[n] = len; push(`${n} 0 obj\n`); };
  const stream = (n, dict, body) => {
    const bytes = typeof body === 'string' ? enc.encode(body) : body;
    begin(n); push(`<< ${dict} /Length ${bytes.length} >>\nstream\n`); push(bytes); push('\nendstream\nendobj\n');
  };
  const { font, used, fontFile, packed, title } = fnt;
  const font0 = 3 + 2 * contents.length; // 글꼴 객체: Type0, CIDFont, FontDescriptor, FontFile2, ToUnicode, Info
  push('%PDF-1.5\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R /Lang (ko-KR) /ViewerPreferences << /DisplayDocTitle true >> >>\nendobj\n');
  begin(2);
  push(`<< /Type /Pages /Count ${contents.length} /Kids [${contents.map((_, i) => `${3 + 2 * i} 0 R`).join(' ')}] >>\nendobj\n`);
  contents.forEach((content, i) => {
    begin(3 + 2 * i);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${font0} 0 R >> >> /Contents ${4 + 2 * i} 0 R >>\nendobj\n`);
    stream(4 + 2 * i, '', content);
  });
  const scale = 1000 / font.upm;
  const gids = [...used.keys()].sort((a, b) => a - b);
  begin(font0);
  push(`<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansKR /Encoding /Identity-H /DescendantFonts [${font0 + 1} 0 R] /ToUnicode ${font0 + 4} 0 R >>\nendobj\n`);
  begin(font0 + 1);
  push(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansKR /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${font0 + 2} 0 R /DW 1000 /W [${gids.map((g) => `${g} [${Math.round(font.adv[g] * scale)}]`).join(' ')}] /CIDToGIDMap /Identity >>\nendobj\n`);
  begin(font0 + 2);
  push(`<< /Type /FontDescriptor /FontName /NotoSansKR /Flags 4 /FontBBox [${font.bbox.map((v) => Math.round(v * scale)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(font.ascent * scale)} /Descent ${Math.round(font.descent * scale)} /CapHeight ${Math.round(font.capHeight * scale)} /StemV 80 /FontFile2 ${font0 + 3} 0 R >>\nendobj\n`);
  stream(font0 + 3, packed ? `/Filter /FlateDecode /Length1 ${fontFile.length}` : `/Length1 ${fontFile.length}`, packed ?? fontFile);
  const bf = gids.filter((g) => used.get(g));
  let cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
  for (let i = 0; i < bf.length; i += 100) {
    const part = bf.slice(i, i + 100);
    cmap += `${part.length} beginbfchar\n${part.map((g) => `<${hex4(g)}> <${utf16Hex(used.get(g))}>`).join('\n')}\nendbfchar\n`;
  }
  cmap += 'endcmap CMapName currentdict /CMap defineresource pop end end';
  stream(font0 + 4, '', cmap);
  begin(font0 + 5);
  push(`<< /Title <FEFF${utf16Hex(title)}> /Producer (McCheyne) >>\nendobj\n`);
  const count = font0 + 6;
  const xref = len;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${font0 + 5} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

/** 오늘의 말씀묵상 공유용 텍스트: 날짜 머리말 + 메모별 공유 텍스트(말씀·묵상) */
function meditationToShareText(memos, iso, passageRef) {
  const date = new Date(`${iso}T00:00`).toLocaleDateString('ko-KR', { dateStyle: 'full' });
  const rule = '══════════════';
  return [`🙏 오늘의 말씀묵상\n${date}`, ...memos.map((m) => memoToShareText(m, passageRef))].join(`\n\n${rule}\n\n`);
}

const memosToText =(memos, passageRef) => memos.map((m) => memoToText(m, passageRef)).join('\n\n----------------------------------------\n\n');

/* ================= 상태 ================= */
const state = {
  books: [], plan: null, labels: [], memos: [], tombstones: {}, remote: null, auth: null, user: null,
  lang: 'ko', date: toISODate(), query: '', page: 1,
  origin: 'today', // 본문 화면이 어디서 열렸는지 ('today' | 'bible') — 이전/다음 끝에서 돌아갈 곳과 메뉴 강조에 사용
  bible: { bookId: null, ch: 1 }, // 성경 화면에서 고른(또는 마지막으로 읽은) 책·장
  chapter: null, // {bookId, ch, verses:[{n,text}]}
  selected: new Set(),
  find: '', // 본문 내 검색어
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

/** 레이블 관리 팝업의 경고: 모달 뒤에 가려지는 토스트 대신 팝업 안에 눈에 보이게 표시 (스크린리더용은 toast 가 상태 영역에 알림) */
function warnLabel(msg) {
  const notice = $('#labels-notice');
  notice.textContent = msg;
  notice.hidden = false;
  toast(msg);
  $('#label-input').focus();
}

let toastTimer;
let toastFillTimer;
let dialogStatusTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = ''; // 라이브 영역을 비웠다가 채워야 같은 문구가 연속돼도 스크린리더가 다시 읽는다
  clearTimeout(toastFillTimer);
  toastFillTimer = setTimeout(() => { t.textContent = msg; }, 50);
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
      getLabels: async () => { const snap = await fs.getDoc(fs.doc(db, 'users', user.uid, 'meta', 'labels')); return snap.exists() ? snap.data() : null; },
      saveLabels: (doc) => fs.setDoc(fs.doc(db, 'users', user.uid, 'meta', 'labels'), doc), // 빈 레이블까지 포함한 목록 전체
      save: (doc) => fs.setDoc(fs.doc(col, doc.id), doc), // 메모 또는 삭제 기록({id, deletedAt}) 한 문서
    };
    renderAuth();
    await syncRemote();
  });
}

const persistMemos = () => writeJSON(KEYS.memos, state.memos);
const persistTombs = () => writeJSON(KEYS.deleted, state.tombstones);
/** 레이블 목록 저장. touch 면 변경 시각을 갱신하고 클라우드에도 올린다 (메모에서 파생된 보충은 touch 하지 않음) */
function persistLabels(touch = true) {
  writeJSON(KEYS.labels, state.labels);
  if (!touch) return;
  state.labelsAt = new Date().toISOString();
  writeJSON(KEYS.labelsAt, state.labelsAt);
  remoteCall((r) => r.saveLabels({ labels: state.labels, updatedAt: state.labelsAt }));
}

/** 메모에 쓰인 레이블을 목록에 반영 (다른 기기·원격 메모의 레이블이 이 기기 목록에 없을 때) */
function syncLabelsFromMemos() {
  const next = labelsWithMemos(state.labels, state.memos);
  if (next !== state.labels) { state.labels = next; persistLabels(false); }
}
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
  if (!state.remote) return null;
  try {
    const docs = await state.remote.list();
    const remoteTombs = Object.fromEntries(docs.filter((d) => d.deletedAt).map((d) => [d.id, d.deletedAt]));
    const r = reconcile(state.memos, state.tombstones, cleanMemos(docs.filter((d) => !d.deletedAt)), remoteTombs);
    state.memos = r.memos;
    state.tombstones = r.tombstones;
    const remoteLabels = await state.remote.getLabels();
    const lm = mergeLabels(state.labels, state.labelsAt, isLabelsDoc(remoteLabels) ? remoteLabels : null, new Date().toISOString());
    state.labels = lm.labels;
    state.labelsAt = lm.at;
    writeJSON(KEYS.labelsAt, state.labelsAt);
    syncLabelsFromMemos();
    persistMemos();
    persistTombs();
    await Promise.all([
      ...(lm.upload ? [state.remote.saveLabels({ labels: lm.labels, updatedAt: lm.at })] : []),
      ...r.toUpload.map((m) => state.remote.save(m)),
      ...r.toTomb.map((id) => state.remote.save({ id, deletedAt: r.tombstones[id] })),
    ]);
    refreshViews();
    toast('클라우드와 동기화했습니다.');
    return true;
  } catch { toast('클라우드 동기화 실패 (이 기기에는 저장됨)'); return false; }
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
  if (parts[0] === 'read' && bookById(parts[1])) return { name: 'reader', bookId: parts[1], ch: Number(parts[2]) || 1, verse: Number(parts[3]) || null };
  if (parts[0] === 'memos') return { name: 'memos' };
  if (parts[0] === 'bible') return { name: 'bible' };
  return { name: 'today' };
}

const setPageTitle = (name) => { document.title = `${name} · 맥체인 성경읽기`; };

async function route() {
  const r = parseRoute();
  for (const v of ['today', 'reader', 'memos', 'bible']) $(`#view-${v}`).hidden = v !== r.name;
  if (r.name === 'today') setPageTitle('오늘의 읽기');
  else if (r.name === 'memos') setPageTitle('메모');
  else if (r.name === 'bible') setPageTitle('성경 읽기');
  if (r.name !== 'reader') state.origin = r.name === 'bible' ? 'bible' : 'today';
  const navRoute = r.name === 'reader' ? state.origin : r.name;
  document.querySelectorAll('.nav-link').forEach((a) => {
    if (a.dataset.route === navRoute) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (r.name === 'today') renderToday();
  else if (r.name === 'memos') renderMemos();
  else if (r.name === 'bible') renderBible();
  else await renderReader(r.bookId, r.ch, r.verse);
}

/* ================= 오늘의 읽기 ================= */
/** 날짜 이동 뒤 바뀐 날짜를 스크린리더에 알림 (포커스는 이동 버튼에 남아 있어 목록만으로는 날짜를 알 수 없음) */
function announceDay() {
  $('#day-status').textContent = `${new Date(`${state.date}T00:00`).toLocaleDateString('ko-KR', { dateStyle: 'full' })} 읽기`;
}

function renderToday() {
  $('#date-input').value = state.date;
  const day = state.plan.days[planKey(state.date, state.plan)] ?? [];
  $('#plan-note').textContent = state.plan.source ? '' : '※ 읽기표는 맥체인 4트랙 구조를 따른 근사값입니다. (README 참고)';
  mount($('#reading-list'), state.plan.tracks.map((_, i) => {
    const refs = [].concat(day[i] ?? []).map(normalizeReading); // 트랙 항목: 단일 객체 또는 배열
    return h('li', { class: 'reading-list__item' },
      refs.length
        ? h('div', { class: 'reading-list__links' }, refs.map((r) =>
          h('a', { class: 'btn', lang: state.lang, href: `#/read/${r.book}/${r.chapter}` }, formatReading(r, bookById(r.book), state.lang))))
        : h('span', { class: 'reading-list__empty' }, '여유일 (밀린 본문 읽기)'));
  }));
}

/* ================= 성경 (책·장 직접 선택) ================= */
function fillChapterSelect(bookId, ch) {
  const sel = $('#bible-chapter');
  mount(sel, Array.from({ length: bookById(bookId).chapters }, (_, i) => h('option', { value: i + 1 }, `${i + 1}장`)));
  sel.value = ch;
}

function renderBible() {
  const b = state.bible;
  if (!b.bookId) b.bookId = state.books[0].id;
  fillBookSelect(state.lang, b.bookId, $('#bible-book'));
  fillChapterSelect(b.bookId, b.ch);
}

/* ================= 본문 보기/구절 선택 ================= */
async function renderReader(bookId, ch, verse = null) {
  const book = bookById(bookId);
  state.bible = { bookId, ch }; // 성경 메뉴로 돌아오면 마지막으로 읽은 곳이 선택되어 있도록
  state.selected.clear();
  lastClicked = null; // 다른 장의 절에서 Shift 범위 선택이 이어지지 않도록
  rangeStart = null;
  $('#selection-status').textContent = ''; // 장을 옮길 때는 "선택 해제됨"을 읽지 않음
  updateSelectionBar();
  mount($('#reader-title'), h('span', { lang: state.lang }, bookName(book, state.lang)), ` ${ch}장`);
  setPageTitle($('#reader-title').textContent);
  $('#passage').lang = state.lang;
  $('#reader-note').textContent = '';
  state.find = ''; // 장이 바뀌면 검색 초기화
  $('#find-input').value = '';
  $('#find-status').textContent = '';
  const home = state.origin === 'bible' ? '#/bible' : '#/'; // 첫 장 이전/마지막 장 다음은 읽던 목록으로
  const prev = ch > 1 ? `#/read/${bookId}/${ch - 1}` : home;
  const next = ch < book.chapters ? `#/read/${bookId}/${ch + 1}` : home;
  $('#reader-prev').href = prev;
  $('#reader-next').href = next;
  const chapterName = (n) => `${bookName(book, state.lang)} ${n}장`;
  $('#reader-prev').setAttribute('aria-label', ch > 1 ? `이전 장, ${chapterName(ch - 1)}` : '이전, 읽던 목록으로');
  $('#reader-next').setAttribute('aria-label', ch < book.chapters ? `다음 장, ${chapterName(ch + 1)}` : '다음, 읽던 목록으로');
  $('#reader-arrow-prev').href = prev;
  $('#reader-arrow-next').href = next;
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
  if (verse) { // 메모의 본문 버튼으로 왔을 때: 첫 구절로 스크롤하고 포커스
    const btn = document.querySelector(`.verse[data-verse="${verse}"] .verse__text`);
    btn?.focus();
    btn?.scrollIntoView({ block: 'center' });
  }
}

/** 순수 함수: 본문을 검색어 기준으로 [{text, hit}] 조각으로 나눔 (대소문자 무시) */
function splitByQuery(text, query) {
  if (!query) return [{ text, hit: false }];
  const parts = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, i)) {
    if (at > i) parts.push({ text: text.slice(i, at), hit: false });
    parts.push({ text: text.slice(at, at + q.length), hit: true });
    i = at + q.length;
  }
  if (i < text.length) parts.push({ text: text.slice(i), hit: false });
  return parts;
}

/** 순수 함수: 검색어가 들어 있는 절 번호 목록 */
const findVerses = (verses, query) =>
  query ? verses.filter((v) => v.text && v.text.toLowerCase().includes(query.toLowerCase())).map((v) => v.n) : [];

const verseTextNodes = (text) =>
  splitByQuery(text, state.find).map((p) => (p.hit ? h('mark', { class: 'verse__mark' }, p.text) : p.text));

/** 이 장에서 단어 검색: 음영 표시 + 첫 결과 절로 포커스, 없으면 팝업 */
function searchChapter(query, { live = false } = {}) {
  if (!state.chapter) return;
  state.find = query.trim();
  renderPassage();
  const status = $('#find-status');
  if (!state.find) { status.textContent = '검색을 해제했습니다.'; return; }
  const hits = findVerses(state.chapter.verses, state.find);
  if (!hits.length) {
    status.textContent = live ? '찾은 결과가 없습니다.' : ''; // 입력 중에는 팝업이 입력을 끊지 않도록 안내만
    if (live) return;
    $('#notice-dialog-title').textContent = '검색 결과 없음';
    $('#notice-text').textContent = `이 장에서 "${state.find}"을(를) 찾을 수 없습니다.`;
    $('#notice-dialog').showModal();
    return;
  }
  status.textContent = `${hits.length}개 절에서 찾았습니다. 첫 결과는 ${hits[0]}절입니다.`;
  const btn = document.querySelector(`.verse[data-verse="${hits[0]}"] .verse__text`);
  if (!live) btn?.focus(); // 입력 중에는 포커스를 옮기지 않고 스크롤만
  btn?.scrollIntoView({ block: 'center' });
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
        ? h('button', { type: 'button', class: 'verse__badge', 'data-action': 'verse-memos', 'data-verse': v.n, title: `메모 ${count}개`, 'aria-label': `${v.n}절에 연결된 메모 ${count}개 보기` },
          v.n, count > 1 && h('sup', { class: 'verse__count', 'aria-hidden': 'true' }, count)) // 2개 이상일 때만 표시, aria-label 로 읽히므로 중복 낭독 방지
        : h('span', { class: 'verse__num', 'aria-hidden': 'true' }, v.n), // 절 번호는 아래 버튼 안의 숨김 텍스트로 읽음
      h('button', { type: 'button', class: 'verse__text', 'aria-pressed': String(on) },
        h('span', { class: 'visually-hidden', lang: state.lang }, state.lang === 'en' ? `Verse ${v.n}. ` : `${v.n}절 `), // 포커스만 옮겨도 절 번호가 들리도록 버튼 이름에 포함
        verseTextNodes(v.text)));
  }));
  updateJumpButtons(); // 본문 길이가 정해진 뒤 버튼 표시 여부 갱신
  const rangeEnd = $('#range-end');
  rangeEnd.lang = state.lang;
  mount(rangeEnd, verses.filter((v) => v.text).map((v) => h('option', { value: v.n }, state.lang === 'en' ? `To ${v.n}` : `${v.n}절까지`)));
}

/** 절 번호 배지 클릭: 그 절에 연결된 메모를 모두 보여 줌 */
function openVerseMemos(n) {
  const { bookId, ch } = state.chapter;
  const list = [...(memosByVerse(state.memos, bookId, ch).get(n) ?? [])].sort(byUpdatedDesc);
  showMemosDialog(formatRef(bookById(bookId), state.lang, ch, [n]), list);
}

/** 이 장에 연결된 메모 전체 팝업 (없으면 안내) */
function openChapterMemos() {
  const { bookId, ch } = state.chapter;
  const ref = formatRef(bookById(bookId), state.lang, ch);
  const list = [...new Set([...memosByVerse(state.memos, bookId, ch).values()].flat())].sort(byUpdatedDesc);
  if (!list.length) {
    $('#notice-dialog-title').textContent = '메모 없음';
    $('#notice-text').replaceChildren(h('span', { lang: state.lang }, ref), '에 기록된 메모가 없습니다.'); // 책 이름만 해당 언어로 낭독
    $('#notice-dialog').showModal();
    return;
  }
  showMemosDialog(ref, list);
}

/** 순수 함수: 말씀의 본문 링크 (장 이동 + 첫 구절로 스크롤) */
const passageHref = (p) => `#/read/${p.bookId}/${p.chapter}/${Math.min(...p.verses)}`;

/** 메모 카드의 '본문' 링크. 연결된 장이 둘 이상이면 눌렀을 때 장을 고르는 팝업이 열린다 */
const passageLink = (m) => h('a', {
  class: 'btn', href: passageHref(m.passages[0]), 'data-action': 'passage-open',
  'aria-label': `${refOf(m)} 본문 보기`, ...(m.passages.length > 1 && { 'aria-haspopup': 'dialog' }),
}, '본문');

/** 연결된 장 선택 팝업 */
function openPassagePicker(m) {
  mount($('#passage-pick-list'), m.passages.map((p) =>
    h('a', { class: 'btn', lang: m.lang, href: passageHref(p), 'data-action': 'passage-go' }, passageRef(m, p))));
  $('#passage-pick-dialog').showModal();
  $('#passage-pick-list a').focus(); // 첫 선택지에서 바로 듣고 고를 수 있도록
}

function showMemosDialog(ref, list) {
  $('#verse-memos-title').replaceChildren(h('span', { lang: state.lang }, ref), ` · 메모 ${list.length}개`);
  mount($('#verse-memos-list'), list.map((m) => h('article', { class: 'verse-memo', 'data-id': m.id },
    h('p', { class: 'read__text' }, memoNodes(m)),
    h('div', { class: 'form__actions form__actions--start' },
      passageLink(m),
      h('button', { type: 'button', class: 'btn', 'data-action': 'memo-edit', 'aria-label': `${refOf(m)} 메모 수정` }, '수정'),
      h('button', { type: 'button', class: 'btn', 'data-action': 'memo-share', 'aria-label': `${refOf(m)} 메모 공유` }, '공유'),
      h('button', { type: 'button', class: 'btn btn--danger', 'data-action': 'memo-delete', 'aria-label': `${refOf(m)} 메모 삭제` }, '삭제')))));
  moveDialog($('#verse-memos-dialog'), 0, 0);
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
  renderSelection();
}

/** 선택 상태(state.selected)를 절의 클래스·aria-pressed 와 선택 바에 반영 (클래스만 바꿈) */
function renderSelection() {
  document.querySelectorAll('.verse').forEach((el) => {
    const on = state.selected.has(Number(el.dataset.verse));
    el.classList.toggle('verse--selected', on);
    el.querySelector('.verse__text').setAttribute('aria-pressed', String(on));
  });
  updateSelectionBar();
}

/** 범위 선택 상자: 포커스를 받을 때의 선택(base)과 기준 절(anchor)을 기억해 두고, 끝 절을 바꿀 때마다 base + anchor~끝 절로 다시 계산 (방향키로 오가도 지나친 절이 남지 않음) */
let rangeStart = null;
function snapshotRange() {
  rangeStart = state.selected.size ? { anchor: lastClicked ?? Math.max(...state.selected), base: new Set(state.selected) } : null;
}

function startRange() {
  snapshotRange();
  if (rangeStart) $('#range-end').value = rangeStart.anchor; // 현재 값과 다른 항목을 골라야 변경 이벤트가 생기므로 기준 절로 맞춤
}

function applyRangeEnd(end) {
  if (!rangeStart) snapshotRange(); // 포커스 이벤트 없이 값만 바뀐 경우 대비
  if (!rangeStart || !end) return;
  const { anchor, base } = rangeStart;
  state.selected.clear();
  base.forEach((n) => state.selected.add(n));
  for (let i = Math.min(anchor, end); i <= Math.max(anchor, end); i++) state.selected.add(i);
  renderSelection();
}

function updateSelectionBar() {
  const bar = $('#selection-bar');
  bar.hidden = state.selected.size === 0;
  const status = $('#selection-status'); // 항상 화면에 있는 알림 영역 (숨겨진 바 안의 live region은 읽히지 않을 수 있음)
  if (!bar.hidden && state.chapter) {
    const ref = formatRef(bookById(state.chapter.bookId), state.lang, state.chapter.ch, [...state.selected]);
    $('#selection-info').textContent = ref;
    $('#selection-info').lang = state.lang;
    const rangeSel = $('#range-end');
    if (document.activeElement !== rangeSel) rangeSel.value = lastClicked ?? Math.max(...state.selected); // 선택 바에 보이는 값을 기준 절에 맞춤
    status.textContent = `${ref} 선택됨`;
  } else status.textContent = status.textContent.endsWith('선택됨') ? '선택 해제됨' : '';
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

/** 하루치 읽기표 → [{bookId, chapter(첫 장)}] (책 중복 제거, 읽기표 순서 유지) */
function todayBookChapters(day) {
  const seen = new Map();
  for (const r of day.flatMap((t) => [].concat(t ?? [])).map(normalizeReading)) {
    if (!seen.has(r.book)) seen.set(r.book, r.chapter);
  }
  return [...seen].map(([bookId, chapter]) => ({ bookId, chapter }));
}

const todayPicks = () => todayBookChapters(state.plan.days[planKey(state.date, state.plan)] ?? [])
  .filter((p) => bookById(p.bookId));

function fillBookSelect(lang, bookId, sel = $('#add-book'), withToday = false) {
  const group = (label, tt) => h('optgroup', { label },
    state.books.filter((b) => b.testament === tt).map((b) => h('option', { value: b.id }, bookName(b, lang))));
  const picks = withToday ? todayPicks() : [];
  const today = picks.length
    ? [h('optgroup', { label: lang === 'en' ? "Today's reading" : '오늘 읽기' },
      picks.map((p) => h('option', { value: p.bookId }, bookName(bookById(p.bookId), lang))))]
    : [];
  mount(sel, ...today, group(lang === 'en' ? 'Old Testament' : '구약', 'OT'), group(lang === 'en' ? 'New Testament' : '신약', 'NT'));
  sel.value = bookId;
}

let pickerToken = 0;
/** 책·장·절 선택기를 채우고 선택한 구절 본문을 미리보기로 표시. 연속 호출 시 마지막 호출만 반영 */
async function syncPicker({ chapter, verse } = {}) {
  const token = ++pickerToken;
  const bookId = $('#add-book').value;
  const book = bookById(bookId);
  const chSel = $('#add-chapter');
  mount(chSel, optionsOf(Array.from({ length: book.chapters }, (_, i) => i + 1), (n) => `${n}장`)); // 라벨을 숨겼으므로 항목에 단위 표기
  chSel.value = Math.min(Math.max(Number(chapter ?? chSel.value) || 1, 1), book.chapters);

  let verses = null;
  try { verses = await loadChapter(bookId, Number(chSel.value), state.draft.lang); } catch { /* 아래에서 안내 */ }
  if (token !== pickerToken) return;
  const vSel = $('#add-verse');
  const readable = (verses ?? []).filter((v) => v.text);
  mount(vSel, optionsOf(readable.map((v) => v.n), (n) => `${n}절`));
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
  fillBookSelect(draft.lang, last.bookId, $('#add-book'), true);
  syncPicker({ chapter: last.chapter, verse: Math.min(...last.verses) });
  renderDraft();
  moveDialog($('#memo-dialog'), 0, 0);
  $('#memo-dialog').showModal();
  $('#memo-content').focus();
}

const draftRef = (d, p) => formatRef(bookById(p.bookId), d.lang, p.chapter, [...p.verses]);

/** 메모 작성 팝업이 열려 있을 때, 화면에서 체크한 레이블을 draft에 반영 (레이블 목록을 다시 그려도 체크가 유지되도록) */
const memoDialogOpen = () => Boolean(state.draft) && $('#memo-dialog').open;
function syncDraftLabels(extra) {
  if (!memoDialogOpen()) return;
  state.draft.labels = new Set([...document.querySelectorAll('#memo-labels input:checked')].map((i) => i.value));
  if (extra) state.draft.labels.add(extra);
}

function renderDraft() {
  const d = state.draft;
  $('#memo-ref').textContent = d.passages.length ? d.passages.map((p) => draftRef(d, p)).join('; ') : '선택된 말씀이 없습니다.';
  mount($('#memo-passages'), d.passages.map((p, pi) => {
    const nums = [...p.verses].sort((a, b) => a - b);
    return h('li', { class: 'memo-passage' },
      h('div', { class: 'memo-passage__head' },
        h('strong', {}, draftRef(d, p)),
        h('div', { class: 'memo-passage__actions' },
          h('button', { type: 'button', class: 'btn btn--danger', 'data-action': 'passage-remove', 'data-pi': pi, 'aria-label': `${draftRef(d, p)} 삭제` }, '삭제'),
          h('button', { type: 'button', class: 'btn', 'data-action': 'passage-view', 'data-pi': pi, 'aria-label': `${draftRef(d, p)} 말씀 보기` }, '보기'))),
      nums.length <= 15 && h('ul', { class: 'chips', 'aria-label': '절' }, nums.map((n) =>
        h('li', {}, h('button', { type: 'button', class: 'chip', 'data-action': 'verse-remove', 'data-pi': pi, 'data-verse': n, 'aria-label': `${n}절 제거` }, `${n}절 ×`)))));
  }));
  mount($('#memo-labels'), sortLabels(state.labels).map((label, i) => {
    const id = `memo-label-${i}`;
    return h('span', {},
      h('label', { class: 'check', for: id },
        h('input', { type: 'checkbox', id, name: 'label', value: label, checked: d.labels.has(label) }), label));
  }));
}

/** 메모에 담긴 말씀의 장 전체를 팝업으로 보여 줌 (메모에 연결된 절은 강조) */
async function openPassageView(p) {
  const d = state.draft;
  const dialog = $('#passage-view-dialog');
  let verses = null;
  try { verses = await loadChapter(p.bookId, p.chapter, d.lang); } catch { /* 아래에서 안내 */ }
  $('#passage-view-title').lang = d.lang; // 책 이름이 메모 언어로 표기되므로 올바른 음성으로 낭독
  $('#passage-view-title').textContent = formatRef(bookById(p.bookId), d.lang, p.chapter, []);
  mount($('#passage-view-body'), verses
    ? verses.filter((v) => v.text).map((v) => {
      const on = p.verses.has(v.n);
      return h('p', { class: `passage-view__verse${on ? ' passage-view__verse--linked' : ''}`, lang: d.lang, 'data-n': v.n },
        h('span', { class: 'passage-view__num' }, v.n),
        on && h('span', { class: 'visually-hidden' }, d.lang === 'en' ? ' (linked) ' : ' (연결된 절) '),
        ' ', v.text);
    })
    : h('p', {}, '본문을 불러오지 못했습니다.'));
  moveDialog(dialog, 0, 0);
  dialog.showModal();
  $('#passage-view-body').querySelector('.passage-view__verse--linked')?.scrollIntoView({ block: 'center' });
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
  return { searching, list: [...list].sort(byUpdatedDesc) };
};

function renderMemos() {
  const { searching, list } = visibleMemos();
  $('#memos-summary').textContent = searching
    ? `검색 결과 ${list.length}건 (수정일 최신순)`
    : `전체 ${list.length}건 (수정일 최신순)`;
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
    // 카드 전체가 눌리는 영역(::after로 확장)이면서, 키보드·스크린리더용 "읽기" 버튼 역할
    h('h3', { class: 'memo-card__ref' },
      h('button', { type: 'button', class: 'memo-card__open', lang: m.lang, 'data-action': 'memo-read', 'aria-label': `${refOf(m)} 메모 읽기` }, refOf(m))),
    memoPassagesText(m) && h('p', { class: 'memo-card__verse', lang: m.lang }, full ? memoPassagesText(m) : firstLine(memoPassagesText(m))),
    h('p', { class: 'memo-card__body' }, full ? m.content : firstLine(m.content)));
}

function confirmDelete(m) {
  if (window.confirm(`이 메모를 삭제할까요?\n\n${refOf(m)}\n${firstLine(m.content)}`)) {
    deleteMemo(m.id);
    route(); // 메모 화면이면 목록, 본문 화면이면 절 배지까지 갱신
    toast('삭제했습니다.');
    focusFirst('#board button', '#search-input');
  }
}

function editMemo(m) {
  openMemoDialog({
    id: m.id, lang: m.lang, content: m.content, labels: new Set(m.labels),
    passages: m.passages.map((p) => ({ bookId: p.bookId, chapter: p.chapter, verses: new Set(p.verses) })),
  });
}

/** memoToText 와 같은 내용이되, 말씀 부분에만 메모의 언어(lang)를 표시 — 스크린리더가 올바른 음성으로 읽도록 */
function memoNodes(m) {
  const blocks = passageBlocks(m, passageRef);
  return [h('span', { lang: m.lang }, blocks), memoToText(m, passageRef).slice(blocks.length)];
}

/** 읽기 팝업: PDF 저장·TXT와 같은 내용 */
function openReadDialog(m) {
  mount($('#read-text'), memoNodes(m));
  $('#read-dialog').dataset.id = m.id;
  moveDialog($('#read-dialog'), 0, 0);
  const link = $('#read-passage');
  link.href = passageHref(m.passages[0]);
  if (m.passages.length > 1) link.setAttribute('aria-haspopup', 'dialog');
  else link.removeAttribute('aria-haspopup');
  $('#read-dialog').showModal();
}

/** 읽기 팝업 버튼: 팝업을 닫고 해당 메모에 동작 적용 */
function withReadMemo(el, fn) {
  const dialog = el.closest('dialog');
  const m = state.memos.find((x) => x.id === dialog.dataset.id);
  dialog.close();
  if (m) fn(m);
}

/* ================= 공유 / 다운로드 ================= */
async function shareMemo(m) {
  await shareText(memoToShareText(m, passageRef));
}

/** 텍스트 공유 시트로 보내고, 지원하지 않으면 클립보드에 복사 */
async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copyText(text, '공유 기능이 없어 클립보드에 복사했습니다.');
}

/* ---- 오늘의 말씀묵상 카드 PDF (Noto Sans KR 부분집합을 PDF에 내장한 텍스트 PDF) ---- */
const CARD_PDF = { w: 595, h: 842, margin: 36, pad: 14,
  c: { bg: '#faf8f4', card: '#ffffff', border: '#ddd6c8', text: '#222222', muted: '#666666', primary: '#2f5d50', verse: '#f3efe4' } };

let pdfFontPromise = null;
/** fonts/ 의 Noto Sans KR 부분집합(글리프 지표 JSON + TTF)을 한 번만 불러온다. 형식이 맞지 않으면 오류 */
function loadPdfFont() {
  pdfFontPromise ??= Promise.all([
    fetch('fonts/NotoSansKR-subset.json').then((r) => { if (!r.ok) throw new Error('글꼴 지표를 불러오지 못했습니다.'); return r.json(); }),
    fetch('fonts/NotoSansKR-subset.ttf').then((r) => { if (!r.ok) throw new Error('글꼴 파일을 불러오지 못했습니다.'); return r.arrayBuffer(); }),
  ]).then(([meta, ttf]) => {
    const ok = meta && Number.isFinite(meta.upm) && Array.isArray(meta.adv) && meta.map && typeof meta.map === 'object' && Array.isArray(meta.bbox);
    if (!ok) throw new Error('글꼴 지표 형식이 올바르지 않습니다.');
    return { meta, ttf: new Uint8Array(ttf) };
  }).catch((e) => { pdfFontPromise = null; throw e; });
  return pdfFontPromise;
}

/** 글꼴에 없는 글자 정리: 이모지·결합 부호는 빼고, 그 밖의 없는 글자는 '?'로 바꾼다 (글꼴에 있는 글자만 PDF에 쓸 수 있음) */
function pdfSafeText(meta, text) {
  let out = '';
  for (const ch of String(text).replace(/\t/g, ' ').replace(/\r/g, '')) {
    if (ch === '\n' || meta.map[ch.codePointAt(0)] !== undefined) out += ch;
    else if (!/[\p{Extended_Pictographic}\p{M}\p{Cf}\p{Cc}]/u.test(ch)) out += '?';
  }
  return out;
}

const glyphOf = (meta, ch) => meta.map[ch.codePointAt(0)] ?? 0;

/** 글자 크기 size(px)로 쓸 때의 너비 */
function textWidth(meta, text, size) {
  let units = 0;
  for (const ch of text) units += meta.adv[glyphOf(meta, ch)] ?? 0;
  return (units / meta.upm) * size;
}

/** 쓰인 글자의 글리프 번호 → 유니코드 글자 (글꼴 잘라내기·ToUnicode용) */
function usedGlyphs(meta, texts) {
  const used = new Map([[0, '']]);
  for (const t of texts) for (const ch of t) used.set(glyphOf(meta, ch), ch);
  return used;
}

const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();
const pdfNum = (n) => String(Math.round(n * 100) / 100);
const pdfRgb = (css) => [1, 3, 5].map((i) => pdfNum(parseInt(css.slice(i, i + 2), 16) / 255)).join(' ');
const utf16Hex = (t) => Array.from({ length: t.length }, (_, i) => hex4(t.charCodeAt(i))).join('');

/** TrueType 글꼴에서 쓰인 글리프만 남긴 새 글꼴 바이트 (글리프 번호는 그대로 — 안 쓰는 글리프는 빈 윤곽) */
function subsetTtf(ttf, used) {
  const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const tables = {};
  for (let i = 0; i < dv.getUint16(4); i++) {
    const at = 12 + 16 * i;
    const tag = String.fromCharCode(...ttf.subarray(at, at + 4));
    tables[tag] = ttf.subarray(dv.getUint32(at + 8), dv.getUint32(at + 8) + dv.getUint32(at + 12));
  }
  const numGlyphs = new DataView(tables.maxp.buffer, tables.maxp.byteOffset).getUint16(4);
  const longLoca = new DataView(tables.head.buffer, tables.head.byteOffset).getInt16(50) === 1;
  const loca = new DataView(tables.loca.buffer, tables.loca.byteOffset);
  const locaAt = (g) => (longLoca ? loca.getUint32(4 * g) : loca.getUint16(2 * g) * 2);
  const glyph = (g) => tables.glyf.subarray(locaAt(g), locaAt(g + 1));
  const keep = new Set(used.keys());
  const queue = [...keep]; // 합성 글리프가 가리키는 부품 글리프도 함께 남긴다
  while (queue.length) {
    const data = glyph(queue.pop());
    if (data.length < 10) continue;
    const gv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (gv.getInt16(0) >= 0) continue;
    let p = 10;
    let flags;
    do {
      flags = gv.getUint16(p);
      const part = gv.getUint16(p + 2);
      if (!keep.has(part)) { keep.add(part); queue.push(part); }
      p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
    } while (flags & 0x20);
  }
  const parts = [];
  const newLoca = new DataView(new ArrayBuffer(4 * (numGlyphs + 1)));
  let size = 0;
  for (let g = 0; g < numGlyphs; g++) {
    newLoca.setUint32(4 * g, size);
    if (!keep.has(g)) continue;
    const data = glyph(g);
    const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
    padded.set(data);
    parts.push(padded);
    size += padded.length;
  }
  newLoca.setUint32(4 * numGlyphs, size);
  const glyf = new Uint8Array(size);
  let pos = 0;
  for (const part of parts) { glyf.set(part, pos); pos += part.length; }
  const head = tables.head.slice();
  new DataView(head.buffer).setInt16(50, 1); // loca를 긴 형식으로 다시 씀
  new DataView(head.buffer).setUint32(8, 0); // checkSumAdjustment
  const out = { glyf, head, hhea: tables.hhea, hmtx: tables.hmtx, loca: new Uint8Array(newLoca.buffer), maxp: tables.maxp };
  const tags = Object.keys(out).sort();
  const dirEnd = 12 + 16 * tags.length;
  const total = tags.reduce((n, t) => n + Math.ceil(out[t].length / 4) * 4, dirEnd);
  const file = new Uint8Array(total);
  const fv = new DataView(file.buffer);
  fv.setUint32(0, 0x00010000);
  fv.setUint16(4, tags.length);
  fv.setUint16(6, 16 * 2 ** Math.floor(Math.log2(tags.length)));
  fv.setUint16(8, Math.floor(Math.log2(tags.length)));
  fv.setUint16(10, 16 * tags.length - fv.getUint16(6));
  let off = dirEnd;
  tags.forEach((tag, i) => {
    const t = out[tag];
    const padded = new Uint8Array(Math.ceil(t.length / 4) * 4);
    padded.set(t);
    let sum = 0;
    const pv = new DataView(padded.buffer);
    for (let k = 0; k < padded.length; k += 4) sum = (sum + pv.getUint32(k)) >>> 0;
    const at = 12 + 16 * i;
    file.set(new TextEncoder().encode(tag), at);
    fv.setUint32(at + 4, sum);
    fv.setUint32(at + 8, off);
    fv.setUint32(at + 12, t.length);
    file.set(padded, off);
    off += padded.length;
  });
  return file;
}

/** 페이지 그리기 명령(PDF 연산자 문자열). 좌표는 화면처럼 왼쪽 위가 원점이고 단위는 px(=pt) */
const pdfOps = {
  rect: (h, x, y, w, ht, fill) => `${pdfRgb(fill)} rg ${pdfNum(x)} ${pdfNum(h - y - ht)} ${pdfNum(w)} ${pdfNum(ht)} re f`,
  roundRect: (h, x, y, w, ht, r, fill, stroke) => {
    const k = 0.5523 * r;
    const [yb, yt] = [h - y - ht, h - y];
    const n = [
      x + r, yb, 'm', x + w - r, yb, 'l', x + w - r + k, yb, x + w, yb + r - k, x + w, yb + r, 'c',
      x + w, yt - r, 'l', x + w, yt - r + k, x + w - r + k, yt, x + w - r, yt, 'c',
      x + r, yt, 'l', x + r - k, yt, x, yt - r + k, x, yt - r, 'c',
      x, yb + r, 'l', x, yb + r - k, x + r - k, yb, x + r, yb, 'c', 'h',
    ].map((v) => (typeof v === 'number' ? pdfNum(v) : v)).join(' ');
    return `${pdfRgb(fill)} rg ${pdfRgb(stroke)} RG 1 w ${n} B`;
  },
  /** 글줄 하나. (x, cy): 글줄 상자의 왼쪽·세로 가운데. 굵은 글씨는 같은 글꼴에 윤곽선을 덧그려 만든다 */
  text: (font, h, text, x, cy, size, color, bold) => {
    const gids = Array.from(text, (ch) => hex4(glyphOf(font.meta, ch))).join('');
    const baseline = h - cy - size * 0.36;
    const weight = bold ? `2 Tr ${pdfRgb(color)} RG ${pdfNum(size * 0.035)} w` : '0 Tr';
    return `BT /F1 ${pdfNum(size)} Tf ${pdfRgb(color)} rg ${weight} ${pdfNum(x)} ${pdfNum(baseline)} Td <${gids}> Tj ET`;
  },
};

/** 메모 한 건 → 카드 안에 그릴 줄 목록 (글자가 PDF 글꼴에 있는 것만 남긴 뒤 줄바꿈) */
function memoCardLines(m, font) {
  const { c, w, margin, pad } = CARD_PDF;
  const inner = w - 2 * margin - 2 * pad;
  const lines = [];
  const add = (text, size, bold, color, lh, extra = {}) => {
    const safe = pdfSafeText(font.meta, text);
    for (const t of wrapText(safe, inner - (extra.indent ?? 0), (s) => textWidth(font.meta, s, size))) lines.push({ text: t, size, bold, color, lh, ...extra });
  };
  const gap = (lh) => lines.push({ text: '', lh });
  m.passages.forEach((p, i) => {
    if (i) gap(8);
    add(passageRef(m, p), 14, true, c.primary, 22);
    if (p.text) add(p.text, 13, false, c.text, 20, { bg: c.verse, indent: 8 });
  });
  gap(10);
  add(m.content, 14, false, c.text, 22);
  return lines;
}

/** 메모들을 카드 형태의 PDF(Blob)로 만듦 */
async function makeMeditationPdf(memos, iso, { title = '오늘의 말씀묵상', subtitle } = {}) {
  const { w, h, margin, pad, c } = CARD_PDF;
  const font = await loadPdfFont();
  const cards = memos.map((m) => memoCardLines(m, font));
  const pages = paginateCards(cards, { firstTop: margin + 64, top: margin, bottom: h - margin - 16, pad });
  const dateLabel = pdfSafeText(font.meta, subtitle ?? new Date(`${iso}T00:00`).toLocaleDateString('ko-KR', { dateStyle: 'full' }));
  const texts = []; // 실제로 쓴 글자 (글꼴 잘라내기용)
  const text = (t, x, cy, size, color, bold) => { texts.push(t); return pdfOps.text(font, h, t, x, cy, size, color, bold); };
  const content = pages.map((segs, pi) => {
    const ops = [pdfOps.rect(h, 0, 0, w, h, c.bg)];
    if (pi === 0) {
      ops.push(text(pdfSafeText(font.meta, title), margin, margin + 20, 24, c.primary, true));
      ops.push(text(dateLabel, margin, margin + 46, 13, c.muted, false));
    }
    for (const seg of segs) {
      ops.push(pdfOps.roundRect(h, margin, seg.y, w - 2 * margin, seg.h, 10, c.card, c.border));
      let y = seg.y + pad;
      for (const it of seg.items) {
        if (it.bg) ops.push(pdfOps.rect(h, margin + pad, y, w - 2 * margin - 2 * pad, it.lh, it.bg));
        if (it.text) ops.push(text(it.text, margin + pad + (it.indent ?? 0), y + it.lh / 2, it.size, it.color, it.bold));
        y += it.lh;
      }
    }
    const label = `${pi + 1} / ${pages.length}`;
    ops.push(text(label, (w - textWidth(font.meta, label, 11)) / 2, h - margin / 2, 11, c.muted, false));
    return ops.join('\n');
  });
  const used = usedGlyphs(font.meta, texts);
  const fontFile = subsetTtf(font.ttf, used);
  const packed = await deflate(fontFile);
  return new Blob([buildPdf(content, { font: font.meta, used, fontFile, packed, title: pdfSafeText(font.meta, title) }, w, h)], { type: 'application/pdf' });
}

/** deflate 압축 (CompressionStream 미지원 브라우저는 null → 압축 없이 저장) */
async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  } catch { return null; }
}

/** 영어 메모의 말씀을 개역한글 본문으로 바꾼 사본 (원본 메모는 그대로). 본문을 못 불러오면 원래 본문 유지 */
async function toKorean(m) {
  if (m.lang !== 'en') return m;
  const passages = await Promise.all(m.passages.map(async (p) => {
    const verses = await loadChapter(p.bookId, p.chapter, 'ko');
    const text = verses ? passageTextOf(verses, p.verses) : '';
    return { ...p, text: text || p.text };
  }));
  return { ...m, lang: 'ko', passages };
}

/** 오늘의 말씀묵상 텍스트 공유 */
async function shareMeditationText(korean = false) {
  let memos = memosOfDay(state.date);
  if (!memos.length) { toast('이 날짜의 읽기 본문에 기록한 메모가 없습니다.'); return; }
  if (korean) memos = await Promise.all(memos.map(toKorean));
  await shareText(meditationToShareText(memos, state.date, passageRef));
}

/** 오늘의 말씀묵상 공유: PDF를 만들어 공유 시트(문자·카톡·이메일 첨부)로 보내고, 안 되면 파일로 저장 */
async function shareMeditation(korean = false) {
  let memos = memosOfDay(state.date);
  if (!memos.length) { toast('이 날짜의 읽기 본문에 기록한 메모가 없습니다.'); return; }
  toast('PDF를 만드는 중입니다…');
  if (korean) memos = await Promise.all(memos.map(toKorean));
  const filename = `말씀묵상${korean ? '-한글' : ''}-${state.date}.pdf`;
  await deliverFile(await makeMeditationPdf(memos, state.date), filename, '오늘의 말씀묵상');
}

/** 터치가 주 입력인 기기(폰·태블릿 앱/브라우저) 여부 */
const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;

/** 파일을 공유 시트(파일에 저장·문자·카톡·이메일 첨부)로 보내고, 안 되면 다운로드. 모바일 사파리는 다운로드 시 미리보기 화면으로 가 버리므로 */
async function deliverFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type.split(';')[0] });
  if (isTouchDevice() && navigator.canShare?.({ files: [file] })) { // 데스크톱 웹은 공유 시트 없이 바로 저장
    try { await navigator.share({ files: [file], title }); return; } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  download(filename, file);
  toast('파일로 저장했습니다.');
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

async function downloadTxt() {
  const { list, searching } = visibleMemos();
  if (!list.length) { toast('다운로드할 메모가 없습니다.'); return; }
  await deliverFile(new Blob(['﻿', memosToText(list, passageRef)], { type: 'text/plain;charset=utf-8' }),
    `mccheyne-${searching ? 'search' : 'memos'}-${stamp()}.txt`, '맥체인 성경읽기 메모');
}

/** 메모 목록(현재 보이는 목록) PDF 저장: window.print()는 모바일에서 차단되므로 PDF 파일을 직접 만든다 */
async function printPdf() {
  const { list, searching } = visibleMemos();
  if (!list.length) { toast('저장할 메모가 없습니다.'); return; }
  toast('PDF를 만드는 중입니다…');
  const blob = await makeMeditationPdf(list, stamp(), { title: '맥체인 성경읽기 메모', subtitle: `${list.length}개 · ${stamp()}` });
  await deliverFile(blob, `mccheyne-${searching ? 'search' : 'memos'}-${stamp()}.pdf`, '맥체인 성경읽기 메모');
}

/** 모든 메모(검색·필터와 무관)를 가져오기와 같은 형식의 JSON 파일로 저장 (PC 전용) */
function exportMemos() {
  if (!state.memos.length) { toast('내보낼 메모가 없습니다.'); return; }
  const blob = new Blob([JSON.stringify(state.memos, null, 2)], { type: 'application/json' });
  download(`mccheyne-memos-${stamp()}.json`, blob);
  toast(`메모 ${state.memos.length}건을 파일로 저장했습니다.`);
}

/** 레이블을 목록과 모든 메모에서 제거 (메모에 남기면 다음 시작 때 목록에 되살아남). 수정된 메모 수를 돌려준다. */
function removeLabelEverywhere(label) {
  state.labels = state.labels.filter((l) => l !== label);
  const now = new Date().toISOString();
  const changed = [];
  state.memos = state.memos.map((m) => {
    if (!m.labels.includes(label)) return m;
    const next = { ...m, labels: m.labels.filter((l) => l !== label), updatedAt: now };
    changed.push(next);
    return next;
  });
  persistLabels();
  if (changed.length) {
    persistMemos();
    remoteCall((r) => Promise.all(changed.map((m) => r.save(m))));
  }
  return changed.length;
}

/**
 * 레이블 이름 바꾸기 (순수 함수). 새 이름이 이미 있으면 하나로 합친다.
 * 바뀐 메모만 새 객체(updatedAt = now)로 돌려준다 → changed
 */
function renameLabel(labels, memos, from, to, now) {
  const merged = labels.includes(to);
  const nextLabels = merged ? labels.filter((l) => l !== from) : labels.map((l) => (l === from ? to : l));
  const changed = [];
  const nextMemos = memos.map((m) => {
    if (!m.labels.includes(from)) return m;
    const memo = { ...m, labels: [...new Set(m.labels.map((l) => (l === from ? to : l)))], updatedAt: now };
    changed.push(memo);
    return memo;
  });
  return { labels: nextLabels, memos: nextMemos, changed, merged };
}

/** 목록과 모든 메모의 레이블 이름을 바꾸고 저장 (로그인 상태면 바뀐 메모를 클라우드에도 저장) */
function renameLabelEverywhere(from, to) {
  const r = renameLabel(state.labels, state.memos, from, to, new Date().toISOString());
  state.labels = r.labels;
  state.memos = r.memos;
  persistLabels();
  if (r.changed.length) {
    persistMemos();
    remoteCall((remote) => Promise.all(r.changed.map((m) => remote.save(m))));
  }
  return r;
}

const findLabelButton = (action, label) => [...document.querySelectorAll(`#labels-list [data-action="${action}"]`)].find((b) => b.dataset.label === label);

function closeRenameForm(focusLabel) {
  $('#label-rename-form').hidden = true;
  delete $('#label-rename-form').dataset.from;
  const target = findLabelButton('label-rename', focusLabel) ?? $('#labels-list button') ?? $('#label-input');
  target.focus();
}

/** 가져오기 결과 대화상자: 줄 목록을 보여 준다 (warn 줄은 강조, sub 는 하위 항목) */
function showImportResult(summary, rows) {
  $('#import-summary').textContent = summary;
  mount($('#import-list'), rows.map((r) => h('li', { class: r.warn ? 'result-list__item--warn' : null, id: r.id },
    r.text,
    r.sub?.length > 0 && h('ul', { class: 'result-list__sub' }, r.sub.map((t) => h('li', {}, t))))));
  $('#import-dialog').showModal();
}

/** 메모 JSON 파일 가져오기: 스키마 검사 후 id 기준 병합(같은 id 는 최신 수정본), 새 레이블 추가, 로그인 상태면 클라우드 동기화. 결과는 대화상자로 알린다. */
async function importMemosFile(file) {
  let list;
  try { list = JSON.parse(await file.text()); } catch { showImportResult('가져오지 못했습니다.', [{ text: `${file.name}: JSON 형식이 올바르지 않아 읽을 수 없습니다.`, warn: true }]); return; }
  if (!Array.isArray(list)) { showImportResult('가져오지 못했습니다.', [{ text: '메모 목록(JSON 배열) 형식이 아닙니다. 이 앱의 메모 형식으로 변환한 파일을 선택하세요.', warn: true }]); return; }
  const r = summarizeImport(list, state.memos, (id) => !!bookById(id));
  const invalidCount = r.invalid.reduce((n, [, c]) => n + c, 0);
  if (!r.ids.length) {
    showImportResult('가져오지 못했습니다.', [
      { text: `파일 속 항목 ${r.total}건 중 쓸 수 있는 메모가 없습니다.`, warn: true, sub: r.invalid.map(([why, c]) => `${why}: ${c}건`) }]);
    return;
  }
  const labelsBefore = state.labels.length;
  state.memos = r.merged;
  for (const id of r.ids) delete state.tombstones[id];
  syncLabelsFromMemos();
  persistMemos();
  persistTombs();
  refreshViews();
  const rows = [
    { text: `새로 추가: ${r.added}건` },
    { text: `기존 메모를 더 최신 내용으로 갱신: ${r.updated}건` },
    { text: `변경 없음 (이미 같거나 더 최신): ${r.unchanged}건` },
  ];
  if (r.duplicates) rows.push({ text: `파일 안에서 id 가 겹쳐 하나만 반영: ${r.duplicates}건` });
  if (invalidCount) rows.push({ text: `형식 오류로 건너뜀: ${invalidCount}건`, warn: true, sub: r.invalid.map(([why, c]) => `${why}: ${c}건`) });
  if (state.labels.length > labelsBefore) rows.push({ text: `레이블 목록에 ${state.labels.length - labelsBefore}개 추가` });
  rows.push({ text: state.remote ? '클라우드 동기화 중…' : '로그인하지 않아 이 기기에만 저장했습니다.', id: 'import-cloud' });
  showImportResult(`파일 속 ${r.total}건 중 ${r.added + r.updated}건을 반영했습니다.`, rows);
  if (state.remote) {
    const ok = await syncRemote();
    const cloud = $('#import-cloud');
    if (cloud) cloud.textContent = ok ? '클라우드 동기화 완료' : '클라우드 동기화 실패 (이 기기에는 저장됨)';
  }
}

/* ================= 레이블 관리 ================= */
function renderLabelsDialog() {
  mount($('#labels-list'), sortLabels(state.labels).map((l) =>
    h('li', { class: 'chips__item' },
      h('button', { type: 'button', class: 'chip', 'data-action': 'label-rename', 'data-label': l, 'aria-label': `레이블 ${l} 이름 바꾸기` }, l))));
}

/* ================= 이벤트 (위임) ================= */
/** 현재 스크롤 위치에서 맨 위/맨 아래 이동 버튼을 보여 줄지 (순수 함수) */
const jumpVisibility = (scrollY, maxY, threshold = 200) => ({
  top: scrollY > threshold,
  bottom: maxY > threshold && maxY - scrollY > threshold,
  topDisabled: scrollY < 1, // 이미 맨 위/맨 아래이면 비활성 (스크린리더에는 '사용 불가'로 읽힘)
  bottomDisabled: maxY - scrollY < 1,
});
const scrollBehavior = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

function updateJumpButtons() {
  const vis = jumpVisibility(window.scrollY, document.documentElement.scrollHeight - window.innerHeight);
  for (const [id, show, off] of [['#jump-top', vis.top, vis.topDisabled], ['#jump-bottom', vis.bottom, vis.bottomDisabled]]) {
    const btn = $(id);
    btn.classList.toggle('reader__jump-btn--idle', !show); // 화면에서만 숨김
    btn.disabled = off;
  }
}

const actions = {
  'scroll-top': () => {
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    $('#reader-title').focus({ preventScroll: true }); // 스크린리더가 장 제목을 읽도록
  },
  'scroll-bottom': () => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: scrollBehavior() });
    const last = [...document.querySelectorAll('#passage .verse__text')].pop();
    last?.focus({ preventScroll: true }); // 마지막 절로 포커스
  },
  'day-prev': () => { state.date = shiftISODate(state.date, -1); renderToday(); announceDay(); },
  'day-next': () => { state.date = shiftISODate(state.date, 1); renderToday(); announceDay(); },
  'day-today': () => { state.date = toISODate(); renderToday(); announceDay(); },
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
  'passage-view': (el) => openPassageView(state.draft.passages[Number(el.dataset.pi)]),
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
  'memos-import': () => $('#import-file').click(),
  'search-clear': () => { const input = $('#search-input'); input.value = ''; state.query = ''; state.page = 1; renderMemos(); input.focus(); },
  'find-clear': () => { $('#find-input').value = ''; searchChapter(''); $('#find-input').focus(); },
  'dialog-close': (el) => el.closest('dialog').close(),
  'passage-open': (el, e) => {
    const m = state.memos.find((x) => x.id === el.closest('[data-id]').dataset.id);
    if (m?.passages.length > 1) { e.preventDefault(); openPassagePicker(m); } // 장을 고른 뒤에 이동
    else el.closest('dialog').close();
  },
  'passage-go': () => document.querySelectorAll('dialog[open]').forEach((d) => d.close()), // 이동하면 열린 팝업을 모두 닫음
  'memo-edit': (el) => { el.closest('dialog')?.close(); editMemo(state.memos.find((x) => x.id === el.closest('[data-id]').dataset.id)); },
  'read-edit': (el) => withReadMemo(el, editMemo),
  'read-share': (el) => withReadMemo(el, shareMemo),
  'read-delete': (el) => withReadMemo(el, confirmDelete),
  'auth-toggle': toggleAuth,
  'page-go': (el) => {
    state.page = Number(el.dataset.page);
    renderMemos();
    $('#memos-summary').scrollIntoView({ block: 'start' });
    $('#board').querySelector('a, button')?.focus({ preventScroll: true });
  },
  'chapter-memos': () => openChapterMemos(),
  'verse-memos': (el) => openVerseMemos(Number(el.dataset.verse)),
  'memo-read': (el) => openReadDialog(state.memos.find((x) => x.id === el.closest('[data-id]').dataset.id)),
  'memo-delete': (el) => { el.closest('dialog')?.close(); confirmDelete(state.memos.find((x) => x.id === el.closest('[data-id]').dataset.id)); },
  'memo-share': (el) => { el.closest('dialog')?.close(); shareMemo(state.memos.find((x) => x.id === el.closest('[data-id]').dataset.id)); },
  'share-meditation': () => shareMeditation(),
  'share-meditation-ko': () => shareMeditation(true),
  'share-meditation-txt': () => shareMeditationText(),
  'share-meditation-txt-ko': () => shareMeditationText(true),
  'memos-export': exportMemos,
  'dl-txt': downloadTxt,
  'dl-pdf': printPdf,
  'labels-open': () => { $('#labels-notice').hidden = true; renderLabelsDialog(); $('#labels-dialog').showModal(); },
  'label-rename': (el) => {
    const form = $('#label-rename-form');
    const input = $('#label-rename-input');
    form.dataset.from = el.dataset.label;
    $('#label-rename-caption').textContent = `레이블 ${el.dataset.label}의 새 이름`; // 화면에는 숨기고 스크린리더용으로만 유지
    input.value = el.dataset.label;
    form.hidden = false;
    input.focus();
    input.select();
  },
  'label-rename-cancel': () => closeRenameForm($('#label-rename-form').dataset.from),
  'label-input-clear': () => {
    const input = $('#label-input');
    input.value = '';
    $('#labels-notice').hidden = true;
    input.focus();
  },
  'label-delete': () => {
    const name = $('#label-rename-form').dataset.from; // 선택한 레이블을 삭제
    if (!name || !state.labels.includes(name)) return;
    $('#labels-notice').hidden = true;
    const used = state.memos.filter((m) => m.labels.includes(name)).length;
    if (!window.confirm(`레이블 "${name}"을(를) 삭제할까요?\n\n⚠ 경고: 해당 메모에서 레이블 삭제${used ? ` (메모 ${used}개)` : ''}\n이 작업은 되돌릴 수 없습니다.`)) { $('#label-rename-input').focus(); return; }
    const count = removeLabelEverywhere(name);
    renderLabelsDialog();
    if (memoDialogOpen()) { syncDraftLabels(); state.draft.labels.delete(name); renderDraft(); }
    toast(`레이블 ${name} 삭제${count ? ` (메모 ${count}개에서 제거)` : ''}`);
    closeRenameForm(null); // 삭제한 레이블은 없으므로 목록 첫 레이블로 포커스
  },
};

/* ---- 팝업 제목을 끌어 위치 이동 (화면 밖으로 나가지 않게 제한) ---- */
const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));

function moveDialog(dialog, dx, dy) {
  dialog.dataset.dx = dx;
  dialog.dataset.dy = dy;
  dialog.style.translate = dx || dy ? `${dx}px ${dy}px` : '';
}

/* 입력 방식 추적: 터치/마우스 뒤 프로그램이 옮긴 포커스에는 링을 그리지 않기 위함 (포커스 자체는 유지) */
document.addEventListener('pointerdown', () => { document.documentElement.dataset.input = 'pointer'; }, true);
document.addEventListener('keydown', () => { document.documentElement.dataset.input = 'keyboard'; }, true);

let dragging = null;
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-drag-handle]');
  if (!handle || e.button !== 0) return;
  const dialog = handle.closest('dialog');
  dragging = { dialog, x: e.clientX, y: e.clientY, ox: Number(dialog.dataset.dx || 0), oy: Number(dialog.dataset.dy || 0), rect: dialog.getBoundingClientRect() };
  handle.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const { dialog, x, y, ox, oy, rect } = dragging;
  const dx = clamp(e.clientX - x, -rect.left, window.innerWidth - rect.right);
  const dy = clamp(e.clientY - y, -rect.top, window.innerHeight - rect.bottom);
  moveDialog(dialog, ox + dx, oy + dy);
});
document.addEventListener('pointerup', () => { dragging = null; });
document.addEventListener('pointercancel', () => { dragging = null; });

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el) { actions[el.dataset.action]?.(el, e); return; }
  const passage = e.target.closest('.memo-passage'); // 말씀 박스의 빈 곳을 눌러도 '보기'와 동일 (버튼·칩은 위에서 처리됨)
  if (passage) { actions['passage-view'](passage.querySelector('[data-action="passage-view"]')); return; }
  const verse = e.target.closest('.verse');
  if (verse) toggleVerse(Number(verse.dataset.verse), e.shiftKey);
});

document.addEventListener('focusin', (e) => { if (e.target.id === 'range-end') startRange(); });

document.addEventListener('submit', (e) => {
  if (e.target.id === 'memo-form') { e.preventDefault(); saveMemo(e.target); }
  else if (e.target.id === 'label-form') {
    e.preventDefault();
    const input = $('#label-input');
    const name = input.value.trim();
    if (name && state.labels.includes(name)) { warnLabel(`"${name}" 레이블은 이미 있습니다.`); input.select(); return; }
    $('#labels-notice').hidden = true;
    if (name) {
      state.labels.push(name);
      persistLabels();
      renderLabelsDialog();
      if (memoDialogOpen()) { syncDraftLabels(name); renderDraft(); } // 메모 작성 중이면 새 레이블을 바로 선택된 상태로 추가
      toast(`레이블 ${name} 추가`);
    }
    input.value = '';
  } else if (e.target.id === 'label-rename-form') {
    e.preventDefault();
    const from = e.target.dataset.from;
    const to = $('#label-rename-input').value.trim();
    if (!to || to === from) { closeRenameForm(from); return; }
    const used = state.memos.filter((m) => m.labels.includes(from)).length;
    const mergeNote = state.labels.includes(to) ? `\n"${to}"은(는) 이미 있는 레이블이라 합쳐집니다.` : '';
    if (!window.confirm(`레이블 "${from}"을(를) "${to}"(으)로 바꿀까요?\n\n⚠ 경고: 해당 메모에서 레이블 이름 변경${used ? ` (메모 ${used}개)` : ''}${mergeNote}\n이 작업은 되돌릴 수 없습니다.`)) { $('#label-rename-input').focus(); return; }
    const r = renameLabelEverywhere(from, to);
    renderLabelsDialog();
    if (memoDialogOpen()) { // 메모 작성 중이면 선택된 레이블도 새 이름으로
      syncDraftLabels();
      if (state.draft.labels.delete(from)) state.draft.labels.add(to);
      renderDraft();
    }
    refreshViews();
    toast(r.merged ? `레이블 ${from}을(를) 이미 있는 ${to}에 합쳤습니다.` : `레이블 ${from} → ${to} 이름을 바꿨습니다.`);
    closeRenameForm(to);
  } else if (e.target.id === 'search-form') e.preventDefault();
  else if (e.target.id === 'find-form') { e.preventDefault(); searchChapter($('#find-input').value); }
  else if (e.target.id === 'bible-form') {
    e.preventDefault();
    const { bookId, ch } = state.bible;
    location.hash = `#/read/${bookId}/${ch}`;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search-input') { state.query = e.target.value; state.page = 1; renderMemos(); }
  else if (e.target.id === 'label-input') $('#labels-notice').hidden = true; // 입력을 고치면 이전 경고는 지움
  else if (e.target.id === 'find-input') searchChapter(e.target.value, { live: true });
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'import-file') {
    const [file] = e.target.files;
    e.target.value = '';
    if (file) importMemosFile(file);
  } else if (e.target.id === 'lang-select') {
    state.lang = e.target.value;
    try { localStorage.setItem(KEYS.lang, state.lang); } catch { /* 무시 */ }
    document.documentElement.lang = 'ko';
    route();
  } else if (e.target.id === 'bible-book') {
    state.bible = { bookId: e.target.value, ch: 1 };
    fillChapterSelect(state.bible.bookId, 1);
  } else if (e.target.id === 'bible-chapter') {
    state.bible.ch = Number(e.target.value);
  } else if (e.target.id === 'range-end') {
    applyRangeEnd(Number(e.target.value));
  } else if (e.target.id === 'add-book') {
    syncPicker({ chapter: todayPicks().find((p) => p.bookId === e.target.value)?.chapter ?? 1 });
  } else if (e.target.id === 'add-chapter') {
    syncPicker({ chapter: Number(e.target.value) });
  } else if (e.target.id === 'add-verse') {
    previewSelectedVerse();
  } else if (e.target.id === 'date-input' && e.target.value) {
    state.date = e.target.value;
    renderToday();
    announceDay();
  }
});

// 본문 화면에서 손가락 쓸기: 오른쪽으로 쓸면 이전, 왼쪽으로 쓸면 다음 (이전/다음 링크와 같은 이동)
let touchStart = null;
const readerView = $('#view-reader');
readerView.addEventListener('touchstart', (e) => {
  touchStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
readerView.addEventListener('touchend', (e) => {
  const start = touchStart;
  touchStart = null;
  if (!start || e.target.closest('.selection-bar') || !window.getSelection().isCollapsed) return; // 글자 선택 드래그와 구분
  const t = e.changedTouches[0];
  const dir = swipeDirection(t.clientX - start.x, t.clientY - start.y);
  if (dir) location.hash = $(`#reader-${dir === 'prev' ? 'prev' : 'next'}`).getAttribute('href');
});
readerView.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });

// 선택 도구 모음 높이(줄바꿈·숨김으로 변함)를 CSS 변수로 알려 이동 버튼이 가려지지 않게 함
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--selection-bar-h', `${entry.target.offsetHeight}px`);
}).observe($('#selection-bar'));

window.addEventListener('scroll', updateJumpButtons, { passive: true });
window.addEventListener('resize', updateJumpButtons);

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
    state.labelsAt = readJSON(KEYS.labelsAt, '');
    syncLabelsFromMemos();
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
