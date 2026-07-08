import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  DATA_DIR,
  createSet,
  getSet,
  listSets,
  updateSet,
  addPhoto,
  updatePhoto,
  addComposite,
} from "./lib/store.js";
import { extractPeople, extractBackground, composite } from "./lib/gemini.js";
import * as gphotos from "./lib/googlePhotos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_PHOTOS_PER_SET = 10;

app.set("trust proxy", true); // Render terminates TLS; trust X-Forwarded-Proto
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/files", express.static(DATA_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, "uploads"),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: MAX_PHOTOS_PER_SET },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype));
  },
});

// ---- Sets ----

app.post("/api/sets", (req, res) => {
  res.status(201).json(createSet(req.body?.name));
});

app.get("/api/sets", (req, res) => {
  res.json(listSets());
});

app.patch("/api/sets/:id", (req, res) => {
  const set = getSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not found" });
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: "Name cannot be empty" });
  res.json(updateSet(set.id, { name }));
});

app.get("/api/sets/:id", (req, res) => {
  const set = getSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not found" });
  res.json(set);
});

// ---- Photo upload ----

app.post("/api/sets/:id/photos", upload.array("photos", MAX_PHOTOS_PER_SET), (req, res) => {
  const set = getSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not found" });

  const room = MAX_PHOTOS_PER_SET - set.photos.length;
  const files = (req.files || []).slice(0, Math.max(room, 0));
  if (!files.length) {
    return res.status(400).json({
      error: room <= 0 ? `A set holds at most ${MAX_PHOTOS_PER_SET} photos` : "No valid images uploaded",
    });
  }

  for (const file of files) {
    addPhoto(set.id, {
      id: crypto.randomUUID(),
      originalName: file.originalname,
      uploadPath: `uploads/${file.filename}`,
      mimeType: file.mimetype,
      status: "uploaded", // uploaded | processing | done | error
      peoplePath: null,
      backgroundPath: null,
      error: null,
    });
  }
  res.status(201).json(getSet(set.id));
});

// ---- AI processing ----

async function processPhoto(set, photo) {
  updatePhoto(set.id, photo.id, { status: "processing", error: null });
  try {
    const buffer = fs.readFileSync(path.join(DATA_DIR, photo.uploadPath));

    // Sequential, not parallel: image models have low per-minute limits (IPM),
    // and firing both calls at once doubles the burst against that ceiling.
    const peopleBuffer = await extractPeople(buffer, photo.mimeType);
    const backgroundBuffer = await extractBackground(buffer, photo.mimeType);

    const peoplePath = `people/${photo.id}.png`;
    const backgroundPath = `backgrounds/${photo.id}.jpg`;
    fs.writeFileSync(path.join(DATA_DIR, peoplePath), peopleBuffer);
    fs.writeFileSync(path.join(DATA_DIR, backgroundPath), backgroundBuffer);

    updatePhoto(set.id, photo.id, { status: "done", peoplePath, backgroundPath });
  } catch (err) {
    const message = friendlyGeminiError(err);
    console.error(`Processing failed for photo ${photo.id}:`, err);
    updatePhoto(set.id, photo.id, { status: "error", error: message });
  }
}

// Translate raw Gemini API errors into something actionable for the user.
function friendlyGeminiError(err) {
  const raw = String(err?.message || err);
  if (/FAILED_PRECONDITION|billing/i.test(raw)) {
    return "Gemini image generation requires billing to be enabled on your Google Cloud project (the free tier no longer includes image models). Enable billing at console.cloud.google.com, then retry.";
  }
  if (/RESOURCE_EXHAUSTED|quota|429/i.test(raw)) {
    return "Gemini rate limit (429) hit even after retries. On a paid account this usually means the API key's Google Cloud project isn't the one with billing linked, the project is still on the free/low tier, or a just-upgraded project hasn't calibrated yet (can take 24–48h). Check the project's rate limits in AI Studio, then retry.";
  }
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(raw)) {
    return "The GEMINI_API_KEY on the server is invalid or lacks access. Re-check the key in Render's environment settings.";
  }
  if (/not found|NOT_FOUND/i.test(raw)) {
    return `The model "${process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image"}" was not found for this API key. Try setting GEMINI_IMAGE_MODEL to a model your key can access.`;
  }
  return raw.slice(0, 300);
}

