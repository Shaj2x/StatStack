// Daily Challenge, Who Am I?, the Locker and the leaderboards. Loaded after
// js/app.js and uses its game state (coins, profile, ownedCards…) and helpers.

const SITE_URL = "https://shaj2x.github.io/StatStack/";

// ─── DAILY CHALLENGE ────────────────────────────────────────────────────────
// Everyone gets the same 10 matchups on the same calendar day: the puzzle is
// built from a random generator seeded with the day's number.
const DAILY_LENGTH = 10;
const DAILY_EPOCH = Date.UTC(2026, 9, 21); // Daily #1
const DAILY_MIN = {ppg: 6, rpg: 2.5, apg: 1.5, spg: 0.6, bpg: 0.4};
const RARITY_ORDER = {common: 0, rare: 1, epic: 2, legendary: 3};
// Points, rebounds and assists come up most; steals and blocks now and then
const DAILY_STATS = ["ppg", "ppg", "ppg", "rpg", "rpg", "apg", "apg", "spg", "bpg"].map(k => statTypes.find(s => s.key === k));

function dailyNumber(d = new Date()) {
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - DAILY_EPOCH) / 86400000) + 1;
}
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hard on purpose: players come from every era, the two numbers are within
// 6% of each other, and every other question pits a star against a lesser
// player who usually edges them
function dailyPuzzle(num) {
  const rand = seeded(Math.imul(num, 2654435761) ^ 0x5eed);
  const any = list => list[Math.floor(rand() * list.length)];
  const pool = ALL_CARDS.filter(c => c.ppg > 0);
  const stars = pool.filter(c => RARITY_ORDER[c.rarity] >= 2);
  const used = new Set(), questions = [];
  for (let guard = 0; questions.length < DAILY_LENGTH && guard < 4000; guard++) {
    const stat = any(DAILY_STATS);
    const trap = questions.length % 2 === 0;
    const a = any(trap ? stars : pool);
    const av = a[stat.key];
    if (av < DAILY_MIN[stat.key] || used.has(a.name)) continue;
    let close = pool.filter(b => b.name !== a.name && !used.has(b.name) && b[stat.key] !== av &&
      Math.abs(b[stat.key] - av) <= Math.max(0.1, av * 0.06) && (!trap || RARITY_ORDER[b.rarity] < RARITY_ORDER[a.rarity]));
    if (trap) {
      const upsets = close.filter(b => b[stat.key] > av);
      if (upsets.length && rand() < 0.7) close = upsets;
    }
    if (!close.length) continue;
    const b = any(close);
    used.add(a.name);
    used.add(b.name);
    // Show the star on the left about half the time so the trap isn't a pattern
    questions.push(rand() < 0.5 ? {a, b, stat: stat.key} : {a: b, b: a, stat: stat.key});
  }
  return questions;
}

let dailyCache = {num: 0, questions: []};
function todaysPuzzle() {
  const num = dailyNumber();
  if (dailyCache.num !== num) dailyCache = {num, questions: dailyPuzzle(num)};
  return dailyCache;
}
const statInfo = key => statTypes.find(s => s.key === key);
const isRight = (q, guess) => (guess === "higher") === (q.b[q.stat] > q.a[q.stat]);
const emojiGrid = answers => answers.map(ok => (ok ? "🟩" : "🟥")).join("");
let dailyRevealed = false; // showing the answer to the question just guessed
let dailyTimer = null;

function dailyState() {
  const {num} = todaysPuzzle();
  const d = profile.daily;
  if (d.num !== num) return "intro";
  return d.done ? "done" : "playing";
}

function renderDots() {
  const d = profile.daily, playing = dailyState() !== "intro";
  $("dailyDots").innerHTML = Array.from({length: DAILY_LENGTH}, (_, i) => {
    const a = playing ? d.answers[i] : undefined;
    const cls = a === true ? "ok" : a === false ? "miss" : i === d.answers.length && playing && !d.done ? "now" : "";
    const label = a === true ? "right" : a === false ? "wrong" : "not played";
    return `<li class="${cls}"><span class="visually-hidden">Question ${i + 1}: ${label}</span></li>`;
  }).join("");
}

