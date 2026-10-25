#!/usr/bin/env python3
"""
Madushan's Rating List - rating calculator.

Reads PGN files for every rating list defined in config/lists.json, computes
maximum-likelihood Elo ratings (the same logistic model Ordo uses for CCRL),
anchors them to the CCRL scale and writes JSON files for the website.

    python tools/rate.py                      # rate everything -> site/data/
    python tools/rate.py --list blitz         # only one list
    python tools/rate.py --pgn-root demo/pgn --config-dir demo/config

Only the Python standard library is required. If numpy is installed it is
used to speed up the matrix algebra for very large engine pools.
"""

from __future__ import annotations

import argparse
import bz2
import datetime as dt
import gzip
import io
import json
import lzma
import math
import os
import re
import sys
import zipfile
from collections import defaultdict

try:  # optional acceleration
    import numpy as _np
except Exception:  # pragma: no cover
    _np = None

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
K = math.log(10) / 400.0  # d(logistic)/d(Elo) scale
Z95 = 1.959963984540054


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def strip_comments(obj):
    """Drop keys starting with '_' (used for comments inside JSON configs)."""
    if isinstance(obj, dict):
        return {k: strip_comments(v) for k, v in obj.items() if not str(k).startswith("_")}
    if isinstance(obj, list):
        return [strip_comments(v) for v in obj]
    return obj


# --------------------------------------------------------------------------
# PGN reading
# --------------------------------------------------------------------------

PGN_EXT = (".pgn", ".pgn.gz", ".pgn.bz2", ".pgn.xz", ".zip")
HEADER_RE = re.compile(r'^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$')
BRACE_RE = re.compile(r"\{([^}]*)\}")
LINE_COMMENT_RE = re.compile(r";[^\n]*")
VARIATION_RE = re.compile(r"\([^()]*\)")
NAG_RE = re.compile(r"\$\d+")
MOVENO_RE = re.compile(r"\d+\.+")
RESULT_TOKENS = {"1-0", "0-1", "1/2-1/2", "*"}


def iter_pgn_files(directory):
    if not os.path.isdir(directory):
        return
    for root, _dirs, files in sorted(os.walk(directory)):
        for name in sorted(files):
            if name.lower().endswith(PGN_EXT):
                yield os.path.join(root, name)


def open_pgn_streams(path):
    low = path.lower()
    kw = dict(encoding="utf-8", errors="replace")
    if low.endswith(".gz"):
        yield gzip.open(path, "rt", **kw)
    elif low.endswith(".bz2"):
        yield bz2.open(path, "rt", **kw)
    elif low.endswith(".xz"):
        yield lzma.open(path, "rt", **kw)
    elif low.endswith(".zip"):
        with zipfile.ZipFile(path) as zf:
            for member in zf.namelist():
                if member.lower().endswith(".pgn"):
                    yield io.TextIOWrapper(zf.open(member), **kw)
    else:
        yield open(path, "r", encoding="utf-8-sig", errors="replace")


def iter_games(stream):
    """Yield (headers, movetext) for every game in a PGN text stream."""
    headers, moves, in_moves = {}, [], False
    for line in stream:
        s = line.strip()
        if s.startswith("["):
            m = HEADER_RE.match(s)
            if m:
                if in_moves:
                    yield headers, "".join(moves)
                    headers, moves, in_moves = {}, [], False
                headers[m.group(1)] = m.group(2).replace('\\"', '"').replace("\\\\", "\\")
                continue
        if s and headers:
            in_moves = True
            moves.append(line)
    if headers:
        yield headers, "".join(moves)


def analyse_movetext(text):
    """Return (plies, last_comment) for a movetext section."""
    comments = BRACE_RE.findall(text)
    last_comment = comments[-1] if comments else ""
    t = BRACE_RE.sub(" ", text)
    t = LINE_COMMENT_RE.sub(" ", t)
    while "(" in t:
        nt = VARIATION_RE.sub(" ", t)
        if nt == t:
            break
        t = nt
    t = NAG_RE.sub(" ", t)
    t = MOVENO_RE.sub(" ", t)
    plies = sum(1 for tok in t.split() if tok not in RESULT_TOKENS)
    return plies, last_comment


