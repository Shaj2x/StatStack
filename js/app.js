// StatStack game logic. Player data (SEASONS) comes from js/data.js.

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
let streak = 0, multiplier = 1, roundNumber = 0;
let player1, player2, currentStat, gameActive = false;

// Newest season first ("1999-00" sorts by its start year)
const SEASON_KEYS = Object.keys(SEASONS).sort((a, b) => parseInt(b) - parseInt(a));
let currentSeasonKey = SEASONS[load('statstack_season', '')] ? load('statstack_season', '') : SEASON_KEYS[0];
let currentPlayers = [];

const statTypes = [
  {key: "ppg", label: "Points Per Game", short: "PPG"},
  {key: "rpg", label: "Rebounds Per Game", short: "RPG"},
  {key: "apg", label: "Assists Per Game", short: "APG"},
  {key: "spg", label: "Steals Per Game", short: "SPG"},
  {key: "bpg", label: "Blocks Per Game", short: "BPG"}
];
const RARITY_EMOJI = {legendary: "⭐", epic: "💜", rare: "💎", common: "🔷"};
const PACK_PRICE = 2000;

// ─── IMAGES ─────────────────────────────────────────────────────────────────
const FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23667eea'/%3E%3Ccircle cx='50' cy='36' r='20' fill='white' opacity='0.6'/%3E%3Cellipse cx='50' cy='82' rx='26' ry='16' fill='white' opacity='0.6'/%3E%3C/svg%3E";
function imgUrl(id) {
  return id ? `https://cdn.nba.com/headshots/nba/latest/1040x760/${id}.png` : FALLBACK;
}
function imgFail(img) { img.onerror = null; img.src = FALLBACK; }
function setImg(img, id, alt) {
  img.onerror = () => imgFail(img);
  img.src = imgUrl(id);
  img.alt = alt;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

// ─── HOOKS ──────────────────────────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
const hooks = ["90% of players get this wrong!","85% fail this challenge!","Only 12% get this right!","Can you beat the odds?","94% lose their streak here!","This one tricks most players!","89% pick the wrong answer!","Only the top 10% pass!","Most people guess wrong here!","Harder than it looks!","88% get fooled by this!","Will you be the exception?"];
const wins  = ["Nice! You're in the top 10%! 🔥","Wow! Most people miss that! 💪","Impressive! Only 12% get that! ⭐","You're crushing it! 🎯","Great eye for stats! 👀","Keep that streak going! 🔥","Genius move! 🧠","Outstanding! 💎","You're on fire! 🔥","Better than 85% of players! 📈"];
const fails = ["Don't worry, 87% got that wrong!","Tough one! 91% miss that!","Fools most people!","So close! Try again!","88% make the same mistake!","Brutal! Even pros miss that!","You're in good company — 92% missed it!","Stats can be deceiving!","Better luck next round!"];

// ─── SCREENS ────────────────────────────────────────────────────────────────
const SCREENS = ["home", "play", "shop", "collection"];
let currentScreen = null;

function showScreen(name) {
  if (!SCREENS.includes(name)) name = "home";
  const changed = name !== currentScreen;
  currentScreen = name;
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.dataset.screen === name));
  if (changed) FX.enter(document.querySelector(`.screen[data-screen="${name}"]`));
  document.querySelectorAll(".tab").forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  });
  if (name === "home") renderHome();
  if (name === "shop") renderShop();
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
  $("seasonChipText").textContent = key;
  $("playerCountInfo").textContent = `${currentPlayers.length} players · real per-game stats`;
}
function changeSeason() {
  setSeason($("seasonSelect").value);
  roundNumber = 0; streak = 0; multiplier = 1; player1 = player2 = null;
  updateBoard();
  renderHome();
}

function renderHome() {
  $("homeBest").textContent = bestStreak;
  $("homeCoins").textContent = coins.toLocaleString();
  $("homeCards").textContent = ownedCards.length;
  $("playBtn").textContent = player1 && roundNumber > 1 ? "🏀 Continue" : "🏀 Play";
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
  // Player 2's card moves into player 1's slot, so remember where it was
  const carried = player2 && currentScreen === "play" ? $("card2").getBoundingClientRect() : null;
  roundNumber++;
  player1 = player2 || randPlayer();
  currentStat = pick(statTypes);
  player2 = pickOpponent(player1, currentStat.key);

  setHook(pick(hooks), "var(--hook-grad)");
  setPlayer(1, player1);
  setPlayer(2, player2, true);

  $("currentStatLabel").textContent = currentStat.label;
  $("p2NameInline").textContent = player2.name;
  $("guessButtons").hidden = false;
  $("nextBtn").hidden = true;
  $("result").textContent = "";
  $("result").className = "result";
  $("roundDisplay").textContent = roundNumber;
  $("swipeHint").hidden = false;
  $("card2").classList.remove("is-correct", "is-wrong");
  gameActive = true;

  if (carried) {
    FX.flipFrom($("card1"), carried);
    FX.enter($("card2"), {y: 16, duration: 220, delay: 60});
  }
}

