// Picture Perfect frontend — plain JS, no build step.
const $ = (sel) => document.querySelector(sel);

const state = {
  currentSet: null,
  selectedPeople: null,
  selectedBackground: null,
  pollTimer: null,
};

// ---------- API ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Sets ----------
async function refreshSets() {
  const sets = await api("/api/sets");
  const list = $("#set-list");
  list.innerHTML = "";
  for (const set of sets) {
    const li = document.createElement("li");
    li.className = state.currentSet?.id === set.id ? "active" : "";
    li.innerHTML = `<span class="set-name">${escapeHtml(set.name)}</span>
      <span class="meta">${set.photos.length}/10 photos · ${set.status}</span>
      <button type="button" class="rename-btn" title="Rename set">✏️</button>`;
    li.querySelector(".set-name").onclick = () => selectSet(set.id);
    li.querySelector(".meta").onclick = () => selectSet(set.id);
    li.querySelector(".rename-btn").onclick = (e) => {
      e.stopPropagation();
      renameSet(set);
    };
    list.appendChild(li);
  }
}

async function renameSet(set) {
  const name = prompt("Rename set (e.g. the photo theme):", set.name);
  if (name === null) return; // cancelled
  const trimmed = name.trim();
  if (!trimmed || trimmed === set.name) return;
  try {
    const updated = await api(`/api/sets/${set.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: trimmed }),
    });
    if (state.currentSet?.id === set.id) state.currentSet = updated;
    render();
  } catch (err) {
    alert(err.message);
  }
}

async function selectSet(id) {
  state.currentSet = await api(`/api/sets/${id}`);
  state.selectedPeople = null;
  state.selectedBackground = null;
  render();
}

$("#new-set-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const set = await api("/api/sets", {
    method: "POST",
    body: JSON.stringify({ name: $("#set-name").value.trim() }),
  });
  $("#set-name").value = "";
  await selectSet(set.id);
});

// ---------- Upload ----------
const dropzone = $("#dropzone");
const fileInput = $("#file-input");

$("#browse-btn").onclick = () => fileInput.click();
fileInput.onchange = () => uploadFiles(fileInput.files);

["dragover", "dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.toggle("dragover", evt === "dragover");
    if (evt === "drop") uploadFiles(e.dataTransfer.files);
  })
);

// ---------- Google Photos ----------
$("#google-photos-btn").onclick = async () => {
  if (!state.currentSet) return;
  const status = $("#google-status");
  const btn = $("#google-photos-btn");
  try {
    const { configured, connected } = await api("/api/google/status");
    if (!configured) {
      status.textContent = "⚠ Google Photos isn't configured on this server yet (see README).";
      return;
    }
    if (!connected) {
      window.location.href = "/auth/google"; // OAuth round-trip, comes back here
      return;
    }

    btn.disabled = true;
    status.textContent = "Opening Google Photos picker…";
    const { sessionId, pickerUri, pollIntervalMs } = await api("/api/google/picker-session", { method: "POST" });
    const pickerWindow = window.open(pickerUri, "_blank");
    if (!pickerWindow) {
      status.innerHTML = `Pop-up blocked — <a href="${pickerUri}" target="_blank" rel="noopener">open the picker</a>, then come back.`;
    } else {
      status.textContent = "Pick your photos in the Google Photos tab — I'll import them when you're done.";
    }

    // Poll until the user finishes picking (mediaItemsSet becomes true)
    await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const s = await api(`/api/google/picker-session/${sessionId}`);
          if (s.mediaItemsSet) {
            clearInterval(timer);
            resolve();
          }
        } catch (err) {
          clearInterval(timer);
          reject(err);
        }
      }, pollIntervalMs || 2000);
    });

    status.textContent = "Importing selected photos…";
    const result = await api(`/api/sets/${state.currentSet.id}/import-google`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
    state.currentSet = result.set;
    status.textContent = `✓ Imported ${result.imported} photo${result.imported === 1 ? "" : "s"}` +
      (result.skipped ? ` (${result.skipped} skipped — set is full)` : "");
  } catch (err) {
    status.textContent = `⚠ ${err.message}`;
  }
  btn.disabled = false;
  render();
};

// After the OAuth redirect lands back here, show the result once.
{
  const params = new URLSearchParams(location.search);
  const g = params.get("google");
  if (g) {
    history.replaceState({}, "", "/");
    if (g === "connected") $("#google-status").textContent = "✓ Google Photos connected — select a set, then click the button again to pick photos.";
    if (g === "denied") $("#google-status").textContent = "Google Photos access was denied.";
    if (g === "error") $("#google-status").textContent = "⚠ Connecting to Google Photos failed — try again.";
  }
}

async function uploadFiles(files) {
  if (!state.currentSet || !files.length) return;
  const form = new FormData();
  [...files].forEach((f) => form.append("photos", f));
  try {
    state.currentSet = await api(`/api/sets/${state.currentSet.id}/photos`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    alert(err.message);
  }
  fileInput.value = "";
  render();
}

// ---------- Processing ----------
$("#process-btn").onclick = async () => {
  try {
    state.currentSet = await api(`/api/sets/${state.currentSet.id}/process`, { method: "POST" });
    startPolling();
  } catch (err) {
    $("#process-status").textContent = `⚠ ${err.message}`;
  }
  render();
};

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    state.currentSet = await api(`/api/sets/${state.currentSet.id}`);
    render();
    if (state.currentSet.status !== "processing") clearInterval(state.pollTimer);
  }, 2500);
}

// ---------- Combine ----------
$("#combine-btn").onclick = async () => {
  const btn = $("#combine-btn");
  btn.disabled = true;
  btn.textContent = "Combining…";
  try {
    await api(`/api/sets/${state.currentSet.id}/combine`, {
      method: "POST",
      body: JSON.stringify({
        peoplePhotoId: state.selectedPeople,
        backgroundPhotoId: state.selectedBackground,
      }),
    });
    state.currentSet = await api(`/api/sets/${state.currentSet.id}`);
  } catch (err) {
    alert(err.message);
  }
  btn.textContent = "🪄 Combine selection";
  render();
};

// ---------- Render ----------
function render() {
  refreshSets();
  const set = state.currentSet;
  $("#upload-section").hidden = !set;
  if (!set) return;

  // Upload grid
  const uploadGrid = $("#upload-grid");
  uploadGrid.innerHTML = "";
  for (const photo of set.photos) {
    const c = card(`/files/${photo.uploadPath}`, badgeFor(photo));
    if (photo.status === "error" && photo.error) {
      const msg = document.createElement("div");
      msg.className = "card-error";
      msg.textContent = photo.error;
      c.appendChild(msg);
    }
    uploadGrid.appendChild(c);
  }
  $("#process-btn").hidden = !set.photos.length;
  const processing = set.status === "processing";
  $("#process-btn").disabled = processing;
  const done = set.photos.filter((p) => p.status === "done").length;
  const failed = set.photos.filter((p) => p.status === "error").length;
  const firstError = set.photos.find((p) => p.status === "error")?.error;
  $("#process-status").textContent = processing
    ? `Processing… ${done}/${set.photos.length} photos complete`
    : failed
      ? `${done} succeeded, ${failed} failed — ${firstError ? firstError + " — " : ""}you can retry processing`
      : "";

  // Pick grids
  const processed = set.photos.filter((p) => p.status === "done");
  $("#pick-section").hidden = !processed.length;
  const peopleGrid = $("#people-grid");
  const bgGrid = $("#background-grid");
  peopleGrid.innerHTML = "";
  bgGrid.innerHTML = "";
  for (const photo of processed) {
    peopleGrid.appendChild(
      pickCard(`/files/${photo.peoplePath}`, photo.id, "selectedPeople", true)
    );
    bgGrid.appendChild(
      pickCard(`/files/${photo.backgroundPath}`, photo.id, "selectedBackground", false)
    );
  }
  $("#combine-btn").disabled = !(state.selectedPeople && state.selectedBackground);

  // Composites
  $("#result-section").hidden = !set.composites.length;
  const list = $("#composite-list");
  list.innerHTML = "";
  for (const c of [...set.composites].reverse()) {
    const fig = document.createElement("figure");
    fig.innerHTML = `<img src="/files/${c.path}" alt="Combined result" />
      <figcaption><a href="/files/${c.path}" download="picture-perfect.jpg">⬇ Download</a></figcaption>`;
    list.appendChild(fig);
  }
}

function card(src, badge) {
  const div = document.createElement("div");
  div.className = "card";
  div.innerHTML = `<img src="${src}" loading="lazy" alt="" />${badge}`;
  return div;
}

function pickCard(src, photoId, stateKey, checker) {
  const div = card(src, "");
  if (checker) div.classList.add("checker");
  div.classList.add("pick");
  if (state[stateKey] === photoId) div.classList.add("selected");
  div.onclick = () => {
    state[stateKey] = state[stateKey] === photoId ? null : photoId;
    render();
  };
  return div;
}

function badgeFor(photo) {
  const labels = { uploaded: "", processing: "⏳ processing", done: "✓ separated", error: "⚠ failed" };
  const label = labels[photo.status];
  return label ? `<span class="badge ${photo.status}" title="${escapeHtml(photo.error || "")}">${label}</span>` : "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

refreshSets();
