// Friends: requests, each friend's record and showcase, challenges sent
// straight to them, and card trades. It all lives on the server
// (supabase/game.sql), so it needs an account. Loaded last; uses the game
// state and helpers from the other scripts.

let friends = null, trades = [], inbox = [];
let social = {requests: 0, challenges: 0, trades: 0};
let socialLoading = false;

// Offers you made that went through since you last looked change your cards
function seenTrades() { return new Set(load("statstack_seen_trades", []) || []); }

async function loadSocial() {
  if (!Account.ranked() || socialLoading) return;
  socialLoading = true;
  const [f, t, c] = await Promise.all([Account.call("friends_list"), Account.call("trades_list"), Account.call("challenge_inbox")]);
  socialLoading = false;
  if (f.error) { friends = friends || []; if (currentScreen === "friends") renderFriends(f.error); return; }
  friends = f.data || [];
  trades = t.data || [];
  inbox = c.data || [];
  const seen = seenTrades();
  const fresh = trades.filter(x => x.dir === "out" && x.status === "accepted" && !seen.has(x.id));
  if (fresh.length) {
    fresh.forEach(x => seen.add(x.id));
    save("statstack_seen_trades", [...seen].slice(-100));
    await refreshCards();
    fresh.forEach((x, i) => setTimeout(() => toast(CHECK_ICON, "Trade done", `${x.with} accepted your offer.`), i * 2600));
  }
  setSocial({
    requests: friends.filter(x => x.status === "incoming").length,
    challenges: inbox.length,
    trades: trades.filter(x => x.dir === "in" && x.status === "open").length,
  });
  if (currentScreen === "friends") renderFriends();
}

async function refreshCards() {
  const r = await Account.call("my_cards");
  if (!r.data) return;
  ownedCards = r.data.cards.map(serverCard).filter(Boolean);
  coins = Number(r.data.coins) || coins;
  save("statstack_cards", ownedCards);
  updateBoard();
  progressChanged();
}

function setSocial(counts) {
  social = counts;
  const n = counts.requests + counts.challenges + counts.trades;
  $("notifyDot").hidden = !n;
  $("friendsCount").hidden = !n;
  $("friendsCount").textContent = n;
}

// ─── THE FRIENDS SCREEN ─────────────────────────────────────────────────────
function friendStateHtml() {
  if (!Account.enabled) return `<div class="panel"><p>Friends need accounts, which aren't set up on this copy of the game.</p></div>`;
  if (!Account.signedIn()) {
    return `<div class="panel friends-empty"><h2 class="panel-title">Play with your friends</h2>
      <p>Sign in to add friends by username, see their records and showcase, send them challenges and trade cards.</p>
      <button class="pill pill-solid pill-sm" type="button" data-fr="signin">Sign in or create account</button></div>`;
  }
  if (!Account.ranked()) {
    return `<div class="panel"><p class="muted">${Account.settled() ? "Friends aren't switched on yet." : "Connecting…"}</p></div>`;
  }
  if (!profile.name) {
    return `<div class="panel friends-empty"><h2 class="panel-title">Pick a username first</h2>
      <p>Friends find you by your username. Choose one on your profile.</p>
      <a class="pill pill-solid pill-sm" href="#profile">Go to profile</a></div>`;
  }
  return "";
}

function cardStrip(list, empty = "") {
  const cards = list.map(serverCard).filter(Boolean);
  return cards.length ? `<ul class="trade-strip">${cards.map(c => `<li class="chase-card">${miniTile(c)}</li>`).join("")}</ul>` : `<p class="muted">${empty}</p>`;
}

function tradeHtml(t) {
  const mine = t.dir === "in" ? t.want : t.give, theirs = t.dir === "in" ? t.give : t.want;
  const status = {accepted: "Done", declined: "Declined", cancelled: "Cancelled", void: "Called off"}[t.status];
  return `<li class="trade${t.status === "open" ? "" : " closed"}">
    <p class="trade-line"><strong>${t.dir === "in" ? `${esc(t.with)} offers you a trade` : `Your offer to ${esc(t.with)}`}</strong>${status ? `<span class="trade-status">${status}</span>` : ""}</p>
    <div class="trade-sides">
      <div><span class="trade-label">You give</span>${cardStrip(mine, "Nothing")}</div>
      <span class="trade-swap" aria-hidden="true">⇄</span>
      <div><span class="trade-label">You get</span>${cardStrip(theirs, "Nothing")}</div>
    </div>
    ${t.status !== "open" ? "" : t.dir === "in"
      ? `<div class="btn-row"><button class="pill pill-solid pill-sm" type="button" data-trade="accept" data-id="${t.id}">Accept</button><button class="pill pill-ghost pill-sm" type="button" data-trade="decline" data-id="${t.id}">Decline</button></div>`
      : `<div class="btn-row"><button class="pill pill-ghost pill-sm" type="button" data-trade="cancel" data-id="${t.id}">Cancel offer</button></div>`}
  </li>`;
}