function setPlayer(n, p, hide = false) {
  setImg($(`player${n}Image`), p.img, p.name);
  $(`player${n}Name`).textContent = p.name;
  $(`player${n}Team`).textContent = p.team;
  $(`player${n}StatLabel`).textContent = currentStat.short;
  const statEl = $(`player${n}Stat`);
  if (hide) { statEl.textContent = "???"; statEl.className = "hidden-stat"; }
  else { statEl.textContent = p[currentStat.key].toFixed(1); statEl.className = "stat-value"; }
}

function setHook(text, bg) {
  $("hookText").textContent = text;
  $("hookBanner").style.background = bg;
}

function makeGuess(guess, fromKeyboard = false) {
  if (!gameActive) return;
  gameActive = false;
  const v1 = player1[currentStat.key], v2 = player2[currentStat.key];
  const coinsBefore = coins, multiplierBefore = multiplier;
  $("player2Stat").className = "stat-value";
  FX.countUp($("player2Stat"), 0, v2);
  const correct = (guess === "higher" && v2 >= v1) || (guess === "lower" && v2 <= v1);
  const res = $("result");
  if (correct) {
    streak++;
    multiplier = Math.floor(streak / 3) + 1;
    const earned = 10 * multiplier;
    coins += earned;
    res.textContent = `✅ Correct! +${earned} coins`;
    res.className = "result correct";
    setHook(pick(wins), "var(--win-grad)");
    $("card2").classList.add("is-correct");
    FX.feedback("correct");
  } else {
    streak = 0; multiplier = 1;
    res.textContent = "❌ Wrong! Streak reset.";
    res.className = "result incorrect";
    setHook(pick(fails), "var(--fail-grad)");
    $("card2").classList.add("is-wrong");
    FX.shake($("card2"));
    FX.feedback("wrong");
  }
  updateBoard();
  FX.enter(res, {y: 4, duration: 160});
  if (correct) {
    FX.countUp($("coins"), coinsBefore, coins, {duration: 300, format: v => Math.round(v).toLocaleString()});
    FX.pop($("coins"));
    FX.pop($("streak"));
    if (multiplier > multiplierBefore) FX.pop($("multiplier"), 1.4);
  }
  $("guessButtons").hidden = true;
  $("swipeHint").hidden = true;
  $("nextBtn").hidden = false;
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
  $("multiplier").textContent = multiplier + "x";
  $("bestStreak").textContent = bestStreak;
}

// ─── SHOP ───────────────────────────────────────────────────────────────────
function renderShop() {
  $("shopCoins").textContent = coins.toLocaleString();
  $("shopSeason").textContent = currentSeasonKey;
  $("buyPackBtn").disabled = coins < PACK_PRICE;
  $("packNeed").textContent = coins < PACK_PRICE
    ? `You need ${(PACK_PRICE - coins).toLocaleString()} more coins. Keep your streak going!`
    : "";
}

function buyPack() {
  if (coins < PACK_PRICE) return;
  coins -= PACK_PRICE;
  updateBoard();
  renderShop();
  $("buyPackBtn").disabled = true;
  $("packOpening").hidden = false;
  $("revealedCard").hidden = true;
  setTimeout(() => {
    const r = Math.random() * 100;
    const rarity = r < 2 ? "legendary" : r < 10 ? "epic" : r < 30 ? "rare" : "common";
    let pool = currentPlayers.filter(p => p.rarity === rarity);
    if (!pool.length) pool = currentPlayers;
    const card = {...pick(pool), season: currentSeasonKey};
    ownedCards.push(card);
    save('statstack_cards', ownedCards);
    $("packOpening").hidden = true;
    $("revealedCard").innerHTML = `
      <div class="revealed-card ${card.rarity}">
        <div class="card-rarity-badge">${RARITY_EMOJI[card.rarity]} ${card.rarity.toUpperCase()}</div>
        <img src="${imgUrl(card.img)}" class="revealed-card-img" alt="${esc(card.name)}" onerror="imgFail(this)">
        <h3>🎉 ${esc(card.name)}</h3>
        <div class="revealed-meta">${esc(card.team)} · ${card.season}</div>
        <div class="revealed-stats">
          📊 ${card.ppg} PPG &nbsp; 🏀 ${card.rpg} RPG<br>
          🎯 ${card.apg} APG &nbsp; 🤚 ${card.spg} SPG &nbsp; 🚫 ${card.bpg} BPG
        </div>
      </div>`;
    $("revealedCard").hidden = false;
    FX.feedback(card.rarity === "legendary" ? "legendary" : "reveal");
    $("revealedCard").scrollIntoView({behavior: "smooth", block: "center"});
    renderShop();
  }, 1800);
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
    g.innerHTML = `<p class="empty">${r === "all" ? "No cards yet. Earn 2,000 coins and open a pack in the Shop!" : `No ${r} cards yet.`}</p>`;
    return;
  }
  g.innerHTML = cards.map(c => `
    <div class="card-small ${c.rarity}">
      <div class="card-rarity-badge">${RARITY_EMOJI[c.rarity]}</div>
      <img src="${imgUrl(c.img)}" class="card-img" alt="${esc(c.name)}" loading="lazy" onerror="imgFail(this)">
      <h4>${esc(c.name)}</h4>
      <div class="card-team">${esc(c.team)} · ${c.season || ""}</div>
      <div class="card-stats">PPG ${c.ppg} | RPG ${c.rpg}<br>APG ${c.apg} | SPG ${c.spg} | BPG ${c.bpg}</div>
    </div>`).join("");
  [...g.children].slice(0, 12).forEach((el, i) => FX.enter(el, {duration: 220, delay: i * 40}));
}

