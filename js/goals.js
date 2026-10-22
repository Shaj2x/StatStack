// Reasons to come back: the daily login streak, card sets with milestone
// rewards, and Lineup Battles for the Locker's starting five. Loaded last;
// uses the game state and helpers from js/app.js and js/modes.js.

// ─── DAILY LOGIN STREAK ─────────────────────────────────────────────────────
// Day 1–6 pay 100–600 coins, day 7 is a free Player Pack, then it repeats.
// Missing a day starts the run again from day 1.
const LOGIN_REWARDS = [100, 200, 300, 400, 500, 600, "pack"];

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}
const loginDue = () => profile.login.last !== dayKey();
const nextLoginStreak = () => (profile.login.last === yesterdayKey() ? profile.login.streak + 1 : 1);

function showLogin() {
  // Wait for a signed-in save to arrive first, so a reward claimed on
  // another device today isn't offered twice
  if (!loginDue() || Account.phase() === "loading" || document.querySelector("dialog[open]") || newsUnseen()) return;
  const n = nextLoginStreak(), slot = (n - 1) % 7, reward = LOGIN_REWARDS[slot];
  $("loginEyebrow").textContent = n === 1 && profile.login.streak > 1 ? "Streak reset · new run" : "Daily reward";
  $("loginTitle").textContent = n === 1 ? "Day 1" : `Day ${n} in a row`;
  $("loginLede").textContent = slot === 6
    ? "Seven days straight. Today's reward is a free pack."
    : `Come back tomorrow for ${LOGIN_REWARDS[slot + 1] === "pack" ? "a free pack" : `${LOGIN_REWARDS[slot + 1]} coins`}. Miss a day and it starts over.`;
  $("loginDays").innerHTML = LOGIN_REWARDS.map((r, i) => `<li class="${i < slot ? "done" : i === slot ? "today" : ""}">
      <span>Day ${i + 1}</span>
      ${r === "pack" ? `<i class="login-pack" aria-hidden="true"></i><strong>Free pack</strong>` : `<span class="coin" aria-hidden="true"></span><strong>${r}</strong>`}
    </li>`).join("");
  $("loginClaim").textContent = reward === "pack" ? "Claim free pack" : `Claim ${reward} coins`;
  $("loginDialog").showModal();
  FX.enter($("loginDialog").querySelector(".today"), {y: 6, duration: 260});
}

function claimLogin() {
  if (!loginDue()) { $("loginDialog").close(); return; }
  const n = nextLoginStreak(), reward = LOGIN_REWARDS[(n - 1) % 7];
  profile.login = {last: dayKey(), streak: n, best: Math.max(profile.login.best, n)};
  if (reward === "pack") profile.freePacks.player++;
  else {
    coins += reward;
    profile.stats.coinsEarned += reward;
  }
  updateBoard();
  progressChanged();
  $("loginDialog").close();
  FX.pop($("coins"));
  FX.feedback("reveal");
  toast(CHECK_ICON, reward === "pack" ? "Free Player Pack added" : `+${reward} coins`,
    reward === "pack" ? "Open it from the Packs tab." : `Day ${n} streak. See you tomorrow.`);
  if (currentScreen === "packs") renderShop();
  if (currentScreen === "profile") renderProfile();
}
$("loginClaim").addEventListener("click", claimLogin);
// Closing without claiming still claims: the reward is never lost
$("loginDialog").addEventListener("cancel", e => { e.preventDefault(); claimLogin(); });

