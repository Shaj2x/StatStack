#!/usr/bin/env python3
"""Find real photos for players NBA.com has no headshot for.

NBA.com's image server returns a generic silhouette, not an error, for many
retired players. This script finds which players get that silhouette, then
looks them up on Wikipedia and uses the article's freely licensed lead photo
when the article is clearly about that basketball player. Each photo keeps
its author and licence so the game can credit it.

Usage (from a home connection; NBA.com and Wikipedia block most servers):
    pip install -r scripts/requirements.txt
    python scripts/fetch_photos.py

Writes js/photos.js. Players with neither an NBA headshot nor a confirmed
Wikipedia photo get the game's own silhouette, never a guess.
"""

import json
import re
import sys
import time
from html import unescape
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_headshots import live_players  # noqa: E402
from player_ids import norm  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "js" / "photos.js"
NBA_URL = "https://cdn.nba.com/headshots/nba/latest/1040x760/{}.png"
WIKI_API = "https://en.wikipedia.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIDTH = 640
DELAY = 0.2  # seconds between Wikipedia requests
HEADERS = {"User-Agent": "StatStack/1.0 (https://github.com/Shaj2x/StatStack; photo lookup)"}

session = requests.Session()
session.headers.update(HEADERS)


def head_signature(url):
    """(status, length, etag) for a HEAD request, following redirects."""
    r = session.head(url, allow_redirects=True, timeout=20)
    return r.status_code, r.headers.get("Content-Length"), r.headers.get("ETag")


def nba_has_photo(player_id, fallback):
    status, length, etag = head_signature(NBA_URL.format(player_id))
    if status != 200:
        return False
    # Same byte size as the stand-in means it is the stand-in (ETags can vary by URL)
    return length != fallback[1] if fallback[0] == 200 else True


def wiki(params, api=WIKI_API):
    r = session.get(api, params={"format": "json", "formatversion": 2, **params}, timeout=30)
    r.raise_for_status()
    time.sleep(DELAY)
    return r.json()


def strip_html(s):
    return unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def team_nicknames():
    """{team code: nickname} from js/teams.js, e.g. ATL -> Hawks."""
    text = (ROOT / "js" / "teams.js").read_text(encoding="utf-8")
    return {code: full.split()[-1] for code, full in re.findall(r'\b([A-Z]{3}): \{name: "([^"]+)"', text)}


NICKNAMES = team_nicknames()


def wikipedia_photo(name, season, team=None):
    """Free lead photo from the player's Wikipedia article, or None.

    When several articles fit (two Eddie Johnsons played in 1984-85), keep
    the one whose opening mentions the player's team; if that still leaves
    more than one, return None rather than guess.
    """
    start = int(season[:4])
    hits = wiki({"action": "query", "list": "search", "srsearch": f'"{name}" basketball', "srlimit": 5})
    titles = [h["title"] for h in hits["query"]["search"]]
    if not titles:
        return None
    pages = wiki({"action": "query", "titles": "|".join(titles), "prop": "pageimages|description",
                  "piprop": "name", "pilicense": "free", "redirects": 1})["query"]["pages"]
    by_title = {p["title"]: p for p in pages}
    candidates = []
    for title in titles:
        page = by_title.get(title)
        if not page or "pageimage" not in page:
            continue
        bare = re.sub(r"\s*\(.*\)$", "", page["title"])
        desc = page.get("description", "").lower()
        if norm(bare) != norm(name) or "basketball" not in desc:
            continue
        # A birth year in the description must fit someone playing in this season
        born = re.search(r"\b(19\d\d)\b", desc)
        if born and not 16 <= start - int(born.group(1)) <= 45:
            continue
        candidates.append(page)

    if len(candidates) > 1 and NICKNAMES.get(team):
        intros = wiki({"action": "query", "titles": "|".join(c["title"] for c in candidates),
                       "prop": "extracts", "exintro": 1, "explaintext": 1})["query"]["pages"]
        mentions = {p["title"] for p in intros if NICKNAMES[team] in p.get("extract", "")}
        candidates = [c for c in candidates if c["title"] in mentions]
    if len(candidates) != 1:
        return None

    for page in candidates:
        info = wiki({"action": "query", "titles": f"File:{page['pageimage']}", "prop": "imageinfo",
                     "iiprop": "url|extmetadata", "iiurlwidth": WIDTH}, api=COMMONS_API)["query"]["pages"][0]
        if "imageinfo" not in info:
            continue
        ii = info["imageinfo"][0]
        meta = ii.get("extmetadata", {})
        licence = strip_html(meta.get("LicenseShortName", {}).get("value"))
        author = strip_html(meta.get("Artist", {}).get("value")) or "Unknown author"
        if not licence:
            continue
        return {
            "src": ii.get("thumburl") or ii["url"],
            "credit": f"Photo: {author[:80]}, {licence}",
            "link": ii.get("descriptionurl", ""),
        }
    return None


def main():
    players = {}
    for season, name, team, ppg, rpg, pid in live_players(with_team=True):
        if float(ppg) == 0 and float(rpg) == 0:
            continue
        key = pid or f"name:{name}"
        players.setdefault(key, (season, name, pid, team))

    print("Finding NBA.com's stand-in silhouette…")
    fallback = head_signature(NBA_URL.format(1))  # an ID with no player
    missing = []
    for i, (key, (season, name, pid, team)) in enumerate(players.items(), 1):
        if pid is None or not nba_has_photo(pid, fallback):
            missing.append((key, season, name, team))
        if i % 200 == 0:
            print(f"  checked {i}/{len(players)}")
    print(f"{len(missing)} of {len(players)} players have no NBA.com headshot")

    photos = {}
    for key, season, name, team in missing:
        try:
            photo = wikipedia_photo(name, season, team)
        except requests.RequestException as exc:
            print(f"  {name}: lookup failed ({exc.__class__.__name__})")
            photo = None
        photos[key] = photo  # None means: show the game's silhouette
        print(f"  {name} ({season}): {'found' if photo else 'no confirmed photo'}")

    found = sum(1 for p in photos.values() if p)
    body = ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in sorted(photos.items()))
    OUT.write_text(
        "// Generated by scripts/fetch_photos.py — do not edit by hand.\n"
        "// Players NBA.com has no headshot for. A Wikimedia photo (with its credit)\n"
        "// replaces NBA.com's stand-in silhouette; null means use the game's own.\n"
        f"const PHOTOS = {{\n{body}\n}};\n",
        encoding="utf-8",
    )
    print(f"Wrote {OUT.relative_to(ROOT)}: {found} photos found, {len(photos) - found} left as silhouettes")


if __name__ == "__main__":
    main()