// ─── INPUT ──────────────────────────────────────────────────────────────────
$("higherBtn").addEventListener("click", () => makeGuess("higher"));
$("lowerBtn").addEventListener("click", () => makeGuess("lower"));
$("nextBtn").addEventListener("click", nextRound);
$("buyPackBtn").addEventListener("click", buyPack);
$("seasonSelect").addEventListener("change", changeSeason);
document.querySelectorAll(".filter-btn").forEach(b => b.addEventListener("click", () => renderColl(b.dataset.filter)));

document.addEventListener("keydown", e => {
  if (currentScreen !== "play" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches("input, select, textarea")) return;
  const k = e.key.toLowerCase();
  if (gameActive && (k === "arrowup" || k === "h")) { e.preventDefault(); makeGuess("higher", true); }
  else if (gameActive && (k === "arrowdown" || k === "l")) { e.preventDefault(); makeGuess("lower", true); }
  else if (!gameActive && k === "enter") { e.preventDefault(); nextRound(); }
});

// ─── SWIPE TO GUESS ─────────────────────────────────────────────────────────
// Drag player 2's card up for higher or down for lower. The card tracks the
// finger 1:1, resists past the commit distance, and springs home on release
// carrying the finger's velocity.
(function swipeToGuess() {
  const card = $("card2");
  const COMMIT = 70, SLOP = 10, FLICK = 0.5; // px, px, px/ms
  let drag = null;

  const setDrag = y => {
    const dir = y < 0 ? "up" : "down";
    card.dataset.drag = Math.abs(y) > SLOP ? dir : "";
    card.style.setProperty("--drag", Math.min(1, Math.abs(y) / COMMIT).toFixed(2));
  };

  card.addEventListener("pointerdown", e => {
    if (!gameActive || e.button !== 0) return;
    card.setPointerCapture(e.pointerId);
    if (card._springRaf) cancelAnimationFrame(card._springRaf);
    const current = new DOMMatrix(getComputedStyle(card).transform).m42 || 0;
    drag = {id: e.pointerId, startY: e.clientY - current, moved: false, history: [{y: e.clientY, t: e.timeStamp}]};
  });

  card.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    const raw = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(raw) < SLOP) return;
    if (!drag.moved) { drag.moved = true; card.classList.add("dragging"); }
    const y = FX.rubberband(raw, COMMIT * 1.4);
    card.style.transform = `translateY(${y}px)`;
    setDrag(y);
    drag.history.push({y: e.clientY, t: e.timeStamp});
    if (drag.history.length > 5) drag.history.shift();
  });

  const release = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const {history, moved} = drag;
    drag = null;
    card.classList.remove("dragging");
    const y = new DOMMatrix(getComputedStyle(card).transform).m42 || 0;
    const first = history[0], last = history[history.length - 1];
    const velocity = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    const commit = moved && gameActive && e.type === "pointerup" &&
      (Math.abs(y) > COMMIT || (Math.abs(velocity) > FLICK && Math.abs(y) > SLOP * 2));
    if (commit) {
      FX.haptic("commit");
      makeGuess(y < 0 ? "higher" : "lower");
    }
    FX.springY(card, y, velocity, {onUpdate: v => setDrag(v)});
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

// ─── INIT ───────────────────────────────────────────────────────────────────
$("seasonSelect").innerHTML = SEASON_KEYS
  .map(k => `<option value="${k}">${SEASONS[k].label}</option>`).join("");
setSeason(currentSeasonKey);
updateBoard();
showScreen(location.hash.slice(1) || "home");
