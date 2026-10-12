// 다른 앱의 묵상 메모(Kim notes.json) -> 맥체인 앱 메모 스키마 변환
// 구절 본문은 data/bible/en (Berean Standard Bible)에서 채운다.
// 사용법: node scripts/convert-kim-notes.js "data/Kim notes.json" backup/kim-memos.json
// 주의: 개인 메모이므로 결과 파일은 저장소에 커밋하지 말 것 (backup/ 은 .gitignore).
const fs = require('fs');
const crypto = require('crypto');

/** 'ROM.13.12' -> { bookId: 'rom', chapter: 13, verse: 12 } */
const parseUsfm = (u) => {
  const [b, c, v] = u.split('.');
  return { bookId: b.toLowerCase(), chapter: Number(c), verse: Number(v) };
};

/** 영어 본문(BSB) 캐시: 책 id -> { 장: [절 본문...] } */
const bibleCache = new Map();
const verseText = (bookId, chapter, verse) => {
  if (!bibleCache.has(bookId)) bibleCache.set(bookId, JSON.parse(fs.readFileSync(`data/bible/en/${bookId}.json`, 'utf8')));
  return bibleCache.get(bookId)[chapter]?.[verse - 1];
};

const toIso = (s) => new Date(s).toISOString();

/** 원본 한 건 -> 메모. id 는 원본 내용에서 결정적으로 만들어 다시 가져와도 중복되지 않는다. */
function convertNote(n, bookIds) {
  const byChapter = new Map();
  for (const v of n.verses ?? []) {
    for (const u of v.usfm ?? []) {
      const { bookId, chapter, verse } = parseUsfm(u);
      if (!bookIds.has(bookId) || !Number.isInteger(chapter) || !Number.isInteger(verse)) continue;
      const key = `${bookId}.${chapter}`;
      const p = byChapter.get(key) ?? { bookId, chapter, verses: [], text: '' };
      if (!p.verses.includes(verse)) p.verses.push(verse);
      byChapter.set(key, p);
    }
  }
  const passages = [...byChapter.values()].map((p) => {
    const verses = p.verses.sort((a, b) => a - b);
    const text = verses.map((v) => [v, verseText(p.bookId, p.chapter, v)]).filter(([, t]) => t).map(([v, t]) => `${v} ${t}`).join('\n');
    return { ...p, verses, text };
  });
  const createdAt = toIso(n.created_dt);
  const id = 'kim-' + crypto.createHash('sha1').update(`${n.created_dt}\n${n.content}`).digest('hex').slice(0, 16);
  return {
    id,
    content: n.content,
    lang: 'en', // 구절 본문이 영어(BSB)
    passages,
    labels: (n.labels ?? []).map((l) => l.trim()).filter(Boolean),
    createdAt,
    updatedAt: n.last_modified ? toIso(n.last_modified) : createdAt,
  };
}

function main([src, dst]) {
  if (!src || !dst) { console.error('사용법: node scripts/convert-kim-notes.js <입력.json> <출력.json>'); process.exit(1); }
  const bookIds = new Set(JSON.parse(fs.readFileSync('data/books.json', 'utf8')).map((b) => b.id));
  const notes = JSON.parse(fs.readFileSync(src, 'utf8'));
  const seen = new Set();
  const memos = [];
  let skipped = 0;
  for (const n of notes) {
    const m = convertNote(n, bookIds);
    if (!m.passages.length || seen.has(m.id)) { skipped++; continue; }
    seen.add(m.id);
    memos.push(m);
  }
  fs.mkdirSync(require('path').dirname(dst), { recursive: true });
  fs.writeFileSync(dst, JSON.stringify(memos, null, 1));
  const labels = [...new Set(memos.flatMap((m) => m.labels))];
  console.log(`원본 ${notes.length}건 -> 변환 ${memos.length}건 (제외 ${skipped}), 레이블 ${labels.length}종`);
}

main(process.argv.slice(2));