// ─── WHAT'S NEW ─────────────────────────────────────────────────────────────
// Shown once per device for each update, before the daily reward. Bump
// NEWS_VERSION (and the list in index.html) when there's something new.
const NEWS_VERSION = "2026-10";
let newsShownOnce = false; // if storage is blocked, still only show it once per visit
function newsUnseen() {
  let seen = "";
  try { seen = localStorage.getItem("statstack_news") || ""; } catch { return !newsShownOnce; }
  return seen !== NEWS_VERSION && !newsShownOnce;
}
function showNews() {
  if (!newsUnseen() || document.querySelector("dialog[open]")) return false;
  newsShownOnce = true;
  $("newsDialog").showModal();
  $("newsDone").focus({preventScroll: true});
  $("newsDialog").scrollTop = 0;
  return true;
}
function closeNews() {
  newsShownOnce = true;
  try { localStorage.setItem("statstack_news", NEWS_VERSION); } catch { /* fine */ }
  if ($("newsDialog").open) $("newsDialog").close();
}
$("newsDone").addEventListener("click", closeNews);
$("newsClose").addEventListener("click", closeNews);
// Each row's button goes straight to that feature
$("newsDialog").addEventListener("click", e => { if (e.target.closest(".news-go")) closeNews(); });
$("newsDialog").addEventListener("close", () => {
  try { localStorage.setItem("statstack_news", NEWS_VERSION); } catch { /* fine */ }
  setTimeout(showLogin, 400);
});

document.addEventListener("DOMContentLoaded", () => setTimeout(() => { if (!showNews()) showLogin(); }, 900));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") showLogin(); });
Account.on(() => setTimeout(showLogin, 300));

// ─── SETS AND THE COLLECTION BOOK ───────────────────────────────────────────
// Every set lists real cards, so missing ones show as gaps. Each pays at three
// milestones, the last being the whole set.
const SET_KINDS = {
  era: {label: "Era", tiers: [1, 5, Infinity], pay: [2000, 10000, 60000]},
  team: {label: "Team", tiers: [5, 15, Infinity], pay: [1000, 4000, 25000]},
  season: {label: "Season", tiers: [10, 40, Infinity], pay: [1500, 6000, 50000]},
};
const SETS = [
  ...ERAS.map(e => ({id: `era-${e.id}`, kind: "era", name: `${e.name} Legends`, sub: `Every legendary card, ${e.label}`,
    cards: ALL_CARDS.filter(c => c.rarity === "legendary" && e.seasons(c.season))})),
  ...[...new Set(ALL_CARDS.map(c => franchise(c.team)))].sort((a, b) => team(a).name.localeCompare(team(b).name))
    .map(t => ({id: `team-${t}`, kind: "team", name: team(t).name, sub: "Every card in the franchise's history",
      cards: ALL_CARDS.filter(c => franchise(c.team) === t)})),
  ...SEASON_KEYS.map(k => ({id: `season-${k}`, kind: "season", name: `${k} Season`, sub: "All 120 players from the season",
    cards: ALL_CARDS.filter(c => c.season === k)})),
];
SETS.forEach(set => { set.cards.sort((a, b) => cardOvr(b) - cardOvr(a)); });

const tierGoal = (set, i) => Math.min(SET_KINDS[set.kind].tiers[i], set.cards.length);
function setProgress(set, owned = new Set(ownedCards.map(cardKey))) {
  return set.cards.filter(c => owned.has(cardKey(c))).length;
}
function setTiersMet(set, have) {
  return SET_KINDS[set.kind].tiers.filter((_, i) => have >= tierGoal(set, i)).length;
}

// Pay any milestone reached and not yet paid (once per milestone, ever)
function checkSets(announce) {
  const owned = new Set(ownedCards.map(cardKey));
  const paid = [];
  for (const set of SETS) {
    const have = setProgress(set, owned), met = setTiersMet(set, have), done = profile.sets[set.id] || 0;
    for (let i = done; i < met; i++) {
      const pay = SET_KINDS[set.kind].pay[i];
      coins += pay;
      profile.stats.coinsEarned += pay;
      paid.push({set, i, pay});
    }
    if (met > done) profile.sets[set.id] = met;
  }
  if (!paid.length) return;
  updatedAt = Date.now();
  save('statstack_profile', profile);
  save('statstack_updated', updatedAt);
  updateBoard();
  Account.changed();
  if (announce) paid.forEach(({set, i, pay}, k) => setTimeout(() => toast(
    `<span class="toast-icon coin-icon" aria-hidden="true"><span class="coin"></span></span>`,
    i === 2 ? `Set complete: ${set.name}` : `${set.name} · ${tierGoal(set, i)} card${tierGoal(set, i) === 1 ? "" : "s"}`,
    `+${pay.toLocaleString()} coins`), 600 + k * 2600));
  if (currentScreen === "book") renderBook();
}
PROGRESS_HOOKS.push(checkSets);

