# StatStack

NBA Higher or Lower: a static web app with no build step.

- `index.html` is the app shell (Play, Packs and Collection screens, plus a settings dialog)
- `css/app.css` has the styles
- `js/app.js` has the game logic
- `js/data.js` has the player database
- `js/teams.js` has team names and the colours used for each player's half

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

## Installable app

StatStack is a Progressive Web App: `manifest.webmanifest` and `icons/` let
phones add it to the home screen, and `sw.js` caches the app (plus recently
seen headshots) so it plays offline. Online, it always loads the latest files,
so changes show on the next reload; the saved copy is only used offline. If you add or rename a
file the app loads, add it to the `SHELL` list in `sw.js` and bump `VERSION`.
