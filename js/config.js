// Cloud accounts. Paste your Supabase project's URL and anon (public) key to
// turn on sign-in and sync; leave them empty and progress stays in this
// browser. The anon key is meant to be public: row-level security in
// supabase/schema.sql keeps each player's save private.
window.STATSTACK_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  // Set to true once Google is enabled under Authentication → Providers
  googleSignIn: false,
};
