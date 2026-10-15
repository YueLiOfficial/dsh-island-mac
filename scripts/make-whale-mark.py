#!/usr/bin/env python3
"""Turn the DeepSeek Harness app icon into the white whale mark the pill shows.

Why generate instead of hand-drawing: the silhouette in the DSH app icon *is* the
mark users already recognise, and hand-authoring an equivalent path would be
guesswork. The output is committed, so building the plugin needs neither the app
icon nor this script — only regenerating the mark does.

Two properties of the source icon were measured, and both broke a naive
implementation:

1. It is RGBA with the area outside its rounded square fully transparent, and
   that transparent area is *black* in RGB. Reading luminance without also
   gating on alpha therefore treats the whole canvas border as part of the mark.
2. It draws a thin dark stroke around the rounded square, and the whale nearly
   touches that square — so there is no inset that removes the stroke without
   clipping the whale. The stroke is instead removed by connectivity: it is a
   separate component from the whale, and cropping to the whale's bounding box
   leaves the stroke outside it.

Luminance is used as a *ramp* rather than a hard threshold so the antialiased
edges and the eye's curve stay smooth.

The mark is emitted as **base64 inside a Swift source file**, not as a SwiftPM
resource bundle. The helper is distributed as a single executable file, and the
first attempt shipped the PNG as a resource: `Bundle.module` then traps at first
render with `unable to find bundle named DynamicIslandBridge_DynamicIslandBridge`
whenever the sidecar `.bundle` is not next to the binary — which is every copied
or packaged copy. The end-to-end check caught it by killing the helper the moment
progress arrived.

Usage:
    scripts/make-whale-mark.py [source-icon.png] [--preview out.png]
"""

import base64
import io
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path("/Applications/DeepSeek Harness.app/Contents/Resources/icon.png")
OUT = REPO / "swift/DynamicIslandBridge/Sources/DynamicIslandBridge/WhaleMarkData.swift"

# Luminance ramp: >= BACKGROUND_LUMA is fully transparent, <= FOREGROUND_LUMA is
# fully opaque. The 1024px icon's histogram inside its opaque area is sharply
# bimodal — the whale is 0-79 (31.5% of pixels), the background gradient is
# 220-255 (68.2%), and only ~0.3% lands in between (the antialiased edge). So
# 200/100 sits in the empty valley between the two modes.
BACKGROUND_LUMA = 200.0
FOREGROUND_LUMA = 100.0

# The pill draws this at 13pt; 60px covers a 3x display with headroom and stays
# a couple of kilobytes.
TARGET_HEIGHT = 60

# Plausibility band for "a whale silhouette fills its own crop". Outside this,
# the threshold caught the background or ate the mark.
MIN_COVERAGE = 0.25
MAX_COVERAGE = 0.95


def ramp(luma: "np.ndarray") -> "np.ndarray":
    """Map luminance to 0-255 alpha, light to dark."""
    span = BACKGROUND_LUMA - FOREGROUND_LUMA
    alpha = (BACKGROUND_LUMA - luma) / span * 255.0
    return np.clip(alpha, 0.0, 255.0)


def largest_component(mask: "np.ndarray") -> "np.ndarray":
    """Boolean mask of the largest 4-connected component of `mask`.

    Deliberately hand-rolled: scipy is not part of the bundled Python, and the
    only alternative in Pillow (morphological opening) would round off the
    whale's thin flukes and fill its eye.
    """
    height, width = mask.shape
    seen = np.zeros(mask.size, dtype=bool)
    flat_mask = mask.ravel()
    best: list[int] = []

    for start in np.flatnonzero(flat_mask):
        if seen[start]:
            continue
        component: list[int] = []
        queue = deque([int(start)])
        seen[start] = True
        while queue:
            index = queue.popleft()
            component.append(index)
            y, x = divmod(index, width)
            if y > 0 and flat_mask[index - width] and not seen[index - width]:
                seen[index - width] = True
                queue.append(index - width)
            if y + 1 < height and flat_mask[index + width] and not seen[index + width]:
                seen[index + width] = True
                queue.append(index + width)
            if x > 0 and flat_mask[index - 1] and not seen[index - 1]:
                seen[index - 1] = True
                queue.append(index - 1)
            if x + 1 < width and flat_mask[index + 1] and not seen[index + 1]:
                seen[index + 1] = True
                queue.append(index + 1)
        if len(component) > len(best):
            best = component

    if not best:
        return np.zeros(mask.shape, dtype=bool)

    keep = np.zeros(mask.size, dtype=bool)
    keep[np.array(best, dtype=np.int64)] = True
    return keep.reshape(mask.shape)