let bookKind = "era";
function milestoneHtml(set, have) {
  return SET_KINDS[set.kind].tiers.map((_, i) => {
    const goal = tierGoal(set, i), got = have >= goal;
    return `<span class="milestone${got ? " got" : ""}" style="left:${(goal / set.cards.length) * 100}%" title="${goal} cards · ${SET_KINDS[set.kind].pay[i].toLocaleString()} coins"></span>`;
  }).join("");
}
function renderBook() {
  const owned = new Set(ownedCards.map(cardKey));
  document.querySelectorAll("#bookTabs .filter-btn").forEach(b => b.classList.toggle("active", b.dataset.kind === bookKind));
  const complete = SETS.filter(s => setProgress(s, owned) === s.cards.length).length;
  const milestones = SETS.reduce((n, s) => n + setTiersMet(s, setProgress(s, owned)), 0);
  $("bookTotals").innerHTML = `<div><dt>Complete</dt><dd>${complete}/${SETS.length}</dd></div>
    <div><dt>Milestones</dt><dd>${milestones}/${SETS.length * 3}</dd></div>`;
  $("setGrid").innerHTML = SETS.filter(s => s.kind === bookKind).map(set => {
    const have = setProgress(set, owned), total = set.cards.length, met = setTiersMet(set, have);
    const goal = met < 3 ? tierGoal(set, met) : 0;
    const next = met < 3 ? `Next: ${goal} card${goal === 1 ? "" : "s"} · ${SET_KINDS[set.kind].pay[met].toLocaleString()} coins` : "Complete";
    const lead = set.kind === "team" ? set.id.slice(5) : set.cards[0].team;
    return `<li><button class="set-card${met === 3 ? " complete" : ""}" type="button" data-set="${set.id}" style="${teamVars(lead)}">
      <span class="set-name">${esc(set.name)}</span>
      <span class="set-sub">${esc(set.sub)}</span>
      <span class="set-count"><strong>${have}</strong> / ${total}</span>
      <span class="set-bar"><b style="width:${(have / total) * 100}%"></b>${milestoneHtml(set, have)}</span>
      <span class="set-next">${next}</span>
    </button></li>`;
  }).join("");
}

function openSet(id) {
  const set = SETS.find(s => s.id === id);
  if (!set) return;
  const owned = new Set(ownedCards.map(cardKey)), have = setProgress(set, owned), met = setTiersMet(set, have);
  $("setKind").textContent = `${SET_KINDS[set.kind].label} set`;
  $("setTitle").textContent = set.name;
  $("setInfo").textContent = `${have} of ${set.cards.length} collected. Rewards at ` +
    SET_KINDS[set.kind].tiers.map((_, i) => `${tierGoal(set, i)} (${SET_KINDS[set.kind].pay[i].toLocaleString()})`).join(", ") +
    (met ? `. ${met} of 3 earned.` : ".");
  $("setBar").style.width = `${(have / set.cards.length) * 100}%`;
  $("setCards").innerHTML = set.cards.map(c => owned.has(cardKey(c))
    ? `<li class="set-slot">${miniTile(c)}</li>`
    : `<li class="set-slot"><span class="mini missing ${c.rarity}"><span class="mini-ovr">${cardOvr(c)}</span><span class="missing-mark" aria-hidden="true">?</span><span class="mini-name">${esc(c.name)}</span><span class="mini-meta">${esc(c.team)} · ${esc(c.season)}</span></span><span class="visually-hidden">Missing</span></li>`).join("");
  $("setDialog").showModal();
}

