"""PDF 저장용 글꼴 부분집합 생성 (개발 때 한 번만 실행, 앱 실행에는 필요 없음).

사용법:
  pip install fonttools
  python scripts/gen-pdf-font.py <NotoSansKR[wght].ttf 경로>

만드는 파일 (fonts/):
  NotoSansKR-subset.ttf   Regular(400) 글자 부분집합 — 앱이 PDF를 만들 때 쓰인 글자만 다시 잘라 PDF에 넣는다
  NotoSansKR-subset.json  글자 → 글리프 번호(map), 글리프 폭(adv), 글꼴 지표 — 줄바꿈 폭 계산과 PDF 글꼴 사전용

포함 글자: KS X 1001 전체(한글 2,350자·기호·로마자 등, 한자 제외) + ASCII/라틴-1/일반 문장부호
          + 개역한글·BSB 본문·메모(data/memos.json)에 실제로 쓰인 글자
글꼴: Noto Sans KR (SIL OFL 1.1, https://fonts.google.com/noto/specimen/Noto+Sans+KR)
"""
import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'fonts'


def ksx1001_chars():
    """EUC-KR 2바이트 영역 중 기호(0xA1~0xAC행)와 한글(0xB0~0xC8행)"""
    chars = set()
    for lead in list(range(0xA1, 0xAD)) + list(range(0xB0, 0xC9)):
        for trail in range(0xA1, 0xFF):
            try:
                chars.add(bytes([lead, trail]).decode('euc_kr'))
            except UnicodeDecodeError:
                pass
    return chars


def text_chars():
    """본문·메모에 실제로 쓰인 글자"""
    chars = set()
    for path in list((ROOT / 'data' / 'bible').glob('*/*.json')) + [ROOT / 'data' / 'memos.json']:
        if path.exists():
            chars.update(path.read_text(encoding='utf-8'))
    return chars


def main(src):
    wanted = ksx1001_chars() | text_chars()
    wanted |= {chr(c) for c in range(0x20, 0x7F)}      # ASCII
    wanted |= {chr(c) for c in range(0xA0, 0x180)}     # 라틴-1, 라틴 확장-A
    wanted |= {chr(c) for c in range(0x2010, 0x2050)}  # 일반 문장부호(따옴표·줄표·말줄임표 등)
    wanted |= {chr(c) for c in range(0x3000, 0x3040)}  # CJK 기호와 문장부호
    wanted |= {chr(c) for c in range(0x3130, 0x3190)}  # 한글 호환 자모
    wanted -= {c for c in wanted if c in '\n\r\t' or ord(c) < 0x20 or 0x7F <= ord(c) < 0xA0}

    font = TTFont(src)
    font = instancer.instantiateVariableFont(font, {'wght': 400})
    tmp = OUT / '_instance.ttf'
    font.save(tmp)

    opts = subset.Options()
    opts.layout_features = []     # 가로쓰기 기본 배치만 쓰므로 GSUB/GPOS 제거
    opts.hinting = False
    opts.glyph_names = False
    opts.notdef_outline = True
    opts.name_IDs = [1, 2, 3, 4, 6]
    opts.drop_tables += ['STAT', 'DSIG']
    sub = subset.Subsetter(opts)
    f = TTFont(tmp)
    cmap = f.getBestCmap()
    sub.populate(unicodes=[ord(c) for c in wanted if ord(c) in cmap])
    sub.subset(f)
    dest = OUT / 'NotoSansKR-subset.ttf'
    f.save(dest)
    tmp.unlink()

    g = TTFont(dest)
    order = g.getGlyphOrder()
    hmtx = g['hmtx']
    cm = g.getBestCmap()
    hhea, head, os2 = g['hhea'], g['head'], g['OS/2']
    meta = {
        'upm': head.unitsPerEm,
        'ascent': hhea.ascent,
        'descent': hhea.descent,
        'capHeight': getattr(os2, 'sCapHeight', 700),
        'bbox': [head.xMin, head.yMin, head.xMax, head.yMax],
        'adv': [hmtx[name][0] for name in order],
        'map': {str(cp): order.index(name) for cp, name in sorted(cm.items())},
    }
    (OUT / 'NotoSansKR-subset.json').write_text(json.dumps(meta, separators=(',', ':')), encoding='utf-8')
    print(f'글자 {len(cm)}개, 글리프 {len(order)}개, TTF {dest.stat().st_size:,}바이트')
    missing = sorted(c for c in wanted if ord(c) not in cm)
    print(f'글꼴에 없는 글자 {len(missing)}개:', ''.join(missing)[:200])


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
