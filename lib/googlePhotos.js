// Google Photos integration via the Photos Picker API.
//
// Google removed general library access for third-party apps in 2025; the
// supported pattern is now the Picker API: we create a "picking session",
// send the user to a Google-hosted picker UI (pickerUri), poll until they
// finish selecting, then download exactly the items they picked.
// Docs: https://developers.google.com/photos/picker/guides/get-started-picker

const PICKER_BASE = "https://photospicker.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

export function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// ---- OAuth 2.0 (authorization code flow) ----

export function authUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // ask for a refresh token
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google OAuth error: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

export async function exchangeCode(code, redirectUri) {
  const data = await tokenRequest({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

export async function refreshAccessToken(refreshToken) {
  const data = await tokenRequest({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  return {
    accessToken: data.access_token,
    refreshToken, // Google usually doesn't re-issue it on refresh
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

// ---- Picker API ----

async function pickerRequest(accessToken, path, options = {}) {
  const res = await fetch(`${PICKER_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    const err = new Error("Google token expired");
    err.code = 401;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Picker API error ${res.status}: ${data.error?.message || "unknown"}`);
  }
  return data;
}

/** Create a picking session -> { id, pickerUri, pollingConfig } */
export function createPickerSession(accessToken) {
  return pickerRequest(accessToken, "/sessions", { method: "POST" });
}

/** Poll a session -> { mediaItemsSet: boolean, ... } */
export function getPickerSession(accessToken, sessionId) {
  return pickerRequest(accessToken, `/sessions/${encodeURIComponent(sessionId)}`);
}

export function deletePickerSession(accessToken, sessionId) {
  return pickerRequest(accessToken, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  }).catch(() => {}); // best-effort cleanup
}

/** List everything the user picked in a finished session. */
export async function listPickedItems(accessToken, sessionId) {
  const items = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ sessionId, pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await pickerRequest(accessToken, `/mediaItems?${params}`);
    items.push(...(data.mediaItems || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * Download the bytes of a picked item. baseUrls require the auth header and
 * a size/download parameter; "=d" requests the original-quality bytes.
 */
export async function downloadMediaItem(accessToken, baseUrl) {
  const res = await fetch(`${baseUrl}=d`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to download media item (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
