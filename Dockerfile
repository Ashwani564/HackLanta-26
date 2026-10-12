# Snacxx on a free host (Render) with no AWS and no paid APIs: the streaming bot, a free LLM, menus from
# data/gsu_dishes.csv, and offline voice (espeak-ng speaks, whisper.cpp transcribes).

# whisper.cpp, built once, plus its small English model (~75 MB).
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.7.6 https://github.com/ggml-org/whisper.cpp /w \
 && cmake -S /w -B /w/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build /w/build -j --config Release --target whisper-cli \
 && curl -fsSL -o /ggml-tiny.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin

FROM node:22-bookworm-slim
# ffmpeg converts voice notes; espeak-ng speaks them; fontconfig renders the cards' text with the bundled Inter fonts.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng fontconfig ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /w/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /ggml-tiny.en.bin /opt/whisper/ggml-tiny.en.bin
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY bot/package.json bot/package-lock.json bot/
RUN cd bot && npm ci
COPY src src
COPY data/gsu_dishes.csv data/gsu_dishes.csv
COPY bot/src bot/src
COPY bot/assets bot/assets
COPY bot/tsconfig.json bot/tsconfig.json
WORKDIR /app/bot
ENV LLM_PROVIDER=free VOICE_ENGINE=local MODE=imessage PORT=10000
EXPOSE 10000
CMD ["npx", "tsx", "src/main.ts"]
