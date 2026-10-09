"""메모 JSON(맥체인 앱 스키마) -> SQLite DB 변환. 표준 라이브러리만 사용.

사용법: python -I scripts/memos_json_to_sqlite.py <입력.json> <출력.db>
테이블: memos, passages(메모당 여러 구절), memo_labels(메모당 여러 레이블)
주의: 개인 메모 원본/DB는 저장소에 커밋하지 말 것.
"""
import json
import os
import sqlite3
import sys

SCHEMA = """
CREATE TABLE memos (id TEXT PRIMARY KEY, content TEXT NOT NULL, lang TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE passages (id INTEGER PRIMARY KEY AUTOINCREMENT, memo_id TEXT NOT NULL REFERENCES memos(id), seq INTEGER NOT NULL, book_id TEXT NOT NULL, chapter INTEGER NOT NULL, verses TEXT NOT NULL, text TEXT);
CREATE TABLE memo_labels (memo_id TEXT NOT NULL REFERENCES memos(id), label TEXT NOT NULL, PRIMARY KEY (memo_id, label));
CREATE INDEX idx_passages_memo ON passages(memo_id);
CREATE INDEX idx_labels_label ON memo_labels(label);
"""


def convert(memos, dst):
    if os.path.exists(dst):
        os.remove(dst)
    db = sqlite3.connect(dst)
    db.executescript(SCHEMA)
    for m in memos:
        db.execute('INSERT INTO memos VALUES (?,?,?,?,?)',
                   (m['id'], m['content'], m.get('lang'), m['createdAt'], m['updatedAt']))
        for i, p in enumerate(m.get('passages', [])):
            db.execute('INSERT INTO passages(memo_id,seq,book_id,chapter,verses,text) VALUES (?,?,?,?,?,?)',
                       (m['id'], i, p['bookId'], p['chapter'], json.dumps(p['verses']), p.get('text')))
        for label in m.get('labels', []):
            db.execute('INSERT OR IGNORE INTO memo_labels VALUES (?,?)', (m['id'], label))
    db.commit()
    for table in ('memos', 'passages', 'memo_labels'):
        print(table, db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0])
    db.close()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with open(sys.argv[1], encoding='utf-8') as f:
        convert(json.load(f), sys.argv[2])
