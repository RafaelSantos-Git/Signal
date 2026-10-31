/* The director for Signal's merged presence (Calibre projecting the hologram). One state machine, used both by the
   film (stepped frame by frame from a script) and by the live page (stepped in real time from the audio element and
   the user's taps). It reads the pre-analysed voice, runs every spring, phase and event, and writes the shader's
   uniforms each frame. Matter keeps time (governed, exact); light speaks (irregular, alive, a little ahead). */
(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const sat = x => Math.min(1, Math.max(0, x));
  const sm = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const dec = s => { const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
  // a spring held in an object: x follows target with natural frequency w (rad/s) and damping ratio z
  const Spring = (x, w, z) => ({ x, v: 0, w, z, step(target, dt) { const f = this.w * this.w * (target - this.x) - 2 * this.z * this.w * this.v; this.v += f * dt; this.x += this.v * dt; return this.x; } });
  // a one-pole follower with different rise and fall times (seconds)
  const Follow = (x, up, down) => ({ x, up, down, step(target, dt) { const tau = target > this.x ? this.up : this.down; this.x += (target - this.x) * (1 - Math.exp(-dt / tau)); return this.x; } });
  // slow pink-ish variation: a few incommensurate sines (periods share no common multiple)
  const wander = (t, seed) => (Math.sin(t * 0.556 + seed) * 0.5 + Math.sin(t * 0.217 + seed * 2.3) * 0.3 + Math.sin(t * 0.0938 + seed * 4.1) * 0.2);

  function create(feat, opt) {
    opt = Object.assign({ live: false, idleHold: 15, el0: 34 * Math.PI / 180, fov: 18 * Math.PI / 180, baseFrac: 0.86, target: [0, 0.30, 0], lead: 0.05 }, opt || {});
    // the voice, baked before playback (scripts/voice_bake.py); silence until it arrives
    const SILENCE = { duration: 1, rate: 100, n: 2, loud: 'AAA=', pitch: 'gIA=', voiced: 'AAA=', bandRate: 50, bandN: 2,
                      bands: btoa(String.fromCharCode.apply(null, new Array(38).fill(0))), syllables: [], accents: [], pauses: [], phrases: [], sections: [0] };
    const V = {};
    let secFrac = [0, 1];
    function setFeatures(f) {
      f = f || SILENCE;
      Object.assign(V, {
        dur: f.duration, rate: f.rate, n: f.n,
        loud: dec(f.loud), pitch: dec(f.pitch), voiced: dec(f.voiced),
        bands: dec(f.bands), bandRate: f.bandRate, bandN: f.bandN,
        syl: f.syllables || [], acc: f.accents || [], pauses: f.pauses || [], phrases: f.phrases || [], sec: (f.sections && f.sections.length ? f.sections : [0]).slice(0, 9),
      });
      secFrac = V.sec.map(s => s / V.dur).concat([1]);
      while (secFrac.length < 10) secFrac.push(1);
    }
    setFeatures(feat);
    const sample = (arr, t, rate, n) => { const x = Math.max(0, t * rate), i = Math.min(n - 2, x | 0), f = Math.min(1, x - i); return (arr[i] * (1 - f) + arr[i + 1] * f) / 255; };
    const loudAt = t => sample(V.loud, t, V.rate, V.n);
    const pitchAt = t => sample(V.pitch, t, V.rate, V.n) * 16 - 8;
    const voicedAt = t => sample(V.voiced, t, V.rate, V.n);
    const bandAt = (t, b) => { const x = Math.max(0, t * V.bandRate), i = Math.min(V.bandN - 2, x | 0), f = Math.min(1, x - i); return (V.bands[i * 19 + b] * (1 - f) + V.bands[(i + 1) * 19 + b] * f) / 255; };
    const sectionAt = t => { let k = 0; for (let i = 0; i < V.sec.length; i++) if (t >= V.sec[i] - 1e-3) k = i; return k; };
    const rateAt = t => { for (const p of V.phrases) if (t >= p[0] && t < p[1]) return p[2]; return 0; };

    // ---- the state
    const S = {
      t: 0, mode: 'asleep', modeT: 0, firstWake: true, wake: 0, leave: 0, wakeDur: 2.4, afterWake: 'idle',
      audioPlaying: false, audioTime: 0, prevSection: 0, sectionT: 99, retractT: 99, jump: 1,
      thinkT: 0, input: 0, lastInputT: -99, heardInput: false, ackT: -1, nodT: -99, intT: 99, err: 0, errOn: false,
      az: 0, el: opt.el0, azTarget: 0, elTarget: opt.el0, holdT: 0,
      carriage: 0, dust: 0, breathPhase: 0, breathPeriod: 5.5, blinkT: 99, blinkFired: false,
      waves: [], afterglow: 0, prewake: 0, flow: 0, inPulses: [], inPrev: 0, inRising: false, inPeak: 0, lastInPulse: -9, thinkPt: 0,
      reduced: false,
    };
    const sp = {
      crown: Spring(0, 14, 1), contract: Spring(0, 8, 0.75), beam: Spring(1, 6, 1), pearlH: Spring(0, 7, 1), front: Spring(0, 10, 1),
      input: Follow(0, 0.08, 0.30), pearl: Follow(0.85, 0.045, 0.22), charge: Follow(0, 0.03, 1.0), ringVis: Spring(0, 6, 1),
      dustV: Spring(0, 3, 1), dustAmt: Spring(0, 3, 1), sweep: Spring(0, 5, 1), rest: Spring(1, 2, 1), interf: Spring(0, 9, 1),
      err: Spring(0, 9, 1), studio: Follow(1, 0.15, 0.6), jump: Spring(1, 25, 1), carW: Spring(0, 3.5, 1), fill: Spring(0, 12, 1),
      prewake: Follow(0, 0.25, 0.4), threadG: Spring(0, 5, 1), flowV: Spring(0, 3, 1), thinkVis: Spring(0, 6, 1),
    };
    const bands = Array.from({ length: 19 }, () => Follow(0, 0.04, 0.16));
    const bytes = new Uint8Array(32);

    // ---- the API: what the user (or the film's script) asks for
    const api = {
      S, V, get secFrac() { return secFrac; }, setFeatures,
      setMode(m) { if (S.mode !== m) { S.mode = m; S.modeT = 0; } },
      prewake() { if (S.mode === 'asleep') api.setMode('prewake'); },
      wake(then) {
        S.afterWake = then || 'idle';
        if (S.mode === 'asleep' || S.mode === 'prewake' || S.mode === 'leaving') {
          S.wakeDur = S.firstWake ? 2.4 : 1.0; S.firstWake = false;
          if (S.mode === 'leaving') { S.wake = Math.max(0.35, 1 - S.leave); } else S.wake = 0;
          S.leave = 0; api.setMode('waking');
        }
      },
      // play the briefing from a time (seconds into it); the live page passes the audio element's own time instead
      play(at) {
        if (at != null) S.audioTime = at;
        if (S.mode === 'asleep' || S.mode === 'prewake' || S.mode === 'leaving') { api.wake('speaking'); S.audioPlaying = true; return; }
        S.audioPlaying = true; api.setMode('speaking');
      },
      pause() { if (S.audioPlaying) { S.audioPlaying = false; S.intT = 0; api.setMode('interrupted'); } },
      think() { S.audioPlaying = false; S.thinkT = 0; if (S.mode === 'asleep' || S.mode === 'prewake') api.wake('thinking'); else api.setMode('thinking'); },
      listen() { S.audioPlaying = false; S.heardInput = false; S.ackT = -1; if (S.mode === 'asleep' || S.mode === 'prewake') api.wake('listening'); else api.setMode('listening'); },
      error(on) { S.errOn = !!on; if (on) { S.audioPlaying = false; api.setMode('error'); } else if (S.mode === 'error') api.setMode('idle'); },
      sleep() { if (S.mode !== 'asleep' && S.mode !== 'leaving') { S.audioPlaying = false; S.leave = 0; api.setMode('leaving'); } },
      setInput(x) { S.input = x; },
      // the live page: rest without passing through an interruption, and replay the first apparition of the day
      idle() { S.audioPlaying = false; if (S.mode !== 'asleep' && S.mode !== 'prewake' && S.mode !== 'leaving') api.setMode('idle'); },
      resetAsleep() { S.audioPlaying = false; S.wake = 0; S.leave = 0; S.firstWake = true; api.setMode('asleep'); },
      setAudio(playing, time) { S.audioPlaying = playing; S.audioTime = time; },
      setOrbit(az, el) { S.azTarget = az; S.elTarget = el; },
      setReduced(r) { S.reduced = !!r; },
      mode() { return S.mode; },
      label() {
        const m = S.mode;
        if (m === 'speaking' && S.sectionT < 2.5 && S.prevSection > 0) return 'Next section';
        return ({ asleep: 'Asleep', prewake: 'Pre-wake', waking: 'Waking', idle: 'Idle', thinking: 'Thinking', speaking: 'Speaking',
                  interrupted: 'Interrupted', listening: 'Listening', error: 'Error', leaving: 'Leaving' })[m];
      },
      // advance by dt seconds (sub-stepped so springs stay stable at any frame rate)
      update(dt) {
        const n = Math.max(1, Math.ceil(dt / (1 / 240)));
        for (let i = 0; i < n; i++) step(dt / n);
      },
      write(gl, at, canvas, layout) { write(gl, at, canvas, layout); },
    };

    // ---- one small step of everything
    function step(dt) {
      S.t += dt; S.modeT += dt;
      const m = S.mode;
      // waking and leaving run as sequences, not springs
      if (m === 'waking') { S.wake = Math.min(1, S.wake + dt / S.wakeDur); if (S.wake >= 1) api.setMode(S.audioPlaying ? 'speaking' : S.afterWake); }
      if (m === 'leaving') { S.leave = Math.min(1, S.leave + dt / (1.4 * S.wakeDur)); if (S.leave >= 1) { S.wake = 0; S.leave = 0; api.setMode('asleep'); } }
      if (m === 'interrupted' && S.modeT > 1.6) api.setMode('idle');
      if (m === 'prewake' && S.modeT > 15) api.setMode('asleep');
      if (m === 'idle' && opt.live && S.modeT > opt.idleHold) api.sleep();
      if (m === 'thinking') S.thinkT += dt;
      if (S.audioPlaying) S.audioTime += dt;
      const awake = S.mode !== 'asleep' && S.mode !== 'prewake';
      const spk = S.mode === 'speaking' && S.audioPlaying ? 1 : 0;
      const lis = S.mode === 'listening' ? 1 : 0, thk = S.mode === 'thinking' ? 1 : 0;
      const ta = S.audioTime + opt.lead;                         // read the voice a little ahead: early is accepted, late is noticed
      const loud = spk ? loudAt(ta) : 0;
      // ---- sections: the ring retracts and the next lacquered segment jumps when a section ends
      const sec = sectionAt(S.audioTime);
      if (sec !== S.prevSection) { S.retractT = 0; S.sectionT = 0; S.prevSection = sec; sp.jump.x = 0; sp.jump.v = 0; }
      S.retractT += dt; S.sectionT += dt;
      const s0 = V.sec[sec], s1 = sec + 1 < V.sec.length ? V.sec[sec + 1] : V.dur;
      const prog = sat((S.audioTime - s0) / (s1 - s0));
      sp.fill.z = S.retractT < 0.5 ? 0.6 : 1; sp.fill.w = S.retractT < 0.5 ? 12 : 18;
      sp.fill.step(S.retractT < 0.5 ? 0 : prog, dt);
      sp.jump.step(1, dt);
      // ---- the voice: crown bands, pearl, lume
      for (let b = 0; b < 19; b++) bands[b].step(spk ? bandAt(ta, b) : 0, dt);
      sp.crown.w = m === 'interrupted' ? 30 : 14;
      sp.crown.step(spk ? 1 : lis ? 0.35 : thk ? 0.22 : m === 'error' ? 0.08 : 0, dt);
      sp.pearl.step(!awake ? 0.7 : m === 'error' ? 0.55 : spk ? 0.78 + 0.55 * loud : thk ? 0.95 : 0.85, dt);
      const pv = spk && voicedAt(ta) > 0.5 ? Math.max(-1, Math.min(1, pitchAt(ta) / 6)) : 0;
      sp.pearlH.step(0.02 * pv, dt);
      sp.contract.step(thk ? 0.04 : 0, dt);
      sp.beam.step(thk ? 1.3 : 1 + 0.15 * loud, dt);
      // the lume: a quick charge and a phosphorescent fade; an interruption drops it at once
      if (m === 'interrupted' && S.intT < 0.02) sp.charge.x *= 0.35;
      sp.charge.down = m === 'interrupted' ? 0.5 : 1.0;
      sp.charge.step(spk ? loud : m === 'waking' ? 0.15 * sm(0.1, 0.45, S.wake) * (1 - sm(0.6, 1, S.wake)) : 0, dt);
      S.intT += dt;
      S.afterglow = Math.max(S.afterglow * Math.exp(-dt / 200), sp.charge.x * 0.45);
      // accents: a gather 150 to 300 ms ahead, a stroke at the syllable, a follow-through; strong ones send a lume wave from 12
      let accent = 0, syl = 0;
      if (spk) {
        for (const [tAcc, z] of V.acc) {
          const d = S.audioTime + 0.03 - tAcc;
          if (d < -0.35 || d > 0.8) continue;
          const g = sat((z - 1.0) / 1.6);
          accent += d < 0 ? -0.35 * g * sm(-0.30, -0.12, d) * (1 - sm(-0.05, 0, d)) : g * Math.exp(-d / 0.30) * sm(-0.02, 0.04, d);
          if (z > 1.7 && d >= 0 && d < dt * 1.5 && !S.waves.some(w => Math.abs(w.t0 - tAcc) < 0.01)) S.waves.push({ t0: tAcc, at: S.t, s: g });
        }
        for (const ts of V.syl) { const d = S.audioTime + 0.05 - ts; if (d > -0.2 && d < 0.2) syl += Math.exp(-((d / 0.07) ** 2)); }
      }
      S.waves = S.waves.filter(w => S.t - w.at < 1.25);
      // ---- listening: the input ring, the crown's front turning to you, a nod at your pauses, an acknowledgement
      sp.input.step(lis ? S.input : 0, dt);
      if (lis) {
        if (S.input > 0.08) { S.heardInput = true; S.lastInputT = S.t; }
        const quiet = S.t - S.lastInputT;
        if (S.heardInput && quiet > 0.2 && quiet < 0.2 + dt * 1.5 && S.t - S.nodT > 1.0) S.nodT = S.t;
        if (S.heardInput && quiet > 0.35 && S.ackT < 0) S.ackT = 0;
      }
      if (S.ackT >= 0) { S.ackT += dt / 0.55; if (S.ackT > 1) S.ackT = -2; }
      sp.front.w = lis ? 10 : 4;
      sp.front.step(lis ? -S.az : 0, dt);
      sp.ringVis.step(lis || (m === 'waking' && S.wake < 0.75) ? 1 : 0, dt);
      // ---- the carriage: 45 s a turn while active, 18 s while thinking, 10 minutes at idle, still when asleep
      const wTarget = !awake ? 0 : thk ? TAU / 18 : (spk || lis || m === 'waking' || m === 'interrupted') ? TAU / 45 : TAU / 600;
      S.carriage += sp.carW.step(wTarget, dt) * dt;
      // ---- dust: it rises while speaking (with the speaking rate), settles while listening, nearly still at idle
      const rate = spk ? rateAt(S.audioTime) : 0;
      S.dust += sp.dustV.step(spk ? 0.030 + 0.010 * rate : lis ? -0.022 : thk ? -0.010 : awake ? 0.004 : 0, dt) * dt;
      sp.dustAmt.step(!awake ? 0 : spk ? 1 : lis ? 0.8 : thk ? 0.7 : 0.35, dt);
      sp.sweep.step(thk || (m === 'waking') ? 1 : 0, dt);
      sp.rest.step(lis ? 0.5 : spk ? 0.6 : thk ? 0.4 : 1, dt);
      sp.err.step(S.errOn ? 1 : 0, dt);
      sp.interf.step(S.errOn ? 1 : 0, dt);
      sp.studio.step(awake ? 0.96 : 1, dt);
      sp.prewake.step(m === 'prewake' ? 1 : 0, dt);
      // ---- the threads: brighter with the voice; light flows up them while speaking and down while listening
      sp.threadG.step(!awake ? 0 : m === 'error' ? 0.18 : m === 'interrupted' ? 0.28 : spk ? 0.45 + 0.50 * loud : thk ? 0.62 : lis ? 0.40 + 0.5 * sp.input.x : 0.34, dt);
      S.flow += sp.flowV.step(!awake ? 0 : spk ? 1.0 + 0.12 * rate : lis ? -0.8 : thk ? 0.35 : 0.12, dt) * dt;
      // your voice, while listening: each syllable you speak runs down the threads to the base
      if (lis) {
        const x = S.input;
        if (x > S.inPrev + 0.004) { S.inRising = true; S.inPeak = x; }
        else if (S.inRising && x < S.inPrev - 0.004) {
          S.inRising = false;
          if (S.inPeak > 0.28 && S.t - S.lastInPulse > 0.16) { S.inPulses.push({ t0: S.t, g: -(0.35 + 0.65 * Math.min(1, S.inPeak)) }); S.lastInPulse = S.t; }
        }
        S.inPrev = x;
      }
      S.inPulses = S.inPulses.filter(q => S.t - q.t0 < 0.32 * 1.4);
      // thinking, graded: nothing for 0.6 s, then a point of light starts to run the timeline ring
      sp.thinkVis.step(thk && S.thinkT > 0.6 ? 1 : 0, dt);
      if (thk && S.thinkT > 0.6) S.thinkPt += dt / 2.4;
      // ---- breath: 5 to 6 seconds, short inhale and long exhale, its period and depth wandering; blinks at the end of an exhale
      S.breathPeriod = 5.5 * (1 + 0.12 * wander(S.t, 1.7));
      const before = S.breathPhase;
      S.breathPhase = (S.breathPhase + dt / S.breathPeriod) % 1;
      if (S.breathPhase < before) {                               // a new breath begins: perhaps blink, at the end of the exhale
        const h = Math.abs(Math.sin(S.t * 12.9898) * 43758.5453) % 1;
        if (awake && !spk && h < 0.40) S.blinkT = 0;
      }
      S.blinkT += dt;
      // ---- the camera: it follows the requested orbit with a short lag
      const k = 1 - Math.exp(-dt / 0.12);
      S.az += (S.azTarget - S.az) * k; S.el += (S.elTarget - S.el) * k;
      // ---- remember what the shader needs
      S.out = {
        spk, lis, thk, loud, accent: Math.max(-1, Math.min(1.2, accent)), syl: Math.min(1, syl), prog, sec,
      };
    }

    // ---- the uniforms
    let tex = null;
    function write(gl, at, canvas, layout) {
      const o = S.out || { spk: 0, lis: 0, thk: 0, loud: 0, accent: 0, syl: 0, prog: 0, sec: 0 };
      const W = canvas.width, H = canvas.height;
      layout = layout || {};
      // camera: a long lens raised 34 degrees, framed so the base fills a fraction of the width
      const F = (H / 2) / Math.tan(opt.fov / 2);
      const frac = layout.baseFrac || opt.baseFrac;
      const d = 2 * F / (frac * W);
      const T = layout.target || opt.target;
      const az = S.az, el = S.el;
      const P = [T[0] + d * Math.sin(az) * Math.cos(el), T[1] + d * Math.sin(el), T[2] + d * Math.cos(az) * Math.cos(el)];
      let f = [T[0] - P[0], T[1] - P[1], T[2] - P[2]]; const fl = Math.hypot(...f); f = f.map(x => x / fl);
      let r = [-f[2], 0, f[0]]; const rl = Math.hypot(...r); r = r.map(x => x / rl);
      const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
      gl.uniform3f(at('uCamPos'), P[0], P[1], P[2]); gl.uniform3f(at('uCamFwd'), f[0], f[1], f[2]);
      gl.uniform3f(at('uCamRight'), r[0], r[1], r[2]); gl.uniform3f(at('uCamUp'), u[0], u[1], u[2]);
      gl.uniform1f(at('uFocal'), F);
      gl.uniform1f(at('uPxS'), layout.pxs || 1);
      const off = layout.offset || [0, 0];
      gl.uniform2f(at('uScreenOff'), off[0] * W, off[1] * H);
      const sf = secFrac;
      gl.uniform4f(at('uSecA'), sf[0], sf[1], sf[2], sf[3]); gl.uniform4f(at('uSecB'), sf[4], sf[5], sf[6], sf[7]); gl.uniform4f(at('uSecC'), sf[8], 1, 1, 1);
      const m = S.mode, awake = m !== 'asleep' && m !== 'prewake';
      // base
      const runner = m === 'thinking' && S.thinkT > 2 ? ((S.thinkT - 2) / 8) % 1 : -1;
      gl.uniform4f(at('uBase'), S.audioTime / V.dur, o.sec, sp.jump.x, sp.err.x);
      gl.uniform4f(at('uBase2'), S.carriage, runner, m === 'speaking' ? 0 : S.afterglow * 0.35, sp.prewake.x);
      // lume: two accent waves at most, each one turn from 12 in about 1.2 s; on waking, one wave charges the lume
      const w = S.waves.slice(-2);
      const wf = x => ((S.t - x.at) / 1.2);
      let w1f = -1, w1s = 0, w2f = -1, w2s = 0;
      if (w.length) { w1f = wf(w[w.length - 1]); w1s = w[w.length - 1].s * Math.exp(-wf(w[w.length - 1]) * 1.2); }
      if (w.length > 1) { w2f = wf(w[0]); w2s = w[0].s * Math.exp(-wf(w[0]) * 1.2); }
      if (m === 'waking' && S.wake > 0.10 && S.wake < 0.55) { w1f = (S.wake - 0.10) / 0.45; w1s = 0.9; }
      const lis = o.lis;
      gl.uniform4f(at('uLumeV'), sp.charge.x, lis ? sp.input.x * 0.8 : 0, w1f, w1s);
      const vis = awake ? (m === 'waking' ? S.wake : m === 'leaving' ? 1 - S.leave : 1) : 0;
      gl.uniform4f(at('uLumeW'), w2f, w2s, sp.studio.x, vis * sp.pearl.x);
      // hologram
      const wakeP = m === 'waking' ? S.wake : awake ? 1 : 0;
      gl.uniform4f(at('uHoloA'), wakeP, m === 'leaving' ? S.leave : 0, sp.crown.x, sp.contract.x);
      const breath = (Math.exp(Math.sin(S.breathPhase * TAU - Math.PI / 2)) - 1 / Math.E) / (Math.E - 1 / Math.E) * 2 - 1;
      const depth = 1 + 0.2 * wander(S.t, 4.2);
      const syl = o.syl, acc = o.accent;
      gl.uniform4f(at('uHoloB'), sp.pearl.x * (1 + 0.04 * breath * depth) * (1 + 0.10 * syl), sp.pearlH.x + 0.004 * breath * depth, breath * depth, sp.fill.x);
      const nod = S.t - S.nodT < 0.5 ? -0.010 * Math.sin(Math.PI * (S.t - S.nodT) / 0.5) : 0;
      const blink = S.blinkT < 0.32 ? (S.blinkT < 0.1 ? S.blinkT / 0.1 : 1 - (S.blinkT - 0.1) / 0.22) : 0;
      gl.uniform4f(at('uHoloC'), sp.front.x, nod, sp.input.x, blink);
      gl.uniform4f(at('uHoloD'), S.dust, sp.dustAmt.x, S.carriage, sp.sweep.x);
      gl.uniform4f(at('uHoloE'), syl, acc, S.thinkPt % 1, sp.thinkVis.x);
      // the voice's pulses on their way up (launched 0.32 s ahead of each syllable, so they land as it sounds)
      const PT = 0.32, ta = S.audioTime + opt.lead, PL = [];
      if (o.spk) for (const ts of V.syl) { const a = PT - (ts - ta); if (a >= 0 && a < PT * 1.35) PL.push([a, 0.35 + 0.65 * Math.min(1, loudAt(ts) * 1.2)]); }
      for (const q of S.inPulses) PL.push([S.t - q.t0, q.g]);
      PL.sort((x, y) => x[0] - y[0]);
      const pa = [-1, -1, -1, -1], ps = [0, 0, 0, 0];
      for (let i = 0; i < Math.min(4, PL.length); i++) { pa[i] = PL[i][0]; ps[i] = S.reduced ? 0 : PL[i][1]; }
      gl.uniform4f(at('uPulse'), pa[0], pa[1], pa[2], pa[3]); gl.uniform4f(at('uPulseS'), ps[0], ps[1], ps[2], ps[3]);
      // accent rings: the two latest strong accents, each running outward from the crown for about a second and a half
      const RL = [];
      if (o.spk) for (const [tAcc, z] of V.acc) { const a = ta - tAcc; if (a >= 0 && a < 1.8 && z > 1.8) RL.push([a, sat((z - 1.5) / 1.2)]); }
      RL.sort((x, y) => x[0] - y[0]);
      const r1 = RL[0] || [-1, 0], r2 = RL[1] || [-1, 0];
      gl.uniform4f(at('uRipple'), r1[0], S.reduced ? 0 : r1[1], r2[0], S.reduced ? 0 : r2[1]);
      // the threads: they turn with the carriage, and weave themselves out of the collet as it wakes
      const weave = m === 'waking' ? sm(0.06, 0.46, S.wake) : m === 'leaving' ? 1 - sm(0.12, 0.50, S.leave) : awake ? 1 : 0;
      gl.uniform4f(at('uThread'), S.carriage / TAU, sp.threadG.x, S.reduced ? 0 : S.flow, weave);
      const zone = Math.max(Math.abs(S.az) / (20 * Math.PI / 180), Math.abs(S.el - opt.el0) / (6 * Math.PI / 180));
      gl.uniform4f(at('uHoloF'), sp.interf.x, Math.min(1, zone), wander(S.t, 0.3), sp.beam.x);
      const drop = m === 'interrupted' ? Math.max(0, 1 - S.intT / 0.25) : 0;
      gl.uniform4f(at('uHoloG'), sp.ringVis.x, S.ackT >= 0 ? S.ackT : -1, drop, sp.rest.x * (S.reduced ? 0 : 1));
      // the engine's own state value, which the shader reads for speaking, thinking and listening
      gl.uniform1f(at('uState'), o.spk ? 3 : o.thk ? 2 : o.lis ? 1 : 0);
      // the nineteen bands, through an 8-bit texture (WebGL 1 cannot index uniform arrays with a variable)
      for (let b = 0; b < 19; b++) bytes[b] = Math.round(sat(bands[b].x) * 255);
      if (!tex) {
        tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 32, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
      gl.uniform1i(at('uBands'), 2); gl.activeTexture(gl.TEXTURE0);
    }
    api.resetTexture = () => { tex = null; };
    return api;
  }
  root.Director = { create };
})(typeof window !== 'undefined' ? window : this);
