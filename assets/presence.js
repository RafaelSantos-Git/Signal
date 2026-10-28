/* presence.js: the engine for presence objects (voice orbs and other living shapes).
   It has no look of its own. The product writes the fragment shader (techniques.md section 19);
   this file brings the quad, the noise texture, OKLab ramps, the motion engine (motion.md section 15),
   the baked-track reader with a live-analyser fallback, the pauses and an offline render hook.

   Usage
     const orb = Presence.create(canvas, {
       fragment: SHADER_SOURCE,                 // GLSL ES 1.00 body with void main(); the header below is prepended
       temperament: direction.presence.temperament,
       ramps: [['#4FD8F0', '#9BEFD0', '#FFC27A'], ['#4FD8F0', '#C9B8FF', '#FFC27A']],
       audio: document.querySelector('audio'),  // optional; drives the 'speaking' state
       track: BAKED_TRACK,                      // optional; from presence.py bake (else a live analyser)
       uniforms: (gl, loc, S) => {},            // optional; set the product's own uniforms each frame
       manage: true,                            // optional; false leaves play, pause and ended to the page
     });
     orb.setState('idle' | 'listening' | 'thinking' | 'speaking');
     orb.setLevel(x);                           // a live input level (0..1) for 'listening'
     orb.show(); orb.show(0.35); orb.hide();    // appear (to full or a dimmed level) and leave, eased over temperament.appear / .leave s
     orb.setTrack(BAKED_TRACK);                 // swap in a baked track that arrived late, without a rebuild
     orb.renderAt(seconds);                     // offline: step deterministically to a time, then draw
     orb.destroy();

   Uniforms available to the shader (declared by the header)
     uRes (px), uPx (one pixel in uv units, uv = (frag - res/2) / (res.y/2)), uTime (s, wrapped at 600)
     uNoise (256 px tiling random texture: .r at p equals .g at p + (37,17)), uRamp (256 x N OKLab ramps), uRampRows
     uEnergy (0..1 overall drive), uLevel (fast envelope), uPresence (slow envelope), uLight (spring)
     uAmp (spring, 0.25 at rest to 1 at full voice), uPhase, uPhase2 (integrated phases, radians)
     uCycles (vec3 of slow integrated phases with unrelated periods), uBreath (-1..1 idle breathing)
     uSpark (impulse on onsets, decays), uSparkSeed (counts onsets), uOnsetAge[8] (seconds since the last eight onsets, newest first, 99 when none;
     slot i moves along with every new onset, so give each sparkle its identity from uSparkSeed - i, never from i)
     uState (0 idle, 1 listening, 2 thinking, 3 speaking)
     uOpacity (appear and leave), uReduced (1 under reduced motion)
   Helpers in the header: hash12, noise2 (texture value noise), noise3, fbm2, screen, ramp(x, row). */
