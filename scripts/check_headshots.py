#!/usr/bin/env python3
"""Check that every player's headshot ID in js/data.js belongs to that player.

Headshots are looked up by official NBA player ID, so a wrong ID shows
someone else's face. Run after editing or regenerating the data:

    python scripts/check_headshots.py          # report problems
    python scripts/check_headshots.py --fix    # also repair fetched seasons

Exits with status 1 if any player has a wrong or missing ID. --fix re-matches
wrong or missing IDs in data/seasons.json with player_ids.resolve and
rebuilds js/data.js; edit ALIASES, PICK or TEAM_PICK in player_ids.py for
names it can't match.
"""

import re
import sys
from pathlib import Path

from player_ids import matches, name_for_id, resolve

DATA = Path(__file__).resolve().parent.parent / "js" / "data.js"
SEASON = re.compile(r'^"(\d{4}-\d{2})":')
PLAYER = re.compile(r'name:"((?:[^"\\]|\\.)*)",team:"([^"]*)".*?ppg:([\d.]+).*?rpg:([\d.]+).*?img:(null|"(\d+)")')


def rows(block):
    """Yield (season, name, team, ppg, rpg, id) for each player line in a SEASONS block."""
    season = None
    for line in block.splitlines():
        m = SEASON.match(line)
        if m:
            season = m.group(1)
            continue
        m = PLAYER.search(line)
        if m:
            name, team, ppg, rpg, _, pid = m.groups()
            yield season, name, team, ppg, rpg, pid


def live_players(with_team=False):
    """(season, name, ppg, rpg, id) for every player the game can show,
    or (season, name, team, ppg, rpg, id) with with_team.

    Fetched seasons (after the SEASONS:BEGIN marker) replace hand-entered ones.
    """
    hand, fetched = DATA.read_text(encoding="utf-8").split("// <SEASONS:BEGIN>", 1)
    fetched_rows = list(rows(fetched))
    fetched_seasons = {r[0] for r in fetched_rows}
    live = [r for r in rows(hand) if r[0] not in fetched_seasons] + fetched_rows
    return live if with_team else [(r[0], r[1], r[3], r[4], r[5]) for r in live]


def fix():
    """Re-match wrong or missing IDs in the fetched seasons, then rebuild js/data.js."""
    import json
    import fetch_nba_data as nba
    data = json.loads(nba.CACHE.read_text(encoding="utf-8"))
    fixed = 0
    for season, players in data.items():
        for p in players:
            if p["img"] and matches(p["name"], p["img"]):
                continue
            pid = resolve(p["name"], season_start=int(season[:4]), team=p["team"])
            new = str(pid) if pid else None
            if new != p["img"]:
                print(f"{season}  {p['name']}: {p['img']} -> {new}")
                p["img"] = new
                fixed += 1
    nba.CACHE.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    nba.write_index(data)
    print(f"Fixed {fixed} ID(s).")


def main():
    if "--fix" in sys.argv[1:]:
        fix()
    problems, checked = [], 0
    for season, name, ppg, rpg, pid in live_players():
        if float(ppg) == 0 and float(rpg) == 0:
            continue  # placeholder rows the game skips
        checked += 1
        if pid is None:
            problems.append(f"{season}  {name}: no headshot ID")
        elif not matches(name, pid):
            problems.append(f"{season}  {name}: ID {pid} belongs to {name_for_id(pid) or 'nobody'}")

    for p in problems:
        print(p)
    print(f"Checked {checked} players: {len(problems)} problem(s).")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