function friendCardHtml(f) {
  const show = (f.showcase || []).map(cardByKey).filter(Boolean);
  const daily = profile.daily.done && profile.daily.num === dailyNumber();
  const n = esc(f.username);
  return `<article class="friend" style="${TEAMS[f.team] ? teamVars(f.team) : ""}">
    <div class="friend-head">
      <span class="avatar avatar-md" data-fav="${n}" data-team="${esc(f.team || "")}"></span>
      <div><strong>${n}</strong><span>${TEAMS[f.team] ? esc(team(f.team).name) : "No team"}</span></div>
    </div>
    <dl class="friend-stats">
      <div><dt>Best streak</dt><dd>${f.best}</dd></div>
      <div><dt>Battles</dt><dd>${f.wins}–${f.losses}</dd></div>
      <div><dt>Legends</dt><dd>${f.legends}</dd></div>
      <div><dt>Cards</dt><dd>${f.cards}</dd></div>
    </dl>
    ${f.daily ? `<p class="friend-daily">Last Daily: #${f.daily.num} · <strong>${f.daily.score}/10</strong></p>` : ""}
    ${show.length ? `<ul class="friend-show">${show.map(c => `<li class="chase-card">${miniTile(c)}</li>`).join("")}</ul>` : ""}
    <div class="friend-actions">
      <button class="pill pill-solid pill-sm" type="button" data-fr="daily" data-name="${n}"${daily ? "" : ` disabled title="Finish today's Daily first"`}>Send Daily score</button>
      <button class="pill pill-ghost pill-sm" type="button" data-fr="lineup" data-name="${n}"${starters().length === 5 ? "" : ` disabled title="Fill your starting five first"`}>Send lineup</button>
      <button class="pill pill-ghost pill-sm" type="button" data-fr="trade" data-name="${n}">Trade</button>
      <button class="link-btn" type="button" data-fr="remove" data-name="${n}">Remove</button>
    </div>
  </article>`;
}

function renderFriends(error) {
  const body = $("friendsBody"), gate = friendStateHtml();
  if (gate) { body.innerHTML = gate; return; }
  if (friends === null) { body.innerHTML = `<div class="panel"><p class="muted">Loading your friends…</p></div>`; loadSocial(); return; }
  const mine = friends.filter(f => f.status === "friend");
  const incomingReq = friends.filter(f => f.status === "incoming"), outgoing = friends.filter(f => f.status === "outgoing");
  const openTrades = trades.filter(t => t.status === "open"), doneTrades = trades.filter(t => t.status !== "open");
  body.innerHTML = `
    ${error ? `<p class="form-msg err">${esc(error)}</p>` : ""}
    <form class="panel add-friend" id="addFriend" autocomplete="off">
      <label class="field"><span>Add a friend by username</span><input id="friendName" maxlength="16" placeholder="e.g. Shaj_2x" autocapitalize="off" spellcheck="false"></label>
      <button class="pill pill-solid pill-sm" type="submit">Send request</button>
      <p class="form-msg" id="friendMsg" role="status" aria-live="polite"></p>
    </form>
    ${inbox.length ? `<section class="friends-sec"><h2 class="section-title">Challenges for you</h2><ul class="fr-list">${inbox.map(c => `<li class="fr-row">
      <span><strong>${esc(c.from || "A friend")}</strong> ${c.kind === "daily" ? `scored <strong>${c.payload.s}/10</strong> on Daily #${c.payload.n}` : `sent a lineup${c.payload.name ? ` · ${esc(c.payload.name)}` : ""}`}</span>
      <span class="btn-row"><button class="pill pill-solid pill-sm" type="button" data-ch="play" data-id="${c.id}">Play</button><button class="pill pill-ghost pill-sm" type="button" data-ch="skip" data-id="${c.id}">Dismiss</button></span>
    </li>`).join("")}</ul></section>` : ""}
    ${incomingReq.length ? `<section class="friends-sec"><h2 class="section-title">Friend requests</h2><ul class="fr-list">${incomingReq.map(f => `<li class="fr-row">
      <span><strong>${esc(f.username)}</strong> wants to be friends</span>
      <span class="btn-row"><button class="pill pill-solid pill-sm" type="button" data-fr="accept" data-name="${esc(f.username)}">Accept</button><button class="pill pill-ghost pill-sm" type="button" data-fr="decline" data-name="${esc(f.username)}">Decline</button></span>
    </li>`).join("")}</ul></section>` : ""}
    ${openTrades.length ? `<section class="friends-sec"><h2 class="section-title">Trades</h2><ul class="trade-list">${openTrades.map(tradeHtml).join("")}</ul></section>` : ""}
    <section class="friends-sec">
      <h2 class="section-title">Your friends${mine.length ? ` · ${mine.length}` : ""}</h2>
      ${mine.length ? `<div class="friend-grid">${mine.map(friendCardHtml).join("")}</div>`
        : `<p class="muted">No friends yet. Add someone by their username above.</p>`}
    </section>
    ${outgoing.length ? `<section class="friends-sec"><h2 class="section-title">Waiting for them</h2><ul class="fr-list">${outgoing.map(f => `<li class="fr-row">
      <span>Request sent to <strong>${esc(f.username)}</strong></span>
      <button class="link-btn" type="button" data-fr="remove" data-name="${esc(f.username)}">Cancel</button>
    </li>`).join("")}</ul></section>` : ""}
    ${doneTrades.length ? `<section class="friends-sec"><h2 class="section-title">Recent trades</h2><ul class="trade-list">${doneTrades.slice(0, 6).map(tradeHtml).join("")}</ul></section>` : ""}`;
  body.querySelectorAll("[data-fav]").forEach(el => paintAvatar(el, TEAMS[el.dataset.team] ? el.dataset.team : "", el.dataset.fav));
}

// One click at a time; the server answers, then the screen redraws
async function friendAction(fn, args, done) {
  const res = await serverMove(fn, args);
  if (res && done) done(res);
  await loadSocial();
  return res;
}

$("friendsBody").addEventListener("submit", async e => {
  if (e.target.id !== "addFriend") return;
  e.preventDefault();
  const name = $("friendName").value.trim();
  if (!NAME_RULE.test(name)) return setMsg("friendMsg", "Usernames are 3–16 letters, numbers or underscores.", "err");
  if (name.toLowerCase() === profile.name.toLowerCase()) return setMsg("friendMsg", "That's you.", "err");
  const res = await Account.call("friend_request", {p_name: name});
  if (res.error) return setMsg("friendMsg", res.error, "err");
  toast(CHECK_ICON, res.data.status === "friends" ? "You're friends now" : "Request sent", res.data.status === "friends" ? `${name} is on your list.` : `${name} will see it next time they play.`);
  await loadSocial();
});

$("friendsBody").addEventListener("click", async e => {
  const b = e.target.closest("button[data-fr], button[data-trade], button[data-ch]");
  if (!b || b.disabled) return;
  const name = b.dataset.name, id = Number(b.dataset.id);
  b.disabled = true;
  const act = b.dataset.fr || b.dataset.trade || b.dataset.ch;
  if (b.dataset.fr) {
    if (act === "signin") openAuth("signin");
    else if (act === "accept") await friendAction("friend_respond", {p_name: name, p_accept: true}, () => toast(CHECK_ICON, "You're friends now", `${name} is on your list.`));
    else if (act === "decline") await friendAction("friend_respond", {p_name: name, p_accept: false});
    else if (act === "remove") {
      if (confirm(`Remove ${name}? Any open trades between you are called off.`)) await friendAction("friend_remove", {p_name: name});
    } else if (act === "daily") {
      await friendAction("challenge_send", {p_name: name, p_kind: "daily", p_num: profile.daily.num, p_keys: null, p_lineup: null},
        () => toast(CHECK_ICON, "Challenge sent", `${name} gets your Daily #${profile.daily.num} score to beat.`));
    } else if (act === "lineup") {
      await friendAction("challenge_send", {p_name: name, p_kind: "lineup", p_num: null, p_keys: starters().map(cardKey), p_lineup: profile.lineup.name || ""},
        () => toast(CHECK_ICON, "Lineup sent", `${name} can play your five from their Locker.`));
    } else if (act === "trade") openTrade(name);
  } else if (b.dataset.trade) {
    if (act === "cancel") await friendAction("trade_cancel", {p_id: id});
    else await friendAction("trade_respond", {p_id: id, p_accept: act === "accept"}, res => {
      if (res.status === "accepted") {
        ownedCards = res.cards.map(serverCard).filter(Boolean);
        save("statstack_cards", ownedCards);
        updateBoard();
        progressChanged();
        FX.feedback("claim");
        toast(CHECK_ICON, "Trade done", "The cards are in your collection.");
      } else if (res.status === "void") toast(`<span class="toast-icon" aria-hidden="true">!</span>`, "Offer called off", res.message);
    });
  } else if (b.dataset.ch) {
    const c = inbox.find(x => x.id === id);
    await Account.call("challenge_seen", {p_id: id});
    inbox = inbox.filter(x => x.id !== id);
    setSocial({...social, challenges: inbox.length});
    if (act === "play" && c) playChallenge(c);
    renderFriends();
  }
  b.disabled = false;
});

