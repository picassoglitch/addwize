// All runtime settings come from env vars (Vercel project settings in production).
const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

// The deployment is on the public internet, so production refuses to run with weak secrets.
export const isProd = Boolean(env.VERCEL_ENV) && env.VERCEL_ENV !== 'development';

export const config = {
  // Staff PIN for /admin. Production requires 8+ characters (the admin API is internet-facing).
  adminPin: env.ADMIN_PIN || (isProd ? '' : '4321'),
  // Optional shared secret to lock registration/play to specific devices (open /register?k=KEY
  // once per device). Unset = any PC, phone or tablet can register and play.
  kioskKey: env.KIOSK_KEY || '',

  timeLimitMs: int(env.TIME_LIMIT_MS, 10_000),
  maxPlaysPerFolio: int(env.MAX_PLAYS_PER_FOLIO, 1),
  // Instant prize: awarded when the owl is found within this time...
  prizeMaxMs: int(env.PRIZE_MAX_MS, 10_000),
  // ...while stock lasts (0 = unlimited).
  prizeStock: int(env.PRIZE_STOCK, 0),
  // Raffle pool: everyone registered (deck) or only those who played.
  raffleRequiresPlay: env.RAFFLE_REQUIRES_PLAY === '1',

  tiers: [
    { maxMs: 3000, label: 'ULTRA FOCUS' },
    { maxMs: 6000, label: 'SHARP FOCUS' },
    { maxMs: 10_000, label: 'FOCUS COMPLETED' },
  ],

  leaderboardSize: int(env.LEADERBOARD_SIZE, 10),
};

export function configProblems() {
  const problems = [];
  if (isProd && config.adminPin.length < 8) problems.push('ADMIN_PIN must be set (8+ characters)');
  return problems;
}
