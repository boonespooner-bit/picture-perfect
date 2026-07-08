# 📸 Picture Perfect

Upload a **set** of photos (up to 10), let AI **separate the people from the backgrounds**, then pick the best people-shot and the best background and **combine them** into one picture-perfect photo.

Typical use: group photos where someone blinks in every frame — take the frame where everyone looks great and put it on the frame with the nicest background.

## How it works

```
Browser ──upload set──▶ Express server ──each photo──▶ Gemini image model
                                                        ├─ "people only" (green screen → real transparency)
                                                        └─ "background only" (people removed, scene reconstructed)
Browser ◀──pick people + background──  server composites them with sharp
```

**Why Gemini and not Claude?** Claude's API can *analyze* images but cannot *output edited images*. Gemini's image model ("Nano Banana", `gemini-2.5-flash-image`) does native image editing — removing people, isolating subjects, reconstructing backgrounds — at ~$0.04 per generated image. Each photo in a set costs two generations (~$0.08).

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + Express | Simple, single service, Render-native |
| AI | Gemini `gemini-2.5-flash-image` via `@google/genai` | Only major API with true image *editing* |
| Image ops | `sharp` | Chroma-key → alpha transparency, final compositing |
| Frontend | Plain HTML/CSS/JS | No build step to maintain |
| Storage | Local disk + JSON (Render persistent disk) | Fine for MVP; swap for S3/Postgres later |

---

## 1. Run locally

```bash
git clone https://github.com/boonespooner-bit/picture-perfect.git
cd picture-perfect
npm install
cp .env.example .env    # then paste your Gemini key into .env
npm start               # http://localhost:3000
```

## 2. Get a Gemini API key

1. Go to <https://aistudio.google.com/apikey> (sign in with a Google account).
2. Click **Create API key** and copy it.
3. Put it in `.env` locally, and in Render's dashboard for production (below).
4. Billing: the free tier includes some image generations; for real usage enable billing on the Google Cloud project. `gemini-2.5-flash-image` output costs ≈ $0.039/image. You can switch models with `GEMINI_IMAGE_MODEL` (e.g. `gemini-3-pro-image-preview` for higher quality).

## 3. Deploy on Render

**Option A — Blueprint (recommended):** `render.yaml` at the repo root does the setup for you. Go to Render → **New + → Blueprint**, pick this repo, and Render creates the web service and persistent disk automatically. It will prompt you for `GEMINI_API_KEY`.

**Option B — Manual web service:**
1. Render → **New + → Web Service** → connect this GitHub repo.
2. **Build command:** `npm install` · **Start command:** `npm start`
3. **Environment variables:** `GEMINI_API_KEY` = your key, `DATA_DIR` = `/var/data`
4. **Disks:** add a disk mounted at `/var/data` (1 GB is plenty to start). Without a disk, uploads/results vanish on every deploy/restart — Render's filesystem is ephemeral.
5. Deploy. The health check is `/api/health`.

## API reference

| Method & path | Purpose |
|---|---|
| `POST /api/sets` `{name}` | Create a set |
| `GET /api/sets` / `GET /api/sets/:id` | List sets / set detail (poll during processing) |
| `POST /api/sets/:id/photos` (multipart `photos[]`) | Upload up to 10 images per set |
| `POST /api/sets/:id/process` | Kick off AI separation for all photos (async) |
| `POST /api/sets/:id/combine` `{peoplePhotoId, backgroundPhotoId}` | Composite the chosen pair |
| `GET /files/*` | Serve uploaded/processed images |

## Notes & next steps

- **Transparency trick:** image models don't reliably emit alpha channels, so we ask Gemini for a flat `#00FF00` backdrop behind the people and chroma-key it to real transparency in `sharp` (`lib/gemini.js`). Tune the thresholds there if you see green fringes.
- **Retries:** re-clicking "Separate" only reprocesses photos that aren't `done`.
- **Later:** auth/user accounts, S3 for storage, a queue (BullMQ) for processing at scale, and letting users nudge/scale the cutout before compositing.
