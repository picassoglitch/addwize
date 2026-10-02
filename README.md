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

The game uses the classroom illustration from the deck ("Mecánica del minigame" slide),
extracted and straightened by `scripts/extract_deck_art.py`. It rotates between two scenes:

- **aula**: the art as designed, with the owl on the bookshelf.
- **aula-variable**: the same art with that owl painted out. Each play, the server drops the
  Addwize mascot (`/img/owl.png`) into one of 12 hiding spots, never the same spot twice in a row.

Both scenes keep the art's "FIND THE OWL" header, and the live clock is drawn over its "10.0" box.
Settings live in `public/scenes/scenes.default.json`, and staff edits are saved in the database (`settings` table).

The deck only has this scene as a low-resolution mockup (~390×650, upscaled), so ask The Bro Media for
the original hi-res illustrations (see `ART.md`). To add more scenes: drop 1080×1920 images into
`public/scenes/`, then Admin → **Escenas** → tap the owl → *Activa* → Guardar.
If no scene is active, the game falls back to generated emoji scenes.

Replace `public/aviso.html` with the approved privacy notice.

## Live owl

`public/owl-rig.js` animates the official `/img/owl.png` on a WebGL mesh: breathing, blinking
(shader-drawn eyelids), head tilts, ear twitches, wing flaps, eyes that follow touches, hops,
fly-bys, and happy/sad reactions. It's used on the attract screen (it flies a lap every 20 s), the
confirm/result/raffle screens and the iPad header. Preview every move at `/owl-lab`.
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
