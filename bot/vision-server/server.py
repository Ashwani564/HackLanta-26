"""SAM 2 box -> mask service for the dining bot.

POST /segment (multipart): image=<jpeg>, boxes=<JSON [[x0, y0, x1, y1], ...] in pixels>
-> {"masks": [<base64 PNG, same size as the image, 255 = item>], "ms": <inference time>}
"""

import base64
import io
import json
import os
import time

import numpy as np
import torch
from fastapi import FastAPI, File, Form, UploadFile
from PIL import Image
from transformers import Sam2Model, Sam2Processor

MODEL_ID = os.environ.get("SAM2_MODEL", "facebook/sam2.1-hiera-tiny")
DEVICE = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"

processor = Sam2Processor.from_pretrained(MODEL_ID)
model = Sam2Model.from_pretrained(MODEL_ID).to(DEVICE).eval()


def segment(image: Image.Image, boxes: list[list[float]]) -> list[np.ndarray]:
    inputs = processor(images=image, input_boxes=[boxes], return_tensors="pt").to(DEVICE)
    with torch.inference_mode():
        out = model(**inputs, multimask_output=False)
    masks = processor.post_process_masks(out.pred_masks.cpu(), inputs["original_sizes"].cpu())[0]
    return [m[0].numpy().astype(bool) for m in masks]


def to_png(mask: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(mask.astype(np.uint8) * 255, mode="L").save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


# Warm up so the first real request doesn't pay for kernel compilation.
segment(Image.new("RGB", (640, 480), "white"), [[100, 100, 300, 300]])

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "device": DEVICE}


@app.post("/segment")
async def segment_route(image: UploadFile = File(...), boxes: str = Form(...)):
    img = Image.open(io.BytesIO(await image.read())).convert("RGB")
    box_list = json.loads(boxes)
    if not box_list:
        return {"masks": [], "ms": 0}
    t = time.perf_counter()
    masks = segment(img, box_list)
    ms = round((time.perf_counter() - t) * 1000)
    return {"masks": [to_png(m) for m in masks], "ms": ms}
