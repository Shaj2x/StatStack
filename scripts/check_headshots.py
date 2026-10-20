#!/usr/bin/env python3
"""Check that every player's headshot ID in js/data.js belongs to that player.

Headshots are looked up by official NBA player ID, so a wrong ID shows
someone else's face. Run after editing or regenerating the data:

    python scripts/check_headshots.py

Exits with status 1 if any player has a wrong or missing ID.
"""

import re
import sys
from pathlib import Path

from player_ids import matches, name_for_id

DATA = Path(__file__).resolve().parent.parent / "js" / "data.js"
SEASON = re.compile(r'^"(\d{4}-\d{2})":')
PLAYER = re.compile(r'name:"((?:[^"\\]|\\.)*)".*?ppg:([\d.]+).*?rpg:([\d.]+).*?img:(null|"(\d+)")')


def rows(block):
    """Yield (season, name, ppg, rpg, id) for each player line in a SEASONS block."""
    season = None
    for line in block.splitlines():
        m = SEASON.match(line)
        if m:
            season = m.group(1)
            continue
        m = PLAYER.search(line)
        if m:
            name, ppg, rpg, _, pid = m.groups()
            yield season, name, ppg, rpg, pid


def main():
    # Fetched seasons (after the SEASONS:BEGIN marker) replace hand-entered ones
    hand, fetched = DATA.read_text(encoding="utf-8").split("// <SEASONS:BEGIN>", 1)
    fetched_rows = list(rows(fetched))
    fetched_seasons = {r[0] for r in fetched_rows}
    live = [r for r in rows(hand) if r[0] not in fetched_seasons] + fetched_rows

    problems, checked = [], 0
    for season, name, ppg, rpg, pid in live:
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
