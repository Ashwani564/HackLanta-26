"""Time SAM 2 on one image: python benchmark.py <image> '<json boxes in pixels>' [out.png]"""

import json
import sys
import time

t0 = time.perf_counter()
import server  # loads the model and warms up

print(f"load + warmup: {time.perf_counter() - t0:.1f}s on {server.DEVICE} ({server.MODEL_ID})")

from PIL import Image

image = Image.open(sys.argv[1]).convert("RGB")
boxes = json.loads(sys.argv[2])

runs = []
for _ in range(5):
    t = time.perf_counter()
    masks = server.segment(image, boxes)
    runs.append((time.perf_counter() - t) * 1000)
print(f"{len(boxes)} boxes, {image.size[0]}x{image.size[1]}: " + ", ".join(f"{r:.0f}ms" for r in runs))
print("mask coverage:", [f"{m.mean():.1%}" for m in masks])

if len(sys.argv) > 3:
    import numpy as np

    overlay = np.array(image).astype(float)
    colors = [(255, 55, 95), (48, 209, 88), (10, 132, 255), (255, 214, 10), (191, 90, 242)]
    for i, m in enumerate(masks):
        overlay[m] = overlay[m] * 0.5 + np.array(colors[i % len(colors)]) * 0.5
    Image.fromarray(overlay.astype("uint8")).save(sys.argv[3])
    print("wrote", sys.argv[3])
