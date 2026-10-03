# Addwize Focus Challenge

Stand activation for Sun Pharma / The Bro Media: doctors register on an **iPad**, get a
folio (`ADD-1234`), type it on the **touch screen**, and have **10 seconds to find the owl**.
Results go to a live leaderboard, finders get an instant prize code (`OWL-1234`), and every
folio enters the final on-screen raffle.

```
iPad /register ──► folio ADD-1234 ──► Touch screen /play ──► 10 s game ──► leaderboard + prize code
                                                                     ▲
                                Staff /admin ── stats · prizes · raffle · scenes · CSV export
```

## Deploy (Vercel)

- **Static pages** are served from `public/`.
- **API:** one Node function, `api/index.js` → `lib/app.js`.
- **Database:** Neon Postgres. Tables are created automatically on first request.
- **Live updates:** the touch screen and leaderboard check `/api/state` every 2 s.

1. Import the GitHub repo into Vercel (Framework preset: *Other*; `vercel.json` sets the rest).
2. Storage → add **Neon** from the Marketplace and connect it to the project. This sets `DATABASE_URL`.
3. Set the environment variables below. Production refuses to serve until `ADMIN_PIN` is set.

| Device | URL | Setup |
|---|---|---|
| iPad (or any phone/PC) | `https://<app>/register` | Safari → Share → *Add to Home Screen*, then **Guided Access** |
| Touch screen | `https://<app>/play` | Chrome kiosk: `chrome --kiosk https://<app>/play` |
| Staff | `https://<app>/admin` | `ADMIN_PIN` |

The venue needs internet; there is no offline mode. Test the stand's Wi-Fi (or bring a 4G/5G hotspot).

## Local dev

```bash
npm install
npm run dev        # http://localhost:3000, embedded Postgres in .data/ (no DATABASE_URL needed)
npm test
```

Set `DATABASE_URL` to point local dev at a Neon branch instead.

## Config (env vars)

| Var | Default | |
|---|---|---|
| `DATABASE_URL` | – | Set by the Neon integration |
| `ADMIN_PIN` | dev: `4321` | **Required in prod, 8+ chars** |
| `KIOSK_KEY` | – | Optional. If set, only devices opened once with `?k=KEY` can register or play |
| `TIME_LIMIT_MS` | `10000` | |
| `MAX_PLAYS_PER_FOLIO` | `1` | Staff can grant +1 from admin |
| `PRIZE_MAX_MS` | `10000` | Instant prize if found within this time |
| `PRIZE_STOCK` | `0` | Max instant prizes (0 = unlimited) |
| `RAFFLE_REQUIRES_PLAY` | off | `1` = only folios that played enter the raffle |
| `LEADERBOARD_SIZE` | `10` | |

Tiers: 0–3 s **ULTRA FOCUS**, 3–6 s **SHARP FOCUS**, 6–10 s **FOCUS COMPLETED** (`config.js`).

## Game scenes

8 scenes, all with the deck's "FIND THE OWL" banner, timer box (live clock drawn over its "10.0") and icon bar:

| Scene | Source | Spots | Mirrored |
|---|---|---|---|
| `aula` | Deck classroom, owl fixed on the bookshelf | 1 | ✓ |
| `aula-variable` | Deck classroom, owl painted out | 12 | ✓ |
| `parque` · `biblioteca` · `recamara` · `laboratorio` · `consultorio` · `arte` | Generated in the deck's style | 11–13 each | all but `parque` and `consultorio` (they contain text) |

So players can't learn the answer, every play also randomises:
- **Scene and spot:** weighted toward the variable scenes. The same variant never appears twice in a row.
- **Mirroring:** the room flips, but the banner, timer and icon bar stay readable.
- **Lighting:** day, sunset or night, lit from each room's own lamp or window (`lights`). Night is harder.
- **Owl size:** ±12%.

That's ~600 distinct rounds. Settings live in `public/scenes/scenes.default.json`; staff edits from
Admin → **Escenas** are saved in the database (`settings` table) and override the file.

**Rebuilding:**
- `scripts/extract_deck_art.py`: the deck classroom (needs the PDF).
- `scripts/compose_scenes.py`: the generated rooms. Source art in `art/generated/`; hiding spots and lights are in the script.

**Adding a room:**
1. Generate it with the prompt in `art/generated/PROMPTS.md`.
   - Model: `gemini-3-pro-image`, with the deck classroom as style reference.
   - Key: `GEMINI_API_KEY` in `~/.config/secrets/ai.env`.
2. Save it as `art/generated/<id>.jpg`.
3. Add its spots and lights to `compose_scenes.py`, then re-run it.

The deck's own classroom is a low-res mockup (~390×650, upscaled); hi-res originals from The Bro Media
would sharpen it (see `ART.md`). If no scene is active, the game falls back to generated emoji scenes.

Replace `public/aviso.html` with the approved privacy notice.

## Live owl

`public/owl-rig.js` animates the official `/img/owl.png` on a WebGL mesh: breathing, blinking
(shader-drawn eyelids), head tilts, ear twitches, wing flaps, gaze that follows touches, hops, flights,
tricks (flip, dance, hover) and happy/sad reactions. Preview every move at `/owl-lab`.

- **Attract screen:** tap the owl for a trick; tap elsewhere and it flies to you. It flies laps when nobody has touched the screen for 8 s. Only **JUGAR** opens the PIN pad.
- **PIN pad:** the owl perches beside it and hops with each digit.
- **Confirm/result/raffle:** it reacts to the outcome: celebrates a find or the raffle winner, droops when time runs out.
- **iPad:** it watches the field being typed in, hops on choices and celebrates the folio.

The owl hidden in the game itself stays still, so motion doesn't give it away.
For full wing-spread flight, the agency would need to supply the owl as a Rive/Spine rig or alpha video.

## Integrity

- Folios are random, not sequential. The screen shows the player's name before they start.
- One play per folio. An abandoned play frees up again after 60 s.
- The server checks that the winning tap is on the owl and that the reported time fits the server clock.
- Wrong taps lock input for 350 ms, so wiping the whole screen doesn't work.
- Re-registering with the same email returns the same folio.
- Each raffle draw is stored with the pool size and a SHA-256 of the pool's folios, and previous winners are excluded.
- Public screens show only "Nombre I.". Email and phone are only visible behind the admin PIN.
- CSV export is formula-injection safe.

## Test

```bash
npm test
```
