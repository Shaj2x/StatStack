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

## Hosting on Vercel

The game is plain files with no build step, so Vercel serves it as is.

1. At vercel.com, **Add New → Project**, import `Shaj2x/StatStack`.
2. Framework preset **Other**. Leave the build command and output
   directory empty (the root is the site). Deploy.
3. In Supabase, **Authentication → URL Configuration**, add the Vercel address
   (for example `https://statstack.vercel.app/**`) to the Redirect URLs, so
   password-reset emails can come back to it.

`vercel.json` stops browsers caching the service worker, the page and the
scripts, so updates show up straight away; `.vercelignore` leaves the
scripts and SQL out of the deploy. Every push to `main` deploys again.
Challenge links use whichever address the game is opened on.

## Overall ratings (OVR)

Cards show a real NBA 2K rating where one exists (marked **2K** on the card
back): NBA 2K26's end-of-season ratings for the 2025-26 season, and 2K's
Classic team ratings (for example the 1995-96 Bulls) for earlier seasons.
That's 208 of the 2,400 cards. They come from
[nba2kapi](https://github.com/wkoverfield/nba2kapi), whose data is from
2kratings.com, and are built into `js/ratings.js` by
`node scripts/build_ratings.js <path to an nba2kapi clone>`.

Every other card shows an estimate (marked **OVR**) fitted to those real
ratings: players are ranked within their season by production (points +
1.2×rebounds + 1.5×assists + 3×steals + 3×blocks) and
OVR = 99.5 − 4.07 × ln(rank), plus 2.5 for rare and epic players, with
floors of 90 for legendary and 85 for epic cards. On the cards with a real
rating this lands within about 2.5 points of 2K. After rebuilding the
ratings, run `node scripts/build_catalog.js` and re-run
`supabase/catalog.sql` so the server's battles use the same numbers.

## Accounts and cloud sync

Players get a profile (username, team-colour avatar, lifetime stats and
badges) whether or not they sign in. An account keeps coins, cards and badges
in sync across devices: players sign up and sign in with an email and
password. It uses [Supabase](https://supabase.com) (free tier) and stays off
while `js/config.js` has no keys; then everything saves in the browser only.

Setting up a Supabase project:

1. Create a free project at supabase.com.
2. In **SQL Editor**, run these three files, in order:
   - `supabase/schema.sql`: the `saves` table (each player can only read and
     write their own row) and the check that a username is free.
   - `supabase/catalog.sql`: every card in the game, for the server to deal
     packs and grade answers from. Rebuild it with
     `node scripts/build_catalog.js` whenever `js/data.js` changes, then run
     it again.
   - `supabase/game.sql`: the server side of the game (see Fair play below)
     and the `leaderboard` function, which shares only usernames, team colours,
     scores, showcased cards and records.

   Running them again is safe, and is how you update an existing project.
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

### Fair play

For signed-in players the server keeps score. Coins, cards, streaks, Daily
results and battle records live in tables players can't write to, and every
move goes through a database function in `supabase/game.sql`: the server
hands out each question, times the answer, grades it and pays for it, deals
packs, sells duplicates, pays set milestones and login rewards, and decides
battles. The leaderboards read only those tables, so editing the game in the
browser changes nothing that counts.

Every question has a shot clock: 6 seconds in Higher or Lower, 8 in Who Am I?
and the Daily. Right answers in the first half of the clock pay a bonus. Long
enough to think, too short to look the answer up.

Accounts made before `game.sql` was first run keep their cards and records,
with coins capped at 50,000. New accounts start fresh: coins and cards earned
as a guest stay on that device. Until `game.sql` is installed, signed-in
players keep score in their save as before.

### Friends, trades and weekend packs

Signed-in players with a username can add friends by username (Friends &
trades, in the account menu). A friend's card shows their best streak,
battle record, legendaries, last Daily score and showcase. You can send a
friend your Daily score or your starting five to beat; it lands in their
inbox and opens like a challenge link. Friends can offer each other up to
five cards each way. Nothing moves until the other side accepts, and the
server checks both sides still own every card at that moment.

Every weekend (Friday to Sunday, UTC) the shop has one limited pack with
better odds. The theme rotates weekly: Playoff Heroes, Glass Cleaners
(9+ rebounds), Bucket Getters (22+ points), Dime Droppers (7+ assists) and
Lockdown (1.6+ steals or 1.8+ blocks). The schedule is in both
`supabase/game.sql` and `js/app.js`.

Guests play entirely in the browser, with the same rules and clocks; nothing
they do reaches the leaderboards. Signing out resets the device to a fresh
guest.

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
- **Ranks**: the monthly season (Daily Challenge points, UTC months; the top
  10 earn a trophy when the next month starts), today's Daily, best streak
  this week and all-time, and most legendaries. Tapping a name shows that
  player's showcase and record. Scores come from players' own saves, so they
  are trusted as sent.
- **Challenge a friend**: Daily results and Locker lineups share as links
  (`?c=` with a small base64url payload). Opening one plays the same puzzle
  or that five; challenge games pay nothing.
- **Settings**: a volume slider for the synthesised sound pack (`js/fx.js`)
  and themes (Auto, Dark, Light, Hardwood, Neon, My team). Cards and team
  colours keep their own palette in every theme.

## Installable app

StatStack is a Progressive Web App: `manifest.webmanifest` and `icons/` let
phones add it to the home screen, and `sw.js` caches the app (plus recently
seen headshots) so it plays offline. Online, it always loads the latest files,
so changes show on the next reload; the saved copy is only used offline. If you add or rename a
file the app loads, add it to the `SHELL` list in `sw.js` and bump `VERSION`.
