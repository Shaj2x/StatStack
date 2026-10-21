// StatStack game logic. Player data (SEASONS) comes from js/data.js, team
// colours from js/teams.js, motion/haptics/sound from js/fx.js.

const $ = id => document.getElementById(id);

// ─── STORAGE ────────────────────────────────────────────────────────────────
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

// ─── GAME STATE ─────────────────────────────────────────────────────────────
let coins = parseInt(load('statstack_coins', 0)) || 0;
let bestStreak = parseInt(load('statstack_bestStreak', 0)) || 0;
let ownedCards = load('statstack_cards', []);
if (!Array.isArray(ownedCards)) ownedCards = [];
// Profile: username, avatar team, lifetime totals and earned badges
function freshProfile() {
  return {name: "", team: "", created: Date.now(), stats: {rounds: 0, correct: 0, coinsEarned: 0, packs: 0}, seasons: [], badges: {}};
}
function readProfile(p) {
  const base = freshProfile();
  const out = {...base, ...(p && typeof p === "object" ? p : {})};
  out.stats = {...base.stats, ...out.stats};
  if (!Array.isArray(out.seasons)) out.seasons = [];
  if (!out.badges || typeof out.badges !== "object") out.badges = {};
  return out;
}
let profile = readProfile(load('statstack_profile', null));
// When progress last changed, so a cloud save and this device can tell which is newer
let updatedAt = load('statstack_updated', 0) || 0;
let streak = 0, multiplier = 1, roundNumber = 0;
let player1, player2, currentStat, gameActive = false;

// Newest season first ("1999-00" sorts by its start year)
const SEASON_KEYS = Object.keys(SEASONS).sort((a, b) => parseInt(b) - parseInt(a));
let currentSeasonKey = SEASONS[load('statstack_season', '')] ? load('statstack_season', '') : SEASON_KEYS[0];
let currentPlayers = [];

const statTypes = [
  {key: "ppg", label: "points per game", short: "PTS"},
  {key: "rpg", label: "rebounds per game", short: "REB"},
  {key: "apg", label: "assists per game", short: "AST"},
  {key: "spg", label: "steals per game", short: "STL"},
  {key: "bpg", label: "blocks per game", short: "BLK"}
];
const PACK_PRICE = 2000;

// ─── IMAGES ─────────────────────────────────────────────────────────────────
// Transparent silhouette used when a headshot is missing or blocked
const FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 260 190'%3E%3Ccircle cx='130' cy='70' r='44' fill='white' opacity='0.18'/%3E%3Cpath d='M30 190c8-52 50-80 100-80s92 28 100 80z' fill='white' opacity='0.18'/%3E%3C/svg%3E";
// Where a player's picture comes from: NBA.com's cut-out headshot, or, for
// players NBA.com has none for, a Wikimedia photo from js/photos.js (null
// there means no confirmed photo, so show the silhouette)
function photoFor(p) {
  const key = p.img || `name:${p.name}`;
  if (key in PHOTOS) {
    const ph = PHOTOS[key];
    return ph ? {src: ph.src, credit: ph.credit, cutout: false} : {src: FALLBACK, credit: "", cutout: true};
  }
  return p.img
    ? {src: `https://cdn.nba.com/headshots/nba/latest/1040x760/${p.img}.png`, credit: "", cutout: true}
    : {src: FALLBACK, credit: "", cutout: true};
}
function imgFail(img) { img.onerror = null; img.src = FALLBACK; img.classList.remove("is-photo"); }
function setImg(img, p, creditEl) {
  const ph = photoFor(p);
  img.onerror = () => { imgFail(img); if (creditEl) creditEl.textContent = ""; };
  img.classList.toggle("is-photo", !ph.cutout);
  img.src = ph.src;
  img.alt = p.name;
  if (creditEl) creditEl.textContent = ph.credit;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}
function teamVars(code) {
  const t = team(code);
  return `--team-bg:${t.bg};--team-bg2:${t.bg2};--team-accent:${t.accent}`;
}
function paint(el, code) {
  const t = team(code);
  el.style.setProperty("--team-bg", t.bg);
  el.style.setProperty("--team-bg2", t.bg2);
  el.style.setProperty("--team-accent", t.accent);
}

// ─── HOOKS ──────────────────────────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
const hooks = ["90% of players get this wrong", "85% fail this one", "Only 12% get this right", "Can you beat the odds?", "94% lose their streak here", "This one tricks most players", "Harder than it looks", "88% get fooled by this", "Will you be the exception?"];
const wins  = ["Nice read", "Most people miss that", "Great eye for stats", "Keep it going", "Better than 85% of players"];
const fails = ["87% got that wrong too", "Tough one", "Stats can be deceiving", "Even the pros miss that one"];

// ─── SCREENS ────────────────────────────────────────────────────────────────
const SCREENS = ["play", "packs", "collection", "profile"];
const ALIASES = {home: "play", shop: "packs"}; // links from the previous layout
let currentScreen = null;

function showScreen(name) {
  name = ALIASES[name] || name;
  if (!SCREENS.includes(name)) name = "play";
  const changed = name !== currentScreen;
  currentScreen = name;
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.dataset.screen === name));
  document.querySelectorAll(".nav-link").forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  });
  if (changed) FX.enter(document.querySelector(`.screen[data-screen="${name}"]`));
  if (name === "packs") renderShop();
  if (name === "collection") { updateCollStats(); renderColl(activeFilter); }
  if (name === "profile") renderProfile();
  if (name === "play" && !player1) startNewRound();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () => showScreen(location.hash.slice(1)));

// ─── SEASON ─────────────────────────────────────────────────────────────────
function setSeason(key) {
  currentSeasonKey = key;
  save('statstack_season', key);
  currentPlayers = SEASONS[key].players.filter(p => p.ppg > 0 || p.rpg > 0);
  $("seasonSelect").value = key;
  $("playerCountInfo").textContent = `${key}: ${currentPlayers.length} players, real regular-season per-game stats.`;
}
function changeSeason() {
  setSeason($("seasonSelect").value);
  roundNumber = 0; streak = 0; multiplier = 1; player1 = player2 = null;
  updateBoard();
  if (currentScreen === "play") startNewRound();
  if (currentScreen === "packs") renderShop();
}

// ─── PLAYER SELECTION ───────────────────────────────────────────────────────
function randPlayer(exclude = null) {
  let p, tries = 0;
  do { p = pick(currentPlayers); tries++; }
  while (exclude && p.name === exclude.name && tries < 40);
  return p;
}

// Difficulty ramp: opponents get closer to player 1's stat as rounds go on
function pickOpponent(base, key) {
  const val = base[key];
  let maxDiff;
  if (roundNumber <= 5)       maxDiff = Infinity;
  else if (roundNumber <= 10) maxDiff = 10;
  else if (roundNumber <= 15) maxDiff = 6;
  else if (roundNumber <= 20) maxDiff = 3.5;
  else                        maxDiff = 1.5;
  const pool = currentPlayers.filter(p => p.name !== base.name && Math.abs(p[key] - val) <= maxDiff);
  return pool.length ? pick(pool) : randPlayer(base);
}

