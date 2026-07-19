# Deploying Chalk (fully hosted — judges can generate videos)

Three deploys, in this order. Total time: ~30 minutes.

```
Vercel (Next.js: landing + studio)
        │
        ▼
Convex cloud (job queue · file storage · live-HLS endpoints)
        ▲
        │  (outbound polling only — no inbound ports)
Railway worker (Docker: ffmpeg + sharp + the icon library)
```

## 0. Commit everything

The worker image is built FROM THE REPO — the generated icon library
(`assets/generated/icon-library/svg + manifest.json + embeddings.*`) and the
OpenMoji embedding index must be committed, or the hosted worker will render
without your icons:

```bash
git add -A && git commit -m "deploy"
git push
```

## 1. Convex → production

```bash
npx convex deploy
```

Note the deployment URL it prints: `https://<name>.convex.cloud`.

Live HLS works out of the box (the `/hls` HTTP actions serve from
`https://<name>.convex.site`; Convex sets `CONVEX_SITE_URL` itself).
Optional env (Convex dashboard → Settings → Environment Variables):
`HLS_MIN_START_SECONDS=12` (buffered seconds before the player attaches).

## 2. Frontend → Vercel

1. vercel.com → Add New Project → import the repo (Next.js auto-detected).
2. Environment variable:
   - `NEXT_PUBLIC_CONVEX_URL = https://<name>.convex.cloud`
3. Deploy. Landing page at `/`, studio at `/chalk`.

Leave `NEXT_PUBLIC_DEMO` unset so generation is ENABLED. (Setting it to `off`
flips the site into gallery-only showcase mode — a useful kill switch if you
ever need it during judging: flip the var and redeploy.)

**Accounts.** Auth is built in (custom username/password, `convex/auth.ts`) —
no extra setup, env vars, or provisioning; `convex deploy` pushes the `users`/
`sessions` tables automatically. Judges open `/chalk`, create an account, and
their videos are tracked to them. The landing page `/` stays public. Each user's
sidebar shows only their own chats; the Gallery shows everyone's finished videos.

## 3-A. Worker → GCP Compute Engine VM (recommended)

Same Google account that powers Vertex/TTS — the VM's **attached service
account** provides credentials via the metadata server, so no key file ever
touches the box (`GOOGLE_USE_ADC=1` tells the worker to trust it).

### 1) Create the VM (once)

```bash
# Find the service account you already use for Vertex:
gcloud iam service-accounts list --project=<PROJECT_ID>

gcloud compute instances create chalk-worker \
  --project=<PROJECT_ID> \
  --zone=us-central1-a \
  --machine-type=e2-standard-2 \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB \
  --service-account=<SA_EMAIL> \
  --scopes=https://www.googleapis.com/auth/cloud-platform
```

The `--scopes=cloud-platform` flag matters: without it, API calls fail even
when the service account has the right IAM roles. No inbound firewall rules
are needed — the worker only dials out.

### 2) Install the runtime

```bash
gcloud compute ssh chalk-worker --zone=us-central1-a

sudo apt-get update && sudo apt-get install -y ffmpeg git fontconfig curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && ffmpeg -version | head -1   # sanity: v20.x + ffmpeg present
```

### 3) Clone + configure

```bash
git clone https://github.com/<you>/<repo>.git chalk   # private repo: use a PAT in the URL
cd chalk && npm ci

cat > .env << 'ENV'
CONVEX_URL=https://<name>.convex.cloud
GOOGLE_CLOUD_PROJECT=<PROJECT_ID>
GOOGLE_USE_ADC=1
GEMINI_MODEL=gemini-3.5-flash
RERANK_MODEL=gemini-3.5-flash
SCENE_QA_MODEL=gemini-3.5-flash
ICON_IMAGE_MODEL=gemini-3.1-flash-lite-image
EMBED_MODEL=gemini-embedding-001
VERTEX_LOCATION=global
VERTEX_EMBED_LOCATION=us-central1
GOOGLE_TTS_VOICE=en-US-Chirp3-HD-Charon
ENV

npm run worker   # test: expect "Render worker worker-<pid> connected to ..."
```

