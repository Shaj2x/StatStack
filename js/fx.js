// StatStack motion, haptics and sound helpers. Loaded before js/app.js.

const FX = (() => {
  const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
  const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => reducedQuery.matches;

  // ─── Settings ─────────────────────────────────────────────────────────────
  const read = (key, fallback) => {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v === "true"; }
    catch { return fallback; }
  };
  const write = (key, value) => { try { localStorage.setItem(key, String(value)); } catch { /* private mode */ } };
  const settings = {
    sound: read("statstack_sound", false),
    haptics: read("statstack_haptics", true),
  };
  function setSetting(name, on) {
    settings[name] = on;
    write(`statstack_${name}`, on);
    if (name === "sound" && on) sound("tap");
  }
  const canVibrate = "vibrate" in navigator;

  // ─── Animation helpers ────────────────────────────────────────────────────
  function stop(el) { el.getAnimations().forEach(a => a.cancel()); }

  // Screen / element entrance: short fade + rise; fade only with reduced motion
  function enter(el, {x = 0, y = 8, duration = 180, delay = 0} = {}) {
    stop(el);
    const from = reduced() ? {opacity: 0} : {opacity: 0, transform: `translate(${x}px, ${y}px)`};
    const to = reduced() ? {opacity: 1} : {opacity: 1, transform: "translate(0, 0)"};
    return el.animate([from, to], {duration, delay, easing: EASE_OUT, fill: "backwards"});
  }

  // Small emphasis on a number that just changed
  function pop(el, scale = 1.18) {
    if (reduced()) return;
    el.animate(
      [{transform: "scale(1)"}, {transform: `scale(${scale})`}, {transform: "scale(1)"}],
      {duration: 240, easing: EASE_OUT}
    );
  }

  // Wrong-answer shake, kept small so it reads as "no" rather than an alarm
  function shake(el) {
    if (reduced()) return;
    el.animate(
      [0, -7, 6, -4, 2, 0].map(x => ({transform: `translateX(${x}px)`})),
      {duration: 320, easing: "ease-out"}
    );
  }

  // Count a number up from `from` to `to`; instant with reduced motion
  function countUp(el, from, to, {duration = 420, decimals = 1, format} = {}) {
    const fmt = format || (v => v.toFixed(decimals));
    if (el._countRaf) cancelAnimationFrame(el._countRaf);
    if (reduced() || from === to) { el.textContent = fmt(to); return; }
    const start = performance.now();
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      el.textContent = fmt(from + (to - from) * eased);
      if (t < 1) el._countRaf = requestAnimationFrame(step);
    };
    el._countRaf = requestAnimationFrame(step);
  }

  // FLIP: animate an element from an old on-screen box to where it sits now
  function flipFrom(el, oldRect, duration = 280) {
    const now = el.getBoundingClientRect();
    const dx = oldRect.left - now.left, dy = oldRect.top - now.top;
    stop(el);
    if (reduced()) {
      el.animate([{opacity: 0.4}, {opacity: 1}], {duration: 150, easing: "ease"});
      return;
    }
    el.animate(
      [{transform: `translate(${dx}px, ${dy}px)`}, {transform: "translate(0, 0)"}],
      {duration, easing: EASE_IN_OUT}
    );
  }

  // Critically damped spring on translateY, starting from the current offset
  // and carrying the release velocity (px/ms) so drag → animation has no seam.
  function springY(el, from, velocity = 0, {response = 0.35, damping = 1, onUpdate} = {}) {
    if (el._springRaf) cancelAnimationFrame(el._springRaf);
    const set = y => { el.style.transform = y ? `translateY(${y}px)` : ""; if (onUpdate) onUpdate(y); };
    if (reduced()) { set(0); return; }
    const omega = (2 * Math.PI) / response;
    let x = from, v = velocity * 1000, last = performance.now();
    const step = now => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const a = -omega * omega * x - 2 * damping * omega * v;
      v += a * dt;
      x += v * dt;
      if (Math.abs(x) < 0.3 && Math.abs(v) < 5) { set(0); el._springRaf = null; return; }
      set(x);
      el._springRaf = requestAnimationFrame(step);
    };
    el._springRaf = requestAnimationFrame(step);
  }

  // Progressive resistance past a soft limit
  function rubberband(offset, limit, dimension = 300, c = 0.55) {
    const over = Math.abs(offset) - limit;
    if (over <= 0) return offset;
    const eased = (over * dimension * c) / (dimension + c * over);
    return Math.sign(offset) * (limit + eased);
  }

  // ─── Haptics ──────────────────────────────────────────────────────────────
  const PATTERNS = {correct: 18, wrong: [40, 50, 40], commit: 8, legendary: [30, 40, 30, 40, 80], reveal: 25,
    charge0: 10, charge1: 18, charge2: 28, charge3: [40, 30, 60], tear: [8, 30, 12],
    coin: 12, claim: [12, 40, 12], win: [20, 40, 20, 40, 40], lose: [60], buzzer: [80], flip: 6, tick: 4};
  function haptic(kind) {
    if (settings.haptics && canVibrate) navigator.vibrate(PATTERNS[kind] || 10);
  }

  // ─── Sound (synthesised, no audio files) ──────────────────────────────────
  // Everything runs through one master gain so the volume slider sets it all.
  let ctx = null, master = null, noiseBuf = null;
  const readVolume = () => {
    try { const v = parseFloat(localStorage.getItem("statstack_volume")); return Number.isFinite(v) ? v : 0.7; }
    catch { return 0.7; }
  };
  let volume = readVolume();
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem("statstack_volume", String(volume)); } catch { /* fine */ }
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
  }
  // A plain tone with a quick attack and an exponential tail
  function tone(ac, freq, at, dur, type = "sine", gain = 0.12, slideTo = null) {
    const t = ac.currentTime + at, osc = ac.createOscillator(), g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }
  // Filtered white noise: rips, whooshes and crowd-ish texture
  function noise(ac, at, dur, {type = "bandpass", from = 2000, to = from, q = 1, gain = 0.12} = {}) {
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = ac.currentTime + at, src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf;
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.03);
  }
  const coinClink = (ac, at = 0) => { tone(ac, 1568, at, 0.12, "sine", 0.09); tone(ac, 2093, at + 0.06, 0.22, "sine", 0.08); };
  const SOUNDS = {
    tap:       ac => tone(ac, 1200, 0, 0.04, "triangle", 0.05),
    flip:      ac => noise(ac, 0, 0.16, {type: "highpass", from: 1800, to: 5000, gain: 0.07}),
    correct:   ac => { tone(ac, 660, 0, 0.12, "triangle", 0.11); tone(ac, 990, 0.08, 0.2, "triangle", 0.1); tone(ac, 1320, 0.08, 0.2, "sine", 0.04); },
    wrong:     ac => { tone(ac, 196, 0, 0.28, "sawtooth", 0.05, 130); tone(ac, 147, 0.1, 0.3, "square", 0.03, 110); },
    reveal:    ac => { tone(ac, 523, 0, 0.14, "triangle"); tone(ac, 784, 0.08, 0.26, "triangle"); noise(ac, 0.05, 0.4, {type: "highpass", from: 6000, gain: 0.03}); },
    legendary: ac => {
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(ac, f, i * 0.07, 0.45, "triangle", 0.09));
      [523, 659, 784].forEach(f => tone(ac, f, 0.38, 0.9, "sine", 0.05));
      noise(ac, 0.3, 1, {type: "highpass", from: 7000, gain: 0.04});
    },
    coin:      ac => coinClink(ac),
    claim:     ac => { coinClink(ac); coinClink(ac, 0.12); tone(ac, 1760, 0.24, 0.3, "sine", 0.05); },
    // Pack opening: each shake rumbles a step higher, then the foil rips
    charge0:   ac => { tone(ac, 98, 0, 0.3, "sine", 0.14); noise(ac, 0, 0.25, {type: "lowpass", from: 400, gain: 0.05}); },
    charge1:   ac => { tone(ac, 131, 0, 0.32, "sine", 0.14); noise(ac, 0, 0.28, {type: "lowpass", from: 600, gain: 0.06}); },
    charge2:   ac => { tone(ac, 165, 0, 0.34, "sine", 0.15); tone(ac, 330, 0, 0.3, "triangle", 0.05); noise(ac, 0, 0.3, {type: "lowpass", from: 900, gain: 0.07}); },
    charge3:   ac => { tone(ac, 196, 0, 0.42, "sine", 0.16); tone(ac, 392, 0, 0.36, "triangle", 0.07); noise(ac, 0, 0.36, {type: "lowpass", from: 1400, gain: 0.08}); },
    tear:      ac => { noise(ac, 0, 0.22, {from: 5000, to: 900, q: 0.8, gain: 0.2}); noise(ac, 0.05, 0.12, {from: 3000, to: 1200, q: 2, gain: 0.08}); },
    // Lineup Battles
    tick:      ac => tone(ac, 880, 0, 0.05, "square", 0.025),
    buzzer:    ac => { tone(ac, 220, 0, 0.7, "square", 0.05); tone(ac, 223, 0, 0.7, "sawtooth", 0.035); },
    win:       ac => { [523, 659, 784].forEach((f, i) => tone(ac, f, i * 0.09, 0.3, "triangle", 0.1)); tone(ac, 1047, 0.27, 0.6, "triangle", 0.1); coinClink(ac, 0.45); },
    lose:      ac => { tone(ac, 392, 0, 0.3, "triangle", 0.08, 370); tone(ac, 330, 0.22, 0.5, "triangle", 0.08, 290); },
  };
  function sound(kind) {
    if (!settings.sound || volume <= 0) return;
    const ac = audio();
    if (ac && SOUNDS[kind]) SOUNDS[kind](ac);
  }

  // Fire visual, haptic and sound feedback together on the same event
  function feedback(kind) { haptic(kind); sound(kind); }

  return {EASE_OUT, reduced, settings, setSetting, canVibrate, stop, enter, pop, shake, countUp, flipFrom, springY, rubberband, feedback, haptic, sound, setVolume, volume: () => volume};
})();
