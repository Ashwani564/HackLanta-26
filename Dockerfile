# Snacxx on a free host (Render) with no AWS: the streaming bot, a free LLM, menus from data/gsu_dishes.csv.
FROM node:22-bookworm-slim
# ffmpeg converts voice notes; fontconfig renders the cards' text with the bundled Inter fonts.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fontconfig ca-certificates && rm -rf /var/lib/apt/lists/*
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
ENV LLM_PROVIDER=free MODE=imessage PORT=10000
EXPOSE 10000
CMD ["npx", "tsx", "src/main.ts"]