def main() -> int:
    arguments = [a for a in sys.argv[1:] if a != "--preview"]
    preview = None
    if "--preview" in sys.argv:
        index = sys.argv.index("--preview")
        if index + 1 >= len(sys.argv):
            print("✖ --preview 需要一个输出路径", file=sys.stderr)
            return 1
        preview = Path(sys.argv[index + 1])
        arguments = [a for a in arguments if a != str(preview)]

    source = Path(arguments[0]) if arguments else DEFAULT_SOURCE
    if not source.exists():
        print(f"✖ 找不到源图标：{source}", file=sys.stderr)
        print("  这是 DSH 应用自带的图标；换机器时把路径作为参数传进来。", file=sys.stderr)
        return 1

    rgba = Image.open(source).convert("RGBA")
    pixels = np.asarray(rgba).astype(np.int16)
    luma = np.asarray(rgba.convert("L")).astype(np.float64)
    source_alpha = pixels[:, :, 3].astype(np.float64) / 255.0

    # Transparent pixels are black in RGB, so alpha has to gate the ramp or the
    # canvas border becomes part of the mark.
    alpha = ramp(luma) * source_alpha

    whale = largest_component(alpha > 127.5)
    if not whale.any():
        print("✖ 找不到任何连通区域 —— 阈值把整张图判成透明了", file=sys.stderr)
        return 1

    rows = np.flatnonzero(whale.any(axis=1))
    cols = np.flatnonzero(whale.any(axis=0))
    top, bottom = int(rows[0]), int(rows[-1]) + 1
    left, right = int(cols[0]), int(cols[-1]) + 1

    # Cropping to the whale's own bounding box is what drops the rounded-square
    # stroke: the stroke surrounds the whale, so it lies outside these bounds.
    alpha_image = Image.fromarray(alpha.astype(np.uint8), "L").crop((left, top, right, bottom))

    mark = Image.new("RGBA", alpha_image.size, (255, 255, 255, 0))
    mark.putalpha(alpha_image)

    scale = TARGET_HEIGHT / mark.height
    mark = mark.resize((max(1, round(mark.width * scale)), TARGET_HEIGHT), Image.LANCZOS)

    opaque = int((np.asarray(mark)[:, :, 3] > 128).sum())
    coverage = opaque / (mark.width * mark.height)

    buffer = io.BytesIO()
    mark.save(buffer, format="PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    wrapped = "\n".join(encoded[i:i + 96] for i in range(0, len(encoded), 96))

    OUT.write_text(
        f'''// GENERATED by scripts/make-whale-mark.py — do not edit by hand.
//
// The DeepSeek whale mark, embedded as base64 PNG rather than shipped as a
// SwiftPM resource bundle. The helper is distributed as one executable file, and
// a sidecar `.bundle` is either left out of the package or makes the binary trap
// at first render with "unable to find bundle named ..." — please keep the bytes
// here instead of moving this back into Resources/.
//
// Source: the DeepSeek Harness app icon, thresholded to a white silhouette.
// Regenerate with: scripts/make-whale-mark.py
enum WhaleMarkData {{
    /// {mark.width}x{mark.height} PNG, white on transparent.
    static let pngBase64 = """
{wrapped}
"""
}}
''',
        encoding="utf-8",
    )

    if preview is not None:
        preview.parent.mkdir(parents=True, exist_ok=True)
        mark.save(preview)

    print(f"源图标     : {source} ({rgba.width}x{rgba.height})")
    print(f"最大连通域 : {int(whale.sum())} px，bbox x[{left},{right}) y[{top},{bottom})")
    print(f"输出       : {OUT.relative_to(REPO)} ({mark.width}x{mark.height}, {len(buffer.getvalue())} 字节 PNG)")
    print(f"不透明占比 : {coverage:.1%}")
    print(f"宽高比     : {mark.width / mark.height:.3f}")
    if preview is not None:
        print(f"预览       : {preview}")

    if not MIN_COVERAGE <= coverage <= MAX_COVERAGE:
        print(f"✖ 不透明占比不在 {MIN_COVERAGE:.0%}–{MAX_COVERAGE:.0%} —— 阈值方向或取值有问题", file=sys.stderr)
        return 1
    if mark.width <= mark.height:
        print("✖ 输出不比高宽 —— 裁剪框没贴合鲸鱼，多半把边框留下了", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