// ─── GAME ROUND ─────────────────────────────────────────────────────────────
function startNewRound() {
  // Player 2's half slides across to become player 1, so remember where it was
  const carried = player2 && currentScreen === "play" ? $("card2").getBoundingClientRect() : null;
  roundNumber++;
  player1 = player2 || randPlayer();
  currentStat = pick(statTypes);
  player2 = pickOpponent(player1, currentStat.key);

  setPlayer(1, player1);
  setPlayer(2, player2, true);

  $("hookText").textContent = pick(hooks);
  $("roundLabel").textContent = `Round ${roundNumber}`;
  $("guessButtons").hidden = false;
  $("swipeHint").hidden = false;
  $("player2Stat").hidden = true;
  $("verdict").hidden = true;
  $("result").textContent = "";
  $("result").className = "result";
  $("vsBadge").textContent = "VS";
  $("vsBadge").className = "vs";
  gameActive = true;

  placeSeam();
  if (carried) {
    FX.flipFrom($("card1"), carried, 420);
    FX.enter($("card2"), {x: 60, y: 0, duration: 320, delay: 120});
  }
}

// On phones the halves stack, so the VS badge follows the boundary between them
const stacked = matchMedia("(max-width: 760px)");
function placeSeam() {
  if (stacked.matches) $("duel").style.setProperty("--seam-y", `${$("card1").offsetHeight}px`);
}
// Names break only between words: each word (hyphens included, so
// Gilgeous-Alexander stays whole) is kept on one line
function nameHtml(name) {
  return String(name).split(/\s+/).map(w => `<span class="name-word">${esc(w)}</span>`).join(" ");
}

// Shrink a name until its longest word fits the space its half (or card)
// leaves for text, so names never break mid-word or run into the VS badge
function fitName(el, min = 24) {
  el.style.fontSize = "";
  const inner = node => {
    const cs = getComputedStyle(node);
    return node.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  };
  const box = el.closest(".side, .pcard, .pback") || el.parentElement;
  const room = Math.min(inner(el.parentElement) || Infinity, inner(box));
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > room + 1 && size > min) {
    size -= 2;
    el.style.fontSize = `${size}px`;
  }
}
window.addEventListener("resize", () => {
  placeSeam();
  fitName($("player1Name"));
  fitName($("player2Name"));
});

function setPlayer(n, p, hide = false) {
  const card = $(`card${n}`);
  paint(card, p.team);
  setImg($(`player${n}Image`), p, $(`player${n}Credit`));
  $(`player${n}Name`).innerHTML = nameHtml(p.name);
  fitName($(`player${n}Name`));
  $(`player${n}Team`).textContent = team(p.team).name || p.team;
  $(`player${n}StatLabel`).textContent = hide
    ? `${currentStat.label} in ${currentSeasonKey}?`
    : `${currentStat.label} in ${currentSeasonKey}`;
  if (!hide) $(`player${n}Stat`).textContent = p[currentStat.key].toFixed(1);
}

function makeGuess(guess, fromKeyboard = false) {
  if (!gameActive) return;
  gameActive = false;
  const v1 = player1[currentStat.key], v2 = player2[currentStat.key];
  const coinsBefore = coins, multiplierBefore = multiplier;
  const correct = (guess === "higher" && v2 >= v1) || (guess === "lower" && v2 <= v1);
  profile.stats.rounds++;
  if (!profile.seasons.includes(currentSeasonKey)) profile.seasons.push(currentSeasonKey);

  $("guessButtons").hidden = true;
  $("swipeHint").hidden = true;
  $("player2StatLabel").textContent = `${currentStat.label} in ${currentSeasonKey}`;
  $("player2Stat").hidden = false;
  FX.countUp($("player2Stat"), 0, v2);
  placeSeam();

  const res = $("result"), vs = $("vsBadge");
  if (correct) {
    streak++;
    multiplier = Math.floor(streak / 3) + 1;
    const earned = 10 * multiplier;
    coins += earned;
    profile.stats.correct++;
    profile.stats.coinsEarned += earned;
    res.innerHTML = `Correct · +${earned}<small>${pick(wins)}</small>`;
    res.className = "result correct";
    vs.textContent = "✓";
    vs.className = "vs is-correct";
    FX.feedback("correct");
  } else {
    streak = 0; multiplier = 1;
    res.innerHTML = `Wrong · streak reset<small>${pick(fails)}</small>`;
    res.className = "result incorrect";
    vs.textContent = "✗";
    vs.className = "vs is-wrong";
    FX.shake($("card2"));
    FX.feedback("wrong");
  }
  updateBoard();
  progressChanged();
  $("verdict").hidden = false;
  FX.enter($("verdict"), {y: 12, duration: 200});
  FX.pop(vs, 1.15);
  if (correct) {
    FX.countUp($("coins"), coinsBefore, coins, {duration: 300, format: v => Math.round(v).toLocaleString()});
    FX.pop($("coins"));
    FX.pop($("streak"));
    if (multiplier > multiplierBefore) FX.pop($("multiplier"), 1.4);
  }
  if (fromKeyboard) $("nextBtn").focus({preventScroll: true});
}
function nextRound() { startNewRound(); }

function updateBoard() {
  if (streak > bestStreak) {
    bestStreak = streak;
    save('statstack_bestStreak', bestStreak);
  }
  save('statstack_coins', coins);
  $("coins").textContent = coins.toLocaleString();
  $("streak").textContent = streak;
  $("streak").parentElement.classList.toggle("hot", streak > 0);
  $("multiplier").textContent = multiplier + "×";
  $("multiplier").parentElement.classList.toggle("flat", multiplier === 1);
  $("bestStreak").textContent = bestStreak;
}

// ─── CARDS ──────────────────────────────────────────────────────────────────
// Refractor-shard cards with a back: tap (or Enter/Space) to flip.
const RARITY_LABEL = {legendary: "★ Legendary", epic: "Epic", rare: "Rare", common: "Common"};
const CARD_STATS = [["ppg", "PTS", "scoring"], ["rpg", "REB", "rebounding"], ["apg", "AST", "assists"], ["spg", "STL", "steals"], ["bpg", "BLK", "blocks"]];

// Where a player ranks in their season for each stat (1 = best) and the season's best value
function seasonRanks(c) {
  const pool = (SEASONS[c.season] || {}).players;
  if (!pool) return null;
  const out = {count: pool.length};
  for (const [key] of CARD_STATS) {
    const vals = pool.map(p => p[key]);
    out[key] = {rank: 1 + vals.filter(v => v > c[key]).length, max: Math.max(...vals)};
  }
  return out;
}