function dailySide(c, stat, showValue, side) {
  const ph = photoFor(c), t = team(c.team);
  return `<article class="daily-side daily-${side}" style="${teamVars(c.team)}">
    <img class="daily-photo${ph.cutout ? "" : " is-photo"}" src="${esc(ph.src)}" alt="" onerror="imgFail(this)">
    <div class="daily-text">
      <span class="daily-season">${esc(c.season)} · ${esc(t.name || c.team)}</span>
      <h2 class="daily-name">${nameHtml(c.name)}</h2>
      <span class="daily-val${showValue ? "" : " hidden-val"}">${showValue ? one(c[stat]) : "?"}</span>
      <span class="daily-lbl">${statInfo(stat).label}</span>
    </div>
  </article>`;
}

function renderDaily() {
  clearInterval(dailyTimer);
  const {num, questions} = todaysPuzzle();
  const state = dailyState(), d = profile.daily, body = $("dailyBody");
  $("dailyTitle").textContent = `Daily #${num}`;
  $("dailyDate").textContent = new Date().toLocaleDateString(undefined, {weekday: "long", month: "long", day: "numeric"});
  renderDots();

  if (state === "intro") {
    body.innerHTML = `<div class="panel daily-intro">
      <h2 class="panel-title">Today's 10 matchups</h2>
      <ul class="daily-rules">
        <li><strong>Every era.</strong> 1984 to today, side by side.</li>
        <li><strong>Every one is close.</strong> The two numbers are within a few percent.</li>
        <li><strong>Stars lie.</strong> Half the questions put a big name against someone who might beat them.</li>
        <li><strong>One try.</strong> Everyone gets the same puzzle today.</li>
      </ul>
      <p>50 coins for each right answer, and a 250-coin bonus for a perfect 10.</p>
      <button class="pill pill-solid" id="dailyStart" type="button">Start Daily #${num}</button>
    </div>`;
    return;
  }

  if (state === "playing" || dailyRevealed) {
    const i = dailyRevealed ? d.answers.length - 1 : d.answers.length;
    const q = questions[i], info = statInfo(q.stat);
    const verdict = dailyRevealed
      ? `<p class="daily-verdict ${d.answers[i] ? "ok" : "miss"}" role="status">${d.answers[i] ? "Right" : "Wrong"} · ${esc(q.b.name)} averaged ${one(q.b[q.stat])}, ${q.b[q.stat] > q.a[q.stat] ? "more" : "fewer"} than ${one(q.a[q.stat])}</p>
         <button class="pill pill-solid daily-next" id="dailyNext" type="button">${d.done ? "See your result" : "Next matchup"}</button>`
      : `<div class="daily-actions">
           <button class="pill pill-solid" type="button" data-daily="higher">Higher</button>
           <button class="pill pill-ghost" type="button" data-daily="lower">Lower</button>
         </div>`;
    body.innerHTML = `<div class="daily-q">
      <p class="daily-ask">Matchup ${i + 1} of ${DAILY_LENGTH} · Did <strong>${esc(q.b.name)}</strong> average more or fewer <strong>${info.label}</strong>?</p>
      <div class="daily-duel">
        ${dailySide(q.a, q.stat, true, "a")}
        <span class="daily-vs" aria-hidden="true">VS</span>
        ${dailySide(q.b, q.stat, dailyRevealed, "b")}
      </div>
      ${verdict}
    </div>`;
    body.querySelectorAll(".daily-name").forEach(el => fitName(el, 18));
    const focus = body.querySelector("#dailyNext, [data-daily]");
    if (focus) focus.focus({preventScroll: true});
    return;
  }

  // Done: score, share, countdown, and how everyone else did
  const reward = d.score * 50 + (d.score === DAILY_LENGTH ? 250 : 0);
  body.innerHTML = `<div class="daily-done">
    <div class="panel daily-result">
      <p class="eyebrow">Your score</p>
      <p class="daily-score display">${d.score}<span>/${DAILY_LENGTH}</span></p>
      <p class="daily-grid" aria-label="${d.score} right out of ${DAILY_LENGTH}">${emojiGrid(d.answers)}</p>
      <p class="muted">+${reward.toLocaleString()} coins earned</p>
      <button class="pill pill-solid pill-sm" id="dailyShare" type="button">Share result</button>
      <p class="daily-next-in">Next Daily in <strong id="dailyCountdown">—</strong></p>
    </div>
    <div class="panel daily-review">
      <h2 class="panel-title">Today's answers</h2>
      <ol class="review-list">${questions.map((q, i) => `<li class="${d.answers[i] ? "ok" : "miss"}">
        <span class="review-mark" aria-hidden="true">${d.answers[i] ? "✓" : "✗"}</span>
        <span><strong>${esc(q.a.name)}</strong> ${one(q.a[q.stat])} vs <strong>${esc(q.b.name)}</strong> ${one(q.b[q.stat])} <em>${statInfo(q.stat).short} · ${esc(q.a.season)} / ${esc(q.b.season)}</em></span>
      </li>`).join("")}</ol>
    </div>
    <div class="panel daily-board">
      <h2 class="panel-title">Today's board</h2>
      <div id="dailyBoard"><p class="muted">Loading…</p></div>
    </div>
  </div>`;
  tickCountdown();
  dailyTimer = setInterval(tickCountdown, 1000);
  loadBoard("daily", $("dailyBoard"), 10);
}

