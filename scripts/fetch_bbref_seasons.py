#!/usr/bin/env python3
"""Fill StatStack's pre-1996 seasons with real stats from Basketball-Reference.

stats.nba.com only has per-game tables from 1996-97 on, so the older seasons
come from basketball-reference.com via basketball_reference_web_scraper.
Each player is matched to their official NBA player ID so headshots show the
right person, and players who can't be matched get the silhouette instead of
a guess.

Usage:
    pip install -r scripts/requirements.txt
    python scripts/fetch_bbref_seasons.py                  # every season before 1996-97
    python scripts/fetch_bbref_seasons.py 1991-92 1984-85  # only these

Writes data/seasons.json and js/data.js the same way fetch_nba_data.py does,
then checks every headshot ID. Basketball-Reference allows about 20 requests
a minute, so the script waits between seasons.
"""

import collections
import json
import subprocess
import sys
import time
from pathlib import Path

from basketball_reference_web_scraper import client
from basketball_reference_web_scraper.data import Team

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_nba_data as nba  # noqa: E402
from player_ids import norm, resolve  # noqa: E402

DELAY = 4  # seconds between Basketball-Reference requests

# Team names as Basketball-Reference reports them → StatStack team codes
TEAM_CODES = {
    Team.ATLANTA_HAWKS: "ATL", Team.BOSTON_CELTICS: "BOS", Team.CHARLOTTE_HORNETS: "CHH",
    Team.CHICAGO_BULLS: "CHI", Team.CLEVELAND_CAVALIERS: "CLE", Team.DALLAS_MAVERICKS: "DAL",
    Team.DENVER_NUGGETS: "DEN", Team.DETROIT_PISTONS: "DET", Team.GOLDEN_STATE_WARRIORS: "GSW",
    Team.HOUSTON_ROCKETS: "HOU", Team.INDIANA_PACERS: "IND", Team.KANSAS_CITY_KINGS: "KCK",
    Team.LOS_ANGELES_CLIPPERS: "LAC", Team.LOS_ANGELES_LAKERS: "LAL", Team.MIAMI_HEAT: "MIA",
    Team.MILWAUKEE_BUCKS: "MIL", Team.MINNESOTA_TIMBERWOLVES: "MIN", Team.NEW_JERSEY_NETS: "NJN",
    Team.NEW_YORK_KNICKS: "NYK", Team.ORLANDO_MAGIC: "ORL", Team.PHILADELPHIA_76ERS: "PHI",
    Team.PHOENIX_SUNS: "PHX", Team.PORTLAND_TRAIL_BLAZERS: "POR", Team.SACRAMENTO_KINGS: "SAC",
    Team.SAN_ANTONIO_SPURS: "SAS", Team.SEATTLE_SUPERSONICS: "SEA", Team.TORONTO_RAPTORS: "TOR",
    Team.UTAH_JAZZ: "UTA", Team.VANCOUVER_GRIZZLIES: "VAN", Team.WASHINGTON_BULLETS: "WSB",
}


def careers():
    """{normalized name: [(id, from_year, to_year)]} from stats.nba.com, or None.

    Lets players who share a name (two Patrick Ewings, two Larry Johnsons) be
    told apart by when they played. Falls back to the offline list if the site
    can't be reached.
    """
    try:
        from nba_api.stats.endpoints import commonallplayers
        df = commonallplayers.CommonAllPlayers(is_only_current_season=0, timeout=60).get_data_frames()[0]
    except Exception as exc:
        print(f"Could not load NBA career years ({exc.__class__.__name__}); using the offline list only")
        return None
    out = collections.defaultdict(list)
    for r in df.to_dict("records"):
        try:
            out[norm(r["DISPLAY_FIRST_LAST"])].append((int(r["PERSON_ID"]), int(r["FROM_YEAR"]), int(r["TO_YEAR"])))
        except (TypeError, ValueError):
            continue
    return out


def season_rows(season, career_years):
    """Per-game rows for one season, shaped for fetch_nba_data.build_season."""
    end_year = int(season[:4]) + 1
    totals = client.players_season_totals(season_end_year=end_year)

    # Traded players have one row per team; add them up and keep the last team
    by_player = collections.OrderedDict()
    for t in totals:
        p = by_player.setdefault(t["slug"], {"name": t["name"], "team": None, "games": 0, "minutes": 0,
                                             "points": 0, "rebounds": 0, "assists": 0, "steals": 0, "blocks": 0})
        p["team"] = TEAM_CODES.get(t["team"], getattr(t["team"], "name", "")[:3])
        p["games"] += t["games_played"] or 0
        p["minutes"] += t["minutes_played"] or 0
        p["points"] += t["points"] or 0
        p["rebounds"] += (t["offensive_rebounds"] or 0) + (t["defensive_rebounds"] or 0)
        p["assists"] += t["assists"] or 0
        p["steals"] += t["steals"] or 0
        p["blocks"] += t["blocks"] or 0

    rows, unmatched = [], []
    for slug, p in by_player.items():
        g = p["games"]
        if not g:
            continue
        nba_id = resolve(p["name"], season_start=int(season[:4]), careers=career_years, team=p["team"])
        if nba_id is None:
            unmatched.append(p["name"])
        rows.append({
            "PLAYER_ID": slug, "IMG": nba_id, "PLAYER_NAME": p["name"], "TEAM": p["team"],
            "GP": g, "MIN": p["minutes"] / g, "PTS": p["points"] / g, "REB": p["rebounds"] / g,
            "AST": p["assists"] / g, "STL": p["steals"] / g, "BLK": p["blocks"] / g,
        })
    return rows, unmatched


def main():
    wanted = sys.argv[1:] or [s for s in nba.SEASONS if int(s[:4]) < 1996]
    unknown = [s for s in wanted if s not in nba.SEASONS]
    if unknown:
        sys.exit(f"Unknown season(s): {', '.join(unknown)}. Add them to SEASONS in fetch_nba_data.py first.")

    career_years = careers()
    data = json.loads(nba.CACHE.read_text(encoding="utf-8")) if nba.CACHE.exists() else {}
    for i, season in enumerate(wanted):
        if i:
            time.sleep(DELAY)
        print(f"Fetching {season} from Basketball-Reference…")
        try:
            rows, unmatched = season_rows(season, career_years)
        except Exception as exc:
            print(f"  {season}: failed ({exc.__class__.__name__}: {exc}), skipping")
            continue
        players = nba.build_season(rows)
        if not players:
            print(f"  {season}: no data returned, skipping")
            continue
        data[season] = players
        kept = {p["name"] for p in players}
        missing = [n for n in unmatched if n in kept]
        print(f"  {season}: {len(players)} players, top scorer {max(players, key=lambda p: p['ppg'])['name']}"
              + (f"; no headshot match for {', '.join(missing)}" if missing else ""))
        nba.CACHE.parent.mkdir(exist_ok=True)
        nba.CACHE.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")

    nba.write_index(data)
    print(f"Wrote {len(data)} seasons to {nba.INDEX.relative_to(nba.ROOT)}", flush=True)
    subprocess.run([sys.executable, str(Path(__file__).with_name("check_headshots.py"))])


if __name__ == "__main__":
    main()