// Stats always show one decimal place (25.0, not 25)
function one(v) { return Number(v).toFixed(1); }

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// The back's plate names the player's best stat: "#2 in scoring"
function bestStat(c, ranks) {
  if (!ranks) return null;
  const best = CARD_STATS.map(([k, , word]) => ({word, r: ranks[k].rank})).sort((a, b) => a.r - b.r)[0];
  return {
    title: `#${best.r} in ${best.word}`,
    sub: best.r === 1 ? `Led all ${ranks.count} players · ${c.season}` : `${ordinal(best.r)} of ${ranks.count} players · ${c.season}`,
  };
}

// A pentagon of season ranks: every player's card back has its own shape
function statRadar(c, ranks) {
  const cx = 110, cy = 100, R = 62;
  const at = (i, r) => {
    const a = (-90 + i * 72) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const ring = f => CARD_STATS.map((_, i) => at(i, R * f).map(n => n.toFixed(1)).join(",")).join(" ");
  const share = key => Math.max(0.08, 1 - (ranks[key].rank - 1) / ranks.count);
  const shape = CARD_STATS.map(([key], i) => at(i, R * share(key)));
  const labels = CARD_STATS.map(([key, label], i) => {
    const [x, y] = at(i, R + 24);
    const r = ranks[key].rank;
    return `<text x="${x.toFixed(1)}" y="${(y - 3).toFixed(1)}" class="rv">${one(c[key])}</text>`
      + `<text x="${x.toFixed(1)}" y="${(y + 9).toFixed(1)}" class="rl">${label} <tspan class="${r <= 10 ? "top" : ""}">#${r}</tspan></text>`;
  }).join("");
  const spoken = CARD_STATS.map(([key, label]) => `${label} ${one(c[key])}, ${ordinal(ranks[key].rank)}`).join("; ");
  return `<svg class="pback-radar" viewBox="0 0 220 196" role="img" aria-label="Season ranks: ${spoken}">
      <polygon class="grid" points="${ring(1)}"/><polygon class="grid" points="${ring(0.66)}"/><polygon class="grid" points="${ring(0.33)}"/>
      ${CARD_STATS.map((_, i) => { const [x, y] = at(i, R); return `<line class="grid" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join("")}
      <polygon class="shape" points="${shape.map(p => p.map(n => n.toFixed(1)).join(",")).join(" ")}"/>
      ${shape.map(([x, y]) => `<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6"/>`).join("")}
      ${labels}
    </svg>`;
}

function cardHtml(c, extraClass = "") {
  const ph = photoFor(c);
  const ranks = seasonRanks(c);
  const pulled = c.pulled ? new Date(c.pulled).toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"}) : "";
  const best = bestStat(c, ranks);
  return `
    <article class="flipcard ${c.rarity} ${extraClass}" style="${teamVars(c.team)}" tabindex="0" role="button" aria-pressed="false"
      aria-label="${esc(c.name)}, ${c.rarity} card. Press to flip.">
      <div class="flip-inner">
        <div class="pcard">
          <div class="shard s1"></div><div class="shard s2"></div><div class="shard s3"></div><div class="shard s4"></div>
          <div class="lines"></div><div class="holo"></div>
          <img class="pcard-photo${ph.cutout ? "" : " is-photo"}" src="${esc(ph.src)}" alt="" loading="lazy" onerror="imgFail(this)">
          <div class="pcard-top"><span>${RARITY_LABEL[c.rarity] || c.rarity}</span><span>${esc(c.season || "")}</span></div>
          <div class="plate">
            <div class="pcard-name">${nameHtml(c.name)}</div>
            <div class="pcard-meta">${esc(c.team)} · ${one(c.ppg)} PTS · ${one(c.rpg)} REB · ${one(c.apg)} AST</div>
          </div>
          ${ph.credit ? `<div class="pcard-credit">${esc(ph.credit)}</div>` : `<div class="flip-hint">Tap to flip</div>`}
          <div class="shine"></div>
        </div>
        <div class="pback" aria-hidden="true">
          <div class="shard s1"></div><div class="shard s2"></div><div class="shard s3"></div><div class="shard s4"></div>
          <div class="lines"></div><div class="holo"></div>
          <div class="pback-head">
            <div class="pback-id">
              <div class="pback-name">${nameHtml(c.name)}</div>
              <div class="pback-team">${esc(team(c.team).name || c.team)} · <span class="nw">${esc(c.season || "")}</span></div>
            </div>
            ${ranks ? `<div class="pback-no"><span>No.</span><b>${String(ranks.ppg.rank).padStart(3, "0")}</b><span>of ${ranks.count}</span></div>` : ""}
          </div>
          ${ranks ? statRadar(c, ranks) : ""}
          ${best ? `<div class="pback-plate"><strong>${best.title}</strong><span>${esc(best.sub)}</span></div>` : ""}
          <div class="pback-foot"><span>${pulled ? "Pulled " + pulled : "Player Pack"}</span><span class="pback-mark">StatStack</span></div>
        </div>
      </div>
    </article>`;
}

function flipCard(card) {
  const on = card.classList.toggle("flipped");
  card.setAttribute("aria-pressed", String(on));
  card.querySelector(".pcard").setAttribute("aria-hidden", String(on));
  card.querySelector(".pback").setAttribute("aria-hidden", String(!on));
  FX.haptic("commit");
}
document.addEventListener("click", e => {
  const card = e.target.closest(".flipcard");
  if (card) flipCard(card);
});
document.addEventListener("keydown", e => {
  const card = e.target.closest && e.target.closest(".flipcard");
  if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); flipCard(card); }
});
// The holo follows the pointer on Epic and Legendary cards
document.addEventListener("pointermove", e => {
  const card = e.target.closest && e.target.closest(".flipcard.epic, .flipcard.legendary");
  if (!card || e.pointerType !== "mouse") return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", ((e.clientX - r.left) / r.width).toFixed(3));
  card.style.setProperty("--my", ((e.clientY - r.top) / r.height).toFixed(3));
});

function fitCardNames(root, min) {
  root.querySelectorAll(".pcard-name").forEach(el => fitName(el, min));
  root.querySelectorAll(".pback-name").forEach(el => fitName(el, min));
  root.querySelectorAll(".pcard-meta, .pback-plate strong").forEach(el => {
    el.style.fontSize = "";
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth + 1 && size > 7) {
      size -= 0.5;
      el.style.fontSize = `${size}px`;
    }
  });
}

// ─── PACKS ──────────────────────────────────────────────────────────────────
function renderShop() {
  $("shopCoins").textContent = coins.toLocaleString();
  $("shopSeason").textContent = currentSeasonKey;
  $("buyPackBtn").disabled = coins < PACK_PRICE || !!opening;
  $("packNeed").textContent = coins < PACK_PRICE
    ? `You need ${(PACK_PRICE - coins).toLocaleString()} more coins. Keep your streak going.`
    : "";
}

function buyPack() {
  if (coins < PACK_PRICE || opening) return;
  coins -= PACK_PRICE;
  const r = Math.random() * 100;
  const rarity = r < 2 ? "legendary" : r < 10 ? "epic" : r < 30 ? "rare" : "common";
  let pool = currentPlayers.filter(p => p.rarity === rarity);
  if (!pool.length) pool = currentPlayers;
  // The card is saved before the animation, so leaving mid-opening never loses it
  const card = {...pick(pool), season: currentSeasonKey, pulled: Date.now()};
  ownedCards.push(card);
  save('statstack_cards', ownedCards);
  profile.stats.packs++;
  updateBoard();
  openPack(card);
  progressChanged();
  renderShop();
}

// ─── PACK OPENING ───────────────────────────────────────────────────────────
// The pack shakes at least three times, and the glow climbs one rarity tier
// per shake until it reaches the card inside. A fourth shake means gold.
const TIERS = ["common", "rare", "epic", "legendary"];
let opening = null;

function beat(ms) {
  return new Promise(resolve => {
    if (opening.skipped) return resolve();
    const t = setTimeout(resolve, ms);
    opening.wake = () => { clearTimeout(t); resolve(); };
  });
}
function run(el, frames, opts) {
  const anim = el.animate(frames, {fill: "forwards", ...opts});
  opening.anims.push(anim);
  return anim;
}
function shakeFrames(amp) {
  const frames = [];
  for (let i = 0; i <= 8; i++) {
    const x = i === 8 ? 0 : (i % 2 ? -1 : 1) * amp * (1 - i / 10);
    frames.push({transform: `translate(${x}px, ${-Math.abs(x) * 0.3}px) rotate(${x * 0.45}deg)`});
  }
  return frames;
}
function setTier(stage, tier) {
  stage.style.setProperty("--glow", `var(--r-${tier})`);
  TIERS.forEach(t => stage.classList.toggle(`tier-${t}`, t === tier));
}

async function openPack(card) {
  const stage = $("packStage"), pack = $("pack"), level = TIERS.indexOf(card.rarity);
  opening = {card, level, skipped: false, ready: false, anims: [], wake: null};
  stage.className = "pack-stage";
  setTier(stage, "common");
  pack.hidden = false;
  pack.querySelector(".pack-top").style.cssText = "";
  $("mystery").hidden = true;
  $("packHint").textContent = "Tap to skip";
  $("revealEmpty").hidden = true;
  $("revealedCard").hidden = true;
  stage.hidden = false;
  $("packStatus").textContent = "Opening pack…";
  stage.scrollIntoView({behavior: FX.reduced() ? "auto" : "smooth", block: "center"});

  if (!FX.reduced()) await animatePack(stage, pack, level);
  settlePack();
}

async function animatePack(stage, pack, level) {
  const glow = stage.querySelector(".pack-glow");
  run(pack, [{transform: "translateY(48px) scale(0.9)", opacity: 0}, {transform: "none", opacity: 1}], {duration: 420, easing: FX.EASE_OUT});
  await beat(560);
  const shakes = Math.max(3, level + 1);
  for (let i = 0; i < shakes; i++) {
    if (opening.skipped) return;
    setTier(stage, TIERS[Math.min(i, level)]);
    const duration = 340 + i * 70;
    run(pack, shakeFrames(3 + i * 3.5), {duration, easing: "linear", fill: "none"});
    run(glow, [{transform: "scale(0.85)"}, {transform: `scale(${1.08 + i * 0.06})`}, {transform: "scale(1)"}], {duration: duration + 200, easing: FX.EASE_OUT, fill: "none"});
    FX.haptic(`charge${Math.min(i, 3)}`);
    FX.sound(`charge${Math.min(i, 3)}`);
    // The pause between shakes grows, so the last one hangs a little longer
    await beat(duration + 260 + i * 90);
  }
  if (opening.skipped) return;

  // Tear the top strip off and let light spill out
  run(pack.querySelector(".pack-top"), [
    {transform: "none", opacity: 1},
    {transform: "translate(70px, -90px) rotate(24deg)", opacity: 0},
  ], {duration: 480, easing: FX.EASE_OUT});
  run(stage.querySelector(".pack-flash"), [{opacity: 0}, {opacity: 0.35 + level * 0.18}, {opacity: 0}], {duration: 520, easing: "ease-out"});
  if (level === 3) stage.classList.add("rays");
  FX.haptic("tear");
  FX.sound("tear");
  await beat(300);
  if (opening.skipped) return;

  // The card slides up out of the pack, face down, and the pack falls away
  const mystery = $("mystery");
  mystery.hidden = false;
  run(mystery, [{transform: "translateY(12%)"}, {transform: "translateY(-20%)"}], {duration: 460, easing: FX.EASE_OUT});
  run(pack, [
    {transform: "none", opacity: 1},
    {transform: "translateY(45%) rotate(-3deg)", opacity: 1, offset: 0.65},
    {transform: "translateY(70%) rotate(-5deg)", opacity: 0},
  ], {duration: 560, easing: "cubic-bezier(0.55, 0, 1, 0.45)"});
  await beat(500);
  if (opening.skipped) return;
  run(mystery, [{transform: "translateY(-20%)"}, {transform: "none"}], {duration: 380, easing: FX.EASE_OUT});
  await beat(380);
}

// Jump to the face-down card: the end of the animation, or a skip
function settlePack() {
  const stage = $("packStage");
  opening.anims.forEach(a => a.cancel());
  opening.anims = [];
  opening.ready = true;
  setTier(stage, opening.card.rarity);
  if (opening.level === 3) stage.classList.add("rays");
  stage.classList.add("ready");
  $("pack").hidden = true;
  $("mystery").hidden = false;
  $("packHint").textContent = "Tap to reveal";
  $("packStatus").textContent = "Pack opened. Press the card to reveal it.";
  $("mystery").focus({preventScroll: true});
}

function skipPack() {
  if (!opening || opening.ready || opening.skipped) return;
  opening.skipped = true;
  opening.wake?.();
}

async function revealPack() {
  if (!opening?.ready) return;
  const {card, level} = opening;
  const stage = $("packStage"), mystery = $("mystery"), slot = $("revealedCard");
  opening.ready = false;
  stage.classList.remove("ready");
  $("packHint").textContent = "";
  if (!FX.reduced()) {
    await mystery.animate([{transform: "perspective(900px) rotateY(0)"}, {transform: "perspective(900px) rotateY(90deg)"}],
      {duration: 180, easing: "cubic-bezier(0.55, 0, 1, 0.45)"}).finished;
  }
  mystery.hidden = true;
  slot.innerHTML = cardHtml(card, "reveal-card");
  slot.hidden = false;
  fitCardNames(slot, 18);
  if (FX.reduced()) {
    slot.animate([{opacity: 0}, {opacity: 1}], {duration: 200, easing: "ease"});
  } else {
    slot.animate([
      {transform: "perspective(900px) rotateY(-90deg) scale(1.04)"},
      {transform: "perspective(900px) rotateY(0) scale(1)"},
    ], {duration: 340, easing: FX.EASE_OUT});
    burst(stage, level);
  }
  FX.feedback(card.rarity === "legendary" ? "legendary" : "reveal");
  $("packStatus").textContent = `${RARITY_LABEL[card.rarity].replace("★ ", "")}: ${card.name}`;
  slot.querySelector(".flipcard").focus({preventScroll: true});
  opening = null;
  renderShop();
  // Badges from this pull wait for the reveal so they don't spoil it
  setTimeout(() => checkBadges(true), 900);
}

// Shards fly out in the rarity colour: a few for rare, a shower for legendary
function burst(stage, level) {
  if (level >= 1) {
    const ring = document.createElement("span");
    ring.className = "ring";
    stage.append(ring);
    ring.animate([{transform: "scale(0.4)", opacity: 1}, {transform: `scale(${2.6 + level * 0.5})`, opacity: 0}],
      {duration: 700, easing: FX.EASE_OUT}).finished.then(() => ring.remove());
  }
  if (level === 3) {
    stage.querySelector(".pack-flash").animate([{opacity: 0.9}, {opacity: 0}], {duration: 700, easing: "ease-out"});
  }
  const count = [0, 8, 18, 30][level];
  for (let i = 0; i < count; i++) {
    const spark = document.createElement("span");
    spark.className = "spark";
    stage.append(spark);
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 150 + Math.random() * 130;
    const spin = Math.random() * 540 - 270;
    spark.animate([
      {transform: `translate(0, 0) rotate(${angle}rad) scale(1)`, opacity: 1},
      {transform: `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px) rotate(${angle * 57.3 + spin}deg) scale(0.3)`, opacity: 0},
    ], {duration: 700 + Math.random() * 400, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)"}).finished.then(() => spark.remove());
  }
}

$("packStage").addEventListener("click", e => {
  if (e.target.closest("#mystery")) revealPack();
  else skipPack();
});
document.addEventListener("keydown", e => {
  if (currentScreen === "packs" && opening && !opening.ready && (e.key === "Escape" || e.key === " ")) {
    e.preventDefault();
    skipPack();
  }
});

// ─── COLLECTION ─────────────────────────────────────────────────────────────
let activeFilter = "all";

function updateCollStats() {
  $("totalCards").textContent = ownedCards.length;
  ["legendary", "epic", "rare", "common"].forEach(r => {
    $(r + "Count").textContent = ownedCards.filter(c => c.rarity === r).length;
  });
}
function renderColl(r) {
  activeFilter = r;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === r));
  const g = $("collectionGrid");
  const cards = r === "all" ? ownedCards : ownedCards.filter(c => c.rarity === r);
  if (!cards.length) {
    g.innerHTML = `<p class="empty">${r === "all" ? "No cards yet. Earn 2,000 coins and open a pack." : `No ${r} cards yet.`}</p>`;
    return;
  }
  g.innerHTML = cards.slice().reverse().map(c => cardHtml(c)).join("");
  fitCardNames(g, 14);
  [...g.children].slice(0, 12).forEach((el, i) => FX.enter(el, {duration: 220, delay: i * 40}));
}

// ─── INPUT ──────────────────────────────────────────────────────────────────
$("higherBtn").addEventListener("click", () => makeGuess("higher"));
$("lowerBtn").addEventListener("click", () => makeGuess("lower"));
$("nextBtn").addEventListener("click", nextRound);
$("buyPackBtn").addEventListener("click", buyPack);
$("seasonSelect").addEventListener("change", changeSeason);
document.querySelectorAll(".filter-btn").forEach(b => b.addEventListener("click", () => renderColl(b.dataset.filter)));
$("settingsBtn").addEventListener("click", () => $("settingsDialog").showModal());

document.addEventListener("keydown", e => {
  if (currentScreen !== "play" || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($("settingsDialog").open || e.target.matches("input, select, textarea")) return;
  const k = e.key.toLowerCase();
  if (gameActive && (k === "arrowup" || k === "h")) { e.preventDefault(); makeGuess("higher", true); }
  else if (gameActive && (k === "arrowdown" || k === "l")) { e.preventDefault(); makeGuess("lower", true); }
  else if (!gameActive && k === "enter") { e.preventDefault(); nextRound(); }
});

// ─── SWIPE TO GUESS ─────────────────────────────────────────────────────────
// On touch screens, drag the mystery half up for higher or down for lower.
// Its text tracks the finger 1:1, resists past the commit distance, and
// springs home on release carrying the finger's velocity.
(function swipeToGuess() {
  const card = $("card2");
  const text = card.querySelector(".side-text");
  const COMMIT = 70, SLOP = 10, FLICK = 0.5; // px, px, px/ms
  let drag = null;

  const setDrag = y => {
    card.dataset.drag = Math.abs(y) > SLOP ? (y < 0 ? "up" : "down") : "";
    card.style.setProperty("--drag", Math.min(1, Math.abs(y) / COMMIT).toFixed(2));
  };

  card.addEventListener("pointerdown", e => {
    if (!gameActive || e.button !== 0 || e.pointerType === "mouse" || e.target.closest("button")) return;
    card.setPointerCapture(e.pointerId);
    if (text._springRaf) cancelAnimationFrame(text._springRaf);
    const current = new DOMMatrix(getComputedStyle(text).transform).m42 || 0;
    drag = {id: e.pointerId, startY: e.clientY - current, moved: false, history: [{y: e.clientY, t: e.timeStamp}]};
  });

  card.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    const raw = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(raw) < SLOP) return;
    if (!drag.moved) { drag.moved = true; card.classList.add("dragging"); }
    const y = FX.rubberband(raw, COMMIT * 1.4);
    text.style.transform = `translateY(${y}px)`;
    setDrag(y);
    drag.history.push({y: e.clientY, t: e.timeStamp});
    if (drag.history.length > 5) drag.history.shift();
  });

  const release = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const {history, moved} = drag;
    drag = null;
    card.classList.remove("dragging");
    const y = new DOMMatrix(getComputedStyle(text).transform).m42 || 0;
    const first = history[0], last = history[history.length - 1];
    const velocity = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    const commit = moved && gameActive && e.type === "pointerup" &&
      (Math.abs(y) > COMMIT || (Math.abs(velocity) > FLICK && Math.abs(y) > SLOP * 2));
    if (commit) {
      FX.haptic("commit");
      makeGuess(y < 0 ? "higher" : "lower");
    }
    FX.springY(text, y, velocity, {onUpdate: v => setDrag(v)});
  };
  card.addEventListener("pointerup", release);
  card.addEventListener("pointercancel", release);
})();

// ─── SETTINGS ───────────────────────────────────────────────────────────────
$("soundToggle").checked = FX.settings.sound;
$("soundToggle").addEventListener("change", e => FX.setSetting("sound", e.target.checked));
$("hapticsToggle").checked = FX.settings.haptics;
$("hapticsToggle").addEventListener("change", e => { FX.setSetting("haptics", e.target.checked); if (e.target.checked) FX.haptic("correct"); });
$("hapticsRow").hidden = !FX.canVibrate;

// ─── INSTALL / OFFLINE ──────────────────────────────────────────────────────
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let installPrompt = null;

if (!isStandalone && isIOS) {
  // iOS has no install prompt; explain the Share sheet route instead
  $("installNote").textContent = "In Safari, tap Share, then “Add to Home Screen”. It opens full-screen and works offline.";
  $("installPanel").hidden = false;
}
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installPrompt = e;
  $("installPanel").hidden = false;
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("installPanel").hidden = true;
});
window.addEventListener("appinstalled", () => { $("installPanel").hidden = true; });

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ─── PROFILE & BADGES ───────────────────────────────────────────────────────
function accuracy() { return profile.stats.rounds ? profile.stats.correct / profile.stats.rounds : 0; }
function countRarity(r) { return ownedCards.filter(c => c.rarity === r).length; }
function bestTeamCount() {
  const n = {};
  ownedCards.forEach(c => { n[c.team] = (n[c.team] || 0) + 1; });
  return Math.max(0, ...Object.values(n));
}
const BADGES = [
  {id: "first-win", name: "First Bucket", desc: "Win a round", glyph: "1", tier: "bronze", goal: 1, value: () => profile.stats.correct},
  {id: "streak-5", name: "Heating Up", desc: "5 right in a row", glyph: "5", tier: "bronze", goal: 5, value: () => bestStreak},
  {id: "streak-10", name: "On Fire", desc: "10 right in a row", glyph: "10", tier: "silver", goal: 10, value: () => bestStreak},
  {id: "streak-20", name: "Unstoppable", desc: "20 right in a row", glyph: "20", tier: "gold", goal: 20, value: () => bestStreak},
  {id: "correct-100", name: "Century", desc: "100 right answers", glyph: "100", tier: "silver", goal: 100, value: () => profile.stats.correct},
  {id: "sharpshooter", name: "Sharpshooter", desc: "75% right over 50+ rounds", glyph: "%", tier: "gold", goal: 1,
    value: () => (profile.stats.rounds >= 50 && accuracy() >= 0.75 ? 1 : 0),
    meter: () => (profile.stats.rounds < 50 ? profile.stats.rounds / 50 : accuracy() / 0.75),
    label: () => (profile.stats.rounds < 50 ? `${profile.stats.rounds} / 50 rounds` : `${Math.round(accuracy() * 100)}% right, need 75%`)},
  {id: "first-pack", name: "Rip It", desc: "Open a pack", glyph: "P", tier: "bronze", goal: 1, value: () => profile.stats.packs},
  {id: "packs-10", name: "Pack Addict", desc: "Open 10 packs", glyph: "×10", tier: "silver", goal: 10, value: () => profile.stats.packs},
  {id: "cards-25", name: "Collector", desc: "Own 25 cards", glyph: "25", tier: "silver", goal: 25, value: () => ownedCards.length},
  {id: "epic", name: "Shiny", desc: "Pull an epic card", glyph: "E", tier: "silver", goal: 1, value: () => countRarity("epic")},
  {id: "legendary", name: "Legend", desc: "Pull a legendary card", glyph: "★", tier: "gold", goal: 1, value: () => countRarity("legendary")},
  {id: "team-5", name: "Team Player", desc: "5 cards from one team", glyph: "T", tier: "silver", goal: 5, value: bestTeamCount},
  {id: "seasons-5", name: "Time Traveler", desc: "Play 5 different seasons", glyph: "ERA", tier: "silver", goal: 5, value: () => profile.seasons.length},
  {id: "bankroll", name: "Bankroll", desc: "Hold 10,000 coins", glyph: "$", tier: "gold", goal: 10000, value: () => coins},
];
function medalHtml(b) { return `<span class="medal ${b.tier}" aria-hidden="true">${b.glyph}</span>`; }

// Award any badge whose goal is met; announce=false backfills quietly
function checkBadges(announce) {
  if (opening) return;
  const fresh = BADGES.filter(b => !profile.badges[b.id] && b.value() >= b.goal);
  if (!fresh.length) return;
  fresh.forEach(b => { profile.badges[b.id] = Date.now(); });
  save('statstack_profile', profile);
  if (announce) fresh.forEach((b, i) => setTimeout(() => toast(medalHtml(b), "Badge unlocked", b.name), i * 2600));
  if (currentScreen === "profile") renderProfile();
}

// Every change to progress goes through here: saved locally, then to the cloud
function progressChanged() {
  updatedAt = Date.now();
  save('statstack_profile', profile);
  save('statstack_updated', updatedAt);
  checkBadges(true);
  Account.changed();
}

let toastTimer = null;
function toast(iconHtml, title, text) {
  const t = $("toast");
  t.innerHTML = `${iconHtml}<div><strong>${esc(title)}</strong>${esc(text)}</div>`;
  t.hidden = false;
  FX.enter(t, {y: -8, duration: 220});
  FX.haptic("reveal");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ─── SAVES (local and cloud) ────────────────────────────────────────────────
function getSave() {
  return {v: 1, coins, bestStreak, cards: ownedCards, profile, updatedAt};
}
function applySave(data) {
  coins = parseInt(data.coins) || 0;
  bestStreak = parseInt(data.bestStreak) || 0;
  ownedCards = Array.isArray(data.cards) ? data.cards : [];
  profile = readProfile(data.profile);
  updatedAt = data.updatedAt || 0;
  save('statstack_coins', coins);
  save('statstack_bestStreak', bestStreak);
  save('statstack_cards', ownedCards);
  save('statstack_profile', profile);
  save('statstack_updated', updatedAt);
  checkBadges(false);
  updateBoard();
  renderIdentity();
  if (currentScreen === "profile") renderProfile();
  if (currentScreen === "collection") { updateCollStats(); renderColl(activeFilter); }
  if (currentScreen === "packs") renderShop();
}
function resetSave() {
  streak = 0;
  multiplier = 1;
  applySave({coins: 0, bestStreak: 0, cards: [], profile: freshProfile(), updatedAt: 0});
}

// ─── ACCOUNT UI ─────────────────────────────────────────────────────────────
const GUEST_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4.5"></circle><path d="M3.5 21c1.4-4.6 4.6-7 8.5-7s7.1 2.4 8.5 7z"></path></svg>`;
const NAME_RULE = /^[A-Za-z0-9_]{3,16}$/;
const AVATAR_TEAMS = [...new Set(SEASONS[SEASON_KEYS[0]].players.map(p => p.team))]
  .sort((a, b) => team(a).name.localeCompare(team(b).name));