// setIds with a pending cancellation. Checked between photos in the
// sequential processing loop below (not mid-photo — a photo already in
// flight always finishes atomically to "done" or "error").
const cancelledSets = new Set();

app.post("/api/sets/:id/process", async (req, res) => {
  const set = getSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not found" });
  if (!set.photos.length) return res.status(400).json({ error: "Upload photos first" });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY" });
  }
  if (set.status === "processing") return res.status(409).json({ error: "Already processing" });

  cancelledSets.delete(set.id);
  updateSet(set.id, { status: "processing" });
  res.status(202).json(getSet(set.id)); // respond now; client polls for progress

  // Only photos that aren't "done" get (re)processed — retrying after a
  // cancel or a partial failure picks up right where it left off.
  const pending = set.photos.filter((p) => p.status !== "done");
  (async () => {
    // One photo at a time to stay under image-model per-minute rate limits.
    // extractPeople + extractBackground already retry with backoff on 429.
    for (const photo of pending) {
      if (cancelledSets.has(set.id)) break;
      await processPhoto(set, photo);
    }
    cancelledSets.delete(set.id);
    const anyDone = getSet(set.id).photos.some((p) => p.status === "done");
    updateSet(set.id, { status: anyDone ? "ready" : "error" });
  })();
});

app.post("/api/sets/:id/cancel", (req, res) => {
  const set = getSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not found" });
  if (set.status !== "processing") {
    return res.status(400).json({ error: "Not currently processing" });
  }
  // The running loop notices this before starting the next photo. The photo
  // it's mid-flight on still finishes normally (finishes to done/error) —
  // cancelling just stops it from starting another one after that.
  cancelledSets.add(set.id);
  res.json({ ok: true, message: "Cancelling — finishing the current photo, then stopping." });
});

// ---- Combine: chosen people + chosen background ----

