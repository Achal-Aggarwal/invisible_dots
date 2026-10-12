"""photos/characters.png -> photos/characters-light.png and photos/characters-dark.png.

The four characters arrive as one picture on a white background, the way an image
model draws them. The animation needs them without it, and differently per theme:

  light  only the white connected to the picture's edge turns transparent, through
         the edge's own shades, so the soft shadows under the feet stay and the
         fur fades into the page the way it faded into the white;
  dark   the same, and the pale grey of those shadows goes too, since a light
         shadow on a dark page reads as a stain.

Only background CONNECTED TO THE EDGE is touched: the whites of the eyes and a lens
are as white as the background and stay opaque. Both outputs are cropped to the
characters, so the pages size them by width alone.

    python docs/hero/cut_out.py
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).parent
SRC = HERE / "photos" / "characters.png"

#: How far from pure white a pixel may be and still be background (0-255, on the
#: channel furthest from white). Covers the paper-white of the picture and its
#: anti-aliased edge; fur is far past it.
PALE = 60
#: A pale pixel with less colour than this is a shadow, not fur fading into white.
GREY = 18
#: How many pixels past the background the fur still carries some of its white.
BAND = 3
#: How far from pure white the paper may be: within this it is no picture at all.
PAPER = 6


def cut(rgb: np.ndarray, keep_shadows: bool) -> np.ndarray:
    a = rgb.astype(np.float64)
    far = (255.0 - a).max(axis=2)                     # 0 = pure white
    spread = a.max(axis=2) - a.min(axis=2)            # 0 = no colour at all
    labels, _ = ndimage.label(far <= PALE)
    edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    bg = np.isin(labels, edge[edge > 0])
    # The fur's outermost pixels are part fur, part white, and past PALE: left
    # opaque they draw a thin light outline on a dark page. They are the band just
    # outside the background, and colour to alpha is exact for them too.
    band = ndimage.binary_dilation(bg, iterations=BAND)

    # Colour to alpha against white: the least alpha that explains the pixel as
    # some colour over white, and that colour with the white taken out.
    alpha = np.where(band, far / 255.0, 1.0)
    # The paper itself is not pure white (an image model draws it at 253-254), and
    # colour to alpha turns that into an opacity of 1 or 2 out of 255 with made-up
    # colours: a faint box around the characters on any page that is not white.
    alpha = np.where(bg & (far <= PAPER), 0.0, alpha)
    if not keep_shadows:
        alpha = np.where(bg & (spread < GREY), 0.0, alpha)
    safe = np.maximum(alpha, 1e-6)[..., None]
    colour = np.where(band[..., None], 255.0 - (255.0 - a) / safe, a)
    out = np.dstack([np.clip(colour, 0, 255), alpha * 255.0]).round().astype(np.uint8)
    out[out[..., 3] == 0, :3] = 0
    return out


def box(rgba: np.ndarray, margin: int = 8) -> tuple:
    """The characters' bounding box. ONE box for both themes: cropped apart, the
    light one (shadows included) would be taller, and at the same width on the
    page the characters would change size between the two themes."""
    ys, xs = np.nonzero(rgba[..., 3] > 8)
    return (max(0, ys.min() - margin), min(rgba.shape[0], ys.max() + margin + 1),
            max(0, xs.min() - margin), min(rgba.shape[1], xs.max() + margin + 1))


def main() -> None:
    rgb = np.asarray(Image.open(SRC).convert("RGB"))
    cuts = {"light": cut(rgb, keep_shadows=True), "dark": cut(rgb, keep_shadows=False)}
    y0, y1, x0, x1 = box(cuts["light"])
    for theme, rgba in cuts.items():
        out = rgba[y0:y1, x0:x1]
        path = HERE / "photos" / f"characters-{theme}.png"
        Image.fromarray(out, "RGBA").save(path, optimize=True)
        print(f"{path.name}: {out.shape[1]}x{out.shape[0]}")


if __name__ == "__main__":
    main()