function initials(name) {
  const parts = name.split("_").filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
}
function paintAvatar(el, teamCode, name) {
  if (teamCode) paint(el, teamCode);
  else ["--team-bg", "--team-bg2", "--team-accent"].forEach(v => el.style.removeProperty(v));
  el.innerHTML = name ? esc(initials(name)) : GUEST_ICON;
}
function syncText() {
  if (Account.sync() === "busy") return "Syncing…";
  if (Account.sync() === "error") return "Couldn't reach the server. Your next move will try again.";
  const t = Account.lastSync();
  return t ? `Synced at ${new Date(t).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})}` : "Synced";
}

function renderIdentity() {
  const label = profile.name || "Guest";
  document.querySelectorAll("[data-avatar]").forEach(el => paintAvatar(el, profile.team, profile.name));
  document.querySelectorAll("[data-username]").forEach(el => { el.textContent = label; });
  const signedIn = Account.signedIn();
  $("menuSub").textContent = signedIn ? Account.email() : Account.enabled ? "Not signed in" : "Saved on this device";
  $("menuSignIn").hidden = signedIn || !Account.enabled;
  $("menuSignOut").hidden = !signedIn;
  const dot = $("syncDot");
  dot.hidden = !signedIn;
  dot.className = `sync-dot${Account.sync() === "busy" ? " busy" : Account.sync() === "error" ? " error" : ""}`;
  $("avatarBtn").setAttribute("aria-label", `Account menu, ${label}${signedIn ? ", signed in" : ""}`);
}