def classify_termination(headers, last_comment):
    text = (last_comment + " " + headers.get("Termination", "")).lower()
    if "illegal" in text:
        return "Illegal move"
    if "on time" in text or "time forfeit" in text or "timeout" in text or "time-forfeit" in text:
        return "Time forfeit"
    if "stall" in text or "disconnect" in text or "crash" in text or "abandon" in text:
        return "Crash / disconnect"
    if "stalemate" in text:
        return "Stalemate"
    if "insufficient" in text:
        return "Insufficient material"
    if "mate" in text:
        return "Checkmate"
    if "repetition" in text:
        return "Repetition"
    if "fifty" in text or "50-move" in text or "50 move" in text:
        return "50-move rule"
    if "adjudicat" in text or "tablebase" in text or "syzygy" in text:
        return "Adjudication"
    if "resign" in text:
        return "Resignation"
    return "Other"


def parse_date(value):
    m = re.match(r"(\d{4})[.\-/](\d{2})[.\-/](\d{2})", value or "")
    if not m or "?" in value[:10]:
        return None
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"


def collect_games(pgn_dir, aliases, exclude):
    games = []
    info = {"files": 0, "unfinished": 0, "excluded": 0}
    for path in iter_pgn_files(pgn_dir):
        info["files"] += 1
        for stream in open_pgn_streams(path):
            with stream:
                for headers, movetext in iter_games(stream):
                    res = headers.get("Result", "*").strip()
                    if res not in ("1-0", "0-1", "1/2-1/2"):
                        info["unfinished"] += 1
                        continue
                    w = headers.get("White", "?").strip()
                    b = headers.get("Black", "?").strip()
                    w, b = aliases.get(w, w), aliases.get(b, b)
                    if w in exclude or b in exclude or w == b:
                        info["excluded"] += 1
                        continue
                    score = 1.0 if res == "1-0" else 0.0 if res == "0-1" else 0.5
                    plies, last_comment = analyse_movetext(movetext)
                    if headers.get("PlyCount", "").isdigit():
                        plies = int(headers["PlyCount"])
                    term = classify_termination(headers, last_comment)
                    date = parse_date(headers.get("Date", "")) or parse_date(headers.get("UTCDate", ""))
                    games.append((w, b, score, plies, term, date))
    return games, info


# --------------------------------------------------------------------------
# Linear algebra (pure Python with optional numpy)
# --------------------------------------------------------------------------

def cholesky(A):
    n = len(A)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        Li = L[i]
        for j in range(i + 1):
            Lj = L[j]
            s = A[i][j] - sum(Li[k] * Lj[k] for k in range(j))
            if i == j:
                if s <= 0:
                    raise ArithmeticError("matrix not positive definite")
                Li[i] = math.sqrt(s)
            else:
                Li[j] = s / Lj[j]
    return L


def chol_solve(L, b):
    n = len(L)
    y = [0.0] * n
    for i in range(n):
        y[i] = (b[i] - sum(L[i][k] * y[k] for k in range(i))) / L[i][i]
    x = [0.0] * n
    for i in reversed(range(n)):
        x[i] = (y[i] - sum(L[k][i] * x[k] for k in range(i + 1, n))) / L[i][i]
    return x


def spd_solve(A, b):
    if _np is not None:
        return list(_np.linalg.solve(_np.array(A), _np.array(b)))
    return chol_solve(cholesky(A), b)


def sandwich(H, J):
    """Return H^-1 J H^-1 for symmetric positive definite H."""
    n = len(H)
    if n == 0:
        return []
    if _np is not None:
        Hi = _np.linalg.inv(_np.array(H))
        return (Hi @ _np.array(J) @ Hi).tolist()
    L = cholesky(H)
    cols = [chol_solve(L, [1.0 if i == j else 0.0 for i in range(n)]) for j in range(n)]
    Hi = [[cols[j][i] for j in range(n)] for i in range(n)]
    HJ = [[sum(Hi[i][k] * J[k][j] for k in range(n)) for j in range(n)] for i in range(n)]
    return [[sum(HJ[i][k] * Hi[k][j] for k in range(n)) for j in range(n)] for i in range(n)]


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def expected(d):
    if d > 4000:
        return 1.0
    if d < -4000:
        return 0.0
    return 1.0 / (1.0 + 10.0 ** (-d / 400.0))


# --------------------------------------------------------------------------
# Rating model
# --------------------------------------------------------------------------

