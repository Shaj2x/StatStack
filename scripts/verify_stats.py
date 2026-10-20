#!/usr/bin/env python3
"""Proofcheck every player's stats in the game against a second, independent source.

  - 1996-97 onward (fetched from stats.nba.com) is checked against Basketball-Reference.
  - Earlier seasons (fetched from Basketball-Reference) are checked against each
    player's official stats.nba.com career record.

Usage (from a home connection; both sites block most servers):
    python scripts/verify_stats.py                  # every season
    python scripts/verify_stats.py 1984-85 2023-24  # only these

Prints each mismatch with both values and writes the full report to
data/stat_check.txt. Differences of 0.1 or less are rounding, not errors.
"""

import collections
import json
import sys
import time
from pathlib import Path

from basketball_reference_web_scraper import client

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_nba_data as nba  # noqa: E402
from player_ids import norm  # noqa: E402

REPORT = nba.ROOT / "data" / "stat_check.txt"
STATS = [("ppg", "PTS"), ("rpg", "REB"), ("apg", "AST"), ("spg", "STL"), ("bpg", "BLK")]
TOLERANCE = 0.11   # each source rounds to one decimal
BBREF_DELAY = 4    # Basketball-Reference allows about 20 requests a minute
NBA_DELAY = 0.8


def bbref_per_game(season):
    """{normalized name: [per-game dict, ...]} from Basketball-Reference, traded players combined."""
    totals = client.players_season_totals(season_end_year=int(season[:4]) + 1)
    by_slug = collections.OrderedDict()
    for t in totals:
        p = by_slug.setdefault(t["slug"], {"name": t["name"], "g": 0, "PTS": 0, "REB": 0, "AST": 0, "STL": 0, "BLK": 0})
        p["g"] += t["games_played"] or 0
        p["PTS"] += t["points"] or 0
        p["REB"] += (t["offensive_rebounds"] or 0) + (t["defensive_rebounds"] or 0)
        p["AST"] += t["assists"] or 0
        p["STL"] += t["steals"] or 0
        p["BLK"] += t["blocks"] or 0
    out = collections.defaultdict(list)
    for p in by_slug.values():
        if p["g"]:
            out[norm(p["name"])].append({k: p[k] / p["g"] for _, k in STATS})
    return out


def nba_per_game(player_id, season):
    """Per-game dict for one player-season from stats.nba.com, or None."""
    from nba_api.stats.endpoints import playercareerstats
    df = playercareerstats.PlayerCareerStats(player_id=player_id, per_mode36="PerGame", timeout=60).get_data_frames()[0]
    rows = df[df["SEASON_ID"] == season]
    if rows.empty:
        return None
    tot = rows[rows["TEAM_ABBREVIATION"] == "TOT"]  # traded players: the full-season row
    r = (tot if not tot.empty else rows).iloc[0]
    return {k: float(r[k] or 0) for _, k in STATS}


def compare(game, real):
    return [(k, game[f], round(real[k], 1)) for f, k in STATS if abs(game[f] - real[k]) > TOLERANCE]


def main():
    data = json.loads(nba.CACHE.read_text(encoding="utf-8"))
    wanted = sys.argv[1:] or sorted(data, reverse=True)
    lines, totals = [], collections.Counter()

    def log(msg):
        print(msg)
        lines.append(msg)

    for season in wanted:
        if season not in data:
            log(f"{season}: not in data/seasons.json, skipping")
            continue
        players = data[season]
        source = "Basketball-Reference" if int(season[:4]) >= 1996 else "stats.nba.com"
        log(f"\n{season}: checking {len(players)} players against {source}")
        season_count = collections.Counter()
        try:
            ref = bbref_per_game(season) if source == "Basketball-Reference" else None
        except Exception as exc:
            log(f"  could not load {source} ({exc.__class__.__name__}: {exc})")
            totals["unchecked"] += len(players)
            continue
        for p in players:
            real = None
            try:
                if ref is not None:
                    matches = ref.get(norm(p["name"]), [])
                    # Same-name players: use the one whose stats are closest
                    real = min(matches, key=lambda m: len(compare(p, m)), default=None)
                elif p["img"]:
                    real = nba_per_game(p["img"], season)
                    time.sleep(NBA_DELAY)
            except Exception as exc:
                log(f"  {p['name']}: lookup failed ({exc.__class__.__name__})")
                totals["unchecked"] += 1
                continue
            if real is None:
                log(f"  {p['name']} ({p['team']}): not found in {source}")
                totals["not found"] += 1
                season_count["not found"] += 1
                continue
            diffs = compare(p, real)
            if diffs:
                season_count["mismatch"] += 1
                totals["mismatch"] += 1
                log(f"  MISMATCH {p['name']} ({p['team']}): " +
                    "; ".join(f"{k} game {g} vs {source} {r}" for k, g, r in diffs))
            else:
                season_count["match"] += 1
                totals["match"] += 1
        log(f"  {season}: {season_count['match']} OK, {season_count['mismatch']} mismatched, "
            f"{season_count['not found']} not found")
        if source == "Basketball-Reference":
            time.sleep(BBREF_DELAY)

    log(f"\nSummary: {totals['match']} players match, {totals['mismatch']} mismatched, "
        f"{totals['not found']} not found in the other source, {totals['unchecked']} not checked")
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Full report: {REPORT.relative_to(nba.ROOT)}")


if __name__ == "__main__":
    main()
