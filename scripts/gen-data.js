// Generates data/books.json and data/plan.json.
// NOTE: plan.json is an APPROXIMATION of the McCheyne plan (4 tracks, 366 days),
// not the official table.
// Run: node scripts/gen-data.js
const fs = require('fs');
const path = require('path');

const B = [
  ['gen', '창세기', 'Genesis', 50], ['exo', '출애굽기', 'Exodus', 40], ['lev', '레위기', 'Leviticus', 27],
  ['num', '민수기', 'Numbers', 36], ['deu', '신명기', 'Deuteronomy', 34], ['jos', '여호수아', 'Joshua', 24],
  ['jdg', '사사기', 'Judges', 21], ['rut', '룻기', 'Ruth', 4], ['1sa', '사무엘상', '1 Samuel', 31],
  ['2sa', '사무엘하', '2 Samuel', 24], ['1ki', '열왕기상', '1 Kings', 22], ['2ki', '열왕기하', '2 Kings', 25],
  ['1ch', '역대상', '1 Chronicles', 29], ['2ch', '역대하', '2 Chronicles', 36], ['ezr', '에스라', 'Ezra', 10],
  ['neh', '느헤미야', 'Nehemiah', 13], ['est', '에스더', 'Esther', 10], ['job', '욥기', 'Job', 42],
  ['psa', '시편', 'Psalms', 150], ['pro', '잠언', 'Proverbs', 31], ['ecc', '전도서', 'Ecclesiastes', 12],
  ['sng', '아가', 'Song of Solomon', 8], ['isa', '이사야', 'Isaiah', 66], ['jer', '예레미야', 'Jeremiah', 52],
  ['lam', '예레미야애가', 'Lamentations', 5], ['ezk', '에스겔', 'Ezekiel', 48], ['dan', '다니엘', 'Daniel', 12],
  ['hos', '호세아', 'Hosea', 14], ['jol', '요엘', 'Joel', 3], ['amo', '아모스', 'Amos', 9],
  ['oba', '오바댜', 'Obadiah', 1], ['jon', '요나', 'Jonah', 4], ['mic', '미가', 'Micah', 7],
  ['nam', '나훔', 'Nahum', 3], ['hab', '하박국', 'Habakkuk', 3], ['zep', '스바냐', 'Zephaniah', 3],
  ['hag', '학개', 'Haggai', 2], ['zec', '스가랴', 'Zechariah', 14], ['mal', '말라기', 'Malachi', 4],
  ['mat', '마태복음', 'Matthew', 28], ['mrk', '마가복음', 'Mark', 16], ['luk', '누가복음', 'Luke', 24],
  ['jhn', '요한복음', 'John', 21], ['act', '사도행전', 'Acts', 28], ['rom', '로마서', 'Romans', 16],
  ['1co', '고린도전서', '1 Corinthians', 16], ['2co', '고린도후서', '2 Corinthians', 13],
  ['gal', '갈라디아서', 'Galatians', 6], ['eph', '에베소서', 'Ephesians', 6], ['php', '빌립보서', 'Philippians', 4],
  ['col', '골로새서', 'Colossians', 4], ['1th', '데살로니가전서', '1 Thessalonians', 5],
  ['2th', '데살로니가후서', '2 Thessalonians', 3], ['1ti', '디모데전서', '1 Timothy', 6],
  ['2ti', '디모데후서', '2 Timothy', 4], ['tit', '디도서', 'Titus', 3], ['phm', '빌레몬서', 'Philemon', 1],
  ['heb', '히브리서', 'Hebrews', 13], ['jas', '야고보서', 'James', 5], ['1pe', '베드로전서', '1 Peter', 5],
  ['2pe', '베드로후서', '2 Peter', 3], ['1jn', '요한일서', '1 John', 5], ['2jn', '요한이서', '2 John', 1],
  ['3jn', '요한삼서', '3 John', 1], ['jud', '유다서', 'Jude', 1], ['rev', '요한계시록', 'Revelation', 22],
];
const books = B.map(([id, ko, en, chapters], i) => ({ id, ko, en, chapters, testament: i < 39 ? 'OT' : 'NT' }));

const chaptersOf = (ids) => ids.flatMap((id) => {
  const b = books.find((x) => x.id === id);
  return Array.from({ length: b.chapters }, (_, i) => `${id}.${i + 1}`);
});
const range = (from, to) => books.slice(books.findIndex((b) => b.id === from), books.findIndex((b) => b.id === to) + 1).map((b) => b.id);

const nt = range('mat', 'rev');
const t1 = chaptersOf(range('gen', 'est'));
const t2 = [...chaptersOf(nt), ...chaptersOf(['psa'])];
const t3 = chaptersOf(range('job', 'mal').filter((id) => id !== 'psa'));
const rot = t2.indexOf('act.1');
const t4 = [...t2.slice(rot), ...t2.slice(0, rot)];

const DAYS = 366; // includes Feb 29
const slice = (track, d) => track.slice(Math.floor((d * track.length) / DAYS), Math.floor(((d + 1) * track.length) / DAYS));
const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const pad = (n) => String(n).padStart(2, '0');

const days = {};
let d = 0;
monthDays.forEach((len, m) => {
  for (let day = 1; day <= len; day++, d++) {
    days[`${pad(m + 1)}-${pad(day)}`] = [t1, t2, t3, t4].map((t) => slice(t, d));
  }
});

const out = path.join(__dirname, '..', 'data');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'books.json'), JSON.stringify(books));
// NOTE: running this overwrites data/plan.json with the approximation (the committed plan.json is the 2026 table).
fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify({
  note: 'Approximation of the McCheyne plan (4 tracks). Replace with the official table if needed.',
  tracks: ['가정 1', '가정 2', '골방 1', '골방 2'],
  days,
}));
console.log('days:', Object.keys(days).length, 'jan01:', days['01-01']);