Generate a test video from the Vercel site, watch it complete, then Ctrl-C.

### 4) Run it as a service (survives reboots + crashes)

```bash
sudo tee /etc/systemd/system/chalk-worker.service > /dev/null << EOF
[Unit]
Description=Chalk render worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/chalk
ExecStart=/usr/bin/npx tsx worker/convexWorker.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now chalk-worker
journalctl -u chalk-worker -f     # live logs
```

### 5) Operate

```bash
# deploy a code update
cd ~/chalk && git pull && npm ci && sudo systemctl restart chalk-worker

# pause billing when the event is over (~$0.07/h while running, ~$1.60/day)
gcloud compute instances stop chalk-worker --zone=us-central1-a
gcloud compute instances start chalk-worker --zone=us-central1-a

# tear down for good
gcloud compute instances delete chalk-worker --zone=us-central1-a
```

**Troubleshooting**: `PERMISSION_DENIED` from Vertex/TTS → the service account
is missing a role (`roles/aiplatform.user`) or the VM was created without
`--scopes=cloud-platform` (scopes can't be edited live: stop the VM, re-set
scopes, start). `RESOURCE_EXHAUSTED` → model quota, not the VM.

## 3-B. Worker → Railway (Docker, alternative)

1. railway.app → New Project → Deploy from GitHub repo. Railway detects the
   `Dockerfile` automatically.
2. Service → Variables — set:

   | Variable | Value |
   |---|---|
   | `CONVEX_URL` | `https://<name>.convex.cloud` |
   | `GOOGLE_CLOUD_PROJECT` | your GCP project id |
   | `GOOGLE_APPLICATION_CREDENTIALS_JSON` | paste the FULL service-account key JSON |
   | `GEMINI_MODEL` | `gemini-3.5-flash` |
   | `RERANK_MODEL` | `gemini-3.5-flash` |
   | `ICON_IMAGE_MODEL` | `gemini-3.1-flash-lite-image` |
   | `EMBED_MODEL` | `gemini-embedding-001` |
   | `VERTEX_LOCATION` | `global` |
   | `VERTEX_EMBED_LOCATION` | `us-central1` |
   | `GOOGLE_TTS_VOICE` | `en-US-Chirp3-HD-Charon` |

   (`worker/env.ts` writes the key JSON to disk at boot and points
   `GOOGLE_APPLICATION_CREDENTIALS` at it — no file mounting needed.)

3. Deploy. The logs should show `Render worker worker-<pid> connected to …`.
   No public networking / domain needed — the worker only dials out.

The worker deletes each job's local artifacts after upload (`KEEP_OUTPUTS=1`
disables that for debugging), so the container's disk stays flat.

## 4. Smoke test (do this before judging)

1. Open the Vercel URL → `/chalk` → generate a short video
   ("Explain how a password manager works").
2. Watch it: playback should start ~12s into rendering (live HLS), then the
   final MP4 replaces it for later visitors.
3. Generate 4–6 good videos so the Gallery is stocked.

## Judge-day notes

- **Concurrency**: one worker renders one video at a time; parallel judge
  requests queue (the UI shows progress). Scale on Railway by bumping the
  service's replica count — each replica claims its own job.
- **Quotas**: generation spends Google quota (Gemini text + TTS; the image
  model only fires for concepts missing from the icon library, and falls back
  to OpenMoji gracefully if its quota is exhausted). Check remaining daily
  quota for `gemini-3.1-flash-lite-image` before the event.
- **Stuck jobs**: the Convex watchdog cron auto-fails stalled jobs and the UI
  offers Resume/Regenerate — a crashed worker never wedges the queue.
- **Kill switch**: set `NEXT_PUBLIC_DEMO=off` on Vercel and redeploy →
  generation disabled, gallery + landing demo keep working.
