# Madushan's Rating List

Ratings of my chess engines at two time controls, on a **CCRL-equivalent** scale:

| List | Time control | Calibrated to |
|------|--------------|---------------|
| Blitz | 2 min + 1 s | CCRL Blitz |
| Classical | 12 min + 8 s | CCRL 40/15 |

Each list shows the rating, its 95% error bar and confidence range, score, average opponent, draw rate,
likelihood of superiority (LOS), a head-to-head crosstable, a full LOS matrix, game statistics
(results, how games ended, game length), CCRL calibration diagnostics, a page for each engine, and a
Blitz vs Classical comparison.

## How it works

```
pgn/blitz/*.pgn        ─┐
pgn/classical/*.pgn    ─┼─►  tools/rate.py  ─►  site/data/*.json  ─►  site/ (static website)
config/*.json          ─┘
```

Every push to `main` runs `.github/workflows/publish.yml`. It recomputes all ratings from the PGN files
and deploys `site/` to GitHub Pages. You never have to commit generated files.

## One-time setup on GitHub

1. Create a new repository on GitHub (for example `rating-list`).
2. Edit `config/site.json` and set `repo_url` to your repository URL.
3. Push this folder:
   ```bash
   git add -A
   git commit -m "Initial rating list"
   git remote add origin https://github.com/YOUR-USERNAME/rating-list.git
   git push -u origin main
   ```
4. On GitHub go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
5. Open the **Actions** tab and wait for "Rate & publish" to finish. The site will be at
   `https://YOUR-USERNAME.github.io/rating-list/`.

## Publishing new games

1. Run your matches (cutechess-cli, fastchess, etc.) and save the PGN.
2. Copy it into `pgn/blitz/` or `pgn/classical/`. Any number of files and subfolders is fine.
   `.pgn`, `.pgn.gz`, `.pgn.bz2`, `.pgn.xz` and `.zip` are all read. Compress big files, because GitHub rejects
   files over 100 MB.
3. Commit and push. The site updates in a minute or two.

Unfinished games (`*`) are ignored. The white advantage is fitted together with the ratings, so you
don't have to balance colours perfectly (you still should, by playing each opening with both colours).

## Making ratings CCRL-equivalent (anchors)

Ratings are only relative until you tie them to a known scale. You do that with **anchors**: reference
engines that also play in your gauntlets and that have a known rating on the matching CCRL list.

1. Choose 3–6 well-known engines whose CCRL ratings sit around your engines' strength, a bit above
   and a bit below. Look up their current rating on the **CCRL Blitz** list for Blitz and on the
   **CCRL 40/15** list for Classical. Use the exact same version and settings CCRL lists (threads, NNUE net, etc.).
2. Make sure your engines play them, and that the anchors also play each other.
3. Add them to `config/lists.json`, using each engine's name exactly as it appears in your PGN:
   ```json
   "anchors": {
     "SomeEngine 3.0": 3105,
     "OtherEngine 15": 3240,
     "ThirdEngine 1.2": 2990
   }
   ```

Two anchor modes are available (`anchor_mode`):

- **`offset`** (default, recommended with several anchors). All ratings are fitted from your games, then the
  whole list is shifted so the anchors' average equals their average CCRL rating. The spacing between
  engines comes purely from your games. The *Statistics → Calibration* table shows how far each anchor
  lands from its CCRL rating, which is a good health check of your setup.
- **`fixed`**. Every anchor is pinned to its CCRL rating, as in Ordo with multiple anchors.

With no anchors the pool average is set to `pool_average` (default 3000).

> **Note on time controls.** CCRL plays on its own reference hardware with hardware-adjusted time
> controls. For closest agreement, use similar per-engine resources (1 thread, comparable hash, a balanced
> book, tablebase adjudication) and describe your hardware in `config/lists.json`. The Classical list
> (12+8) is calibrated to CCRL 40/15. Anchoring makes the scales line up, but rating gaps can differ
> slightly because engines scale differently with time.

## Your engines and other metadata

`config/engines.json` is optional:

```json
{
  "engines": {
    "MyEngine 2.0": {
      "own": true,
      "author": "Madushan",
      "country": "LK",
      "url": "https://github.com/YOUR-USERNAME/MyEngine",
      "aliases": ["MyEngine-2.0-avx2"],
      "notes": "NNUE, trained on self-play data"
    }
  },
  "exclude": ["BrokenEngine 0.1"]
}
```

- `own: true` highlights the engine and enables the **My engines only** filter.
- `aliases` merges different PGN names into one engine.
- `family` (optional) groups versions for **Best version only**. By default the family is the name
  before the version number, so "MyEngine 2.0" belongs to "MyEngine".

## List settings (`config/lists.json`)

| Key | Meaning |
|-----|---------|
| `id`, `name` | URL id and display name |
| `time_control`, `time_control_long` | shown in the header |
| `ccrl_equivalent` | which CCRL list the scale matches |
| `pgn_dir` | folder under `pgn/` |
| `hardware`, `settings` | shown on the About page |
| `anchors`, `anchor_mode`, `pool_average` | calibration (see above) |
| `white_advantage` | fit a white-move advantage (default `true`) |
| `virtual_draws` | small prior, about 1 virtual draw per engine. It keeps 100% / 0% scores finite and is negligible after a few dozen games |
| `provisional_games` | engines with fewer games are marked provisional |
| `los_matrix_max` | largest pool for which the LOS matrix is stored (default 200) |

To add another list (for example Rapid), add an entry and a matching `pgn/<dir>/` folder.

## Preview locally

```bash
python tools/rate.py
```

```bash
python -m http.server 8000 --directory site
```

Then open <http://localhost:8000>. To see the site with fictional demo data before you have real games:

```bash
python tools/make_demo.py
```

```bash
python tools/rate.py --config-dir demo/config --pgn-root demo/pgn
```

The demo is written to `demo/`, which is git-ignored, and GitHub always rebuilds from your real `pgn/` folder.

## Methodology

- **Model.** Logistic Elo: expected score = 1 / (1 + 10^(−(R_white − R_black + W) / 400)), where W is the
  white advantage. Draws count as half a point. Ratings and W are found by maximum likelihood (Newton's
  method), the same model Ordo uses for CCRL.
- **Error bars.** The covariance of all ratings is estimated with a draw-aware sandwich estimator.
  A draw carries less information than a decisive game, so a high draw rate is accounted for correctly.
  The `±` column is the 95% half-width (1.96 σ). In simulation tests the reported errors match the
  spread you get from replaying the same tournament many times.
- **LOS.** Φ((R_a − R_b) / σ_(a−b)), using the full covariance, so shared opponents are taken into account.
- **Connectivity.** Only engines connected to the anchors through games can be rated. Others are listed
  as "not rated" on the Statistics page.