$("bookTabs").addEventListener("click", e => {
  const b = e.target.closest("[data-kind]");
  if (!b) return;
  bookKind = b.dataset.kind;
  renderBook();
});
$("setGrid").addEventListener("click", e => {
  const card = e.target.closest("[data-set]");
  if (card) openSet(card.dataset.set);
});
$("setClose").addEventListener("click", () => $("setDialog").close());
$("setDialog").addEventListener("click", e => { if (e.target === $("setDialog")) $("setDialog").close(); });
SCREEN_HOOKS.book = renderBook;

// ─── LINEUP BATTLES ─────────────────────────────────────────────────────────
// Your starting five against a computer team built from cards near a target
// rating. Higher Team OVR wins more often, but any game can go either way.
const DIFFICULTY = [
  {id: "rookie", name: "Rookie", offset: -7, pay: 60},
  {id: "pro", name: "Pro", offset: -3, pay: 150},
  {id: "allstar", name: "All-Star", offset: 2, pay: 350},
  {id: "legend", name: "Legend", offset: 6, pay: 800},
];
const OPP_NAMES = ["Glass Cleaners", "Splash Club", "Paint Patrol", "Fast Break Five", "Iso Kings", "Lockdown Crew",
  "Bench Mob", "Showtime Select", "Twin Towers", "Retro Ballers", "Pick and Roll", "Hardwood Heroes", "Night Shift", "Full Court Press"];
let battleLevel = load('statstack_battleLevel', "pro") || "pro";
let opponent = null, battleBusy = false, lastResult = null;

const starters = () => profile.lineup.slots.slice(0, 5).map(ownedByKey).filter(Boolean);
const teamOvr = cards => Math.round(cards.reduce((s, c) => s + cardOvr(c), 0) / cards.length);

function makeOpponent(level) {
  const mine = starters();
  const target = Math.max(70, Math.min(97, teamOvr(mine) + DIFFICULTY.find(d => d.id === level).offset));
  const taken = new Set(mine.map(c => c.name));
  const near = width => ALL_CARDS.filter(c => !taken.has(c.name) && Math.abs(cardOvr(c) - target) <= width);
  let pool = near(2);
  if (pool.length < 12) pool = near(5);
  const five = [];
  while (five.length < 5 && pool.length) {
    const c = pick(pool);
    five.push(c);
    pool = pool.filter(p => p.name !== c.name);
  }
  return {level, name: pick(OPP_NAMES), cards: five};
}

function battleTeamHtml(name, cards, side) {
  return `<div class="battle-team battle-${side}">
    <div class="battle-team-head"><strong>${esc(name)}</strong><span class="battle-ovr">OVR ${teamOvr(cards)}</span></div>
    <ul class="battle-five">${cards.map(c => `<li>${miniTile(c)}</li>`).join("")}</ul>
  </div>`;
}

