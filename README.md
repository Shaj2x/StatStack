# StatStack

NBA Higher or Lower: a static web app with no build step.

- `index.html` is the app shell (Home, Play, Shop and Collection screens)
- `css/app.css` has the styles
- `js/app.js` has the game logic
- `js/data.js` has the player database

## Refreshing player data

Season stats come from stats.nba.com through [nba_api](https://github.com/swar/nba_api):

```bash
pip install -r scripts/requirements.txt
python scripts/fetch_nba_data.py                  # all seasons
python scripts/fetch_nba_data.py 2023-24 1986-87  # just these
```

The script writes `data/seasons.json` and regenerates the `API_SEASONS` block in
`js/data.js`. Fetched seasons replace the hand-entered `SEASONS` data, and the
season dropdown lists only seasons that have data. Each season keeps the 120
players with the most minutes (40%+ of games played); rarity is assigned by
points + rebounds + assists rank (top 4% legendary, next 8% epic, next 23% rare).

stats.nba.com blocks most cloud/datacenter IPs, so run the script from a home
connection.
