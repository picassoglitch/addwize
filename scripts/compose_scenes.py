#!/usr/bin/env python3
"""Turn the generated illustrations in art/generated/ into playable 1080x1920 scenes.

Each scene gets the deck's "FIND THE OWL" banner, timer box and icon bar (cut from
public/scenes/aula.jpg, built by extract_deck_art.py) so every room looks like the same game.
Scenes whose art contains text aren't mirrored (the text would read backwards).

Hiding spots live in SCENES below as (x, y, owl height) in 1080x1920 px.
Writes public/scenes/<id>.jpg, <id>-mirror.jpg and merges them into scenes.default.json.

Usage: python3 scripts/compose_scenes.py
"""
import json, os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'art', 'generated')
OUT = os.path.join(ROOT, 'public', 'scenes')
W, H = 1080, 1920

# Pieces of the deck UI in aula.jpg (1080x1800): box, corner radius, where it goes on the 1080x1920 scene.
DECK = os.path.join(OUT, 'aula.jpg')
BANNER = ((163, 39, 972, 285), 55, (163, 39))
TIMER = ((339, 219, 806, 435), 36, (339, 219))
ICONBAR = ((19, 1587, 1063, 1797), 70, (19, H - 222))
# Live clock overlay = the "10.0" digits inside the timer box.
TIMER_BOX = {'x': 0.4769, 'y': round(249 / H, 4), 'w': 0.2407, 'h': round(122 / H, 4), 'bg': '#011d4e'}

# Where the light comes from in each room (0..1), used by the sunset/night moods.
LIGHTS = {
    'parque': {'lamp': [0.5, 0.08], 'win': [0.5, 0.3]},
    'biblioteca': {'lamp': [0.25, 0.3], 'win': [0.22, 0.36]},
    'recamara': {'lamp': [0.76, 0.3], 'win': [0.76, 0.34]},
    'laboratorio': {'lamp': [0.15, 0.32], 'win': [0.92, 0.36]},
    'consultorio': {'lamp': [0.1, 0.18], 'win': [0.1, 0.22]},
    'arte': {'lamp': [0.08, 0.24], 'win': [0.08, 0.28]},
}

SCENES = {
    # id: (mirror?, weight, [(x, y, owl height px), ...])
    'parque': (False, 2, [(90, 525, 90), (900, 420, 85), (675, 620, 95), (250, 790, 90), (1000, 690, 90), (720, 950, 90), (130, 765, 90), (300, 975, 90), (450, 1140, 90), (780, 1350, 95), (630, 1420, 95), (330, 1530, 90), (980, 1260, 90)]),
    'biblioteca': (True, 2, [(960, 525, 110), (850, 650, 110), (150, 975, 120), (455, 1030, 95), (518, 1160, 110), (690, 1185, 100), (990, 1180, 120), (95, 1130, 120), (330, 1420, 100), (800, 1545, 110), (1000, 1560, 100), (250, 1580, 100)]),
    'recamara': (True, 2, [(240, 440, 100), (440, 618, 100), (330, 860, 110), (190, 1035, 110), (700, 720, 105), (820, 665, 100), (900, 1060, 115), (430, 1330, 105), (735, 1240, 100), (900, 1380, 100), (600, 1580, 95), (880, 1560, 100)]),
    'laboratorio': (True, 2, [(230, 440, 90), (180, 640, 95), (700, 540, 95), (845, 850, 95), (860, 1025, 105), (600, 1060, 100), (480, 1215, 100), (150, 1150, 95), (280, 1560, 100), (840, 1610, 100), (990, 1480, 95)]),
    'consultorio': (False, 2, [(230, 425, 90), (60, 780, 100), (575, 690, 95), (700, 690, 95), (990, 790, 95), (650, 915, 100), (300, 915, 105), (420, 1190, 100), (480, 1270, 105), (870, 1190, 95), (570, 1515, 100), (880, 1470, 95)]),
    'arte': (True, 2, [(150, 820, 90), (70, 745, 85), (300, 1100, 105), (560, 1110, 95), (690, 1000, 95), (870, 745, 90), (680, 1300, 100), (930, 1310, 95), (520, 1320, 95), (300, 1560, 95), (840, 1600, 95), (660, 610, 90)]),
}


def fit(img):
    s = W / img.width
    img = img.resize((W, round(img.height * s)), Image.LANCZOS)
    top = (img.height - H) // 2
    return img.crop((0, top, W, top + H))


def add_ui(img, deck):
    for box, radius, at in (BANNER, TIMER, ICONBAR):
        piece = deck.crop(box)
        mask = Image.new('L', piece.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((2, 2, piece.width - 3, piece.height - 3), radius, fill=255)
        img.paste(piece, at, mask.filter(ImageFilter.GaussianBlur(2)))
    return img


def main():
    deck = Image.open(DECK).convert('RGB')
    entries = []
    for sid, (mirror, weight, spots) in SCENES.items():
        art = fit(Image.open(os.path.join(SRC, f'{sid}.jpg')).convert('RGB'))
        add_ui(art.copy(), deck).save(os.path.join(OUT, f'{sid}.jpg'), quality=88)
        if mirror:
            add_ui(art.transpose(Image.FLIP_LEFT_RIGHT), deck).save(os.path.join(OUT, f'{sid}-mirror.jpg'), quality=88)
        entry = {'id': sid, 'image': f'/scenes/{sid}.jpg', 'weight': weight, 'enabled': bool(spots),
                 'timerBox': TIMER_BOX, 'lights': LIGHTS[sid], 'sprite': '/img/owl.png',
                 'spots': [{'x': round(x / W, 4), 'y': round(y / H, 4), 'r': round(h / 2 / W, 4)} for x, y, h in spots]}
        if mirror:
            entry['mirrorImage'] = f'/scenes/{sid}-mirror.jpg'
        entries.append(entry)
        print(f'{sid}: {len(spots)} spots{" + mirror" if mirror else ""}')

    path = os.path.join(OUT, 'scenes.default.json')
    existing = [s for s in json.load(open(path)) if s['id'] not in SCENES]
    json.dump(existing + entries, open(path, 'w'), indent=2)


if __name__ == '__main__':
    main()
