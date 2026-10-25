#!/usr/bin/env python3
"""
Generate a synthetic demo pool so you can preview the website before you
have real games. Everything is written under demo/ (never into pgn/):

    python tools/make_demo.py
    python tools/rate.py --config-dir demo/config --pgn-root demo/pgn

All engine names and ratings here are fictional.
"""

import json
import math
import os
import random
import shutil

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEMO = os.path.join(REPO, "demo")

# name -> (blitz strength, classical strength); None = does not play that list
ENGINES = {
    "Aurora 7.2": (3420, 3450),
    "Basilisk 15": (3330, 3365),
    "Cobalt 4.1": (3260, 3270),
    "Dynamo 2.8": (3190, 3215),
    "Eclipse 11": (3120, 3110),
    "Falcon 3.0": (3040, 3060),
    "Granite 1.9": (2960, 2950),
    "Helix 0.9": (2880, None),
    "Madu 1.0": (2990, 3005),
    "Madu 1.1": (3075, 3100),
    "Madu 2.0": (3185, 3230),
    "Madu 2.1-dev": (3215, None),
}
OWN = {"Madu 1.0", "Madu 1.1", "Madu 2.0", "Madu 2.1-dev"}
ANCHORS = {"blitz": ["Aurora 7.2", "Cobalt 4.1", "Falcon 3.0"],
           "classical": ["Aurora 7.2", "Cobalt 4.1", "Falcon 3.0"]}
TERMS_DECISIVE = ["{%s mates}", "{%s wins by adjudication}", "{%s wins by adjudication: SyzygyTB}",
                  "{%s loses on time}"]
TERMS_DRAW = ["{Draw by adjudication}", "{Draw by 3-fold repetition}", "{Draw by fifty moves rule}",
              "{Draw by adjudication: SyzygyTB}", "{Draw by insufficient mating material}", "{Draw by stalemate}"]


def play(rw, rb, draw_base, rng):
    d = rw - rb + 30  # white advantage
    e = 1 / (1 + 10 ** (-d / 400))
    draw = draw_base * math.exp(-abs(d) / 350)
    draw = min(draw, 2 * min(e, 1 - e) * 0.95)
    x = rng.random()
    if x < e - draw / 2:
        return "1-0"
    if x < e + draw / 2:
        return "1/2-1/2"
    return "0-1"


def write_list(list_id, col, draw_base, rounds, start_day, rng):
    names = [n for n, s in ENGINES.items() if s[col] is not None]
    out_dir = os.path.join(DEMO, "pgn", list_id)
    os.makedirs(out_dir, exist_ok=True)
    tc = "120+1" if list_id == "blitz" else "720+8"
    lines = []
    game_no = 0
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            gap = abs(ENGINES[a][col] - ENGINES[b][col])
            pairs = rounds if gap < 300 else rounds // 3
            if a == "Madu 2.1-dev" or b == "Madu 2.1-dev":
                pairs = max(4, pairs // 6)
            for k in range(pairs):
                for white, black in ((a, b), (b, a)):
                    game_no += 1
                    res = play(ENGINES[white][col], ENGINES[black][col], draw_base, rng)
                    plies = max(20, int(rng.gauss(150 if res == "1/2-1/2" else 120, 45)))
                    if res == "1/2-1/2":
                        term = rng.choices(TERMS_DRAW, [40, 25, 15, 12, 5, 3])[0]
                    else:
                        winner = "White" if res == "1-0" else "Black"
                        idx = rng.choices(range(4), [25, 60, 14, 1])[0]
                        term = TERMS_DECISIVE[idx] % (winner if idx < 3 else ("Black" if winner == "White" else "White"))
                    day = start_day + game_no // 400
                    lines.append(
                        f'[Event "Demo {list_id}"]\n[Site "Demo"]\n[Date "2026.{9 + day // 30:02d}.{day % 30 + 1:02d}"]\n'
                        f'[Round "{game_no}"]\n[White "{white}"]\n[Black "{black}"]\n[Result "{res}"]\n'
                        f'[PlyCount "{plies}"]\n[TimeControl "{tc}"]\n\n{term} {res}\n\n')
    with open(os.path.join(out_dir, f"demo_{list_id}.pgn"), "w", encoding="utf-8") as f:
        f.writelines(lines)
    return game_no


def main():
    rng = random.Random(2026)
    if os.path.isdir(DEMO):
        shutil.rmtree(DEMO)
    nb = write_list("blitz", 0, 0.55, 60, 0, rng)
    nc = write_list("classical", 1, 0.68, 30, 3, rng)

    with open(os.path.join(REPO, "config", "lists.json"), encoding="utf-8") as f:
        lists = json.load(f)
    for l in lists["lists"]:
        col = 0 if l["id"] == "blitz" else 1
        l["anchors"] = {n: ENGINES[n][col] for n in ANCHORS[l["id"]]}
        l["hardware"] = "Demo data - fictional engines"
    os.makedirs(os.path.join(DEMO, "config"), exist_ok=True)
    with open(os.path.join(DEMO, "config", "lists.json"), "w", encoding="utf-8") as f:
        json.dump(lists, f, indent=2)
    with open(os.path.join(DEMO, "config", "engines.json"), "w", encoding="utf-8") as f:
        json.dump({"engines": {n: {"own": True, "author": "Madushan", "country": "LK"} for n in OWN}}, f, indent=2)
    shutil.copy(os.path.join(REPO, "config", "site.json"), os.path.join(DEMO, "config", "site.json"))
    print(f"Demo written to demo/  ({nb} blitz games, {nc} classical games)")
    print("Now run:  python tools/rate.py --config-dir demo/config --pgn-root demo/pgn")


if __name__ == "__main__":
    main()
