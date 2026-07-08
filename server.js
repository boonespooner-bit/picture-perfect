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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_PHOTOS_PER_SET = 10;

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

    const [peopleBuffer, backgroundBuffer] = await Promise.all([
      extractPeople(buffer, photo.mimeType),
      extractBackground(buffer, photo.mimeType),
    ]);

    const peoplePath = `people/${photo.id}.png`;
    const backgroundPath = `backgrounds/${photo.id}.jpg`;
    fs.writeFileSync(path.join(DATA_DIR, peoplePath), peopleBuffer);
    fs.writeFileSync(path.join(DATA_DIR, backgroundPath), backgroundBuffer);

    updatePhoto(set.id, photo.id, { status: "done", peoplePath, backgroundPath });
  } catch (err) {
    updatePhoto(set.id, photo.id, { status: "error", error: String(err.message || err) });
  }
}

app.post("/api/sets/:id/process", async (req, res) => {
  const set = getSet(req.params.id);
  if (!set) return res.status(404).json({ error: "Set not found" });
  if (!set.photos.length) return res.status(400).json({ error: "Upload photos first" });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY" });
  }
  if (set.status === "processing") return res.status(409).json({ error: "Already processing" });

  updateSet(set.id, { status: "processing" });
  res.status(202).json(getSet(set.id)); // respond now; client polls for progress

  const pending = set.photos.filter((p) => p.status !== "done");
  const CONCURRENCY = 3;
  (async () => {
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      await Promise.all(pending.slice(i, i + CONCURRENCY).map((p) => processPhoto(set, p)));
    }
    const anyDone = getSet(set.id).photos.some((p) => p.status === "done");
    updateSet(set.id, { status: anyDone ? "ready" : "error" });
  })();
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY) });
});

app.listen(PORT, () => {
  console.log(`Picture Perfect running on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn("⚠ GEMINI_API_KEY not set — uploads work, but AI processing will fail.");
  }
});