app.post("/api/sets/:id/combine", async (req, res) => {
  const set = getSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not found" });

  const { peoplePhotoId, backgroundPhotoId } = req.body || {};
  const peoplePhoto = set.photos.find((p) => p.id === peoplePhotoId);
  const backgroundPhoto = set.photos.find((p) => p.id === backgroundPhotoId);
  if (!peoplePhoto?.peoplePath || !backgroundPhoto?.backgroundPath) {
    return res.status(400).json({ error: "Pick one processed people shot and one processed background" });
  }

  try {
    const result = await composite(
      fs.readFileSync(path.join(DATA_DIR, backgroundPhoto.backgroundPath)),
      fs.readFileSync(path.join(DATA_DIR, peoplePhoto.peoplePath))
    );
    const id = crypto.randomUUID();
    const filePath = `composites/${id}.jpg`;
    fs.writeFileSync(path.join(DATA_DIR, filePath), result);
    const record = addComposite(set.id, {
      id,
      path: filePath,
      peoplePhotoId,
      backgroundPhotoId,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---- Google Photos (Picker API) ----
//
// Browser cookie (pp_sid) -> in-memory token store. Tokens are lost on server
// restart, which is fine: the user just reconnects. Move to a DB/session store
// if you need durability.

const googleTokens = new Map(); // sid -> { accessToken, refreshToken, expiresAt }

function getSid(req, res) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=").map(decodeURIComponent))
  );
  let sid = cookies.pp_sid;
  if (!sid) {
    sid = crypto.randomUUID();
    res.setHeader("Set-Cookie", `pp_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  return sid;
}

function redirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get("host")}/auth/google/callback`;
}

/** Valid access token for this browser, refreshing if needed; null if not connected. */
async function googleAccessToken(sid) {
  const tokens = googleTokens.get(sid);
  if (!tokens) return null;
  if (Date.now() < tokens.expiresAt) return tokens.accessToken;
  if (!tokens.refreshToken) {
    googleTokens.delete(sid);
    return null;
  }
  try {
    const refreshed = await gphotos.refreshAccessToken(tokens.refreshToken);
    googleTokens.set(sid, refreshed);
    return refreshed.accessToken;
  } catch {
    googleTokens.delete(sid);
    return null;
  }
}

app.get("/auth/google", (req, res) => {
  if (!gphotos.isConfigured()) {
    return res.status(500).send("Google Photos is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  }
  const sid = getSid(req, res);
  res.redirect(gphotos.authUrl(redirectUri(req), sid));
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect("/?google=denied");
  try {
    const tokens = await gphotos.exchangeCode(code, redirectUri(req));
    googleTokens.set(state, tokens); // state carries the sid we sent
    // Make sure the browser keeps the same sid the tokens are stored under.
    res.setHeader("Set-Cookie", `pp_sid=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    res.redirect("/?google=connected");
  } catch (err) {
    console.error("Google OAuth callback failed:", err.message);
    res.redirect("/?google=error");
  }
});

app.get("/api/google/status", async (req, res) => {
  const sid = getSid(req, res);
  res.json({
    configured: gphotos.isConfigured(),
    connected: Boolean(await googleAccessToken(sid)),
  });
});

app.post("/api/google/picker-session", async (req, res) => {
  const sid = getSid(req, res);
  const token = await googleAccessToken(sid);
  if (!token) return res.status(401).json({ error: "Not connected to Google Photos" });
  try {
    const session = await gphotos.createPickerSession(token);
    res.status(201).json({
      sessionId: session.id,
      pickerUri: session.pickerUri,
      pollIntervalMs: Math.max(Number(session.pollingConfig?.pollInterval?.replace("s", "")) * 1000 || 2000, 1500),
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/google/picker-session/:sessionId", async (req, res) => {
  const sid = getSid(req, res);
  const token = await googleAccessToken(sid);
  if (!token) return res.status(401).json({ error: "Not connected to Google Photos" });
  try {
    const session = await gphotos.getPickerSession(token, req.params.sessionId);
    res.json({ mediaItemsSet: Boolean(session.mediaItemsSet) });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.post("/api/sets/:id/import-google", async (req, res) => {
  const set = getSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not found" });
  const sid = getSid(req, res);
  const token = await googleAccessToken(sid);
  if (!token) return res.status(401).json({ error: "Not connected to Google Photos" });

  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  try {
    const items = await gphotos.listPickedItems(token, sessionId);
    const photos = items.filter((i) => (i.type || "").toUpperCase() !== "VIDEO");
    const room = MAX_PHOTOS_PER_SET - set.photos.length;
    const toImport = photos.slice(0, Math.max(room, 0));
    if (!toImport.length) {
      return res.status(400).json({
        error: room <= 0 ? `A set holds at most ${MAX_PHOTOS_PER_SET} photos` : "No photos were selected",
      });
    }

    let imported = 0;
    for (const item of toImport) {
      const file = item.mediaFile || item; // field name per Picker API; tolerate both shapes
      const baseUrl = file.baseUrl;
      if (!baseUrl) continue;
      const buffer = await gphotos.downloadMediaItem(token, baseUrl);
      const mimeType = file.mimeType || "image/jpeg";
      const ext = mimeType.includes("png") ? ".png" : mimeType.includes("webp") ? ".webp" : ".jpg";
      const filename = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(DATA_DIR, "uploads", filename), buffer);
      addPhoto(set.id, {
        id: crypto.randomUUID(),
        originalName: file.filename || "google-photos-import",
        uploadPath: `uploads/${filename}`,
        mimeType,
        status: "uploaded",
        peoplePath: null,
        backgroundPath: null,
        error: null,
        source: "google-photos",
      });
      imported++;
    }

    gphotos.deletePickerSession(token, sessionId); // best-effort cleanup
    res.status(201).json({ imported, skipped: photos.length - imported, set: getSet(set.id) });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY) });
});

app.listen(PORT, () => {
  console.log(`Picture Perfect running on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("⚠ GEMINI_API_KEY not set — uploads work, but AI processing will fail.");
  }
});