function renderProfile() {
  renderIdentity();
  $("profileStatus").textContent = Account.signedIn() ? "Signed in · synced across devices"
    : Account.enabled ? "Guest · sign in to keep progress everywhere" : "Guest · saved on this device";
  $("profileSince").textContent = `Playing since ${new Date(profile.created).toLocaleDateString(undefined, {month: "long", year: "numeric"})}`;
  if (document.activeElement !== $("nameInput")) $("nameInput").value = profile.name;
  if (document.activeElement !== $("teamSelect")) $("teamSelect").value = profile.team;

  const s = profile.stats;
  const rows = [
    ["Rounds", s.rounds], ["Right", s.correct], ["Accuracy", s.rounds ? `${Math.round(accuracy() * 100)}%` : "—"],
    ["Best streak", bestStreak], ["Coins earned", s.coinsEarned], ["Packs opened", s.packs],
    ["Cards", ownedCards.length], ["Legendaries", countRarity("legendary")], ["Seasons played", profile.seasons.length],
  ];
  $("statGrid").innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${typeof v === "number" ? v.toLocaleString() : v}</dd></div>`).join("");

  const earned = BADGES.filter(b => profile.badges[b.id]).length;
  $("badgeCount").textContent = `${earned} of ${BADGES.length}`;
  $("badgeGrid").innerHTML = BADGES.map(b => {
    const at = profile.badges[b.id];
    if (at) {
      const day = new Date(at).toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"});
      return `<li class="badge">${medalHtml(b)}<div class="badge-text"><strong>${b.name}</strong><span>${b.desc}</span><span>Earned ${day}</span></div></li>`;
    }
    const have = Math.min(b.value(), b.goal);
    const frac = Math.max(0, Math.min(1, b.meter ? b.meter() : have / b.goal));
    const label = b.label ? b.label() : `${have.toLocaleString()} / ${b.goal.toLocaleString()}`;
    return `<li class="badge locked">${medalHtml(b)}<div class="badge-text"><strong>${b.name}</strong><span>${b.desc}</span>
      <div class="badge-meter" role="progressbar" aria-label="${b.name} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(frac * 100)}"><b style="width:${frac * 100}%"></b></div>
      <span>${label}</span></div></li>`;
  }).join("");
  renderAccountPanel();
}

let panelPhase = null;
function renderAccountPanel() {
  const panel = $("accountPanel"), phase = Account.phase();
  // Sync updates only touch the status line
  if (phase === panelPhase) {
    const line = panel.querySelector(".sync-line");
    if (line) line.innerHTML = `<span class="${$("syncDot").className}"></span>${esc(syncText())}`;
    return;
  }
  panelPhase = phase;
  const views = {
    off: `<h2 class="panel-title">Cloud sync</h2>
      <p>Accounts aren't switched on for this site yet, so your progress is saved in this browser.</p>`,
    loading: `<h2 class="panel-title">Account</h2><p>Checking your account…</p>`,
    "signed-out": `<h2 class="panel-title">Save your progress</h2>
      <p>Make a free account to keep your coins, cards and badges on every device. Sign in anywhere with your email and password.</p>
      <div class="btn-row">
        <button class="pill pill-solid pill-sm" type="button" data-auth="signup">Create account</button>
        <button class="pill pill-ghost pill-sm" type="button" data-auth="signin">Sign in</button>
      </div>`,
    "signed-in": `<h2 class="panel-title">Account</h2>
      <p>Signed in as <strong>${esc(Account.email())}</strong></p>
      <p class="sync-line"><span class="${$("syncDot").className}"></span>${esc(syncText())}</p>
      <div class="btn-row">
        <button class="pill pill-ghost pill-sm" type="button" data-auth="newpass">Change password</button>
        <button class="pill pill-ghost pill-sm" type="button" id="signOutBtn">Sign out</button>
      </div>`,
  };
  panel.innerHTML = views[phase] || views.off;
}

