// Live owl: the official /img/owl.png on a WebGL mesh that is deformed every frame
// (breathing, head tilts, wing flaps, ear twitches, eyes that follow a point) plus
// shader-drawn eyelids for blinking. No extra artwork needed — the same image, made to move.
//
//   const owl = createOwl(container);   // fills the container's width
//   owl.lookAt(clientX, clientY); owl.hop(); owl.flap(3); owl.happy(); owl.sad();
//   owl.react();                        // random happy trick (flip, wiggle, double hop…) or a mid-air roll
//   owl.flyTo(clientX, clientY);        // fly to a screen point, hover, swoop back home
//   owl.tour();                         // lap around the whole screen
//   owl.hits(clientX, clientY);         // is that point on the owl?
//   owl.mount(otherContainer);          // move it to another screen
//
// Falls back to a plain <img> with a CSS bob when WebGL isn't available.

const SRC = '/img/owl.png';
const IMG_W = 437, IMG_H = 584;
// Landmarks in owl.png pixels.
const EYES = [{ x: 145, y: 191, r: 50 }, { x: 306, y: 199, r: 48 }];
const NECK = { x: 220, y: 335 };
const WING_L = { x: 100, y: 300 }, WING_R = { x: 342, y: 305 };
const TUFT_L = { x: 100, y: 100 }, TUFT_R = { x: 340, y: 100 };
const FEET = { x: 220, y: 584 };
// Room around the image for flapping wings / tilted head.
const PAD_X = 110, PAD_TOP = 40, PAD_BOTTOM = 20;
const W = IMG_W + PAD_X * 2, H = IMG_H + PAD_TOP + PAD_BOTTOM;
const COLS = 44, ROWS = 58;

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rotate(p, pivot, a) {
  if (!a) return;
  const c = Math.cos(a), s = Math.sin(a), dx = p[0] - pivot.x, dy = p[1] - pivot.y;
  p[0] = pivot.x + dx * c - dy * s;
  p[1] = pivot.y + dx * s + dy * c;
}

// Critically damped spring toward `target`.
class Spring {
  constructor(v = 0, k = 120) { this.v = v; this.vel = 0; this.target = v; this.k = k; }
  step(dt) {
    const a = this.k * (this.target - this.v) - 2 * Math.sqrt(this.k) * this.vel;
    this.vel += a * dt;
    this.v += this.vel * dt;
    return this.v;
  }
}

const VERT = `
attribute vec2 a_pos; attribute vec2 a_uv; varying vec2 v_uv; uniform vec2 u_size;
void main() { vec2 c = a_pos / u_size * 2.0 - 1.0; gl_Position = vec4(c.x, -c.y, 0.0, 1.0); v_uv = a_uv; }`;

