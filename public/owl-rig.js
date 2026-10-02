// Live owl: the official /img/owl.png on a WebGL mesh that is deformed every frame
// (breathing, head tilts, wing flaps, ear twitches, eyes that follow a point) plus
// shader-drawn eyelids for blinking. No extra artwork needed — the same image, made to move.
//
//   const owl = createOwl(container);   // fills the container's width
//   owl.lookAt(clientX, clientY); owl.hop(); owl.flap(3); owl.happy(); owl.sad();
//   await owl.flyBy(dx, dy);            // fly to an offset (px) and back home
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
varying vec2 v_uv; uniform sampler2D u_tex; uniform vec2 u_img; uniform float u_blink;
uniform vec3 u_eye0; uniform vec3 u_eye1;
// Upper and lower lids close onto a curved "sleepy smile" line just below the eye centre.
vec3 lid(vec3 rgb, float a, vec2 p, vec3 e) {
  if (u_blink < 0.01) return rgb;
  float rr = length(p - e.xy) / e.z;
  float inside = 1.0 - smoothstep(1.0, 1.06, rr);
  float dxn = clamp((p.x - e.x) / e.z, -1.0, 1.0);
  float closeY = e.y + 0.12 * e.z + 0.24 * e.z * (1.0 - dxn * dxn);
  float upper = mix(e.y - 1.08 * e.z, closeY, u_blink);
  float lower = mix(e.y + 1.08 * e.z, closeY + 1.0, u_blink);
  float upperMask = 1.0 - smoothstep(upper - 1.2, upper + 1.2, p.y);
  float lowerMask = smoothstep(lower - 1.2, lower + 1.2, p.y);
  float covered = max(upperMask, lowerMask) * inside;
  // Feather-white lid, shaded toward the rim like the rest of the face disc.
  vec3 lidCol = mix(vec3(0.97, 0.95, 0.97), vec3(0.66, 0.60, 0.70), smoothstep(0.45, 1.0, rr) * 0.75);
  lidCol *= mix(0.92, 1.0, smoothstep(e.y - e.z, e.y, p.y));
  // Lash line along the upper lid edge, thickest in the middle.
  float thick = 2.0 + 2.5 * (1.0 - dxn * dxn);
  float lash = (1.0 - smoothstep(thick * 0.5, thick, abs(p.y - upper))) * inside;
  lidCol = mix(lidCol, vec3(0.28, 0.17, 0.11), lash);
  return mix(rgb, lidCol * a, max(covered, lash));
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
  const uBlink = U('u_blink');
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
  };
  let blink = 0, flapHz = 0, flapAmp = 0, flapT = 0, breathT = Math.random() * 10;
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
    p[0] = FEET.x + (p[0] - FEET.x) * (1 + 0.022 * breath * wb);
    p[1] -= breath * 3 * (1 - wb) + breath * 1.5 * wb * (1 - y / IMG_H);
    // Head tilt and bob around the neck.
    const wh = smooth(380, 290, y);
    if (wh > 0) { rotate(p, NECK, S.head.v * wh); p[1] += S.bob.v * wh; }
    // Squash & stretch from the feet.
    p[0] = FEET.x + (p[0] - FEET.x) * S.sx.v;
    p[1] = FEET.y + (p[1] - FEET.y) * S.sy.v;
    pos[k * 2] = p[0] + PAD_X;
    pos[k * 2 + 1] = p[1] + PAD_TOP;
  }

  // ----- idle brain -----
  const timers = { blink: 0, look: 0, tilt: 0, ear: 0, ruffle: 0 };
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
  function frame(now) {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    breathT += dt * (Math.PI * 2 / 3.4);
    brain(now);
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
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
    }
    wrap.style.transform = `translate(${S.x.v}px, ${S.y.v - S.lift.v}px) rotate(${S.tilt.v}rad)`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  blinker();

  // ----- actions -----
  async function flap(times = 3, amp = 0.45, hz = 5) {
    flapAmp = amp; flapHz = hz; flapT = 0;
    await sleep((times / hz) * 1000);
    flapHz = 0; S.wingL.target = 0; S.wingR.target = 0;
  }
  async function hop(height = 0.12) {
    const h = wrap.clientHeight * height;
    S.sx.target = 1.07; S.sy.target = 0.9;
    await sleep(110);
    S.sx.target = 0.95; S.sy.target = 1.08; S.lift.target = h;
    S.wingL.target = 0.3; S.wingR.target = 0.3;
    await sleep(230);
    S.lift.target = 0; S.wingL.target = 0; S.wingR.target = 0;
    S.sx.target = 1; S.sy.target = 1;
    await sleep(220);
    S.sx.target = 1.08; S.sy.target = 0.9;
    await sleep(110);
    S.sx.target = 1; S.sy.target = 1;
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
      S.head.target = Math.max(-0.12, Math.min(0.12, dx / (r.width * 6)));
      externalLookUntil = performance.now() + holdMs;
    },
    blink: doBlink,
    flap,
    hop,
    async happy() {
      busy = true;
      S.lookX.target = 0; S.lookY.target = -0.2;
      for (let i = 0; i < 2; i++) { flap(2, 0.6, 7); await hop(0.16); }
      S.head.target = 0.15; await sleep(250); S.head.target = -0.15; await sleep(250); S.head.target = 0;
      busy = false;
    },
    async sad() {
      busy = true;
      S.head.target = 0.2; S.bob.target = 10; S.lookY.target = 0.8; S.lookX.target = -0.3;
      S.wingL.target = -0.06; S.wingR.target = -0.06;
      await sleep(400); await doBlink(); await sleep(1600);
      S.bob.target = 0; S.head.target = 0; S.wingL.target = 0; S.wingR.target = 0;
      busy = false;
    },
    // Take off, fly to (dx, dy) px from home with flapping + banking, then fly back and land.
    async flyBy(dx, dy, { stayMs = 900 } = {}) {
      if (busy) return;
      busy = true;
      S.sx.target = 1.06; S.sy.target = 0.92; await sleep(120);
      S.sx.target = 0.96; S.sy.target = 1.05;
      flapAmp = 0.75; flapHz = 6;
      S.lift.target = wrap.clientHeight * 0.15;
      S.x.target = dx; S.y.target = dy; S.tilt.target = Math.sign(dx) * 0.18;
      S.lookX.target = Math.sign(dx); S.lookY.target = 0;
      await sleep(1300);
      S.tilt.target = 0; flapAmp = 0.35; flapHz = 3;
      await sleep(stayMs);
      flapAmp = 0.75; flapHz = 6;
      S.x.target = 0; S.y.target = 0; S.tilt.target = -Math.sign(dx) * 0.18; S.lookX.target = -Math.sign(dx);
      await sleep(1300);
      S.tilt.target = 0; S.lift.target = 0; flapHz = 0; S.wingL.target = 0; S.wingR.target = 0;
      await sleep(250);
      S.sx.target = 1.08; S.sy.target = 0.9; await sleep(120);
      S.sx.target = 1; S.sy.target = 1;
      busy = false;
    },
    // Move this owl into another container (e.g. from the confirm screen to the result screen).
    mount(el) { el.append(wrap); },
    destroy() { alive = false; gl.getExtension('WEBGL_lose_context')?.loseContext(); wrap.remove(); },
    // Owl Lab only: hold a pose for inspection.
    _pose({ blink: b, wing, head, look } = {}) {
      if (b !== undefined) blink = b;
      if (wing !== undefined) { flapHz = 0; S.wingL.target = wing; S.wingR.target = wing; }
      if (head !== undefined) S.head.target = head;
      if (look) { S.lookX.target = look[0]; S.lookY.target = look[1]; externalLookUntil = performance.now() + 60_000; }
      idle = false;
    },
  };
  return api;
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
  return { el: wrap, mount: (el) => el.append(wrap), _pose() {}, lookAt() {}, blink: noop, flap: noop, hop: noop, happy: noop, sad: noop, flyBy: noop, destroy: () => wrap.remove() };
}