function setMsg(id, text, kind = "") {
  $(id).textContent = text;
  $(id).className = `form-msg${kind ? " " + kind : ""}`;
}
const CHECK_ICON = `<span class="toast-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg></span>`;
async function signOut() {
  if (!confirm("Sign out? Your progress stays in your account, and this device starts fresh.")) return;
  await Account.signOut();
  toast(`<span class="avatar avatar-md">${GUEST_ICON}</span>`, "Signed out", "Sign in again any time to pick up where you left off.");
}

$("accountPanel").addEventListener("click", e => {
  const auth = e.target.closest("[data-auth]");
  if (auth) openAuth(auth.dataset.auth);
  else if (e.target.closest("#signOutBtn")) signOut();
});
$("menuSignOut").addEventListener("click", signOut);
$("menuSignIn").addEventListener("click", () => openAuth("signin"));

// ─── SIGN-IN WINDOW ─────────────────────────────────────────────────────────
const EMAIL_RULE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_TEXT = {
  signin: {title: "Welcome back", lede: "Sign in with your email and password.", submit: "Sign in", pass: "Password", auto: "current-password"},
  signup: {title: "Create your account", lede: "Your coins, cards and badges on this device come with you.", submit: "Create account", pass: "Password", auto: "new-password"},
  forgot: {title: "Reset your password", lede: "We'll email you a link to choose a new one.", submit: "Email me a reset link"},
  newpass: {title: "Choose a new password", lede: "You'll use it to sign in from now on.", submit: "Save password", pass: "New password", auto: "new-password"},
};
let authMode = "signin";

