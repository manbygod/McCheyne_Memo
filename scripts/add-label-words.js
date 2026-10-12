// 메모 내용에 레이블 이름이 들어 있으면 그 레이블을 메모에 추가한다 (구절 본문은 보지 않음).
// 사용법: node scripts/add-label-words.js <메모.json> <출력.json>
// 레이블 집합 = 입력 파일의 메모들이 쓰고 있는 모든 레이블. 영문은 대소문자 무시.
// 추가된 메모의 updatedAt 은 1ms 만 늦춘다 (앱의 병합/동기화가 더 최신 쪽을 택하므로 이미 가져온 메모도 갱신됨).
const fs = require('fs');

// "-기도"(살기도, 여기도록)가 아니라 낱말 기도만 찾기 위해, 한글 바로 뒤에 붙은 기도는 이 접두어일 때만 인정
const PREFIX_OK = { 기도: ['새벽', '도고', '중보', '합심', '통성', '철야', '대표', '묵상', '감사', '금식', '부모', '가정', '부르짖'] };

const isHangul = (ch) => /[가-힣]/.test(ch ?? '');

/** content 안에서 label 낱말이 쓰였는지 (순수 함수) */
function hasWord(content, label) {
  const text = content.toLowerCase();
  const word = label.toLowerCase();
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    const before = text.slice(0, i);
    if (!isHangul(before.at(-1))) return true;
    const prefixes = PREFIX_OK[label];
    if (prefixes?.some((p) => before.endsWith(p))) return true;
    if (!prefixes) return true; // 접두어 제한이 없는 레이블은 어디에 붙어 있어도 인정 (불순종, 부정직 등)
  }
  return false;
}

function main([src, dst]) {
  if (!src || !dst) { console.error('사용법: node scripts/add-label-words.js <메모.json> <출력.json>'); process.exit(1); }
  const memos = JSON.parse(fs.readFileSync(src, 'utf8'));
  const labels = [...new Set(memos.flatMap((m) => m.labels))];
  let changed = 0, added = 0;
  const out = memos.map((m) => {
    const add = labels.filter((l) => !m.labels.includes(l) && hasWord(m.content, l));
    if (!add.length) return m;
    changed++; added += add.length;
    return { ...m, labels: [...m.labels, ...add], updatedAt: new Date(new Date(m.updatedAt).getTime() + 1).toISOString() };
  });
  fs.writeFileSync(dst, JSON.stringify(out, null, 1));
  console.log(`레이블 ${labels.length}종 기준: 메모 ${changed}건에 레이블 ${added}개 추가 -> ${dst}`);
}

main(process.argv.slice(2));
