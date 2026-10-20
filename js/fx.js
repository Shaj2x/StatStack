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
  const PATTERNS = {correct: 18, wrong: [40, 50, 40], commit: 8, legendary: [30, 40, 30, 40, 80], reveal: 25};
  function haptic(kind) {
    if (settings.haptics && canVibrate) navigator.vibrate(PATTERNS[kind] || 10);
  }

  // ─── Sound (synthesised, no audio files) ──────────────────────────────────
  let ctx = null;
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function tone(ac, freq, at, dur, type = "sine", gain = 0.12) {
    const osc = ac.createOscillator(), g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ac.currentTime + at);
    g.gain.setValueAtTime(0, ac.currentTime + at);
    g.gain.linearRampToValueAtTime(gain, ac.currentTime + at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + at + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(ac.currentTime + at);
    osc.stop(ac.currentTime + at + dur + 0.02);
  }
  const SOUNDS = {
    tap:       ac => tone(ac, 880, 0, 0.08, "triangle", 0.08),
    correct:   ac => { tone(ac, 660, 0, 0.12, "triangle"); tone(ac, 990, 0.08, 0.18, "triangle"); },
    wrong:     ac => { tone(ac, 220, 0, 0.18, "sawtooth", 0.06); tone(ac, 165, 0.12, 0.25, "sawtooth", 0.06); },
    reveal:    ac => { tone(ac, 523, 0, 0.12); tone(ac, 784, 0.1, 0.22); },
    legendary: ac => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(ac, f, i * 0.08, 0.3, "triangle", 0.1)),
  };
  function sound(kind) {
    if (!settings.sound) return;
    const ac = audio();
    if (ac && SOUNDS[kind]) SOUNDS[kind](ac);
  }

  // Fire visual, haptic and sound feedback together on the same event
  function feedback(kind) { haptic(kind); sound(kind); }

  return {EASE_OUT, reduced, settings, setSetting, canVibrate, stop, enter, pop, shake, countUp, flipFrom, springY, rubberband, feedback, haptic};
})();
