# Render worker image (Railway / Render / Fly / any Docker host).
# The worker is OUTBOUND-ONLY: it polls Convex for jobs, renders with
# ffmpeg + sharp, and uploads MP4s + live HLS segments back — no ports exposed.
FROM node:20-slim

# ffmpeg (encode) + fontconfig (librsvg text rendering for the marker font).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for layer caching (tsx runs the worker, so dev
# dependencies are required; sharp fetches its linux-x64 binary here).
COPY package.json package-lock.json ./
RUN npm ci

# App source + bundled assets (fonts, OpenMoji, the generated icon library).
COPY . .

ENV NODE_ENV=production
# Required at runtime (set them in the host's dashboard):
#   CONVEX_URL                          — https://<deployment>.convex.cloud
#   GOOGLE_CLOUD_PROJECT                — GCP project id
#   GOOGLE_APPLICATION_CREDENTIALS_JSON — the service-account key JSON, pasted verbatim
#   GEMINI_MODEL / RERANK_MODEL / ICON_IMAGE_MODEL / EMBED_MODEL — model ids
# Optional: CONVEX_AUTH_TOKEN, GOOGLE_TTS_VOICE, VIDEO_WIDTH/HEIGHT/FPS, HLS_SEGMENT_SECONDS

CMD ["npx", "tsx", "worker/convexWorker.ts"]