const FRAG = `
precision mediump float;
varying vec2 v_uv; uniform sampler2D u_tex; uniform vec2 u_img; uniform float u_blink; uniform float u_smile;
uniform vec3 u_eye0; uniform vec3 u_eye1;
// Blink: upper and lower lids close onto a curved "sleepy" line just below the eye centre.
// Smile: the lower lid pushes up into an arch (cheeks raised); at full smile the upper lid
// meets it, closing the eye into a happy ^ arc.
vec3 lid(vec3 rgb, float a, vec2 p, vec3 e) {
  if (u_blink < 0.01 && u_smile < 0.01) return rgb;
  float rr = length(p - e.xy) / e.z;
  float inside = 1.0 - smoothstep(1.0, 1.06, rr);
  float dxn = clamp((p.x - e.x) / e.z, -1.0, 1.0);
  float closeY = e.y + 0.12 * e.z + 0.24 * e.z * (1.0 - dxn * dxn);
  float archY = e.y + e.z * (0.3 - 0.5 * (1.0 - dxn * dxn));
  float shut = smoothstep(0.65, 1.0, u_smile);
  float upper = max(mix(e.y - 1.08 * e.z, closeY, u_blink), mix(e.y - 1.08 * e.z, archY, shut));
  float lower = min(mix(e.y + 1.08 * e.z, closeY + 1.0, u_blink), mix(e.y + 1.08 * e.z, archY + 1.0, u_smile));
  float upperMask = 1.0 - smoothstep(upper - 1.2, upper + 1.2, p.y);
  float lowerMask = smoothstep(lower - 1.2, lower + 1.2, p.y);
  float covered = max(upperMask, lowerMask) * inside;
  // Feather-white lid, shaded toward the rim like the rest of the face disc.
  vec3 lidCol = mix(vec3(0.97, 0.95, 0.97), vec3(0.66, 0.60, 0.70), smoothstep(0.45, 1.0, rr) * 0.75);
  lidCol *= mix(0.92, 1.0, smoothstep(e.y - e.z, e.y, p.y));
  // Dark lash line along the upper lid edge once it's coming down, thickest in the middle.
  float thick = 2.0 + 2.5 * (1.0 - dxn * dxn);
  float lashOn = max(step(0.01, u_blink), shut);
  float lash = (1.0 - smoothstep(thick * 0.5, thick, abs(p.y - upper))) * inside * lashOn;
  // Crease along the top of the raised lower lid so a half smile reads as cheeks, not a blob.
  float crease = (1.0 - smoothstep(1.2, 3.2, abs(p.y - lower))) * inside * smoothstep(0.05, 0.4, u_smile) * (1.0 - lashOn);
  lidCol = mix(lidCol, vec3(0.28, 0.17, 0.11), max(lash, crease * 0.85));
  return mix(rgb, lidCol * a, max(max(covered, lash), crease * 0.85));
}
void main() {
  vec4 c = texture2D(u_tex, v_uv);
  vec2 p = v_uv * u_img;
  vec3 rgb = lid(c.rgb, c.a, p, u_eye0);
  rgb = lid(rgb, c.a, p, u_eye1);
  gl_FragColor = vec4(rgb, c.a);
}`;