function setAuthMode(mode) {
  authMode = mode;
  const t = AUTH_TEXT[mode], d = $("authDialog");
  d.dataset.mode = mode;
  $("authTitle").textContent = t.title;
  $("authLede").textContent = t.lede;
  $("authSubmit").textContent = t.submit;
  if (t.pass) {
    $("authPassLabel").textContent = t.pass;
    $("authPass").autocomplete = t.auto;
  }
  d.querySelectorAll("[data-modes]").forEach(el => { el.hidden = !el.dataset.modes.split(" ").includes(mode); });
  $("authTabs").hidden = mode !== "signin" && mode !== "signup";
  d.querySelectorAll(".auth-tab").forEach(tab => {
    const on = tab.dataset.mode === mode;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  setMsg("authMsg", "");
}
function focusAuthField() {
  const field = [...$("authForm").querySelectorAll(".field:not([hidden]) input")].find(i => !i.value) ||
    $("authForm").querySelector(".field:not([hidden]) input");
  if (field) field.focus();
}
function openAuth(mode = "signin") {
  setMenu(false);
  setAuthMode(mode);
  const d = $("authDialog");
  if (!d.open) d.showModal();
  focusAuthField();
}

$("authDialog").querySelectorAll(".auth-tab").forEach(tab => {
  tab.addEventListener("click", () => { setAuthMode(tab.dataset.mode); focusAuthField(); });
  tab.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = authMode === "signin" ? "signup" : "signin";
    setAuthMode(next);
    $(next === "signin" ? "tabSignin" : "tabSignup").focus();
  });
});
$("forgotBtn").addEventListener("click", () => { setAuthMode("forgot"); focusAuthField(); });
$("backBtn").addEventListener("click", () => { setAuthMode("signin"); focusAuthField(); });
$("authClose").addEventListener("click", () => $("authDialog").close());
// A click on the dimmed backdrop lands on the dialog itself
$("authDialog").addEventListener("click", e => { if (e.target === $("authDialog")) $("authDialog").close(); });
$("pwToggle").addEventListener("click", () => {
  const show = $("authPass").type === "password";
  $("authPass").type = show ? "text" : "password";
  $("pwToggle").textContent = show ? "Hide" : "Show";
  $("pwToggle").setAttribute("aria-pressed", String(show));
  $("pwToggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
});

$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const mode = authMode;
  const email = $("authEmail").value.trim(), pass = $("authPass").value, name = $("authName").value.trim();
  const fail = text => { setMsg("authMsg", text, "err"); FX.shake($("authForm")); };
  if (mode !== "newpass" && !EMAIL_RULE.test(email)) return fail("Enter a valid email address.");
  if (mode === "signup" && !NAME_RULE.test(name)) return fail("Usernames are 3–16 letters, numbers or underscores.");
  if (mode === "signin" && !pass) return fail("Enter your password.");
  if ((mode === "signup" || mode === "newpass") && pass.length < 8) return fail("Use at least 8 characters for your password.");

  const btn = $("authSubmit"), label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "One moment…";
  const err = mode === "signin" ? await Account.signIn(email, pass)
    : mode === "signup" ? await Account.signUp(email, pass, name)
    : mode === "forgot" ? await Account.sendReset(email)
    : await Account.updatePassword(pass);
  btn.disabled = false;
  btn.textContent = label;
  if (err) return fail(err);
  if (mode === "forgot") return setMsg("authMsg", `If there's an account for ${email}, a reset link is on its way.`, "ok");

  $("authDialog").close();
  $("authPass").value = "";
  if (mode === "newpass") toast(CHECK_ICON, "Password saved", "Use it next time you sign in.");
  else toast(CHECK_ICON, mode === "signup" ? "Account created" : "Signed in", "Your progress now syncs across devices.");
});

