// Sign-in and cloud saves through Supabase. Loaded before js/app.js, which
// hands over how to read and apply a save with Account.init(). Without keys in
// js/config.js nothing here runs and the game saves to this browser only.

const Account = (() => {
  const cfg = window.STATSTACK_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js";
  const PUSH_DELAY = 1500;

  let client = null, user = null, hooks = null, pushTimer = null;
  // phase: off | loading | signed-out | signed-in
  let phase = enabled ? "loading" : "off";
  let sync = "idle"; // idle | busy | error
  let lastSync = 0;
  // Set when the player arrived from a password-reset email
  let recovering = false;
  // Username chosen at sign-up, claimed once the account's save is in place
  let pendingName = "";
  const listeners = [];
  const emit = () => listeners.forEach(fn => fn());

  function loadLib() {
    if (window.supabase) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIB;
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });
  }

  async function init(h) {
    hooks = h;
    if (!enabled) return;
    try { await loadLib(); }
    catch { phase = "signed-out"; sync = "error"; emit(); return; }
    const url = new URL(location.href);
    recovering = url.searchParams.get("reset") === "1";
    // PKCE puts the reset code in ?code=, leaving the #screen hash alone
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {flowType: "pkce", persistSession: true, detectSessionInUrl: true},
    });
    client.auth.onAuthStateChange((event, session) => {
      const was = user && user.id;
      user = session ? session.user : null;
      phase = user ? "signed-in" : "signed-out";
      if (event === "PASSWORD_RECOVERY") recovering = true;
      // Supabase asks that other calls wait until this callback returns
      if (user && user.id !== was) setTimeout(pull, 0);
      emit();
    });
    await client.auth.getSession();
    if (url.searchParams.has("code") || url.searchParams.has("reset")) {
      url.searchParams.delete("code");
      url.searchParams.delete("reset");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    if (!user) recovering = false;
    if (phase === "loading") phase = "signed-out";
    emit();
  }

  // Cards from both sides are kept; everything else comes from whichever
  // save changed last, except records (best streak, totals, badges) which
  // keep the higher value
  function merge(local, cloud) {
    const newer = (cloud.updatedAt || 0) >= (local.updatedAt || 0) ? cloud : local;
    const cards = new Map();
    for (const c of [...(cloud.cards || []), ...(local.cards || [])]) {
      cards.set(`${c.name}|${c.season}|${c.pulled || 0}`, c);
    }
    const lp = local.profile || {}, cp = cloud.profile || {};
    const stats = {...(newer.profile || {}).stats};
    for (const k of new Set([...Object.keys(lp.stats || {}), ...Object.keys(cp.stats || {})])) {
      stats[k] = Math.max((lp.stats || {})[k] || 0, (cp.stats || {})[k] || 0);
    }
    const badges = {...cp.badges};
    for (const [id, t] of Object.entries(lp.badges || {})) badges[id] = badges[id] ? Math.min(badges[id], t) : t;
    return {
      ...newer,
      bestStreak: Math.max(local.bestStreak || 0, cloud.bestStreak || 0),
      cards: [...cards.values()].sort((a, b) => (a.pulled || 0) - (b.pulled || 0)),
      profile: {
        ...newer.profile,
        stats,
        badges,
        seasons: [...new Set([...(lp.seasons || []), ...(cp.seasons || [])])],
        weekly: mergeWeekly(lp.weekly, cp.weekly),
        daily: mergeDaily(lp.daily, cp.daily),
        login: (lp.login || {}).last > (cp.login || {}).last ? lp.login : cp.login || lp.login,
        monthPts: Object.fromEntries([...new Set([...Object.keys(lp.monthPts || {}), ...Object.keys(cp.monthPts || {})])]
          .map(m => [m, Math.max((lp.monthPts || {})[m] || 0, (cp.monthPts || {})[m] || 0)])),
        trophies: [...new Map([...(cp.trophies || []), ...(lp.trophies || [])].map(t => [t.month, t])).values()],
        sets: Object.fromEntries([...new Set([...Object.keys(lp.sets || {}), ...Object.keys(cp.sets || {})])]
          .map(id => [id, Math.max((lp.sets || {})[id] || 0, (cp.sets || {})[id] || 0)])),
        battle: ["w", "l", "best", "legendWins"].reduce((b, k) => ({...b, [k]: Math.max((lp.battle || {})[k] || 0, (cp.battle || {})[k] || 0)}), {...(newer.profile || {}).battle}),
        newsSeen: [lp.newsSeen || "", cp.newsSeen || ""].sort().pop(),
        created: Math.min(lp.created || Date.now(), cp.created || Date.now()),
      },
    };
  }

  // Same week: keep the better streak. Same puzzle: keep the run that got further.
  function mergeWeekly(a = {}, b = {}) {
    if (a.week !== b.week) return (a.week || "") > (b.week || "") ? a : b;
    return {week: a.week, best: Math.max(a.best || 0, b.best || 0)};
  }
  function mergeDaily(a = {}, b = {}) {
    if ((a.num || 0) !== (b.num || 0)) return (a.num || 0) > (b.num || 0) ? a : b;
    return ((a.answers || []).length >= (b.answers || []).length) ? a : b;
  }

  async function leaderboard(board, puzzle, period) {
    if (!client) return {error: "off"};
    const {data, error} = await client.rpc("leaderboard", {board, puzzle: puzzle == null ? null : puzzle, period: period || null});
    return error ? {error: friendly(error)} : {rows: data || []};
  }

  function setSync(s) { sync = s; emit(); }

  async function pull() {
    if (!user) return;
    setSync("busy");
    const {data, error} = await client.from("saves").select("data").eq("id", user.id).maybeSingle();
    if (error) { setSync("error"); return; }
    if (data && data.data) hooks.apply(merge(hooks.get(), data.data));
    if (pendingName) {
      const name = pendingName;
      pendingName = "";
      if (!(await claimName(name))) hooks.rename(name);
    }
    await push();
  }

  async function push() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (!user) return;
    setSync("busy");
    const {error} = await client.from("saves").upsert({id: user.id, data: hooks.get(), updated_at: new Date().toISOString()});
    if (error) { setSync("error"); return; }
    lastSync = Date.now();
    setSync("idle");
  }

  // The game calls this after every change; saves are batched
  function changed() {
    if (!user) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, PUSH_DELAY);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && pushTimer) push();
  });

  // Supabase's messages, reworded for players
  function friendly(error) {
    const m = (error && error.message) || "";
    if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
    if (/already registered|already been registered|already exists/i.test(m)) return "There's already an account with that email. Sign in instead.";
    if (/email not confirmed/i.test(m)) return "This account still needs its email confirmed. Turn off “Confirm email” in Supabase, or use the link in the email.";
    if (/password should be|weak password|at least/i.test(m)) return m;
    if (/rate limit|too many/i.test(m)) return "Too many tries. Wait a minute and try again.";
    if (/fetch|network/i.test(m)) return "Couldn't reach the server. Check your connection.";
    return m || "Something went wrong. Try again.";
  }

  async function signIn(email, password) {
    const {error} = await client.auth.signInWithPassword({email, password});
    return error ? friendly(error) : null;
  }

  async function usernameAvailable(name) {
    const {data, error} = await client.rpc("username_available", {name});
    return error ? true : !!data; // if the check fails, the save itself still enforces it
  }

  async function signUp(email, password, name) {
    if (name && !(await usernameAvailable(name))) return "That username is taken.";
    pendingName = name || "";
    const {data, error} = await client.auth.signUp({email, password});
    if (error) { pendingName = ""; return friendly(error); }
    // No session means the project still asks new accounts to confirm their email
    if (!data.session) return "Account made. Check your email to confirm it, then sign in.";
    return null;
  }

  async function sendReset(email) {
    const {error} = await client.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}${location.pathname}?reset=1`,
    });
    return error ? friendly(error) : null;
  }

  async function updatePassword(password) {
    const {error} = await client.auth.updateUser({password});
    if (!error) { recovering = false; emit(); }
    return error ? friendly(error) : null;
  }

  // Usernames are unique across players; the database enforces it
  async function claimName(name) {
    if (!user) return null;
    const {error} = await client.from("saves").upsert({id: user.id, username: name, data: hooks.get(), updated_at: new Date().toISOString()});
    if (!error) { lastSync = Date.now(); emit(); return null; }
    return error.code === "23505" ? "That username is taken." : friendly(error);
  }

  // Progress is already in the account, so the device goes back to a fresh guest
  async function signOut() {
    if (pushTimer) await push();
    await client.auth.signOut();
    user = null;
    phase = "signed-out";
    hooks.reset();
    emit();
  }

  return {
    enabled,
    init,
    on: fn => listeners.push(fn),
    phase: () => phase,
    sync: () => sync,
    lastSync: () => lastSync,
    email: () => (user ? user.email : ""),
    signedIn: () => !!user,
    recovering: () => recovering,
    leaderboard, changed, signIn, signUp, sendReset, updatePassword, claimName, signOut, merge,
  };
})();
