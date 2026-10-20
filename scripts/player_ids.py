"""Match player names to official NBA player IDs (the IDs headshots are keyed by).

Uses nba_api's bundled player list, which works offline. Names that belong
to more than one NBA player are resolved by the years each one played, when
those are available, and otherwise must be listed in PICK.
"""

import collections
import unicodedata

from nba_api.stats.static import players as static_players

# Names that differ between sources, mapped to the name in NBA's list
ALIASES = {
    "fat lever": "lafayette lever",
    "world b free": "world free",
    "chris jackson": "mahmoud abdul rauf",
    "clarence weatherspoon": "clar weatherspoon",
    "michael ray richardson": "micheal ray richardson",
    "dave greenwood": "david greenwood",
    "cliff robinson": "cliff t robinson",  # the 1990s Portland one is listed as Clifford
    "steve smith": "steven smith",
}

# Names shared by several NBA players, resolved to the one who played in the
# seasons StatStack has hand-entered data for (the 1980s and early 90s)
PICK = {
    "patrick ewing": 121, "gary payton": 56, "larry johnson": 913, "glen rice": 779,
    "ron harper": 166, "reggie williams": 199, "dee brown": 244, "charles smith": 293,
    "bobby jones": 77193, "mike dunleavy": 76616, "steven smith": 120, "eddie johnson": 698,
}

# Same-name players who played at the same time, told apart by team
TEAM_PICK = {
    ("eddie johnson", "ATL"): 77144,  # the Hawks guard; Eddie A. Johnson (698) was the scorer
}


def norm(name):
    """Lower-case ASCII name without punctuation or suffixes like Jr. and III."""
    # Letters with no accent-free decomposition (Aşık, Łukasz, Ørsted) map by hand
    s = name.translate(str.maketrans({"ı": "i", "İ": "I", "ł": "l", "Ł": "L", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D", "ß": "ss"}))
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    for ch in ".'-,":
        s = s.replace(ch, " " if ch == "-" else "")
    words = [w for w in s.split() if w not in ("jr", "sr", "ii", "iii", "iv")]
    key = " ".join(words)
    return ALIASES.get(key, key)


_by_id = {p["id"]: p for p in static_players.get_players()}
_by_name = collections.defaultdict(list)
for _p in _by_id.values():
    _by_name[norm(_p["full_name"])].append(_p["id"])


def name_for_id(player_id):
    p = _by_id.get(int(player_id))
    return p["full_name"] if p else None


def matches(name, player_id):
    """True when player_id belongs to a player called `name`."""
    official = name_for_id(player_id)
    return official is not None and norm(official) == norm(name)


def resolve(name, season_start=None, careers=None, team=None):
    """Return the NBA player ID for `name`, or None if it can't be told apart.

    careers: optional {normalized name: [(id, from_year, to_year), ...]} from
    stats.nba.com, used to pick the player who was active in season_start.
    """
    key = norm(name)
    if (key, team) in TEAM_PICK:
        return TEAM_PICK[(key, team)]
    if careers and season_start is not None:
        active = [pid for pid, start, end in careers.get(key, []) if start <= season_start <= end]
        if len(active) == 1:
            return active[0]
    ids = _by_name.get(key, [])
    if len(ids) == 1:
        return ids[0]
    return PICK.get(key)
