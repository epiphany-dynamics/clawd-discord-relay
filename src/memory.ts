/**
 * Memory Module
 * Tries Mem0 HTTP service first, falls back to direct Qdrant + Ollama embeddings.
 * Optionally searches a second brain collection (Gemini multimodal) if configured.
 */

import { getGeminiTextEmbedding } from "./gemini-embed.ts";

const MEM0_URL    = process.env.MEM0_URL    || "http://localhost:8100";
const QDRANT_URL  = process.env.QDRANT_URL  || "http://localhost:6333";
const OLLAMA_URL  = process.env.OLLAMA_URL  || "http://localhost:11434";
const COLLECTION  = process.env.QDRANT_COLLECTION || "claude-relay";
const BRAIN_V2_COLLECTION = process.env.QDRANT_BRAIN_COLLECTION || "";
const USER_ID     = process.env.MEMORY_USER_ID || "user";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

// --- Mem0 health cache ---
let mem0Healthy: boolean | null = null;
let mem0HealthCheckedAt = 0;
const HEALTH_CACHE_MS = 60_000;

async function isMem0Available(): Promise<boolean> {
  const now = Date.now();
  if (mem0Healthy !== null && now - mem0HealthCheckedAt < HEALTH_CACHE_MS) {
    return mem0Healthy;
  }
  try {
    const resp = await fetch(`${MEM0_URL}/health`, { signal: AbortSignal.timeout(3000) });
    mem0Healthy = resp.ok;
  } catch {
    mem0Healthy = false;
  }
  mem0HealthCheckedAt = now;
  return mem0Healthy;
}

// --- Ollama embedding helper ---
async function getEmbedding(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!resp.ok) throw new Error(`Ollama embedding failed: ${resp.status}`);
  const data = (await resp.json()) as { embedding: number[] };
  return data.embedding;
}

// --- Qdrant direct helpers ---
async function ensureQdrantCollection(): Promise<void> {
  const check = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`);
  if (check.ok) return;

  const testEmbed = await getEmbedding("test");
  const dim = testEmbed.length;

  await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors: { size: dim, distance: "Cosine" },
    }),
  });
}

async function qdrantStore(text: string, metadata: Record<string, string> = {}): Promise<void> {
  await ensureQdrantCollection();
  const embedding = await getEmbedding(text);
  const id = crypto.randomUUID();
  await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: [
        {
          id,
          vector: embedding,
          payload: {
            text,
            user_id: USER_ID,
            created_at: new Date().toISOString(),
            ...metadata,
          },
        },
      ],
    }),
  });
}

async function qdrantSearchRaw(query: string, limit = 5): Promise<Array<{ text: string; score: number; source?: string }>> {
  await ensureQdrantCollection();
  const embedding = await getEmbedding(query);
  const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vector: embedding,
      limit,
      with_payload: true,
      filter: {
        must: [{ key: "user_id", match: { value: USER_ID } }],
      },
    }),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as {
    result: Array<{ payload?: { text?: string; source?: string }; score?: number }>;
  };
  return (data.result || [])
    .filter((r) => r.payload?.text && (r.score ?? 0) > 0.3)
    .map((r) => ({ text: r.payload!.text!, score: r.score ?? 0, source: r.payload?.source }));
}

async function qdrantSearch(query: string, limit = 5): Promise<string[]> {
  const results = await qdrantSearchRaw(query, limit);
  return results.map((r) => r.text);
}

// --- Second Brain V2 (Gemini) search — optional ---
async function searchBrainV2(query: string, limit = 4): Promise<Array<{ text: string; score: number; source?: string }>> {
  if (!BRAIN_V2_COLLECTION) return [];
  try {
    const check = await fetch(`${QDRANT_URL}/collections/${BRAIN_V2_COLLECTION}`);
    if (!check.ok) return [];

    const embedding = await getGeminiTextEmbedding(query, "RETRIEVAL_QUERY");
    const resp = await fetch(`${QDRANT_URL}/collections/${BRAIN_V2_COLLECTION}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector: embedding,
        limit,
        with_payload: true,
        filter: {
          must: [{ key: "user_id", match: { value: USER_ID } }],
        },
      }),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      result: Array<{ payload?: { text?: string; source?: string }; score?: number }>;
    };
    return (data.result || [])
      .filter((r) => r.payload?.text && (r.score ?? 0) > 0.3)
      .map((r) => ({ text: r.payload!.text!, score: r.score ?? 0, source: r.payload?.source || "second-brain" }));
  } catch (err: any) {
    console.error("[memory] searchBrainV2 error (non-fatal):", err.message);
    return [];
  }
}

