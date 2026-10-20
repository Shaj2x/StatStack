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
const SCREENS = ["play", "packs", "collection"];
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
  $("multiplier").textContent = multiplier + "×";
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

function backNote(c, ranks) {
  if (!ranks) return "";
  const best = CARD_STATS.map(([k, , word]) => ({k, word, r: ranks[k].rank})).sort((a, b) => a.r - b.r)[0];
  if (best.r === 1) return `Led the ${c.season} season in ${best.word}.`;
  if (best.r <= 10) return `${ordinal(best.r)} in ${best.word} among the ${ranks.count} players this season.`;
  return `${c.team} · ${c.season}`;
}

function cardHtml(c, extraClass = "") {
  const ph = photoFor(c);
  const ranks = seasonRanks(c);
  const pulled = c.pulled ? new Date(c.pulled).toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"}) : "";
  const rows = CARD_STATS.map(([key, label]) => {
    const r = ranks && ranks[key];
    const width = r && r.max ? Math.round((c[key] / r.max) * 100) : 0;
    return `<div class="pback-row"><span>${label}</span><i><b style="width:${width}%"></b></i><strong>${one(c[key])}</strong><em class="${r && r.rank <= 10 ? "top" : ""}">${r ? "#" + r.rank : ""}</em></div>`;
  }).join("");
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
          <div class="pback-head">
            <div>
              <div class="pback-name">${nameHtml(c.name)}</div>
              <div class="pback-team">${esc(team(c.team).name || c.team)} · ${esc(c.season || "")}</div>
            </div>
            ${ranks ? `<div class="pback-no">CARD<b>${ranks.ppg.rank}</b>OF ${ranks.count}</div>` : ""}
          </div>
          <div class="pback-rows">${rows}</div>
          <p class="pback-note">${esc(backNote(c, ranks))}</p>
          <div class="pback-foot"><span>Per game · rank in season</span><span>${pulled ? "Pulled " + pulled : "Player Pack"}</span></div>
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
  root.querySelectorAll(".pcard-meta").forEach(el => {
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
  $("buyPackBtn").disabled = coins < PACK_PRICE;
  $("packNeed").textContent = coins < PACK_PRICE
    ? `You need ${(PACK_PRICE - coins).toLocaleString()} more coins. Keep your streak going.`
    : "";
}

function buyPack() {
  if (coins < PACK_PRICE) return;
  coins -= PACK_PRICE;
  updateBoard();
  renderShop();
  $("buyPackBtn").disabled = true;
  $("revealEmpty").hidden = true;
  $("revealedCard").hidden = true;
  $("packOpening").hidden = false;
  setTimeout(() => {
    const r = Math.random() * 100;
    const rarity = r < 2 ? "legendary" : r < 10 ? "epic" : r < 30 ? "rare" : "common";
    let pool = currentPlayers.filter(p => p.rarity === rarity);
    if (!pool.length) pool = currentPlayers;
    const card = {...pick(pool), season: currentSeasonKey, pulled: Date.now()};
    ownedCards.push(card);
    save('statstack_cards', ownedCards);
    $("packOpening").hidden = true;
    $("revealedCard").innerHTML = cardHtml(card, "reveal-card");
    $("revealedCard").hidden = false;
    fitCardNames($("revealedCard"), 18);
    $("revealedCard").scrollIntoView({behavior: FX.reduced() ? "auto" : "smooth", block: "center"});
    FX.feedback(card.rarity === "legendary" ? "legendary" : "reveal");
    renderShop();
  }, 1600);
}

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

// ─── INIT ───────────────────────────────────────────────────────────────────
$("seasonSelect").innerHTML = SEASON_KEYS
  .map(k => `<option value="${k}">${SEASONS[k].label}</option>`).join("");
setSeason(currentSeasonKey);
updateBoard();
showScreen(location.hash.slice(1) || "play");
