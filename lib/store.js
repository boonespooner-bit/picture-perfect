// Simple JSON-file-backed store for sets and their photos.
// Fine for an MVP; swap for a database (Render Postgres) when you need
// multi-instance deploys or durability guarantees.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "sets.json");

for (const dir of ["uploads", "people", "backgrounds", "composites"]) {
  fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });
}

let sets = {};
if (fs.existsSync(DB_FILE)) {
  try {
    sets = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    sets = {};
  }
}

function persist() {
  fs.writeFileSync(DB_FILE, JSON.stringify(sets, null, 2));
}

// If the server stopped mid-run (crash, redeploy, manual restart), any set or
// photo left at "processing" would otherwise be stuck there forever — nothing
// clears it and /process refuses to start again while status is "processing".
// Reset those back to a resumable state on boot; the next "Process" click
// only touches photos that aren't "done" yet, so this picks up where it left off.
function recoverInterruptedProcessing() {
  let changed = false;
  for (const set of Object.values(sets)) {
    for (const photo of set.photos) {
      if (photo.status === "processing") {
        photo.status = "uploaded";
        photo.error = "Interrupted by a server restart — click Process again to retry.";
        changed = true;
      }
    }
    if (set.status === "processing") {
      set.status = set.photos.some((p) => p.status === "done") ? "ready" : "created";
      changed = true;
    }
  }
  if (changed) persist();
}
recoverInterruptedProcessing();

export function createSet(name) {
  const id = crypto.randomUUID();
  sets[id] = {
    id,
    name: name || `Set ${Object.keys(sets).length + 1}`,
    createdAt: new Date().toISOString(),
    status: "created", // created | processing | ready | error
    photos: [], // { id, originalName, uploadPath, status, peoplePath, backgroundPath, error }
    composites: [], // { id, path, peoplePhotoId, backgroundPhotoId, createdAt }
  };
  persist();
  return sets[id];
}

export function getSet(id) {
  return sets[id];
}

export function listSets() {
  return Object.values(sets).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateSet(id, patch) {
  Object.assign(sets[id], patch);
  persist();
  return sets[id];
}

export function addPhoto(setId, photo) {
  sets[setId].photos.push(photo);
  persist();
  return photo;
}

export function updatePhoto(setId, photoId, patch) {
  const photo = sets[setId].photos.find((p) => p.id === photoId);
  if (photo) {
    Object.assign(photo, patch);
    persist();
  }
  return photo;
}

export function addComposite(setId, composite) {
  sets[setId].composites.push(composite);
  persist();
  return composite;
}