def components(players, edges):
    adj = defaultdict(set)
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    seen, comps = set(), []
    for p in players:
        if p in seen:
            continue
        stack, comp = [p], []
        seen.add(p)
        while stack:
            x = stack.pop()
            comp.append(x)
            for y in adj[x]:
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        comps.append(comp)
    return comps


def fit_ratings(n_players, groups, cfg, anchor_idx):
    """
    Maximum-likelihood Elo fit.

    groups: list of (white_idx, black_idx, W, D, L) from white's point of view.
    anchor_idx: {player_idx: ccrl_rating}
    Returns (ratings, cov, white_adv, white_adv_sigma, mode_used).
    """
    vd = float(cfg.get("virtual_draws", 1.0))
    use_white = bool(cfg.get("white_advantage", True))
    mode = cfg.get("anchor_mode", "offset")
    if not anchor_idx:
        mode = "average"

    # games per player and per unordered pair (for virtual draws & draw rates)
    n_player = [0] * n_players
    pair_n, pair_d = defaultdict(int), defaultdict(int)
    tot_n = tot_d = 0
    for a, b, W, D, L in groups:
        n = W + D + L
        n_player[a] += n
        n_player[b] += n
        key = (min(a, b), max(a, b))
        pair_n[key] += n
        pair_d[key] += D
        tot_n += n
        tot_d += D
    global_draw = tot_d / tot_n if tot_n else 0.0

    fit_groups = []
    for a, b, W, D, L in groups:
        n = W + D + L
        v = vd * n * 0.5 * (1.0 / n_player[a] + 1.0 / n_player[b])
        key = (min(a, b), max(a, b))
        draw = (pair_d[key] + 10 * global_draw) / (pair_n[key] + 10)
        fit_groups.append((a, b, n + v, W + 0.5 * D + 0.5 * v, n, draw))

    # parameterisation
    r = [0.0] * n_players
    if mode == "fixed":
        fixed = set(anchor_idx)
        for i, val in anchor_idx.items():
            r[i] = float(val)
        start = sum(anchor_idx.values()) / len(anchor_idx)
        for i in range(n_players):
            if i not in fixed:
                r[i] = start
        mean_set = None
    else:
        mean_set = sorted(anchor_idx) if mode == "offset" else list(range(n_players))
        fixed = {mean_set[0]}  # reference player, shifted afterwards
    free = [i for i in range(n_players) if i not in fixed]
    pos = {p: k for k, p in enumerate(free)}
    pw = len(free) if use_white else None
    P = len(free) + (1 if use_white else 0)
    w = 0.0

    def build(info=False):
        g = [0.0] * P
        H = [[0.0] * P for _ in range(P)]
        J = [[0.0] * P for _ in range(P)] if info else None
        for a, b, n, s, n_real, draw in fit_groups:
            E = expected(r[a] - r[b] + w)
            grad = K * (s - n * E)
            h = K * K * n * E * (1.0 - E)
            entries = []
            if a in pos:
                entries.append((pos[a], 1.0))
            if b in pos:
                entries.append((pos[b], -1.0))
            if pw is not None:
                entries.append((pw, 1.0))
            if info:
                dr = min(draw, 2.0 * min(E, 1.0 - E))
                var = K * K * n_real * max(E * (1.0 - E) - dr / 4.0, 0.02 * E * (1.0 - E))
            for p, c in entries:
                g[p] += c * grad
                for q, c2 in entries:
                    H[p][q] += c * c2 * h
                    if info:
                        J[p][q] += c * c2 * var
        return g, H, J

    for _ in range(200):
        if P == 0:
            break
        g, H, _J = build()
        for i in range(P):
            H[i][i] += 1e-9
        step = spd_solve(H, g)
        big = max(abs(x) for x in step)
        if big > 300:
            step = [x * 300 / big for x in step]
        for p, k in pos.items():
            r[p] += step[k]
        if pw is not None:
            w += step[pw]
        if big < 1e-6:
            break

    _g, H, J = build(info=True)
    for i in range(P):
        H[i][i] += 1e-9
    cf = sandwich(H, J) if P else []

    # full covariance over players (+ white advantage in the last slot)
    C = [[0.0] * (n_players + 1) for _ in range(n_players + 1)]
    idx = {p: k for p, k in pos.items()}
    if pw is not None:
        idx[n_players] = pw
    for i, ki in idx.items():
        for j, kj in idx.items():
            C[i][j] = cf[ki][kj]

    if mean_set is not None:
        target = (sum(anchor_idx[i] for i in mean_set) / len(mean_set)
                  if mode == "offset" else float(cfg.get("pool_average", 3000)))
        shift = target - sum(r[i] for i in mean_set) / len(mean_set)
        r = [x + shift for x in r]
        a = [0.0] * (n_players + 1)
        for i in mean_set:
            a[i] = 1.0 / len(mean_set)
        u = [sum(C[i][k] * a[k] for k in mean_set) for i in range(n_players + 1)]
        s = sum(a[k] * u[k] for k in mean_set)
        N1 = n_players + 1
        C2 = [[0.0] * N1 for _ in range(N1)]
        for i in range(N1):
            for j in range(N1):
                pi, pj = i < n_players, j < n_players
                C2[i][j] = C[i][j] - (u[j] if pi else 0) - (u[i] if pj else 0) + (s if pi and pj else 0)
        C = C2

    wsig = math.sqrt(max(C[n_players][n_players], 0.0)) if use_white else 0.0
    return r, [row[:n_players] for row in C[:n_players]], (w if use_white else 0.0), wsig, mode


