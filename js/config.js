// Cloud accounts. Your Supabase project's URL and publishable (public) key
// turn on sign-in and sync; with them empty, progress stays in this browser.
// This key is meant to be public: row-level security in
// supabase/schema.sql keeps each player's save private.
window.STATSTACK_CONFIG = {
  supabaseUrl: "https://floebuslqpoumeqopeyi.supabase.co",
  supabaseAnonKey: "sb_publishable_9xV9SGU_w8oO-Nu2P8t6Kw_VcTFrXV7",
  // Set to true once Google is enabled under Authentication → Providers
  googleSignIn: false,
  // Set to true if the sign-in email template includes {{ .Token }} (needs custom SMTP)
  emailCode: false,
};