function renderBattles() {
  const body = $("battleBody"), mine = starters(), b = profile.battle;
  $("battleRecord").textContent = b.w + b.l ? `${b.w}–${b.l}${b.streak > 1 ? ` · ${b.streak} straight wins` : ""}` : "";
  if (mine.length < 5) {
    body.innerHTML = `<div class="panel"><p>Fill all five starting spots to play. Your Team OVR decides how good your odds are.</p></div>`;
    opponent = null;
    return;
  }
  if (battleBusy) return;
  if (!opponent || opponent.level !== battleLevel) opponent = makeOpponent(battleLevel);
  const my = teamOvr(mine), level = DIFFICULTY.find(d => d.id === battleLevel);
  const odds = Math.round(100 / (1 + Math.exp(-(my - teamOvr(opponent.cards)) / 3)));
  body.innerHTML = `<div class="panel battle-panel">
    <div class="battle-levels" role="group" aria-label="Difficulty">${DIFFICULTY.map(d =>
      `<button class="filter-btn${d.id === battleLevel ? " active" : ""}" type="button" data-level="${d.id}" aria-pressed="${d.id === battleLevel}">${d.name} · <span class="coin" aria-hidden="true"></span>${d.pay}</button>`).join("")}</div>
    <div class="battle-matchup">
      ${battleTeamHtml(profile.lineup.name || "Your Five", mine, "you")}
      <span class="battle-vs" aria-hidden="true">VS</span>
      ${battleTeamHtml(opponent.name, opponent.cards, "them")}
    </div>
    <div class="battle-foot">
      <p class="muted">About <strong>${odds}%</strong> to win · a win pays ${level.pay} coins</p>
      <div class="btn-row">
        <button class="pill pill-ghost pill-sm" type="button" id="newOpponent">New opponent</button>
        <button class="pill pill-solid pill-sm" type="button" id="playBattle">Play game</button>
      </div>
    </div>
    <div id="battleGame"></div>
  </div>`;
  if (lastResult) showResult(lastResult, false);
}

// One game: who wins comes from the OVR gap; the score and box line are dressing
function simulate(mine, theirs) {
  const gap = teamOvr(mine) - teamOvr(theirs);
  const win = Math.random() < 1 / (1 + Math.exp(-gap / 3));
  const margin = 1 + Math.floor(Math.random() ** 1.6 * 22);
  const base = 100 + (teamOvr(mine) + teamOvr(theirs) - 160) * 0.4 + Math.random() * 14;
  const hi = Math.round(base + margin / 2), lo = hi - margin;
  const [us, them] = win ? [hi, lo] : [lo, hi];
  const quarters = total => {
    const w = [0, 1, 2, 3].map(() => 0.8 + Math.random() * 0.4), sum = w.reduce((a, b) => a + b, 0);
    const q = w.map(x => Math.round((x / sum) * total));
    q[3] += total - q.reduce((a, b) => a + b, 0);
    return q;
  };
  // Share the points, rebounds and assists out by each starter's per-game numbers
  const share = (total, key) => {
    const w = mine.map(c => c[key] * (0.7 + Math.random() * 0.6)), sum = w.reduce((a, b) => a + b, 0) || 1;
    return w.map(x => Math.round((x / sum) * total));
  };
  const pts = share(us, "ppg"), reb = share(42 + Math.round(Math.random() * 10), "rpg"), ast = share(22 + Math.round(Math.random() * 8), "apg");
  const mvp = pts.indexOf(Math.max(...pts));
  return {win, us, them, qUs: quarters(us), qThem: quarters(them), mvp: {card: mine[mvp], pts: pts[mvp], reb: reb[mvp], ast: ast[mvp]}};
}

