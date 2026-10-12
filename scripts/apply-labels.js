// 메모 JSON 에 레이블을 적용: node scripts/apply-labels.js <메모.json> <레이블.json> <출력.json>
// 레이블.json = { "메모 id": ["레이블", ...] }. 이미 레이블이 있는 메모는 그대로 두고, 없는 메모에만 채운다.
// 바뀐 메모의 updatedAt 은 2ms 만 늦춘다: 앱의 병합/동기화는 updatedAt 이 더 최신인 쪽을 택하므로 이미 가져온 메모도 갱신되고,
// 화면(분 단위)과 정렬 순서는 사실상 그대로다.
const fs = require('fs');

function main([src, labelsFile, dst]) {
  if (!src || !labelsFile || !dst) { console.error('사용법: node scripts/apply-labels.js <메모.json> <레이블.json> <출력.json>'); process.exit(1); }
  const memos = JSON.parse(fs.readFileSync(src, 'utf8'));
  const auto = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
  let filled = 0;
  const out = memos.map((m) => {
    const add = !m.labels.length ? auto[m.id] : null;
    if (!add?.length) return m;
    filled++;
    return { ...m, labels: add, updatedAt: new Date(new Date(m.updatedAt).getTime() + 2).toISOString() };
  });
  fs.writeFileSync(dst, JSON.stringify(out, null, 1));
  console.log(`레이블 채움 ${filled}건 -> ${dst}`);
}

main(process.argv.slice(2));