(function (root) {
  'use strict';

  const HEADER = `
precision highp float;
uniform vec2 uRes; uniform float uPx, uTime;
uniform sampler2D uNoise; uniform sampler2D uRamp; uniform float uRampRows;
uniform float uEnergy, uLevel, uPresence, uLight, uAmp, uPhase, uPhase2, uBreath, uSpark, uSparkSeed, uState, uOpacity, uReduced;
uniform vec3 uCycles;
uniform float uOnsetAge[8];
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise2(vec2 p){ return texture2D(uNoise, (p + 0.5) / 256.0).r; }
float noise3(vec3 x){ vec3 p = floor(x); vec3 f = fract(x); f = f*f*(3.0 - 2.0*f);
  vec2 uv = (p.xy + vec2(37.0, 17.0)*p.z) + f.xy; vec2 rg = texture2D(uNoise, (uv + 0.5)/256.0).yx; return mix(rg.x, rg.y, f.z); }
float fbm2(vec2 p){ float s = 0.0, a = 0.5; mat2 m = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 4; i++){ s += a*noise2(p*8.0); p = m*p*2.02 + 0.17; a *= 0.5; } return s/0.9375; }
vec3 screen(vec3 a, vec3 b){ return 1.0 - (1.0 - a)*(1.0 - b); }
vec3 ramp(float x, float row){ return texture2D(uRamp, vec2(clamp(x, 0.0, 1.0), (row + 0.5)/max(uRampRows, 1.0))).rgb; }
`;

  // A deliberately plain placeholder, for testing the pipeline before the product's own shader exists.
  const PLACEHOLDER = `
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes) / (0.5*uRes.y);
  float r = length(uv) / (0.55 + 0.04*uAmp + 0.01*uBreath);
  float edge = 1.0 - smoothstep(1.0 - 2.0*uPx, 1.0, r);
  vec3 col = mix(vec3(0.94), vec3(0.62 + 0.25*uLight), edge);
  col += 0.08*sin(uPhase + uv.x*4.0)*edge;
  gl_FragColor = vec4(col*uOpacity, uOpacity);
}`;

  const VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
  const TAU = Math.PI * 2;
  const STATES = { idle: 0, listening: 1, thinking: 2, speaking: 3 };

  /* ---------- colour: OKLab ramps built on the CPU ---------- */
  const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const srgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(x => x + x).join(''); const n = parseInt(h, 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  function toLab([r, g, b]) {
    r = lin(r); g = lin(g); b = lin(b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function toRgb([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]
      .map(c => srgb(Math.min(1, Math.max(0, c))));
  }
  // rows: [[stop, stop, ...], ...]; a stop is '#hex' (evenly spaced) or ['#hex', position 0..1]
  function rampPixels(rows, W = 256) {
    const px = new Uint8Array(W * rows.length * 4);
    rows.forEach((row, y) => {
      const stops = row.map((s, i) => (Array.isArray(s) ? [toLab(hexToRgb(s[0])), s[1]] : [toLab(hexToRgb(s)), row.length > 1 ? i / (row.length - 1) : 0]));
      for (let x = 0; x < W; x++) {
        const t = x / (W - 1); let k = 0;
        while (k < stops.length - 2 && t > stops[k + 1][1]) k++;
        const [a, ta] = stops[k], [b, tb] = stops[Math.min(k + 1, stops.length - 1)];
        const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
        const rgb = toRgb([0, 1, 2].map(i => a[i] + (b[i] - a[i]) * f));
        const o = (y * W + x) * 4; px[o] = rgb[0] * 255 + 0.5; px[o + 1] = rgb[1] * 255 + 0.5; px[o + 2] = rgb[2] * 255 + 0.5; px[o + 3] = 255;
      }
    });
    return px;
  }

  /* ---------- the baked track: {rate, lvl, high, onset} as base64 bytes ---------- */
  function decodeTrack(t) {
    if (!t) return null;
    const u8 = s => (s ? Uint8Array.from(atob(s), c => c.charCodeAt(0)) : null);
    return { rate: t.rate || 100, lvl: u8(t.lvl), high: u8(t.high), onset: u8(t.onset) };
  }
  function sample(A, rate, t) {
    if (!A || !A.length) return 0;
    const x = Math.max(0, t * rate), i = Math.min(A.length - 2, x | 0), f = Math.min(1, x - i);
    return (A[i] * (1 - f) + A[Math.max(0, i + 1)] * f) / 255;
  }
  function onsetBetween(A, rate, t0, t1) {
    if (!A) return false;
    for (let i = Math.max(0, Math.floor(t0 * rate)); i <= Math.floor(t1 * rate) && i < A.length; i++) if (A[i] > 127 && i / rate > t0) return true;
    return false;
  }

  /* ---------- the motion engine: envelopes, springs, integrated phases ---------- */
  function engine(T) {
    // Defaults are neutral placeholders; a product supplies its own temperament (motion.md section 15).
    const tp = Object.assign({ fastest_rhythm: 1.0, slowest_rhythm: 8, attack: 0.08, release: 0.4, damping: 0.85, settle: 1.2, appear: 1.0, leave: 0.6 }, T || {});
    const S = {
      t: 0, level: 0, presence: 0, energy: 0, spark: 0, sparkSeed: 0, lastOnset: -9, opacity: 0, opacityTarget: 0, fadeFrom: 0, fadeTo: 0, fadeK: 1, state: 0, reduced: 0,
      amp: { x: 0.25, v: 0 }, light: { x: 0.25, v: 0 }, phase: 0, phase2: 0, cycles: [0, 1.7, 3.1], breath: 0, onsets: [],
    };
    const presIn = Math.min(0.5, Math.max(0.15, tp.settle * 0.2)), presOut = Math.max(0.3, tp.settle * 0.8);
    const kAmp = (TAU / Math.max(0.3, tp.settle)) ** 2, kLight = (TAU / Math.max(0.12, tp.attack * 4)) ** 2;
    const idlePeriod = tp.slowest_rhythm * 0.6, activePeriod = Math.max(tp.fastest_rhythm * 2, 0.3);
    const refractory = Math.min(0.4, Math.max(0.15, tp.release * 0.6));
    const spring = (s, target, k, z, dt) => { const c = 2 * z * Math.sqrt(k); s.v += (k * (target - s.x) - c * s.v) * dt; s.x += s.v * dt; };
    function step(dt, input, onset) {
      S.t += dt;
      const ease = tau => 1 - Math.exp(-dt / tau);
      S.level += (input - S.level) * ease(input > S.level ? tp.attack : tp.release);
      const on = input > 0.12 ? 1 : 0;
      S.presence += (on - S.presence) * ease(on ? presIn : presOut);
      S.energy = Math.min(1, Math.max(0.05, 0.55 * S.presence + 0.45 * S.level));     // the idle floor keeps it alive
      const e = S.reduced ? 0 : S.energy;
      const period = idlePeriod + (activePeriod - idlePeriod) * e;
      S.phase += dt * TAU / period;
      S.phase2 += dt * TAU / (period * 0.65);
      const sp = 1 + 0.7 * e, base = tp.slowest_rhythm;
      S.cycles[0] += dt * TAU / (base * 0.525) * sp; S.cycles[1] += dt * TAU / (base * 0.742) * sp; S.cycles[2] += dt * TAU / (base * 0.975) * sp;
      S.breath = Math.sin(S.t * TAU / base);
      spring(S.amp, 0.25 + 0.75 * e, kAmp, tp.damping, dt);
      spring(S.light, 0.25 + 0.6 * S.level + 0.15 * S.presence, kLight, 1.0, dt);
      if (onset && S.level > 0.35 && S.t - S.lastOnset > refractory) { S.spark = 1; S.sparkSeed += 1; S.lastOnset = S.t; S.onsets.unshift(S.t); S.onsets.length = Math.min(S.onsets.length, 8); }
      S.spark *= Math.exp(-dt / 0.35);
      // appear and leave on a timed ease-in-out (smootherstep), so the object neither pops in nor snaps out:
      // an exponential fade starts at full speed and reads as a jump (motion.md section 15, mechanics 9)
      if (S.opacityTarget !== S.fadeTo) { S.fadeFrom = S.opacity; S.fadeTo = S.opacityTarget; S.fadeK = 0; }
      if (S.fadeK < 1) {
        const span = Math.abs(S.fadeTo - S.fadeFrom), dur = Math.max(0.25, (S.fadeTo > S.fadeFrom ? tp.appear : tp.leave) * Math.sqrt(span));
        S.fadeK = Math.min(1, S.fadeK + dt / dur);
        const k = S.fadeK;
        S.opacity = S.fadeFrom + (S.fadeTo - S.fadeFrom) * k * k * k * (k * (6 * k - 15) + 10);
      }
    }
    // a living baseline per state when there is no signal (motion.md section 15, mechanics 8)
    function synthetic(state, t) {
      if (state === 2) return 0.30 + 0.06 * Math.sin(0.7 * t) + 0.05 * Math.sin(2.1 * t) * Math.sin(0.37 * t + 1.2);
      if (state === 3) return 0.55 + 0.18 * Math.sin(3.6 * t) * Math.sin(0.9 * t + 0.4);
      return 0;
    }
    return { S, tp, step, synthetic };
  }

  function create(canvas, opts = {}) {
    const o = Object.assign({ dpr: 1.5, maxDpr: 2, lookAhead: 0.04, alpha: true }, opts);
    const E = engine(o.temperament);
    const S = E.S;
    let gl, prog, loc = {}, raf = 0, running = false, visible = true, onScreen = true, liveLevel = 0, dpr = Math.min(o.dpr, o.maxDpr, window.devicePixelRatio || 1);
    let slowFrames = 0, lastNow = 0, startedAt = 0, analyser = null, prevHigh = 0, lastActive = 0;
    let track = decodeTrack(o.track);
    const rampRows = o.ramps && o.ramps.length ? o.ramps : [['#000000', '#ffffff']];
    const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    S.reduced = mq && mq.matches ? 1 : 0;

    function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
    function init() {
      gl = canvas.getContext('webgl', { alpha: o.alpha, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: !!o.preserve });
      if (!gl) { canvas.dataset.presence = 'unsupported'; return false; }
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, HEADER + (o.fragment || PLACEHOLDER)));
      gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const pl = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 0, 0);
      ['uRes', 'uPx', 'uTime', 'uNoise', 'uRamp', 'uRampRows', 'uEnergy', 'uLevel', 'uPresence', 'uLight', 'uAmp', 'uPhase', 'uPhase2', 'uBreath', 'uSpark', 'uSparkSeed', 'uState', 'uOpacity', 'uReduced', 'uCycles', 'uOnsetAge[0]']
        .forEach(n => { loc[n.replace('[0]', '')] = gl.getUniformLocation(prog, n); });
      // noise: seeded random bytes; green repeats red at an offset of (37, 17) for noise3
      let seed = 1234567; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const N = 256, r = new Uint8Array(N * N); for (let i = 0; i < N * N; i++) r[i] = Math.floor(rnd() * 256);
      const d = new Uint8Array(N * N * 4);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = (y * N + x) * 4; d[i] = r[y * N + x]; d[i + 1] = r[((y - 17 + N) % N) * N + ((x - 37 + N) % N)]; d[i + 3] = 255; }
      const tex = (unit, w, h, px, wrap) => {
        const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      };
      tex(0, N, N, d, gl.REPEAT); gl.uniform1i(loc.uNoise, 0);
      tex(1, 256, rampRows.length, rampPixels(rampRows), gl.CLAMP_TO_EDGE); gl.uniform1i(loc.uRamp, 1); gl.uniform1f(loc.uRampRows, rampRows.length);
      resize();
      return true;
    }
    // resizing a canvas wipes it: skip resizes that change nothing (iPhone Safari fires 'resize' while its toolbar
    // hides on scroll) and redraw in the same frame, so a blank canvas is never shown (a one-frame flash)
    function resize() {
      const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (W === canvas.width && H === canvas.height) return;
      canvas.width = W; canvas.height = H;
      if (gl) { gl.viewport(0, 0, W, H); if (S.t > 0 || S.opacity > 0) draw(); }
    }
    function draw() {
      if (!gl) return;
      gl.uniform2f(loc.uRes, canvas.width, canvas.height); gl.uniform1f(loc.uPx, 2 / canvas.height); gl.uniform1f(loc.uTime, S.t % 600);
      gl.uniform1f(loc.uEnergy, S.energy); gl.uniform1f(loc.uLevel, S.level); gl.uniform1f(loc.uPresence, S.presence); gl.uniform1f(loc.uLight, S.light.x);
      gl.uniform1f(loc.uAmp, S.amp.x); gl.uniform1f(loc.uPhase, S.phase % (TAU * 1000)); gl.uniform1f(loc.uPhase2, S.phase2 % (TAU * 1000));
      gl.uniform1f(loc.uBreath, S.breath); gl.uniform1f(loc.uSpark, S.spark); gl.uniform1f(loc.uSparkSeed, S.sparkSeed);
      gl.uniform1f(loc.uState, S.state); gl.uniform1f(loc.uOpacity, S.opacity); gl.uniform1f(loc.uReduced, S.reduced);
      gl.uniform3f(loc.uCycles, S.cycles[0] % (TAU * 1000), S.cycles[1] % (TAU * 1000), S.cycles[2] % (TAU * 1000));
      const ages = new Float32Array(8).fill(99); S.onsets.forEach((t, i) => { ages[i] = Math.min(99, S.t - t); }); gl.uniform1fv(loc.uOnsetAge, ages);
      if (o.uniforms) o.uniforms(gl, n => gl.getUniformLocation(prog, n), S);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // the signal at time t: the baked track, a live analyser, a live input level, or the state's own baseline
    let lastAt = -1;
    function signal(t) {
      const a = o.audio;
      if (S.state === 3 && a && !a.paused && !a.ended) {
        const at = a.currentTime + o.lookAhead;
        // onsets since the last read, so a slow frame (33 ms on a busy phone) misses none; after a seek, only the last 20 ms
        if (track) { const from = at > lastAt && at - lastAt < 0.3 ? lastAt : at - 0.02, on = at !== lastAt && onsetBetween(track.onset, track.rate, from, at); lastAt = at; return { level: sample(track.lvl, track.rate, at), onset: on }; }
        if (analyser) return analyser.read();
      }
      if (S.state === 1) return { level: liveLevel, onset: false };
      if (S.state === 2 || (S.state === 3 && !a)) return { level: E.synthetic(S.state, t), onset: false };
      return { level: 0, onset: false };
    }
    function liveAnalyser(audio) {
      // fallback only: cross-origin media without CORS reads as silence; on iPhone the mute switch silences Web Audio
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaElementSource(audio), an = ctx.createAnalyser();
      an.fftSize = 1024; an.smoothingTimeConstant = 0.5; src.connect(an); an.connect(ctx.destination);
      const td = new Float32Array(an.fftSize), fd = new Uint8Array(an.frequencyBinCount);
      const bin = f => Math.floor(f / (ctx.sampleRate / an.fftSize));
      return { ctx, read() {
        an.getFloatTimeDomainData(td); an.getByteFrequencyData(fd);
        let s = 0; for (let i = 0; i < td.length; i++) s += td[i] * td[i];
        const db = 10 * Math.log10(s / td.length + 1e-10), level = Math.min(1, Math.max(0, (db + 50) / 35));
        let hi = 0; const b0 = bin(1000), b1 = bin(4000); for (let i = b0; i < b1; i++) hi += fd[i]; hi /= (b1 - b0) * 255;
        const onset = hi - prevHigh > 0.06; prevHigh = hi; return { level, onset };
      } };
    }

    function frame(now) {
      raf = 0; if (!running) return;
      const dt = Math.min(0.05, Math.max(0, (now - (lastNow || now)) / 1000)); lastNow = now;
      const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
      for (let k = 0; k < sub; k++) { const sg = signal(S.t); E.step(dt / sub, sg.level, sg.onset && k === 0); }
      draw();
      // adapt: a second of slow frames drops the pixel ratio to 1
      // adapt only once warmed up: the first 2 s after a start are slow anywhere (shader compile, the stage opening)
      if (now - startedAt > 2000) { if (dt > 0.02) { slowFrames += dt; if (slowFrames > 1 && dpr > 1) { dpr = 1; resize(); } } else slowFrames = Math.max(0, slowFrames - dt); }
      // settled: hidden, or resting with no signal and the springs still; stop until something changes
      if (S.state !== 0 || S.level > 0.01) lastActive = S.t;
      const still = Math.abs(S.opacity - S.opacityTarget) < 0.002 && Math.abs(S.amp.v) < 1e-3 && S.t - lastActive > E.tp.settle * 2;
      if ((S.opacityTarget === 0 && S.opacity < 0.002) || (S.state === 0 && still)) { running = false; return; }
      if (visible && onScreen) raf = requestAnimationFrame(frame); else running = false;
    }
    function start() { if (!running && gl && visible && onScreen) { running = true; lastNow = 0; startedAt = performance.now(); raf = requestAnimationFrame(frame); } }

    if (!init()) return { supported: false, setState() {}, setLevel() {}, show() {}, hide() {}, renderAt() {}, destroy() {} };
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); running = false; });
    canvas.addEventListener('webglcontextrestored', () => { init(); start(); });
    const onVis = () => { visible = !document.hidden; if (visible) start(); };
    document.addEventListener('visibilitychange', onVis);
    const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => { onScreen = es[0].isIntersecting; if (onScreen) start(); }) : null;
    if (io) io.observe(canvas);
    if (mq && mq.addEventListener) mq.addEventListener('change', e => { S.reduced = e.matches ? 1 : 0; });
    window.addEventListener('resize', resize);
    if (o.audio && !track && o.analyser !== false) {
      o.audio.addEventListener('play', () => { if (!analyser) { try { analyser = liveAnalyser(o.audio); } catch (e) { analyser = null; } } if (analyser) analyser.ctx.resume(); }, { once: false });
    }
    draw();

    const api = {
      supported: true, state: S, temperament: E.tp,
      setState(name) { S.state = STATES[name] != null ? STATES[name] : 0; start(); },
      setLevel(x) { liveLevel = Math.min(1, Math.max(0, x)); },
      // a baked track that arrives after the object was created: swap it in without rebuilding (no reset, no flash)
      setTrack(t) { track = decodeTrack(t); },
      show(level = 1) { S.opacityTarget = Math.min(1, Math.max(0, level)); start(); },
      hide() { S.opacityTarget = 0; S.state = 0; start(); },
      // offline: step to time t at 240 Hz from the current time, reading the baked track at t (no audio element needed)
      renderAt(t, opts2 = {}) {
        const tr = opts2.track ? decodeTrack(opts2.track) : track;
        S.opacityTarget = opts2.opacity != null ? opts2.opacity : 1;
        if (opts2.opacity != null) { S.opacity = S.fadeFrom = S.fadeTo = opts2.opacity; S.fadeK = 1; }
        if (opts2.state) S.state = STATES[opts2.state];
        else if (tr) S.state = 3;
        while (S.t < t - 1e-6) {
          const h = Math.min(1 / 240, t - S.t), at = S.t + o.lookAhead;
          const lv = tr ? sample(tr.lvl, tr.rate, at) : E.synthetic(S.state, S.t);
          const on = tr ? onsetBetween(tr.onset, tr.rate, at - h, at) : false;
          E.step(h, lv, on);
        }
        if (opts2.opacity != null) S.opacity = opts2.opacity;
        draw();
      },
      resize() { resize(); draw(); },
      destroy() { running = false; if (raf) cancelAnimationFrame(raf); if (io) io.disconnect(); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('resize', resize); },
    };
    if (o.audio && o.manage !== false) {
      o.audio.addEventListener('play', () => { api.setState('speaking'); api.show(); });
      o.audio.addEventListener('pause', () => { api.setState('idle'); setTimeout(() => { if (o.audio.paused) api.hide(); }, Math.max(450, E.tp.settle * 1000)); });
      o.audio.addEventListener('ended', () => { api.setState('idle'); setTimeout(() => api.hide(), Math.max(450, E.tp.settle * 1000)); });
    }
    return api;
  }

  root.Presence = { create, rampPixels, HEADER, PLACEHOLDER, decodeTrack };
})(typeof window !== 'undefined' ? window : this);
