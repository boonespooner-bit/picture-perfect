// AI photo separation via the Gemini image model ("Nano Banana").
//
// Why Gemini and not Claude: Claude's API is text/vision-analysis only — it can
// describe an image but cannot output an edited image. Gemini's image models
// natively support image *editing* (removing people, isolating subjects,
// reconstructing backgrounds), which is exactly what this app needs.
//
// Two operations per photo:
//   1. extractPeople    -> the people isolated on a solid chroma-green backdrop,
//                          which we then key out into real alpha transparency.
//   2. extractBackground-> the scene with all people removed and the background
//                          reconstructed (generative inpainting).
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

let client;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey");
  }
  client = client || new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const PEOPLE_PROMPT =
  "Edit this photo: keep every person exactly as they appear (same pose, clothing, " +
  "lighting, and position in the frame) and replace the entire background with a " +
  "single flat, uniform, pure green color (#00FF00). No shadows, no gradients, no " +
  "texture in the background — only solid green behind and around the people. " +
  "Do not alter the people in any way.";

const BACKGROUND_PROMPT =
  "Edit this photo: remove every person from the image completely. Reconstruct the " +
  "background naturally where the people were standing, matching the surrounding " +
  "scenery, lighting, and perspective. Keep everything else in the photo exactly " +
  "the same. The result should look like the same photo taken with nobody in it.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull a suggested retry delay (seconds) out of a Gemini 429 error, if present.
function retryDelaySeconds(err) {
  const raw = String(err?.message || "");
  const m = raw.match(/"retryDelay"\s*:\s*"(\d+)s"/) || raw.match(/retin\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

async function editImage(imageBuffer, mimeType, prompt) {
  const ai = getClient();
  const MAX_ATTEMPTS = 4;

  for (let attempt = 1; ; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [
          { inlineData: { mimeType, data: imageBuffer.toString("base64") } },
          { text: prompt },
        ],
        // Image models are multimodal: TEXT must accompany IMAGE or requests fail.
        config: { responseModalities: ["TEXT", "IMAGE"] },
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p) => p.inlineData?.data);
      if (!imagePart) {
        const text = parts.find((p) => p.text)?.text || "no image returned";
        throw new Error(`Gemini did not return an image: ${text.slice(0, 200)}`);
      }
      return Buffer.from(imagePart.inlineData.data, "base64");
    } catch (err) {
      const is429 = /429|RESOURCE_EXHAUSTED|quota/i.test(String(err?.message || err));
      if (!is429 || attempt >= MAX_ATTEMPTS) throw err;
      // Respect the server's suggested delay, else exponential backoff (2s,4s,8s).
      const waitMs = (retryDelaySeconds(err) || 2 ** attempt) * 1000;
      await sleep(waitMs);
    }
  }
}

// Convert chroma-green pixels to transparency. Image models don't reliably emit
// a true alpha channel, so we ask for a flat green screen and key it out here.
async function chromaKeyGreen(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Green dominates both red and blue -> treat as backdrop.
    if (g > 90 && g > r * 1.4 && g > b * 1.4) {
      data[i + 3] = 0;
    } else if (g > 90 && g > r * 1.15 && g > b * 1.15) {
      // Edge pixels: partially transparent and de-spill the green tint.
      data[i + 3] = Math.round(data[i + 3] * 0.5);
      data[i + 1] = Math.round((r + b) / 2);
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** Returns a PNG buffer of the people with a transparent background. */
export async function extractPeople(imageBuffer, mimeType) {
  const greenScreened = await editImage(imageBuffer, mimeType, PEOPLE_PROMPT);
  return chromaKeyGreen(greenScreened);
}

/** Returns an image buffer of the scene with all people removed. */
export async function extractBackground(imageBuffer, mimeType) {
  const result = await editImage(imageBuffer, mimeType, BACKGROUND_PROMPT);
  return sharp(result).jpeg({ quality: 92 }).toBuffer();
}

/** Composite a people cutout (transparent PNG) onto a background image. */
export async function composite(backgroundBuffer, peopleBuffer) {
  const bg = sharp(backgroundBuffer);
  const { width, height } = await bg.metadata();
  const people = await sharp(peopleBuffer)
    .resize(width, height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return bg
    .composite([{ input: people }])
    .jpeg({ quality: 92 })
    .toBuffer();
}