export function createOwl(container, { idle = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'owlActor';
  wrap.style.cssText = 'position:relative;width:100%;aspect-ratio:' + W + '/' + H + ';will-change:transform;pointer-events:none';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  wrap.append(canvas);
  container.append(wrap);

  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: true });
  if (!gl) return fallback(container, wrap);

  // ----- GL setup -----
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fallback(container, wrap);
  gl.useProgram(prog);

  const n = (COLS + 1) * (ROWS + 1);
  const base = new Float32Array(n * 2), pos = new Float32Array(n * 2), uv = new Float32Array(n * 2);
  for (let j = 0, k = 0; j <= ROWS; j++) {
    for (let i = 0; i <= COLS; i++, k++) {
      base[k * 2] = (i / COLS) * IMG_W;
      base[k * 2 + 1] = (j / ROWS) * IMG_H;
      uv[k * 2] = i / COLS;
      uv[k * 2 + 1] = j / ROWS;
    }
  }
  const idx = new Uint16Array(COLS * ROWS * 6);
  for (let j = 0, t = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const a = j * (COLS + 1) + i, b = a + 1, c = a + COLS + 1, d = c + 1;
      idx.set([a, b, c, b, d, c], t);
      t += 6;
    }
  }
  const buf = (data, attr) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, attr === 'a_pos' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, attr);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return b;
  };
  const posBuf = buf(pos, 'a_pos');
  buf(uv, 'a_uv');
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

  const U = (name) => gl.getUniformLocation(prog, name);
  gl.uniform2f(U('u_size'), W, H);
  gl.uniform2f(U('u_img'), IMG_W, IMG_H);
  gl.uniform3f(U('u_eye0'), EYES[0].x, EYES[0].y, EYES[0].r);
  gl.uniform3f(U('u_eye1'), EYES[1].x, EYES[1].y, EYES[1].r);
  const uBlink = U('u_blink'), uSmile = U('u_smile');
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let ready = false;
  const img = new Image();
  img.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    ready = true;
  };
  img.src = SRC;

  // ----- pose -----
  const S = {
    head: new Spring(0, 60), bob: new Spring(0, 90), ear: new Spring(0, 200),
    wingL: new Spring(0, 260), wingR: new Spring(0, 260),
    lookX: new Spring(0, 140), lookY: new Spring(0, 140),
    sx: new Spring(1, 300), sy: new Spring(1, 300),
    lift: new Spring(0, 160), tilt: new Spring(0, 80),
    x: new Spring(0, 14), y: new Spring(0, 14),
    scale: new Spring(1, 40), smile: new Spring(0, 120), air: new Spring(0, 30),
  };
  let blink = 0, flapHz = 0, flapAmp = 0, flapT = 0, breathT = Math.random() * 10;
  let spin = 0, jumpY = 0, airborne = false, flight = null, prevFX = 0, prevFY = 0;
  let externalLookUntil = 0, busy = false, alive = true;

  function deform(k, now) {
    const p = [base[k * 2], base[k * 2 + 1]];
    const [x, y] = p;
    // Eyes: the iris/pupil slides toward the look target, the eye rim stays put.
    for (const e of EYES) {
      const w = 1 - smooth(e.r * 0.5, e.r * 0.97, Math.hypot(x - e.x, y - e.y));
      if (w > 0) { p[0] += S.lookX.v * 10 * w; p[1] += S.lookY.v * 7 * w; }
    }
    // Ear tufts twitch.
    const wt = smooth(125, 45, y);
    if (wt > 0) {
      if (x < 150) rotate(p, TUFT_L, -S.ear.v * wt * smooth(170, 110, x));
      else if (x > 290) rotate(p, TUFT_R, S.ear.v * wt * smooth(270, 330, x));
    }
    // Wings rotate outward around the shoulders.
    const notFeet = smooth(540, 500, y); // feet stay planted
    const wl = smooth(140, 80, x) * smooth(285, 335, y) * notFeet;
    if (wl > 0) rotate(p, WING_L, S.wingL.v * wl);
    const wr = smooth(300, 360, x) * smooth(285, 335, y) * notFeet;
    if (wr > 0) rotate(p, WING_R, -S.wingR.v * wr);
    // Breathing: chest swells, head rides on top.
    const breath = Math.sin(breathT);
    const wb = smooth(280, 380, y);
    p[0] = FEET.x + (p[0] - FEET.x) * (1 + 0.028 * breath * wb);
    p[1] -= breath * 3.5 * (1 - wb) + breath * 1.5 * wb * (1 - y / IMG_H);
    // Head tilt and bob around the neck.
    const wh = smooth(380, 290, y);
    if (wh > 0) { rotate(p, NECK, S.head.v * wh); p[1] += S.bob.v * wh; }
    // Squash & stretch from the feet.
    p[0] = FEET.x + (p[0] - FEET.x) * S.sx.v;
    p[1] = FEET.y + (p[1] - FEET.y) * S.sy.v;
    pos[k * 2] = p[0] + PAD_X;
    pos[k * 2 + 1] = p[1] + PAD_TOP;
  }

  // ----- action bookkeeping -----
  // Every new action takes over: older sequences notice they're stale and stop issuing poses.
  let gen = 0;
  function take() {
    const id = ++gen;
    busy = true;
    endFlight();
    if (airborne && !flight) { airborne = false; S.x.target = 0; S.y.target = 0; S.scale.target = 1; }
    neutral();
    return () => id !== gen;
  }
  const release = (stale) => { if (!stale()) busy = false; };
  function neutral() {
    flapHz = 0;
    for (const k of ['wingL', 'wingR', 'head', 'bob', 'lift', 'tilt', 'smile']) S[k].target = 0;
    S.sx.target = 1; S.sy.target = 1;
  }
  async function tween(ms, fn, stale = () => false) {
    const t0 = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) / ms);
      fn(t);
      if (t >= 1 || stale() || !alive) return;
      await new Promise(requestAnimationFrame);
    }
  }
  const easeIO = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

  // Little floating hearts / sparkles / notes above the head.
  function fx(chars = '✨', count = 3) {
    const r = wrap.getBoundingClientRect();
    if (!r.width) return;
    ensureCss();
    for (let i = 0; i < count; i++) {
      const el = document.createElement('span');
      el.className = 'owlFx';
      el.textContent = [...chars][Math.floor(Math.random() * [...chars].length)];
      el.style.cssText = `left:${r.left + r.width * rand(0.3, 0.7)}px;top:${r.top + r.height * rand(0.1, 0.3)}px;` +
        `font-size:${Math.max(16, r.width * rand(0.09, 0.15))}px;--dx:${rand(-1, 1) * r.width * 0.35}px;` +
        `--dy:${-r.height * rand(0.25, 0.5)}px;--r:${rand(-40, 40)}deg;animation-delay:${i * 90}ms`;
      document.body.append(el);
      setTimeout(() => el.remove(), 1400 + i * 90);
    }
  }

  // ----- flight -----
  // Offsets are in px from the owl's home spot; paths are Catmull-Rom splines through waypoints.
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  function pathAt(pts, u) {
    const n = pts.length - 1, f = Math.min(n - 1e-6, u * n), i = Math.floor(f), t = f - i;
    const P = (k) => pts[Math.max(0, Math.min(n, k))];
    const ax = (key) => cr(P(i - 1)[key] ?? 1, P(i)[key] ?? 1, P(i + 1)[key] ?? 1, P(i + 2)[key] ?? 1, t);
    return { x: ax('x'), y: ax('y'), s: ax('s') };
  }
  const flySpeed = () => Math.max(500, innerWidth * 0.6); // px/s
  function flyPath(pts) {
    endFlight();
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const dur = Math.max(600, Math.min(6000, (len / flySpeed()) * 1000 * 1.25));
    airborne = true;
    prevFX = S.x.v; prevFY = S.y.v;
    return new Promise((resolve) => { flight = { pts, t: 0, dur, resolve }; });
  }
  function endFlight() { const f = flight; flight = null; f?.resolve(); }
  function stepFlight(now, dt) {
    flight.t += dt * 1000; // frame time, so a stalled frame can't skip the whole trip
    const u = easeIO(Math.min(1, flight.t / flight.dur));
    const p = pathAt(flight.pts, u);
    S.x.v = S.x.target = p.x; S.x.vel = 0;
    S.y.v = S.y.target = p.y; S.y.vel = 0;
    S.scale.target = p.s;
    const vx = (p.x - prevFX) / dt, vy = (p.y - prevFY) / dt, ref = flySpeed();
    prevFX = p.x; prevFY = p.y;
    S.tilt.target = Math.max(-0.4, Math.min(0.4, (vx / ref) * 0.45)); // bank into the turn
    S.lookX.target = Math.max(-1, Math.min(1, vx / (ref * 0.5)));
    S.lookY.target = Math.max(-0.7, Math.min(0.7, vy / (ref * 0.6)));
    flapAmp = 0.95; flapHz = 4 + Math.max(-1, Math.min(3, (-vy / ref) * 5)); // climb harder
    if (u >= 1) endFlight();
  }
  // Viewport point → offset from home, keeping the whole owl on screen.
  function toOffset(cx, cy) {
    const pr = wrap.parentElement.getBoundingClientRect();
    const w = wrap.offsetWidth, h = wrap.offsetHeight;
    const hw = w * 0.34, top = h * 0.62, bottom = h * 0.5; // room for the float bob and ear tufts
    cx = Math.max(hw, Math.min(innerWidth - hw, cx));
    cy = Math.max(top, Math.min(innerHeight - bottom, cy));
    return { x: cx - (pr.left + w / 2), y: cy - (pr.top + h / 2) };
  }
  const minY = () => toOffset(innerWidth / 2, -1e9).y; // highest offset that keeps the owl on screen
  async function takeoff(stale) {
    S.sx.target = 1.08; S.sy.target = 0.9; await sleep(110);
    if (stale()) return;
    S.sx.target = 0.96; S.sy.target = 1.05;
    flapAmp = 0.75; flapHz = 6; airborne = true;
  }
  async function land(stale) {
    airborne = false; flapHz = 0;
    S.tilt.target = 0; S.lift.target = 0; S.wingL.target = 0; S.wingR.target = 0; S.scale.target = 1;
    S.lookX.target = 0; S.lookY.target = 0;
    await sleep(200);
    if (stale()) return;
    S.sx.target = 1.1; S.sy.target = 0.88; await sleep(120);
    S.sx.target = 1; S.sy.target = 1;
    fx('✨', 2);
  }
  async function roll() {
    fx('✨⭐', 3);
    const from = spin;
    await tween(620, (t) => { spin = from + Math.PI * 2 * easeIO(t); });
    spin = 0;
  }
  // Hover in place with lazy flaps while the flight bob keeps it floating.
  function hover() { flapAmp = 0.4; flapHz = 3.5; S.tilt.target = 0; S.lookX.target = 0; S.lookY.target = 0.2; }

  // ----- tricks (on the ground) -----
  // A real jump: crouch, launch with a stretch, fly a gravity parabola, squash on landing.
  // `during(t)` runs every frame of the airtime (t 0→1) for spins etc.
  async function jump(height = 0.12, { air, during, stale = () => false } = {}) {
    const h = wrap.clientHeight * height;
    air ??= 260 + 520 * Math.sqrt(height); // higher jumps hang longer
    S.sx.target = 1.1; S.sy.target = 0.86;
    await sleep(100);
    if (stale()) return;
    S.sx.target = 0.93; S.sy.target = 1.1;
    S.wingL.target = 0.35; S.wingR.target = 0.35;
    await tween(air, (t) => {
      jumpY = 4 * h * t * (1 - t);
      if (t > 0.35) { S.sx.target = 1; S.sy.target = 1; }
      during?.(t);
    }, stale);
    jumpY = 0;
    S.wingL.target = 0; S.wingR.target = 0;
    S.sx.target = 1.12; S.sy.target = 0.86;
    await sleep(110);
    S.sx.target = 1; S.sy.target = 1;
  }
  const hop = (height = 0.12) => jump(height);

  const TRICKS = {
    async bounce(stale) {
      S.smile.target = 1; fx('✨💛', 2);
      await jump(0.22, { stale });
    },
    async double(stale) {
      S.smile.target = 1;
      await jump(0.1, { stale }); if (stale()) return;
      fx('💛', 2); await jump(0.26, { stale });
    },
    async flip(stale) {
      S.smile.target = 1; fx('✨⭐', 3);
      // Spin only while well off the ground; tuck the wings in the middle of it.
      await jump(0.6, { stale, air: 760, during: (t) => {
        const k = smooth(0.12, 0.85, t);
        spin = Math.PI * 2 * k;
        const w = t < 0.12 || t > 0.85 ? 0.5 : 0.1;
        S.wingL.target = w; S.wingR.target = w;
      } });
      spin = 0;
    },
    async wiggle(stale) {
      S.smile.target = 1; fx('♪♫', 3);
      for (let i = 0; i < 4 && !stale(); i++) {
        const side = i % 2 ? -1 : 1;
        S.tilt.target = side * 0.16; S.head.target = -side * 0.14;
        S.wingL.target = side > 0 ? 0.35 : 0.05; S.wingR.target = side > 0 ? 0.05 : 0.35;
        await jump(0.05, { stale, air: 200 });
      }
    },
    async hover(stale) {
      S.smile.target = 1;
      flapAmp = 0.8; flapHz = 8; S.lift.target = wrap.clientHeight * 0.24; S.sy.target = 1.04;
      fx('✨', 2);
      await sleep(900); if (stale()) return;
      flapHz = 0; S.wingL.target = 0; S.wingR.target = 0; S.lift.target = 0; S.sy.target = 1;
      await sleep(220); if (stale()) return;
      S.sx.target = 1.1; S.sy.target = 0.88; await sleep(110);
      S.sx.target = 1; S.sy.target = 1;
    },
    async bobble(stale) {
      S.smile.target = 1; fx('💛♪', 2); twitch();
      for (let i = 0; i < 4 && !stale(); i++) { S.head.target = i % 2 ? -0.22 : 0.22; S.bob.target = -6; await sleep(150); }
      S.bob.target = 0;
    },
  };
  let lastTrick = '';
  async function trick(name) {
    const stale = take();
    if (!name) {
      const names = Object.keys(TRICKS).filter((n) => n !== lastTrick);
      name = names[Math.floor(Math.random() * names.length)];
    }
    lastTrick = name;
    await TRICKS[name](stale);
    if (!stale()) { neutral(); await sleep(150); }
    release(stale);
  }

  // ----- idle brain -----
  const timers = { blink: 0, look: 0, tilt: 0, ear: 0, ruffle: 0, smile: 0, trick: performance.now() + rand(4000, 8000) };
  function brain(now) {
    if (!idle || busy) return;
    if (now > timers.look && now > externalLookUntil) {
      const center = Math.random() < 0.35;
      S.lookX.target = center ? 0 : rand(-1, 1);
      S.lookY.target = center ? 0 : rand(-0.7, 0.7);
      timers.look = now + rand(1200, 3800);
    }
    if (now > timers.tilt) {
      S.head.target = Math.random() < 0.4 ? 0 : rand(0.07, 0.17) * (Math.random() < 0.5 ? -1 : 1);
      timers.tilt = now + rand(2500, 7000);
    }
    if (now > timers.ear) { twitch(); timers.ear = now + rand(3000, 9000); }
    if (now > timers.ruffle) { flap(2, 0.22); timers.ruffle = now + rand(9000, 16000); }
    // A content little smile now and then.
    if (now > timers.smile) {
      S.smile.target = 0.45;
      setTimeout(() => { if (!busy) S.smile.target = 0; }, rand(1200, 2400));
      timers.smile = now + rand(4000, 9000);
    }
    // Happy to be here: an unprompted small trick every few seconds.
    if (now > timers.trick) {
      trick(['bounce', 'wiggle', 'bobble', 'double'][Math.floor(Math.random() * 4)]);
      timers.trick = now + rand(6000, 12000);
    }
  }
  async function doBlink() {
    const steps = [[0, 1, 70], [1, 1, 40], [1, 0, 120]];
    for (const [a, b, ms] of steps) {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        blink = a + (b - a) * ((performance.now() - t0) / ms);
        await new Promise(requestAnimationFrame);
      }
    }
    blink = 0;
  }
  async function blinker() {
    while (alive) {
      await sleep(rand(1800, 5200));
      if (!alive) return;
      await doBlink();
      if (Math.random() < 0.2) { await sleep(120); await doBlink(); }
    }
  }
  async function twitch() {
    S.ear.target = rand(0.12, 0.22);
    await sleep(110);
    S.ear.target = 0;
  }

  // ----- render loop -----
  let last = performance.now();
  wrap.style.transformOrigin = '50% 60%';
  function frame(now) {
    if (!alive) return;
    const raw = Math.max(0.001, (now - last) / 1000), dt = Math.min(0.05, raw);
    last = now;
    breathT += dt * (Math.PI * 2 / 3.2);
    brain(now);
    if (flight) stepFlight(now, Math.min(0.25, raw));
    if (flapHz > 0) {
      flapT += dt * flapHz * Math.PI * 2;
      const a = flapAmp * (0.5 - 0.5 * Math.cos(flapT));
      S.wingL.target = a;
      S.wingR.target = a;
    }
    for (const s of Object.values(S)) s.step(dt);
    if (ready && canvas.clientWidth > 0) { // skip work while on a hidden screen
      for (let k = 0; k < n; k++) deform(k, now);
      const dpr = Math.min(2, devicePixelRatio || 1);
      const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
      gl.uniform1f(uBlink, blink);
      gl.uniform1f(uSmile, Math.max(0, Math.min(1, S.smile.v)));
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
    }
    // Gentle happy rocking on the ground, a floaty bob in the air.
    const h = wrap.clientHeight;
    S.air.target = airborne ? 1 : 0;
    const sway = (1 - S.air.v) * 0.03 * Math.sin(now * 0.0022);
    // In the air the body rises on each downstroke (wings up = body dips), like real flapping.
    const beat = flapHz > 0 ? Math.cos(flapT) : Math.sin(now * 0.006);
    const float = S.air.v * (beat * h * 0.03 + h * 0.05);
    wrap.style.transform = `translate(${S.x.v}px, ${S.y.v - S.lift.v - jumpY - float}px) rotate(${S.tilt.v + sway + spin}rad) scale(${S.scale.v})`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  blinker();

  // ----- actions -----
  async function flap(times = 3, amp = 0.45, hz = 5) {
    flapAmp = amp; flapHz = hz; flapT = 0;
    await sleep((times / hz) * 1000);
    if (airborne) return;
    flapHz = 0; S.wingL.target = 0; S.wingR.target = 0;
  }
  // Fly from wherever it is to the given offsets (px from home) and back, then land.
  async function excursion(waypoints, { stayMs = 0, rollChance = 0 } = {}) {
    const stale = take();
    if (S.lift.v < 2 && !airborne) await takeoff(stale);
    if (stale()) return;
    S.smile.target = 0.5;
    const out = [{ x: S.x.v, y: S.y.v, s: S.scale.v }, ...waypoints];
    const go = flyPath(out);
    if (Math.random() < rollChance) setTimeout(() => !stale() && roll(), 500);
    await go;
    if (stale()) return;
    if (stayMs) {
      hover(); S.smile.target = 1; fx('💛✨', 3);
      await sleep(stayMs * 0.4); if (stale()) return;
      flapAmp = 0.9; flapHz = 7; fx('✨', 2); // happy flutter
      await sleep(stayMs * 0.25); if (stale()) return;
      hover();
      await sleep(stayMs * 0.35); if (stale()) return;
    }
    const end = waypoints[waypoints.length - 1];
    // Swoop home on an arc rather than a straight line.
    const mid = { x: end.x * 0.5, y: Math.max(minY(), Math.min(end.y, 0) * 0.5 - wrap.offsetHeight * 0.5), s: 1.05 };
    await flyPath([{ x: S.x.v, y: S.y.v, s: S.scale.v }, mid, { x: 0, y: 0, s: 1 }]);
    if (stale()) return;
    await land(stale);
    release(stale);
  }
  const api = {
    el: wrap,
    lookAt(clientX, clientY, holdMs = 2500) {
      const r = canvas.getBoundingClientRect();
      const ex = r.left + r.width * ((PAD_X + 225) / W), ey = r.top + r.height * ((PAD_TOP + 195) / H);
      const dx = clientX - ex, dy = clientY - ey, d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, d / (r.width * 0.8));
      S.lookX.target = (dx / d) * reach;
      S.lookY.target = (dy / d) * reach * 0.8;
      if (!flight) S.head.target = Math.max(-0.12, Math.min(0.12, dx / (r.width * 6)));
      externalLookUntil = performance.now() + holdMs;
    },
    // True if a viewport point is on the owl's body (not the transparent padding around it).
    hits(clientX, clientY) {
      const r = wrap.getBoundingClientRect();
      const x = (clientX - r.left) / r.width, y = (clientY - r.top) / r.height;
      return x > PAD_X / W && x < 1 - PAD_X / W && y > PAD_TOP / H * 0.5 && y < 1;
    },
    blink: doBlink,
    flap,
    hop,
    fx,
    // A random happy trick (or a barrel roll if it's mid-flight). Good for "any tap".
    react() {
      if (flight || airborne) return roll();
      return trick();
    },
    trick,
    // Fly to a viewport point, hover there happily for a moment, then swoop home.
    flyTo(clientX, clientY, { stayMs = 1400 } = {}) {
      const o = toOffset(clientX, clientY - wrap.offsetHeight * 0.3);
      const from = { x: S.x.v, y: S.y.v };
      const mid = { x: (from.x + o.x) / 2, y: Math.max(minY(), Math.min(from.y, o.y) - wrap.offsetHeight * 0.4), s: 1.1 };
      return excursion([mid, { ...o, s: 1 }], { stayMs });
    },
    // A lap around the whole screen through random waypoints, with depth and maybe a roll.
    tour() {
      const pts = [];
      const n = 3 + Math.floor(Math.random() * 2);
      let side = Math.random() < 0.5 ? -1 : 1;
      for (let i = 0; i < n; i++, side = -side) {
        const cx = innerWidth * (0.5 + side * rand(0.18, 0.38)), cy = innerHeight * rand(0.12, 0.6);
        pts.push({ ...toOffset(cx, cy), s: rand(0.8, 1.15) });
      }
      return excursion(pts, { rollChance: 0.6 });
    },
    async happy() {
      const stale = take();
      S.lookX.target = 0; S.lookY.target = -0.2; S.smile.target = 1;
      fx('💛✨⭐', 5);
      for (let i = 0; i < 2 && !stale(); i++) { flap(2, 0.6, 7); await jump(0.18, { stale }); }
      if (stale()) return;
      await TRICKS.flip(stale);
      if (stale()) return;
      S.head.target = 0.15; await sleep(250); S.head.target = -0.15; await sleep(250);
      neutral();
      release(stale);
    },
    async sad() {
      const stale = take();
      S.head.target = 0.2; S.bob.target = 10; S.lookY.target = 0.8; S.lookX.target = -0.3;
      S.wingL.target = -0.06; S.wingR.target = -0.06;
      await sleep(400); await doBlink(); await sleep(1400);
      if (stale()) return;
      // ...but it never stays down for long.
      neutral(); S.lookY.target = -0.2; await sleep(200);
      if (stale()) return;
      await TRICKS.bounce(stale);
      neutral();
      release(stale);
    },
    // Kept for older callers: fly to an offset (px) from home and back.
    flyBy(dx, dy, { stayMs = 900 } = {}) {
      return excursion([{ x: dx * 0.5, y: dy - wrap.offsetHeight * 0.3, s: 1.1 }, { x: dx, y: dy, s: 1 }], { stayMs });
    },
    get busy() { return busy; },
    // Move this owl into another container (e.g. from the confirm screen to the result screen).
    mount(el) {
      take(); release(() => false);
      airborne = false; spin = 0;
      for (const k of ['x', 'y', 'lift', 'tilt']) { S[k].v = S[k].target = 0; S[k].vel = 0; }
      S.scale.v = S.scale.target = 1;
      el.append(wrap);
    },
    destroy() { alive = false; endFlight(); gl.getExtension('WEBGL_lose_context')?.loseContext(); wrap.remove(); },
    // Owl Lab only: hold a pose for inspection.
    _pose({ blink: b, wing, head, look, smile } = {}) {
      if (b !== undefined) blink = b;
      if (smile !== undefined) S.smile.target = smile;
      if (wing !== undefined) { flapHz = 0; S.wingL.target = wing; S.wingR.target = wing; }
      if (head !== undefined) S.head.target = head;
      if (look) { S.lookX.target = look[0]; S.lookY.target = look[1]; externalLookUntil = performance.now() + 60_000; }
      idle = false;
    },
  };
  return api;
}