async function playBattle() {
  if (battleBusy || !opponent) return;
  const mine = starters();
  if (mine.length < 5) return;
  battleBusy = true;
  lastResult = null;
  const game = simulate(mine, opponent.cards), level = DIFFICULTY.find(d => d.id === battleLevel);
  document.querySelectorAll("#battleBody button").forEach(b => { b.disabled = true; });
  const el = $("battleGame");
  el.innerHTML = `<div class="scoreboard" role="status" aria-live="polite">
    <div class="sb-row"><span class="sb-team">${esc(profile.lineup.name || "Your Five")}</span>${[0, 1, 2, 3].map(i => `<span class="sb-q" id="qu${i}">–</span>`).join("")}<strong class="sb-total" id="sbUs">0</strong></div>
    <div class="sb-row"><span class="sb-team">${esc(opponent.name)}</span>${[0, 1, 2, 3].map(i => `<span class="sb-q" id="qt${i}">–</span>`).join("")}<strong class="sb-total" id="sbThem">0</strong></div>
    <p class="sb-clock" id="sbClock">Tip-off</p>
  </div>`;
  el.scrollIntoView({behavior: FX.reduced() ? "auto" : "smooth", block: "nearest"});
  let us = 0, them = 0;
  const step = FX.reduced() ? 150 : 750;
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, step));
    $("sbClock").textContent = i < 3 ? `End of Q${i + 1}` : "Final";
    const u0 = us, t0 = them;
    us += game.qUs[i];
    them += game.qThem[i];
    $(`qu${i}`).textContent = game.qUs[i];
    $(`qt${i}`).textContent = game.qThem[i];
    FX.countUp($("sbUs"), u0, us, {duration: step * 0.8, decimals: 0});
    FX.countUp($("sbThem"), t0, them, {duration: step * 0.8, decimals: 0});
    FX.haptic("commit");
  }
  await new Promise(r => setTimeout(r, step));

  const b = profile.battle;
  if (game.win) {
    b.w++;
    b.streak++;
    b.best = Math.max(b.best, b.streak);
    if (level.id === "legend") b.legendWins++;
    coins += level.pay;
    profile.stats.coinsEarned += level.pay;
  } else {
    b.l++;
    b.streak = 0;
  }
  battleBusy = false;
  lastResult = {...game, pay: game.win ? level.pay : 0, opp: opponent.name};
  opponent = makeOpponent(battleLevel);
  updateBoard();
  progressChanged();
  FX.feedback(game.win ? "correct" : "wrong");
  renderBattles();
  if (game.win) FX.pop($("coins"));
}

function showResult(r, animate = true) {
  const el = $("battleGame");
  el.innerHTML = `<div class="battle-result ${r.win ? "win" : "loss"}">
    <p class="battle-score display">${r.win ? "W" : "L"} ${r.us}–${r.them}</p>
    <p>vs ${esc(r.opp)} · ${r.win ? `+${r.pay} coins` : "No coins this time"}</p>
    <p class="battle-mvp"><span>Player of the game</span><strong>${esc(r.mvp.card.name)}</strong> ${r.mvp.pts} PTS · ${r.mvp.reb} REB · ${r.mvp.ast} AST</p>
  </div>`;
  if (animate) FX.enter(el.firstElementChild, {y: 10, duration: 240});
}

$("battleBody").addEventListener("click", e => {
  const lvl = e.target.closest("[data-level]");
  if (lvl && !battleBusy) {
    battleLevel = lvl.dataset.level;
    save('statstack_battleLevel', battleLevel);
    lastResult = null;
    renderBattles();
  } else if (e.target.closest("#newOpponent") && !battleBusy) {
    opponent = makeOpponent(battleLevel);
    lastResult = null;
    renderBattles();
  } else if (e.target.closest("#playBattle")) playBattle();
});
const lockerScreen = SCREEN_HOOKS.locker;
SCREEN_HOOKS.locker = () => { lockerScreen(); renderBattles(); };

// ─── BADGES FOR THESE GOALS ─────────────────────────────────────────────────
BADGES.push(
  {id: "regular", name: "Regular", desc: "Claim 7 days in a row", glyph: "7", tier: "silver", goal: 7, value: () => profile.login.best},
  {id: "set-starter", name: "Set Starter", desc: "Reach any set milestone", glyph: "S", tier: "bronze", goal: 1,
    value: () => Object.values(profile.sets).reduce((a, b) => a + b, 0)},
  {id: "completionist", name: "Completionist", desc: "Complete a whole set", glyph: "100%", tier: "gold", goal: 1,
    value: () => Object.values(profile.sets).filter(n => n >= 3).length},
  {id: "first-w", name: "First W", desc: "Win a Lineup Battle", glyph: "W", tier: "bronze", goal: 1, value: () => profile.battle.w},
  {id: "win-streak", name: "Dynasty", desc: "Win 5 Lineup Battles in a row", glyph: "W5", tier: "silver", goal: 5, value: () => profile.battle.best},
  {id: "giant-slayer", name: "Giant Slayer", desc: "Beat a Legend team", glyph: "GS", tier: "gold", goal: 1, value: () => profile.battle.legendWins},
);