// A challenge from the inbox opens like a challenge link does
function playChallenge(c) {
  if (c.kind === "daily") {
    incoming = {type: "daily", num: c.payload.n, score: c.payload.s, from: c.from};
  } else {
    const cards = (c.payload.k || []).map(cardByKey);
    if (!cards.every(Boolean)) return toast(`<span class="toast-icon" aria-hidden="true">!</span>`, "Update needed", "Reload the page to get the latest players.");
    incoming = {type: "lineup", keys: c.payload.k, cards, from: c.from, name: c.payload.name || ""};
  }
  showChallenge();
}

// ─── TRADE BUILDER ──────────────────────────────────────────────────────────
let tradeWith = "", theirCards = [];
const tradePick = {give: new Set(), want: new Set()};

async function openTrade(name) {
  tradeWith = name;
  theirCards = [];
  tradePick.give.clear();
  tradePick.want.clear();
  $("tradeTitle").textContent = `Trade with ${name}`;
  $("tradeGiveSearch").value = $("tradeWantSearch").value = "";
  setMsg("tradeMsg", "Loading their cards…");
  renderTrade();
  $("tradeDialog").showModal();
  const res = await serverMove("friend_cards", {p_name: name});
  theirCards = res ? res.map(serverCard).filter(Boolean) : [];
  setMsg("tradeMsg", theirCards.length ? "" : `${name} has no cards yet. You can still send them a gift.`);
  renderTrade();
}

