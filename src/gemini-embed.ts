/**
 * Gemini Embedding Module
 * Uses gemini-embedding-2-preview for multimodal embeddings (text, image, video, audio, PDF).
 * All modalities map to the same unified vector space — cross-modal search works natively.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_EMBED_MODEL = "gemini-embedding-2-preview";
const GEMINI_EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
const DEFAULT_DIMENSIONS = 3072;

type TaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING";

interface EmbedResponse {
  embedding?: { values?: number[] };
  error?: { message?: string; code?: number };
}

/**
 * Raw API call to Gemini embedContent endpoint.
 */
async function callGeminiEmbed(
  parts: Array<Record<string, any>>,
  taskType: TaskType = "RETRIEVAL_DOCUMENT",
  dimensions: number = DEFAULT_DIMENSIONS,
): Promise<number[]> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const resp = await fetch(`${GEMINI_EMBED_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts },
      taskType,
      outputDimensionality: dimensions,
    }),
    signal: AbortSignal.timeout(60000), // 60s for large media
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    console.error(`[gemini-embed] API error ${resp.status}:`, errText.slice(0, 500));
    throw new Error(`Gemini embed API error: ${resp.status}`);
  }

  const data = (await resp.json()) as EmbedResponse;
  if (data.error) {
    console.error(`[gemini-embed] API returned error:`, data.error.message);
    throw new Error(`Gemini embed error: ${data.error.message}`);
  }

  const values = data.embedding?.values;
  if (!values || !values.length) {
    throw new Error("Gemini embed returned empty embedding");
  }

  return values;
}

/**
 * Embed text content.
 */
export async function getGeminiTextEmbedding(
  text: string,
  taskType: TaskType = "RETRIEVAL_DOCUMENT",
  dimensions: number = DEFAULT_DIMENSIONS,
): Promise<number[]> {
  return callGeminiEmbed([{ text }], taskType, dimensions);
}

/**
 * Embed a media file (image, video, audio, PDF) from base64 data.
 */
export async function getGeminiMediaEmbedding(
  base64Data: string,
  mimeType: string,
  taskType: TaskType = "RETRIEVAL_DOCUMENT",
  dimensions: number = DEFAULT_DIMENSIONS,
): Promise<number[]> {
  return callGeminiEmbed(
    [{ inline_data: { mime_type: mimeType, data: base64Data } }],
    taskType,
    dimensions,
  );
}

/**
 * Embed interleaved content (text + media together) as a single embedding.
 * Useful for captioned images, annotated documents, etc.
 */
export async function getGeminiInterleavedEmbedding(
  text: string,
  base64Data: string,
  mimeType: string,
  taskType: TaskType = "RETRIEVAL_DOCUMENT",
  dimensions: number = DEFAULT_DIMENSIONS,
): Promise<number[]> {
  return callGeminiEmbed(
    [
      { text },
      { inline_data: { mime_type: mimeType, data: base64Data } },
    ],
    taskType,
    dimensions,
  );
}

/**
 * Check if a MIME type is a media file supported by Gemini embedding.
 */
export function isMediaFile(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType === "application/pdf"
  );
}

/**
 * Check if a MIME type is a text-based file that should have text extracted.
 */
export function isTextFile(mimeType: string, filename: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    filename.endsWith(".md") ||
    filename.endsWith(".txt") ||
    filename.endsWith(".csv") ||
    filename.endsWith(".json") ||
    filename.endsWith(".ts") ||
    filename.endsWith(".js") ||
    filename.endsWith(".py")
  );
}

export { DEFAULT_DIMENSIONS, GEMINI_EMBED_MODEL, type TaskType };
