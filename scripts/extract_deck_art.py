#!/usr/bin/env python3
"""Build the playable classroom scenes from the "Mecánica del minigame" slide of the deck.

The deck only contains the scene as a kiosk mockup photographed at an angle, so this
straightens it, upscales it to the touch-screen width, and produces two scenes:

  aula.jpg           the art as designed, owl on the bookshelf (fixed position)
  aula-variable.jpg  same art with the owl painted out; the server drops the official
                     mascot (/img/owl.png) into one of SPOTS per play
  *-mirror.jpg       mirrored versions (banner, timer, poster and icon bar kept readable)

Usage: python3 scripts/extract_deck_art.py "~/Downloads/ADDWIZE FOCUS CHALLENGE.pdf"
Needs poppler-utils (pdfimages) and Pillow. Replace with hi-res originals when available.
"""
import json, os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'scenes')
OUT_W = 1080

# Kiosk screen corners on slide 5 (UL, LL, LR, UR) and the straightened working size.
QUAD = (374, 170, 367, 820, 759, 795, 755, 205)
W, H = 780, 1300
# Owl drawn in the original art (working px): centre + half-height.
BAKED_OWL = (668, 601, 76)
# Hiding spots for the mascot (working px): centre x, centre y, sprite height.
SPOTS = [(668, 604, 120), (700, 318, 80), (250, 655, 80), (330, 790, 85), (115, 330, 80),
         (420, 770, 70), (470, 985, 85), (225, 1005, 80), (700, 885, 75), (45, 880, 80),
         (560, 640, 70), (150, 560, 70)]
# The art's built-in "10.0" readout; the game draws the live clock over it.
TIMER = (372, 180, 560, 268)
# Elements with text stay readable in the mirrored scenes: pasted back unflipped (x0, y0, x1, y1, radius).
KEEP_UNFLIPPED = [(118, 28, 702, 206, 40),    # FIND THE OWL banner
                  (245, 158, 582, 314, 26),   # timer box
                  (8, 380, 160, 645, 10),     # SUEÑA / EXPLORA poster
                  (14, 1146, 768, 1298, 50)]  # icon bar


def mirrored(img):
    out = img.transpose(Image.FLIP_LEFT_RIGHT)
    for x0, y0, x1, y1, rad in KEEP_UNFLIPPED:
        piece = img.crop((x0, y0, x1, y1))
        mask = Image.new('L', piece.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((2, 2, piece.width - 3, piece.height - 3), rad, fill=255)
        # The poster moves to the other wall with the rest of the room; the UI stays where it was.
        x = W - x1 if (x0, y0) == (8, 380) else x0
        out.paste(piece, (x, y0), mask.filter(ImageFilter.GaussianBlur(2)))
    return out


def main(pdf):
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(['pdfimages', '-f', '5', '-l', '5', '-j', pdf, os.path.join(tmp, 'p')], check=True)
        # Slide 5's full-page render is the 1672-wide jpeg that contains the kiosk mockup.
        cands = [Image.open(os.path.join(tmp, f)) for f in sorted(os.listdir(tmp)) if f.endswith('.jpg')]
        slide = [c for c in cands if c.size == (1672, 941)][-1].convert('RGB')

    art = slide.transform((W, H), Image.QUAD, QUAD, Image.BICUBIC)

    # Paint the owl out with the books row from the shelf below (same shelf geometry).
    src = art.crop((612, 690, 724, 836))
    mask = Image.new('L', src.size, 0)
    ImageDraw.Draw(mask).rectangle((6, 6, src.width - 6, src.height - 2), fill=255)
    clean = art.copy()
    clean.paste(src, (612, 530), mask.filter(ImageFilter.GaussianBlur(3)))

    out_h = round(H * OUT_W / W)
    def save(img, name):
        big = img.resize((OUT_W, out_h), Image.LANCZOS).filter(ImageFilter.UnsharpMask(2, 60, 2))
        big.save(os.path.join(OUT, name), quality=90)

    os.makedirs(OUT, exist_ok=True)
    save(art, 'aula.jpg')
    save(clean, 'aula-variable.jpg')
    save(mirrored(art), 'aula-mirror.jpg')
    save(mirrored(clean), 'aula-variable-mirror.jpg')

    nx, ny = (lambda v: round(v / W, 4)), (lambda v: round(v / H, 4))
    timer = {'x': nx(TIMER[0]), 'y': ny(TIMER[1]), 'w': nx(TIMER[2] - TIMER[0]), 'h': ny(TIMER[3] - TIMER[1]),
             'bg': '#011d4e'}
    scenes = [
        {'id': 'aula', 'image': '/scenes/aula.jpg', 'mirrorImage': '/scenes/aula-mirror.jpg', 'weight': 1,
         'enabled': True, 'timerBox': timer,
         'owl': {'x': nx(BAKED_OWL[0]), 'y': ny(BAKED_OWL[1]), 'r': nx(BAKED_OWL[2])}},
        {'id': 'aula-variable', 'image': '/scenes/aula-variable.jpg', 'mirrorImage': '/scenes/aula-variable-mirror.jpg',
         'weight': 3, 'enabled': True, 'timerBox': timer,
         'sprite': '/img/owl.png',
         'spots': [{'x': nx(x), 'y': ny(y), 'r': nx(s / 2)} for x, y, s in SPOTS]},
    ]
    with open(os.path.join(OUT, 'scenes.default.json'), 'w') as f:
        json.dump(scenes, f, indent=2)
    print(f'wrote {OUT}/aula.jpg, aula-variable.jpg, scenes.default.json ({OUT_W}x{out_h})')


if __name__ == '__main__':
    main(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/Downloads/ADDWIZE FOCUS CHALLENGE.pdf'))