// Best cards first; chosen ones stay at the top; at most 60 shown at once
function pickHtml(cards, side, q) {
  const chosen = tradePick[side];
  const words = q.trim().toLowerCase();
  const list = cards.filter(c => chosen.has(c.sid) || !words || `${c.name} ${c.season} ${c.team}`.toLowerCase().includes(words))
    .sort((a, b) => (chosen.has(b.sid) - chosen.has(a.sid)) || cardOvr(b) - cardOvr(a)).slice(0, 60);
  if (!list.length) return `<li class="muted trade-none">${cards.length ? "No cards match." : "No cards."}</li>`;
  return list.map(c => `<li><button class="trade-card${chosen.has(c.sid) ? " on" : ""}" type="button" data-side="${side}" data-sid="${c.sid}" aria-pressed="${chosen.has(c.sid)}" aria-label="${esc(c.name)} ${esc(c.season)}"><span class="chase-card">${miniTile(c)}</span></button></li>`).join("");
}
function renderTrade() {
  $("tradeGive").innerHTML = pickHtml(ownedCards.filter(c => c.sid), "give", $("tradeGiveSearch").value);
  $("tradeWant").innerHTML = pickHtml(theirCards, "want", $("tradeWantSearch").value);
  $("tradeGiveN").textContent = `${tradePick.give.size}/5`;
  $("tradeWantN").textContent = `${tradePick.want.size}/5`;
  $("tradeSend").disabled = !(tradePick.give.size + tradePick.want.size);
  $("tradeSend").textContent = tradePick.give.size && !tradePick.want.size ? "Send as a gift" : "Send offer";
}
$("tradeDialog").addEventListener("click", e => {
  const b = e.target.closest("[data-side]");
  if (!b) return;
  const set = tradePick[b.dataset.side], sid = Number(b.dataset.sid);
  if (set.has(sid)) set.delete(sid);
  else if (set.size < 5) set.add(sid);
  else return setMsg("tradeMsg", "Up to five cards each way.", "err");
  setMsg("tradeMsg", "");
  renderTrade();
});
$("tradeGiveSearch").addEventListener("input", renderTrade);
$("tradeWantSearch").addEventListener("input", renderTrade);
$("tradeClose").addEventListener("click", () => $("tradeDialog").close());
$("tradeSend").addEventListener("click", async () => {
  $("tradeSend").disabled = true;
  const res = await Account.call("trade_offer", {p_name: tradeWith, p_give: [...tradePick.give], p_want: [...tradePick.want]});
  if (res.error) { setMsg("tradeMsg", res.error, "err"); $("tradeSend").disabled = false; return; }
  $("tradeDialog").close();
  toast(CHECK_ICON, "Offer sent", `${tradeWith} can accept it from their Friends page.`);
  await loadSocial();
});

// ─── KEEPING UP TO DATE ─────────────────────────────────────────────────────
SCREEN_HOOKS.friends = () => { renderFriends(); loadSocial(); };
SCREEN_HOOKS.gameState = st => { if (st.social) setSocial(st.social); };
Account.on(() => {
  if (!Account.signedIn()) { friends = null; trades = []; inbox = []; setSocial({requests: 0, challenges: 0, trades: 0}); }
  if (currentScreen === "friends") renderFriends();
});
// Check for new requests, challenges and offers every minute and a half
setInterval(async () => {
  if (!Account.ranked() || document.visibilityState !== "visible") return;
  if (currentScreen === "friends") return loadSocial();
  const r = await Account.call("social_counts");
  if (r.data) setSocial(r.data);
}, 90000);