function ensureCss() {
  if (document.getElementById('owlFxCss')) return;
  const st = document.createElement('style');
  st.id = 'owlFxCss';
  st.textContent = `.owlFx{position:fixed;z-index:70;pointer-events:none;line-height:1;opacity:0;transform:translate(-50%,-50%);
    animation:owlFx 1.2s ease-out forwards;filter:drop-shadow(0 2px 6px rgba(0,0,0,.35))}
    @keyframes owlFx{0%{opacity:0;transform:translate(-50%,-50%) scale(.3)}
    20%{opacity:1;transform:translate(-50%,-50%) scale(1.15)}
    100%{opacity:0;transform:translate(calc(-50% + var(--dx)),calc(-50% + var(--dy))) scale(.9) rotate(var(--r))}}`;
  document.head.append(st);
}

function fallback(container, wrap) {
  wrap.innerHTML = `<img src="${SRC}" alt="" style="width:${(IMG_W / W) * 100}%;margin:${(PAD_TOP / W) * 100}% auto 0;display:block;animation:owlBob 2.6s ease-in-out infinite">`;
  if (!document.getElementById('owlBobCss')) {
    const st = document.createElement('style');
    st.id = 'owlBobCss';
    st.textContent = '@keyframes owlBob{50%{transform:translateY(-4%) rotate(-3deg)}}';
    document.head.append(st);
  }
  const noop = async () => {};
  return {
    el: wrap, mount: (el) => el.append(wrap), _pose() {}, lookAt() {}, hits: () => false, fx() {}, busy: false,
    blink: noop, flap: noop, hop: noop, happy: noop, sad: noop, flyBy: noop, flyTo: noop, tour: noop, react: noop, trick: noop,
    destroy: () => wrap.remove(),
  };
}