// --- Intent-aware expanded search ---
const TASK_INTENT_PATTERNS = [
  /\b(remind|reminder|todo|to-do|to do|task|tasks|agenda|tonight|today|tomorrow)\b/i,
  /\bwhat (should|do|am|was) i\b/i,
  /\bwhat('s| is| are) (on )?my\b/i,
  /\b(supposed to|need to|have to|gotta|planning)\b/i,
  /\b(catch me up|what did i miss|bring me up to speed)\b/i,
];

function detectsTaskIntent(message: string): boolean {
  return TASK_INTENT_PATTERNS.some((p) => p.test(message));
}

async function expandedMemorySearch(query: string, limit = 8): Promise<string[]> {
  const [primaryResults, brainV2Results] = await Promise.all([
    qdrantSearchRaw(query, limit),
    searchBrainV2(query, 4),
  ]);

  if (!detectsTaskIntent(query)) {
    const seen = new Map<string, { text: string; score: number; source?: string }>();
    for (const r of [...primaryResults, ...brainV2Results]) {
      const existing = seen.get(r.text);
      if (!existing || r.score > existing.score) {
        seen.set(r.text, r);
      }
    }
    const merged = Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, limit);
    const brainEntries = merged.filter((r) => r.source === "second-brain");
    const otherEntries = merged.filter((r) => r.source !== "second-brain");
    return [...brainEntries, ...otherEntries].slice(0, limit).map((r) => r.text);
  }

  console.log("[memory] Task intent detected, running expanded search");

  const expandedQueries = [
    "todo list tasks reminders things to do",
    "second brain notes reminders",
  ];

  const expandedResults = await Promise.all(
    expandedQueries.map((q) => qdrantSearchRaw(q, 4))
  );

  const allSeen = new Map<string, { text: string; score: number; source?: string }>();
  for (const result of [primaryResults, ...expandedResults, brainV2Results]) {
    for (const r of result) {
      const existing = allSeen.get(r.text);
      if (!existing || r.score > existing.score) {
        allSeen.set(r.text, r);
      }
    }
  }

  const merged = Array.from(allSeen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const brainEntries = merged.filter((r) => r.source === "second-brain");
  const otherEntries = merged.filter((r) => r.source !== "second-brain");
  const final = [...brainEntries, ...otherEntries].slice(0, limit);

  console.log(`[memory] Expanded search: ${primaryResults.length} primary + ${expandedResults.flat().length} expanded + ${brainV2Results.length} brainV2 -> ${final.length} merged`);

  return final.map((r) => r.text);
}

// --- Mem0 HTTP helpers ---
async function mem0Store(text: string): Promise<void> {
  const resp = await fetch(`${MEM0_URL}/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, user_id: USER_ID }),
  });
  if (!resp.ok) {
    mem0Healthy = false;
    mem0HealthCheckedAt = Date.now();
    throw new Error(`Mem0 /add failed: ${resp.status}`);
  }
}

async function mem0Search(query: string, limit = 5): Promise<string[]> {
  const resp = await fetch(`${MEM0_URL}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, user_id: USER_ID, limit }),
  });
  if (!resp.ok) throw new Error(`Mem0 /search failed: ${resp.status}`);
  const data = (await resp.json()) as Array<{ memory?: string; text?: string }>;
  return data.map((m) => m.memory || m.text || "").filter(Boolean);
}