$("teamSelect").innerHTML = `<option value="">No team</option>` +
  AVATAR_TEAMS.map(t => `<option value="${t}">${esc(team(t).name)}</option>`).join("");
// Preview the colours on the big avatar before saving
$("teamSelect").addEventListener("change", () => {
  paintAvatar(document.querySelector(".avatar-xl"), $("teamSelect").value, $("nameInput").value.trim() || profile.name);
});
$("profileForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("nameInput").value.trim();
  if (name && !NAME_RULE.test(name)) return setMsg("nameMsg", "Use 3–16 letters, numbers or underscores.", "err");
  if (name && name !== profile.name && Account.signedIn()) {
    setMsg("nameMsg", "Checking…");
    const err = await Account.claimName(name);
    if (err) return setMsg("nameMsg", err, "err");
  }
  profile.name = name;
  profile.team = $("teamSelect").value;
  progressChanged();
  renderProfile();
  setMsg("nameMsg", "Saved.", "ok");
});

function setMenu(open) {
  const menu = $("accountMenu"), btn = $("avatarBtn");
  if (open === !menu.hidden) return;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (open) {
    FX.enter(menu, {y: -6, duration: 160});
    menu.querySelector(".menu-item:not([hidden])").focus({preventScroll: true});
  }
}
$("avatarBtn").addEventListener("click", () => setMenu($("accountMenu").hidden));
document.addEventListener("click", e => { if (!e.target.closest(".account")) setMenu(false); });
$("accountMenu").addEventListener("click", e => { if (e.target.closest(".menu-item")) setMenu(false); });
$("accountMenu").addEventListener("keydown", e => {
  const items = [...$("accountMenu").querySelectorAll(".menu-item:not([hidden])")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") { setMenu(false); $("avatarBtn").focus(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  } else if (e.key === "Tab") setMenu(false);
});

// Arriving from a password-reset email opens the new-password form once
let recoveryShown = false;
Account.on(() => {
  renderIdentity();
  if (currentScreen === "profile") renderProfile();
  if (Account.recovering() && Account.signedIn() && !recoveryShown) {
    recoveryShown = true;
    openAuth("newpass");
  }
});

// ─── INIT ───────────────────────────────────────────────────────────────────
$("seasonSelect").innerHTML = SEASON_KEYS
  .map(k => `<option value="${k}">${SEASONS[k].label}</option>`).join("");
setSeason(currentSeasonKey);
checkBadges(false);
updateBoard();
renderIdentity();
showScreen(location.hash.slice(1) || "play");
Account.init({
  get: getSave,
  apply: applySave,
  reset: resetSave,
  rename: name => { profile.name = name; progressChanged(); renderIdentity(); },
});
