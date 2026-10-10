# vision-server

Local SAM 2 service that turns Gemini's rough food boxes into pixel-accurate masks.
The bot calls it at `SAM_URL` (default `http://127.0.0.1:8788`). If the service isn't
running, the bot draws plain boxes instead.

```bash
npm run vision        # from bot/; first run downloads PyTorch + SAM 2.1 tiny (~1-2 GB)
```

Requires [uv](https://docs.astral.sh/uv/). Uses the Apple Silicon GPU (MPS) when available,
then CUDA, then CPU.

| Step | Typical time (M4) |
|---|---|
| Gemini Flash-Lite: labels, boxes, calories | ~1.2-2.5 s (hedged if slow) |
| SAM 2.1 tiny: masks for all items | ~0.3-0.4 s |
| Drawing | ~0.07 s |

Benchmark on any image: `uv run python benchmark.py photo.jpg '[[x0,y0,x1,y1], ...]' out.png`
