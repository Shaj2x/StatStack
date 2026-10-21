// Sign-in and cloud saves through Supabase. Loaded before js/app.js, which
// hands over how to read and apply a save with Account.init(). Without keys in
// js/config.js nothing here runs and the game saves to this browser only.

const Account = (() => {
  const cfg = window.STATSTACK_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js";
  const PUSH_DELAY = 1500;

  let client = null, user = null, hooks = null, pushTimer = null;
  // phase: off | loading | signed-out | sent | signed-in
  let phase = enabled ? "loading" : "off";
  let sync = "idle"; // idle | busy | error
  let lastSync = 0, pendingEmail = "";
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
    // PKCE puts the sign-in code in ?code=, leaving the #screen hash alone
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {flowType: "pkce", persistSession: true, detectSessionInUrl: true},
    });
    client.auth.onAuthStateChange((event, session) => {
      const was = user && user.id;
      user = session ? session.user : null;
      if (user) phase = "signed-in";
      else if (phase !== "sent") phase = "signed-out";
      // Supabase asks that other calls wait until this callback returns
      if (user && user.id !== was) setTimeout(pull, 0);
      emit();
    });
    await client.auth.getSession();
    const url = new URL(location.href);
    if (url.searchParams.has("code")) {
      url.searchParams.delete("code");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    if (!user && phase === "loading") { phase = "signed-out"; emit(); }
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
        created: Math.min(lp.created || Date.now(), cp.created || Date.now()),
      },
    };
  }

  function setSync(s) { sync = s; emit(); }

  async function pull() {
    if (!user) return;
    setSync("busy");
    const {data, error} = await client.from("saves").select("data").eq("id", user.id).maybeSingle();
    if (error) { setSync("error"); return; }
    if (data && data.data) hooks.apply(merge(hooks.get(), data.data));
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

  const redirect = () => location.origin + location.pathname;

  async function sendLink(email) {
    const {error} = await client.auth.signInWithOtp({email, options: {emailRedirectTo: redirect()}});
    if (error) return error.message;
    pendingEmail = email;
    phase = "sent";
    emit();
    return null;
  }
  async function verifyCode(code) {
    const {error} = await client.auth.verifyOtp({email: pendingEmail, token: code, type: "email"});
    return error ? error.message : null;
  }
  function cancelLink() { phase = "signed-out"; pendingEmail = ""; emit(); }
  function google() { return client.auth.signInWithOAuth({provider: "google", options: {redirectTo: redirect()}}); }

  // Usernames are unique across players; the database enforces it
  async function claimName(name) {
    if (!user) return null;
    const {error} = await client.from("saves").upsert({id: user.id, username: name, data: hooks.get(), updated_at: new Date().toISOString()});
    if (!error) { lastSync = Date.now(); emit(); return null; }
    return error.code === "23505" ? "That username is taken." : error.message;
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
    google: !!cfg.googleSignIn,
    init,
    on: fn => listeners.push(fn),
    phase: () => phase,
    sync: () => sync,
    lastSync: () => lastSync,
    email: () => (user ? user.email : pendingEmail),
    signedIn: () => !!user,
    changed, sendLink, verifyCode, cancelLink, signInWithGoogle: google, claimName, signOut, merge,
  };
})();
