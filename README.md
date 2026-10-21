# StatStack

NBA Higher or Lower: a static web app with no build step.

- `index.html` is the app shell (Play, Packs and Collection screens, plus a settings dialog)
- `css/app.css` has the styles
- `js/app.js` has the game logic
- `js/data.js` has the player database
- `js/teams.js` has team names and the colours used for each player's half
- `js/modes.js` has the Daily Challenge, Who Am I?, the Locker and the leaderboards
- `js/account.js` handles sign-in and cloud saves; `js/config.js` holds its keys

## Refreshing player data

Stats come from two sources, both run from your own computer
(stats.nba.com and Basketball-Reference block most cloud servers):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/fetch_nba_data.py        # 1996-97 onward, from stats.nba.com via nba_api
python scripts/fetch_bbref_seasons.py   # earlier seasons, from Basketball-Reference
python scripts/check_headshots.py --fix # confirm every headshot ID is the right player
python scripts/fetch_photos.py          # real photos for players NBA.com has none for
python scripts/verify_stats.py          # proofcheck every stat against a second source
```

Both fetch scripts write `data/seasons.json` and regenerate the `API_SEASONS`
block in `js/data.js`, and the season dropdown lists only seasons that have
data. Pass season names (for example `2023-24`) to fetch only those, or
`--cache-only` to `fetch_nba_data.py` to rebuild `js/data.js` without fetching.
Each season keeps the 120 players with the most minutes (40%+ of games
played); rarity is assigned by points + rebounds + assists rank (top 4%
legendary, next 8% epic, next 23% rare).

### Headshots

Headshots load from NBA.com by official NBA player ID, so the ID decides whose
face appears. `check_headshots.py` checks every player in the game against
nba_api's offline list of all NBA players and reports any ID that belongs to
someone else. Basketball-Reference players are matched to NBA IDs by name and
the years they played; anyone who can't be matched gets a silhouette instead
of a guess. Names that need a hand-picked ID go in `scripts/player_ids.py`.

NBA.com has no headshot for many retired players and returns a generic
silhouette instead. `fetch_photos.py` finds those players and first looks them up on
Wikidata, which links each player's NBA.com ID to their photo (an exact
match). Anyone still missing is looked up on Wikipedia, using the article's freely licensed lead photo only when the
article is about that basketball player (matching name, "basketball" in the
description, an age that fits the season, and the team when two articles
fit). Results go in `js/photos.js` with each photo's author and licence, which
the game shows as a credit. Players with no confirmed photo keep the game's
own silhouette rather than a guess. Rerun it after fetching new seasons.

### Checking the stats

`verify_stats.py` compares every player's numbers in the game with a second,
independent source: seasons from 1996-97 on (which come from stats.nba.com)
against Basketball-Reference, and earlier seasons (which come from
Basketball-Reference) against each player's stats.nba.com career record. It
prints every mismatch with both values and saves the full report to
`data/stat_check.txt`. Differences of 0.1 are rounding.

## Accounts and cloud sync

Players get a profile (username, team-colour avatar, lifetime stats and
badges) whether or not they sign in. An account keeps coins, cards and badges
in sync across devices: players sign up and sign in with an email and
password. It uses [Supabase](https://supabase.com) (free tier) and stays off
while `js/config.js` has no keys; then everything saves in the browser only.

Setting up a Supabase project:

1. Create a free project at supabase.com.
2. In **SQL Editor**, run `supabase/schema.sql`. It makes the `saves` table
   (each player can only read and write their own row), a check that a
   username is free, and the `leaderboard` function, which shares only
   usernames, team colours and scores. Running it again is safe.
3. Under **Authentication → Sign In / Providers → Email**, keep Email on and
   turn **Confirm email** off, so new accounts can play straight away.
4. Under **Authentication → URL Configuration**, set the Site URL to
   `https://shaj2x.github.io/StatStack/` and add
   `https://shaj2x.github.io/StatStack/**` to the Redirect URLs. Only
   password-reset emails use these.
5. Copy the Project URL and the publishable key (under **Project Settings →
   API Keys**) into `js/config.js`. The publishable key is meant to be
   public; the table's row-level security is what protects each save.

Supabase's built-in email sender only allows a few emails an hour, which is
fine for password resets. For more, add your own SMTP under
**Authentication → Emails**.

When a player signs in, cards from the device and the account are combined;
coins and settings come from whichever was played most recently, and records
(best streak, totals, badges) keep the higher value. Signing out leaves the
progress in the account and resets the device to a fresh guest.

## Game modes

- **Higher or Lower** and **Who Am I?** share the Play tab and the season
  picker. Who Am I? shows a season's stat line and four names; the wrong
  names are the players with the closest numbers that season.
- **Daily Challenge**: ten matchups a day, the same for everyone, built from
  a generator seeded with the day number (Daily #1 is 21 October 2026).
  Players come from every season, the two numbers are within about 6%, and
  every other question sets a star against a lesser player who usually edges
  them. One try per day; results share as an emoji grid.
- **Packs**: Player (current season), Era, Team (a franchise across every
  season) and Elite (rare or better). Duplicates stack in the collection and
  can be quick-sold by rarity.
- **Locker**: a starting five and a bench from your own cards, with an OVR
  from each player's ranks in their season.
- **Ranks**: today's Daily, best streak this week and all-time, and most
  legendaries. Scores come from players' own saves, so they are trusted as
  sent.

## Installable app

StatStack is a Progressive Web App: `manifest.webmanifest` and `icons/` let
phones add it to the home screen, and `sw.js` caches the app (plus recently
seen headshots) so it plays offline. Online, it always loads the latest files,
so changes show on the next reload; the saved copy is only used offline. If you add or rename a
file the app loads, add it to the `SHELL` list in `sw.js` and bump `VERSION`.