// --- Core store / search ---
export async function storeMemory(text: string, metadata: Record<string, string> = {}): Promise<void> {
  if (await isMem0Available()) {
    await mem0Store(text);
  } else {
    console.warn("[memory] mem0 unavailable — skipping store. Will retry next message.");
  }
}

async function searchMemories(query: string, limit = 5): Promise<string[]> {
  if (await isMem0Available()) {
    return await mem0Search(query, limit);
  } else {
    return await qdrantSearch(query, limit);
  }
}

// ======================================================
// Exported functions
// ======================================================

/**
 * processMemoryIntents
 *
 * Parses special tags from the AI response text:
 *   [REMEMBER: ...]  — store a memory
 *   [GOAL: ... | DEADLINE: ...]  — store a goal with optional deadline
 *   [DONE: ...]  — mark a goal/task as completed
 *
 * Returns the cleaned text (tags stripped) after processing.
 */
export async function processMemoryIntents(
  _supabase: any,
  responseText: string,
): Promise<string> {
  let cleaned = responseText;

  try {
    const rememberRegex = /\[REMEMBER:\s*(.+?)\]/gi;
    let match: RegExpExecArray | null;
    while ((match = rememberRegex.exec(responseText)) !== null) {
      const memory = match[1].trim();
      if (memory) {
        try {
          await storeMemory(memory, { type: "remember" });
          console.log("[memory] stored REMEMBER:", memory.slice(0, 80));
        } catch (e) {
          console.error("[memory] failed to store REMEMBER:", e);
        }
      }
    }
    cleaned = cleaned.replace(rememberRegex, "").trim();

    const goalRegex = /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi;
    while ((match = goalRegex.exec(responseText)) !== null) {
      const goal = match[1].trim();
      const deadline = match[2]?.trim() || "none";
      if (goal) {
        try {
          const text = `GOAL: ${goal} | DEADLINE: ${deadline}`;
          await storeMemory(text, { type: "goal", deadline });
          console.log("[memory] stored GOAL:", goal.slice(0, 80));
        } catch (e) {
          console.error("[memory] failed to store GOAL:", e);
        }
      }
    }
    cleaned = cleaned.replace(goalRegex, "").trim();

    const doneRegex = /\[DONE:\s*(.+?)\]/gi;
    while ((match = doneRegex.exec(responseText)) !== null) {
      const done = match[1].trim();
      if (done) {
        try {
          const text = `COMPLETED: ${done} (at ${new Date().toISOString()})`;
          await storeMemory(text, { type: "done" });
          console.log("[memory] stored DONE:", done.slice(0, 80));
        } catch (e) {
          console.error("[memory] failed to store DONE:", e);
        }
      }
    }
    cleaned = cleaned.replace(doneRegex, "").trim();
  } catch (err) {
    console.error("[memory] processMemoryIntents error (non-fatal):", err);
  }

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned;
}

/**
 * getRelevantContext
 *
 * Searches stored memories for content relevant to the query.
 * Returns formatted string or empty string on failure.
 */
export async function getRelevantContext(
  _supabase: any,
  query: string,
  limit = 5,
): Promise<string> {
  try {
    if (!query || query.trim().length < 3) return "";

    let memories: string[];
    if (await isMem0Available()) {
      memories = await mem0Search(query, limit);
    } else {
      memories = await expandedMemorySearch(query, limit);
    }
    if (!memories.length) return "";

    const bullets = memories.map((m) => `- ${m}`).join("\n");
    return `RELEVANT MEMORIES:\n${bullets}`;
  } catch (err) {
    console.error("[memory] getRelevantContext error (non-fatal):", err);
    return "";
  }
}