# --------------------------------------------------------------------------
# Engine metadata helpers
# --------------------------------------------------------------------------

FAMILY_RE = re.compile(r"[\s_\-]+v?\d")


def family_of(name, meta):
    if meta.get("family"):
        return meta["family"]
    m = FAMILY_RE.search(name)
    return name[: m.start()].strip() if m else name


def r1(x):
    return round(x, 1)


# --------------------------------------------------------------------------
# One rating list
# --------------------------------------------------------------------------

def rate_list(lcfg, pgn_root, engines_cfg):
    meta_all = engines_cfg.get("engines", {})
    aliases = {}
    for name, meta in meta_all.items():
        for al in meta.get("aliases", []):
            aliases[al] = name
    exclude = set(engines_cfg.get("exclude", []))

    pgn_dir = os.path.join(pgn_root, lcfg.get("pgn_dir", lcfg["id"]))
    games, info = collect_games(pgn_dir, aliases, exclude)
    anchors_cfg = {aliases.get(k, k): float(v) for k, v in lcfg.get("anchors", {}).items()}

    out = {
        "id": lcfg["id"],
        "name": lcfg.get("name", lcfg["id"]),
        "time_control": lcfg.get("time_control", ""),
        "time_control_long": lcfg.get("time_control_long", ""),
        "ccrl_equivalent": lcfg.get("ccrl_equivalent", ""),
        "description": lcfg.get("description", ""),
        "hardware": lcfg.get("hardware", ""),
        "settings": lcfg.get("settings", ""),
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "provisional_games": int(lcfg.get("provisional_games", 100)),
    }

    players_all = sorted({g[0] for g in games} | {g[1] for g in games})
    comps = components(players_all, [(g[0], g[1]) for g in games])
    anchored = [c for c in comps if any(p in anchors_cfg for p in c)]
    main = max(anchored or comps, key=len) if comps else []
    main_set = set(main)
    excluded_engines = sorted(p for p in players_all if p not in main_set)
    games_main = [g for g in games if g[0] in main_set]

    players = sorted(main)
    index = {p: i for i, p in enumerate(players)}
    anchor_idx = {index[p]: v for p, v in anchors_cfg.items() if p in index}
    missing_anchors = sorted(p for p in anchors_cfg if p not in index)

    grp = defaultdict(lambda: [0, 0, 0])
    for w, b, s, *_ in games_main:
        k = (index[w], index[b])
        grp[k][0 if s == 1.0 else 1 if s == 0.5 else 2] += 1
    groups = [(a, b, v[0], v[1], v[2]) for (a, b), v in grp.items()]

    if players:
        ratings, cov, wadv, wsig, mode = fit_ratings(len(players), groups, lcfg, anchor_idx)
    else:
        ratings, cov, wadv, wsig, mode = [], [], 0.0, 0.0, "average"

    # ---- per-engine statistics ----
    N = len(players)
    st = [dict(games=0, wins=0, draws=0, losses=0, points=0.0, wg=0, wp=0.0, bg=0, bp=0.0,
               opp_sum=0.0, plies=0, first=None, last=None) for _ in range(N)]
    h2h = defaultdict(lambda: [0, 0, 0])  # (i, j) i<j : from i's view W D L
    for w, b, s, plies, term, date in games_main:
        i, j = index[w], index[b]
        for p, opp, sc, white in ((i, j, s, True), (j, i, 1.0 - s, False)):
            e = st[p]
            e["games"] += 1
            e["points"] += sc
            e["wins" if sc == 1.0 else "draws" if sc == 0.5 else "losses"] += 1
            if white:
                e["wg"] += 1
                e["wp"] += sc
            else:
                e["bg"] += 1
                e["bp"] += sc
            e["opp_sum"] += ratings[opp]
            e["plies"] += plies
            if date:
                e["first"] = date if not e["first"] or date < e["first"] else e["first"]
                e["last"] = date if not e["last"] or date > e["last"] else e["last"]
        a, bb = (i, j) if i < j else (j, i)
        sa = s if a == i else 1.0 - s
        h2h[(a, bb)][0 if sa == 1.0 else 1 if sa == 0.5 else 2] += 1

    order = sorted(range(N), key=lambda i: -ratings[i])
    rank_of = {p: k for k, p in enumerate(order)}
    sig = [math.sqrt(max(cov[i][i], 0.0)) for i in range(N)]

    def los(i, j):
        var = cov[i][i] + cov[j][j] - 2 * cov[i][j]
        if var <= 1e-12:
            return 1.0 if ratings[i] > ratings[j] else 0.0 if ratings[i] < ratings[j] else 0.5
        return norm_cdf((ratings[i] - ratings[j]) / math.sqrt(var))

    engines = []
    for k, i in enumerate(order):
        e = st[i]
        name = players[i]
        meta = meta_all.get(name, {})
        n = e["games"]
        engines.append({
            "rank": k + 1,
            "name": name,
            "family": family_of(name, meta),
            "rating": r1(ratings[i]),
            "sigma": r1(sig[i]),
            "error": r1(Z95 * sig[i]),
            "low": r1(ratings[i] - Z95 * sig[i]),
            "high": r1(ratings[i] + Z95 * sig[i]),
            "games": n,
            "wins": e["wins"], "draws": e["draws"], "losses": e["losses"],
            "score": round(100 * e["points"] / n, 1) if n else 0,
            "draw_rate": round(100 * e["draws"] / n, 1) if n else 0,
            "white_games": e["wg"], "white_score": round(100 * e["wp"] / e["wg"], 1) if e["wg"] else None,
            "black_games": e["bg"], "black_score": round(100 * e["bp"] / e["bg"], 1) if e["bg"] else None,
            "avg_opp": r1(e["opp_sum"] / n) if n else None,
            "avg_plies": r1(e["plies"] / n) if n else None,
            "los_next": round(100 * los(i, order[k + 1]), 1) if k + 1 < N else None,
            "provisional": n < out["provisional_games"],
            "anchor": name in anchors_cfg,
            "ccrl": anchors_cfg.get(name),
            "own": bool(meta.get("own", False)),
            "author": meta.get("author", ""),
            "country": meta.get("country", ""),
            "url": meta.get("url", ""),
            "notes": meta.get("notes", ""),
            "first_date": e["first"], "last_date": e["last"],
        })
    out["engines"] = engines
    out["pairs"] = [[rank_of[a], rank_of[b], *v] if rank_of[a] < rank_of[b]
                    else [rank_of[b], rank_of[a], v[2], v[1], v[0]]
                    for (a, b), v in sorted(h2h.items())]
    out["los"] = [[int(round(100 * los(i, j))) if i != j else None for j in order] for i in order] \
        if N <= int(lcfg.get("los_matrix_max", 200)) else None

    # ---- list-wide statistics ----
    total = len(games_main)
    ww = sum(1 for g in games_main if g[2] == 1.0)
    dd = sum(1 for g in games_main if g[2] == 0.5)
    plies = sorted(g[3] for g in games_main)
    terms = defaultdict(int)
    for g in games_main:
        terms[g[4]] += 1
    bins = defaultdict(int)
    for p in plies:
        bins[min((p + 1) // 2 // 10, 15)] += 1
    dates = [g[5] for g in games_main if g[5]]
    out["stats"] = {
        "games": total,
        "engines": N,
        "white_wins": ww,
        "draws": dd,
        "black_wins": total - ww - dd,
        "white_score": round(100 * (ww + 0.5 * dd) / total, 1) if total else None,
        "draw_rate": round(100 * dd / total, 1) if total else None,
        "white_advantage": r1(wadv),
        "white_advantage_error": r1(Z95 * wsig),
        "avg_moves": r1(sum(plies) / total / 2) if total else None,
        "median_moves": r1(plies[total // 2] / 2) if total else None,
        "length_histogram": [{"from": b * 10, "to": None if b == 15 else b * 10 + 9, "count": bins.get(b, 0)}
                             for b in range(16)],
        "terminations": dict(sorted(terms.items(), key=lambda kv: -kv[1])),
        "first_date": min(dates) if dates else None,
        "last_date": max(dates) if dates else None,
        "pgn_files": info["files"],
        "unfinished_games": info["unfinished"],
        "excluded_games": info["excluded"] + (len(games) - total),
        "disconnected_engines": excluded_engines,
    }
    out["downloads"] = [{"path": os.path.relpath(f, pgn_root).replace(os.sep, "/"), "bytes": os.path.getsize(f)}
                        for f in iter_pgn_files(pgn_dir)]
    out["calibration"] = {
        "mode": mode,
        "pool_average": float(lcfg.get("pool_average", 3000)) if mode == "average" else None,
        "anchors": [{"name": p, "ccrl": v, "rating": r1(ratings[index[p]]),
                     "error": r1(Z95 * sig[index[p]]), "games": st[index[p]]["games"]}
                    for p, v in sorted(anchors_cfg.items(), key=lambda kv: -kv[1]) if p in index],
        "missing_anchors": missing_anchors,
    }
    return out


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def print_table(data):
    print(f"\n== {data['name']} ({data['time_control']}) - {data['stats']['games']} games, "
          f"{data['stats']['engines']} engines, anchor mode: {data['calibration']['mode']}")
    for w in data["calibration"]["missing_anchors"]:
        print(f"   ! anchor '{w}' has no games in this list")
    for w in data["stats"]["disconnected_engines"]:
        print(f"   ! '{w}' is not connected to the main pool and was not rated")
    if not data["engines"]:
        print("   (no games yet)")
        return
    print(f"   {'#':>3}  {'Engine':<32} {'Elo':>7} {'+/-95':>6} {'Games':>6} {'Score':>6} {'LOS':>6}")
    for e in data["engines"]:
        flag = "*" if e["anchor"] else ("?" if e["provisional"] else " ")
        los = f"{e['los_next']:.0f}%" if e["los_next"] is not None else ""
        print(f"   {e['rank']:>3}{flag} {e['name'][:32]:<32} {e['rating']:>7.0f} {e['error']:>6.0f} "
              f"{e['games']:>6} {e['score']:>5.1f}% {los:>6}")
    print("   (* anchor, ? provisional)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config-dir", default=os.path.join(REPO, "config"))
    ap.add_argument("--pgn-root", default=os.path.join(REPO, "pgn"))
    ap.add_argument("--out", default=os.path.join(REPO, "site", "data"))
    ap.add_argument("--list", action="append", help="only rate this list id (repeatable)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    site = strip_comments(load_json(os.path.join(args.config_dir, "site.json"), {}))
    lists = strip_comments(load_json(os.path.join(args.config_dir, "lists.json"), {"lists": []}))["lists"]
    engines_cfg = strip_comments(load_json(os.path.join(args.config_dir, "engines.json"), {}))
    os.makedirs(args.out, exist_ok=True)

    summary = []
    for lcfg in lists:
        path = os.path.join(args.out, f"{lcfg['id']}.json")
        if args.list and lcfg["id"] not in args.list:
            if os.path.exists(path):
                summary.append(json.load(open(path, encoding="utf-8")))
            continue
        data = rate_list(lcfg, args.pgn_root, engines_cfg)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        if not args.quiet:
            print_table(data)
        summary.append(data)

    index = {
        "site": site,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "lists": [{"id": d["id"], "name": d["name"], "time_control": d["time_control"],
                   "ccrl_equivalent": d["ccrl_equivalent"], "games": d["stats"]["games"],
                   "engines": d["stats"]["engines"]} for d in summary],
    }
    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    if not args.quiet:
        print(f"\nWrote {len(summary)} list(s) to {os.path.relpath(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