function tickCountdown() {
  const el = $("dailyCountdown");
  if (!el || currentScreen !== "daily") { clearInterval(dailyTimer); return; }
  const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const left = Math.max(0, next - now);
  if (left < 1000 || dailyNumber() !== dailyCache.num) { renderDaily(); return; }
  const h = Math.floor(left / 3600000), m = Math.floor(left / 60000) % 60, s = Math.floor(left / 1000) % 60;
  el.textContent = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function startDaily() {
  profile.daily = {num: todaysPuzzle().num, answers: [], done: false, score: 0};
  dailyRevealed = false;
  progressChanged();
  renderDaily();
}

function answerDaily(guess) {
  if (dailyState() !== "playing" || dailyRevealed) return;
  const {questions} = todaysPuzzle(), d = profile.daily;
  const q = questions[d.answers.length], ok = isRight(q, guess);
  d.answers.push(ok);
  if (d.answers.length === DAILY_LENGTH) {
    d.done = true;
    d.score = d.answers.filter(Boolean).length;
    const reward = d.score * 50 + (d.score === DAILY_LENGTH ? 250 : 0);
    coins += reward;
    profile.stats.coinsEarned += reward;
    profile.stats.dailies++;
    if (d.score === DAILY_LENGTH) profile.stats.dailyPerfect++;
    updateBoard();
  }
  dailyRevealed = true;
  FX.feedback(ok ? "correct" : "wrong");
  progressChanged();
  renderDaily();
  const val = $("dailyBody").querySelector(".daily-b .daily-val");
  if (val) FX.countUp(val, 0, q.b[q.stat]);
  if (!ok) FX.shake($("dailyBody").querySelector(".daily-b"));
}

async function shareDaily() {
  const d = profile.daily;
  const text = `StatStack Daily #${d.num} · ${d.score}/${DAILY_LENGTH}\n${emojiGrid(d.answers)}\n${SITE_URL}`;
  if (navigator.share && matchMedia("(hover: none)").matches) {
    try { await navigator.share({text}); return; } catch { /* closed the share sheet */ }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(CHECK_ICON, "Copied", "Paste it anywhere to share your result.");
  } catch {
    prompt("Copy your result:", text);
  }
}

$("dailyBody").addEventListener("click", e => {
  const guess = e.target.closest("[data-daily]");
  if (guess) answerDaily(guess.dataset.daily);
  else if (e.target.closest("#dailyStart")) startDaily();
  else if (e.target.closest("#dailyNext")) { dailyRevealed = false; renderDaily(); }
  else if (e.target.closest("#dailyShare")) shareDaily();
});
SCREEN_HOOKS.daily = () => { dailyRevealed = false; renderDaily(); };

// ─── WHO AM I? ──────────────────────────────────────────────────────────────
// A season's stat line and four names. The wrong names are the players whose
// numbers that season were closest, so the stat line alone has to decide it.
const WHO_SCALE = {ppg: 5, rpg: 2, apg: 1.5, spg: 0.4, bpg: 0.4};
const WHO_PAY = 25, WHO_PAY_HINT = 12;
let who = null, whoStreak = 0;

function newWho() {
  const pool = currentPlayers.filter(p => p.ppg >= 4);
  const answer = pick(pool);
  const dist = p => statTypes.reduce((sum, s) => sum + Math.abs(p[s.key] - answer[s.key]) / WHO_SCALE[s.key], 0);
  const near = pool.filter(p => p.name !== answer.name).sort((x, y) => dist(x) - dist(y)).slice(0, 7);
  const decoys = near.sort(() => Math.random() - 0.5).slice(0, 3);
  const options = [answer, ...decoys].sort(() => Math.random() - 0.5);
  who = {answer, options, hint: false, picked: null};
  renderWho();
}

function renderWho() {
  if (!who) return newWho();
  const {answer, options, hint, picked} = who, done = picked !== null;
  const card = $("whoCard");
  if (hint || done) paint(card, answer.team);
  else ["--team-bg", "--team-bg2", "--team-accent"].forEach(v => card.style.removeProperty(v));
  card.classList.toggle("revealed", done);
  card.classList.toggle("tinted", hint || done);
  $("whoSeason").textContent = `${currentSeasonKey} season`;
  $("whoTitle").innerHTML = done ? nameHtml(answer.name) : "Who am I?";
  if (done) fitName($("whoTitle"), 28);
  else $("whoTitle").style.fontSize = "";
  const img = $("whoPhoto");
  if (done) setImg(img, answer); else img.removeAttribute("src");
  img.hidden = !done;
  $("whoStats").innerHTML = statTypes.map(s => `<div><dt>${s.short}</dt><dd>${one(answer[s.key])}</dd></div>`).join("");
  $("whoHint").hidden = hint || done;
  $("whoTeam").hidden = !(hint || done);
  $("whoTeam").textContent = team(answer.team).name || answer.team;
  $("whoOptions").innerHTML = options.map((p, i) => {
    const cls = !done ? "" : p === answer ? " ok" : p === picked ? " miss" : " dim";
    return `<button class="who-option${cls}" type="button" data-who="${i}"${done ? " disabled" : ""}><span class="who-key" aria-hidden="true">${i + 1}</span>${esc(p.name)}</button>`;
  }).join("");
  $("whoNext").hidden = !done;
  $("whoStreak").textContent = whoStreak;
  $("whoRight").textContent = profile.stats.whoCorrect.toLocaleString();
  $("whoBest").textContent = profile.stats.whoBest;
}

function answerWho(i) {
  if (!who || who.picked !== null) return;
  const choice = who.options[i];
  if (!choice) return;
  who.picked = choice;
  const ok = choice === who.answer;
  profile.stats.whoRounds++;
  if (ok) {
    const pay = who.hint ? WHO_PAY_HINT : WHO_PAY;
    coins += pay;
    profile.stats.coinsEarned += pay;
    profile.stats.whoCorrect++;
    whoStreak++;
    profile.stats.whoBest = Math.max(profile.stats.whoBest, whoStreak);
    $("whoResult").textContent = `Right · +${pay} coins`;
    $("whoResult").className = "who-result ok";
  } else {
    whoStreak = 0;
    $("whoResult").textContent = `It was ${who.answer.name}`;
    $("whoResult").className = "who-result miss";
  }
  FX.feedback(ok ? "correct" : "wrong");
  updateBoard();
  progressChanged();
  renderWho();
  if (ok) FX.pop($("coins"));
  else FX.shake($("whoOptions"));
  $("whoNext").focus({preventScroll: true});
}

$("whoOptions").addEventListener("click", e => {
  const b = e.target.closest("[data-who]");
  if (b) answerWho(Number(b.dataset.who));
});
$("whoHint").addEventListener("click", () => { if (who && who.picked === null) { who.hint = true; renderWho(); } });
$("whoNext").addEventListener("click", () => { $("whoResult").textContent = ""; newWho(); $("whoOptions").querySelector("button").focus({preventScroll: true}); });
document.addEventListener("keydown", e => {
  if (currentScreen !== "who" || e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, select, textarea")) return;
  if (document.querySelector("dialog[open]")) return;
  if (/^[1-4]$/.test(e.key) && who && who.picked === null) answerWho(Number(e.key) - 1);
  else if (e.key.toLowerCase() === "t" && who && who.picked === null) $("whoHint").click();
  else if (e.key === "Enter" && who && who.picked !== null && !e.target.closest("button")) $("whoNext").click();
});
SCREEN_HOOKS.who = () => renderWho();
SCREEN_HOOKS.seasonChanged = () => {
  who = null;
  whoStreak = 0;
  if (currentScreen === "who") { $("whoResult").textContent = ""; newWho(); }
};

// ─── LOCKER ─────────────────────────────────────────────────────────────────
// A starting five and a three-player bench built from cards you own.
const SLOT_NAMES = ["PG", "SG", "SF", "PF", "C", "6th", "7th", "8th"];
const OVR_WEIGHT = {ppg: 0.4, rpg: 0.2, apg: 0.2, spg: 0.1, bpg: 0.1};
let pickingSlot = null;

// 55–99, from where the player ranked in their own season
function cardOvr(c) {
  const ranks = seasonRanks(c);
  if (!ranks) return 55;
  const score = Object.entries(OVR_WEIGHT).reduce((sum, [k, w]) => sum + w * (1 - (ranks[k].rank - 1) / ranks.count), 0);
  return Math.round(55 + 44 * score);
}
function ownedByKey(key) {
  return key ? ownedCards.find(c => cardKey(c) === key) || null : null;
}
function miniTile(c) {
  const ph = photoFor(c);
  return `<span class="mini ${c.rarity}" style="${teamVars(c.team)}">
    <img class="mini-photo${ph.cutout ? "" : " is-photo"}" src="${esc(ph.src)}" alt="" loading="lazy" onerror="imgFail(this)">
    <span class="mini-ovr">${cardOvr(c)}</span>
    <span class="mini-name">${esc(c.name)}</span>
    <span class="mini-meta">${esc(c.team)} · ${esc(c.season)}</span>
  </span>`;
}
function slotHtml(i) {
  const c = ownedByKey(profile.lineup.slots[i]);
  return `<button class="slot${c ? " filled" : ""}" type="button" data-slot="${i}" aria-label="${SLOT_NAMES[i]}: ${c ? esc(c.name) + ", change" : "empty, add a card"}">
    <span class="slot-pos">${SLOT_NAMES[i]}</span>
    ${c ? miniTile(c) : `<span class="slot-empty" aria-hidden="true">+</span>`}
  </button>`;
}

function renderLocker() {
  const slots = profile.lineup.slots;
  $("court").innerHTML = `<svg class="court-lines" viewBox="0 0 500 470" preserveAspectRatio="none" aria-hidden="true">
      <rect x="2" y="2" width="496" height="466" rx="8"></rect>
      <rect x="170" y="2" width="160" height="190"></rect>
      <path d="M170 192a80 80 0 0 0 160 0"></path>
      <path d="M30 2v140a220 220 0 0 0 440 0V2"></path>
      <path d="M190 468a60 60 0 0 1 120 0"></path>
      <circle cx="250" cy="42" r="9"></circle>
    </svg>` + [0, 1, 2, 3, 4].map(i => `<div class="court-spot spot-${i}">${slotHtml(i)}</div>`).join("");
  $("bench").innerHTML = [5, 6, 7].map(slotHtml).join("");
  if (document.activeElement !== $("lineupName")) $("lineupName").value = profile.lineup.name;

  const starters = slots.slice(0, 5).map(ownedByKey).filter(Boolean);
  $("teamOvr").textContent = starters.length ? Math.round(starters.reduce((s, c) => s + cardOvr(c), 0) / starters.length) : "—";
  $("teamOvr").parentElement.dataset.partial = starters.length && starters.length < 5 ? `${starters.length}/5` : "";
  $("lineupStats").innerHTML = statTypes.map(s =>
    `<div><dt>${s.short}</dt><dd>${starters.length ? one(starters.reduce((sum, c) => sum + c[s.key], 0)) : "—"}</dd></div>`).join("");
  $("lockerTotals").innerHTML = `<div><dt>Starters</dt><dd>${starters.length}/5</dd></div>
    <div><dt>Bench</dt><dd>${slots.slice(5).map(ownedByKey).filter(Boolean).length}/3</dd></div>`;
}

function openPicker(i) {
  pickingSlot = i;
  $("pickerTitle").textContent = `${SLOT_NAMES[i]} · pick a card`;
  $("pickerSearch").value = "";
  $("pickerRemove").hidden = !profile.lineup.slots[i];
  renderPicker();
  $("pickerDialog").showModal();
  $("pickerSearch").focus();
}
function renderPicker() {
  const q = $("pickerSearch").value.trim().toLowerCase();
  const taken = new Set(profile.lineup.slots.filter((k, j) => k && j !== pickingSlot));
  const cards = [...groupCards(ownedCards).values()].map(copies => copies[0])
    .filter(c => !q || c.name.toLowerCase().includes(q) || (team(c.team).name || "").toLowerCase().includes(q) || c.season.includes(q))
    .map(c => ({c, ovr: cardOvr(c)}))
    .sort((a, b) => b.ovr - a.ovr);
  $("pickerList").innerHTML = cards.length ? cards.map(({c}) => {
    const key = cardKey(c), used = taken.has(key);
    return `<li><button class="pick-row" type="button" data-pick="${esc(key)}"${used ? " disabled" : ""}>
      ${miniTile(c)}
      <span class="pick-text"><strong>${esc(c.name)}</strong><span>${esc(team(c.team).name || c.team)} · ${esc(c.season)}${used ? " · in lineup" : ""}</span></span>
    </button></li>`;
  }).join("") : `<li class="muted picker-empty">${ownedCards.length ? "No cards match." : "No cards yet. Open a pack first."}</li>`;
}
function setSlot(key) {
  profile.lineup.slots[pickingSlot] = key;
  progressChanged();
  $("pickerDialog").close();
  renderLocker();
  const slot = document.querySelector(`[data-slot="${pickingSlot}"]`);
  if (slot) { FX.pop(slot, 1.06); slot.focus({preventScroll: true}); }
}

document.querySelector("#screen-locker").addEventListener("click", e => {
  const slot = e.target.closest("[data-slot]");
  if (slot) openPicker(Number(slot.dataset.slot));
});
$("pickerList").addEventListener("click", e => {
  const row = e.target.closest("[data-pick]");
  if (row && !row.disabled) setSlot(row.dataset.pick);
});
$("pickerSearch").addEventListener("input", renderPicker);
$("pickerRemove").addEventListener("click", () => setSlot(null));
$("pickerClose").addEventListener("click", () => $("pickerDialog").close());
$("pickerDialog").addEventListener("click", e => { if (e.target === $("pickerDialog")) $("pickerDialog").close(); });
let nameTimer = null;
$("lineupName").addEventListener("input", () => {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => { profile.lineup.name = $("lineupName").value.trim().slice(0, 24); progressChanged(); }, 600);
});
$("clearLineup").addEventListener("click", () => {
  if (!profile.lineup.slots.some(Boolean) || !confirm("Clear every spot in your lineup?")) return;
  profile.lineup.slots = profile.lineup.slots.map(() => null);
  progressChanged();
  renderLocker();
});
SCREEN_HOOKS.locker = renderLocker;

// ─── LEADERBOARDS ───────────────────────────────────────────────────────────
const BOARDS = {
  daily: {unit: s => `${s}/10`, empty: "Nobody has finished today's Daily yet."},
  week: {unit: s => `${s} in a row`, empty: "No streaks yet this week."},
  alltime: {unit: s => `${s} in a row`, empty: "No streaks yet."},
  legendaries: {unit: s => `${s} legendar${s === 1 ? "y" : "ies"}`, empty: "No legendaries pulled yet."},
};
let activeBoard = load('statstack_board', "daily") || "daily";
const boardCache = {};

async function loadBoard(board, el, limit = 50) {
  if (!Account.enabled) {
    el.innerHTML = `<p class="muted">Leaderboards need accounts, which aren't switched on for this site.</p>`;
    return;
  }
  const puzzle = board === "daily" ? dailyNumber() : null;
  const cacheKey = `${board}:${puzzle}`;
  let res = boardCache[cacheKey];
  if (!res || Date.now() - res.at > 30000) {
    el.innerHTML = `<p class="muted">Loading…</p>`;
    res = {...(await Account.leaderboard(board, puzzle)), at: Date.now()};
    if (!res.error) boardCache[cacheKey] = res;
  }
  if (res.error) {
    const text = res.error !== "off" ? `Couldn't load the board. ${esc(res.error)}`
      : Account.phase() === "loading" ? "Connecting…" : "Couldn't reach the leaderboard. Check your connection and refresh.";
    el.innerHTML = `<p class="muted">${text}</p>`;
    return;
  }
  const me = Account.signedIn() && profile.name ? profile.name.toLowerCase() : "";
  const rows = res.rows.slice(0, limit);
  const join = Account.signedIn()
    ? (profile.name ? "" : `<p class="muted board-note">Pick a username on your <a href="#profile">profile</a> to show up here.</p>`)
    : `<p class="board-note"><button class="link-btn" type="button" data-auth="signup">Create an account</button> to get your name on the board.</p>`;
  el.innerHTML = (rows.length ? `<ol class="board-list">${rows.map((r, i) => `
    <li class="board-row${r.username.toLowerCase() === me ? " me" : ""}${i < 3 ? ` top top-${i + 1}` : ""}">
      <span class="board-rank">${i + 1}</span>
      <span class="avatar" style="${TEAMS[r.team] ? teamVars(r.team) : ""}">${esc(initials(r.username))}</span>
      <span class="board-name">${esc(r.username)}</span>
      <span class="board-score">${BOARDS[board].unit(r.score)}</span>
    </li>`).join("")}</ol>` : `<p class="muted">${BOARDS[board].empty}</p>`) + join;
}

function renderRanks() {
  document.querySelectorAll(".board-tab").forEach(t => {
    const on = t.dataset.board === activeBoard;
    t.classList.toggle("active", on);
    t.setAttribute("aria-pressed", String(on));
  });
  loadBoard(activeBoard, $("board"));
}
$("boardTabs").addEventListener("click", e => {
  const t = e.target.closest("[data-board]");
  if (!t) return;
  activeBoard = t.dataset.board;
  save('statstack_board', activeBoard);
  renderRanks();
});
$("ranksRefresh").addEventListener("click", () => {
  Object.keys(boardCache).forEach(k => delete boardCache[k]);
  renderRanks();
});
document.addEventListener("click", e => {
  const auth = e.target.closest(".board-note [data-auth]");
  if (auth) openAuth(auth.dataset.auth);
});
SCREEN_HOOKS.ranks = renderRanks;
// Redraw once the account connection settles (or the player signs in or out)
let lastPhase = Account.phase();
Account.on(() => {
  if (Account.phase() === lastPhase) return;
  lastPhase = Account.phase();
  if (currentScreen === "ranks") renderRanks();
  if (currentScreen === "daily" && dailyState() === "done") loadBoard("daily", $("dailyBoard") || document.createElement("div"), 10);
});
