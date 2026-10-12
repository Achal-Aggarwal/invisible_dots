# The README animation

The six `docs/images/hero-*.gif` are built from this folder, in three layers, each
made from the one before:

| layer | where | what it is |
|---|---|---|
| photos | `photos/` | the pictures the animation shows |
| frames | `html/` | one page per layout that composes the photos; `renderLoop(t)` draws the frame at second `t` |
| GIFs | `docs/images/` | the frames, 12 a second, one palette per loop |

The repository's social preview, `docs/images/social-preview.png`, comes from the
same photos through one more page, `html/social.html`, as a single frame.

```sh
node docs/hero/build.mjs              # all six GIFs and the social preview
node docs/hero/build.mjs wide         # only hero-light.gif and hero-dark.gif
node docs/hero/build.mjs social       # only the social preview
```

The social preview is not read from the tree: after a build it is uploaded by hand,
in the repository's Settings, under Social preview.

It needs the repository's `node_modules` (Playwright comes with `apps/web`), Python
with Pillow, NumPy and SciPy, and `ffmpeg` on `PATH`. The pages use Segoe UI and
Consolas, so the GIFs come out identical only on Windows. The frames land in
`docs/hero/frames/`, which is not tracked.

## The photos

| file | what it is | edit it? |
|---|---|---|
| `photos/characters.png` | the four characters on a white background | yes: this is the one to replace |
| `photos/characters-light.png` | the same, cut out for the light theme, shadows kept | no, `cut_out.py` writes it |
| `photos/characters-dark.png` | the same, cut out for the dark theme, shadows removed | no, `cut_out.py` writes it |
| `photos/trending.png` | the GitHub Trending page in the last scene's third card | yes |

New characters are a new `characters.png`, drawn on plain white, all four in one
row and about the same height. The build cuts them out again on every run.

## The pages

| page | builds | size |
|---|---|---|
| `html/wide.html` | `hero-light.gif`, `hero-dark.gif` | 1280 x 470 |
| `html/mobile.html` | `hero-mobile-light.gif`, `hero-mobile-dark.gif` | 720 x 620 |
| `html/small.html` | `hero-small-light.gif`, `hero-small-dark.gif` | 720 x 620 |
| `html/social.html` | `social-preview.png` | 1280 x 640 |

The three animated pages read `?theme=light` or `?theme=dark` and, opened in a browser, play
the whole loop as the GIF will: the scenes, their words and their timing are all
in the page. With `&frames` they stay still and wait for `renderLoop(t)`, which is
how the build takes one frame at a time. A change to a scene is a change to the
three pages, then a build.

The README picks the GIF by the reader's width and theme, in its `<picture>` at
the top.
