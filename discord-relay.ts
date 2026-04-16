/**
 * Claude Discord Relay — with full memory loop
 *
 * Routing modes:
 * - direct:         channel name → agent profile → Claude CLI spawn
 * - smart-dispatch: #all-hands → Haiku identifies agents → spawn each in parallel
 * - broadcast:      message → all listed agents in parallel
 * - webhook-feed:   read-only channel receives proactive posts via HTTP webhook
 *
 * Memory loop:
 * 1. RECEIVE user's message
 * 2. QUERY Qdrant/Mem0 for relevant memories
 * 3. LOAD last N exchanges for this channel
 * 4. BUILD prompt: profile + memories + history + message
 * 5. SPAWN Claude CLI
 * 6. PROCESS memory intents ([REMEMBER:], [GOAL:], [DONE:])
 * 7. EXTRACT new memories via GPT-4o-mini (async, non-blocking)
 * 8. APPEND exchange to channel history
 * 9. SEND response to Discord
 */

import { Client, GatewayIntentBits, Events, type Message, type TextChannel } from "discord.js";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import type { Attachment } from "discord.js";
import { spawn } from "bun";

import { getRelevantContext, processMemoryIntents, storeMemory } from "./src/memory.ts";
import { getRecentExchanges, appendExchange } from "./src/conversation-history.ts";
import { extractMemories } from "./src/memory-extract.ts";

// ── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN       = process.env.DISCORD_BOT_TOKEN        || "";
const GUILD_ID        = process.env.DISCORD_GUILD_ID          || "";
const OWNER_USER_ID   = process.env.DISCORD_OWNER_USER_ID     || "";
const CLAUDE_PATH     = process.env.CLAUDE_PATH               || "/root/.local/bin/claude";
const PROJECT_DIR     = process.env.PROJECT_DIR               || process.cwd();
const AGENTS_DIR      = process.env.AGENTS_DIR                || join(PROJECT_DIR, "agents");
const CHANNEL_CONFIG  = join(import.meta.dir, "channels.json");
const CLAUDE_TIMEOUT  = parseInt(process.env.CLAUDE_TIMEOUT_MS || "900000", 10);
const FEED_WEBHOOK    = process.env.DISCORD_FEED_WEBHOOK_URL  || "";
const WEBHOOK_PORT    = parseInt(process.env.WEBHOOK_PORT || "3007", 10);
const ATTACHMENTS_DIR = join(PROJECT_DIR, "tmp", "attachments");
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20 MB
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = /\.(ts|js|py|md|txt|json|yaml|yml|toml|sh|sql|csv|xml|html|css|tsx|jsx)$/i;
const MAX_INLINE_SIZE = 50 * 1024; // 50 KB

if (!BOT_TOKEN)     throw new Error("DISCORD_BOT_TOKEN is required");
if (!GUILD_ID)      throw new Error("DISCORD_GUILD_ID is required");
if (!OWNER_USER_ID) throw new Error("DISCORD_OWNER_USER_ID is required");

// ── Session persistence ─────────────────────────────────────────────────────

const SESSIONS_FILE = join(PROJECT_DIR, "tmp", "discord-sessions.json");

interface ChannelSession {
  sessionId: string;
  agent: string;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
}

let sessionStore: Record<string, ChannelSession> = {};

async function loadSessions(): Promise<void> {
  try {
    const raw = await readFile(SESSIONS_FILE, "utf-8");
    sessionStore = JSON.parse(raw);
    console.log(`[Sessions] Loaded ${Object.keys(sessionStore).length} active sessions`);
  } catch {
    sessionStore = {};
    console.log("[Sessions] No existing sessions — starting fresh");
  }
}

async function saveSessions(): Promise<void> {
  await mkdir(join(PROJECT_DIR, "tmp"), { recursive: true });
  await writeFile(SESSIONS_FILE, JSON.stringify(sessionStore, null, 2));
}

function getSession(channelName: string, agentName: string): ChannelSession | null {
  const key = `${channelName}:${agentName}`;
  return sessionStore[key] || null;
}

function setSession(channelName: string, agentName: string, sessionId: string): void {
  const key = `${channelName}:${agentName}`;
  const existing = sessionStore[key];
  sessionStore[key] = {
    sessionId,
    agent: agentName,
    createdAt: existing?.createdAt || new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    messageCount: (existing?.messageCount || 0) + 1,
  };
  saveSessions().catch((err) => console.error("[Sessions] Save error:", err));
}

function clearSession(channelName: string, agentName: string): void {
  const key = `${channelName}:${agentName}`;
  delete sessionStore[key];
  saveSessions().catch((err) => console.error("[Sessions] Save error:", err));
}

function clearAllSessions(): number {
  const count = Object.keys(sessionStore).length;
  sessionStore = {};
  saveSessions().catch((err) => console.error("[Sessions] Save error:", err));
  return count;
}

// ── Active process tracking (for stop commands) ─────────────────────────────

interface ActiveProcess {
  proc: ReturnType<typeof spawn>;
  agent: string;
  channel: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  stopTyping?: () => void;
}

const activeProcesses = new Map<string, ActiveProcess>();

function processKey(channel: string, agent: string): string {
  return `${channel}:${agent}`;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface DirectChannel {
  type: "direct";
  agent: string;
  model: string;
}

interface SmartDispatchChannel {
  type: "smart-dispatch";
  agents: string[];
}

interface WebhookFeedChannel {
  type: "webhook-feed";
}

interface BroadcastChannel {
  type: "broadcast";
  agents: { name: string; model: string }[];
}

type ChannelConfig = DirectChannel | SmartDispatchChannel | WebhookFeedChannel | BroadcastChannel;

// ── Channel config ───────────────────────────────────────────────────────────

let channelMap: Record<string, ChannelConfig> = {};

async function loadChannelConfig(): Promise<void> {
  const raw = await readFile(CHANNEL_CONFIG, "utf-8");
  channelMap = JSON.parse(raw);
  console.log(`[Config] Loaded ${Object.keys(channelMap).length} channel configs`);
}

// ── Agent profile ────────────────────────────────────────────────────────────

async function loadAgentProfile(agentName: string): Promise<string> {
  const path = join(AGENTS_DIR, `${agentName}.md`);
  try {
    return await readFile(path, "utf-8");
  } catch {
    return `You are ${agentName}, an AI agent. Be helpful, concise, and direct.`;
  }
}

// ── Claude CLI spawn ─────────────────────────────────────────────────────────

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE") && key !== "CLAUDE_PATH") delete env[key];
  }
  delete env.TERM_PROGRAM;
  delete env.TERM_SESSION_ID;
  env.HOME = env.HOME || "/root";
  env.PATH = env.PATH || "/usr/local/bin:/usr/bin:/bin";
  return env;
}

// ── Attachment handling ───────────────────────────────────────────────────────

interface DownloadedFile {
  localPath: string;
  originalName: string;
  contentType: string | null;
  isImage: boolean;
  inlinedContent?: string;
}

interface AttachmentContext {
  imageFiles: DownloadedFile[];
  textContent: string[];
  fileReferences: string[];
  allPaths: string[];
}

async function ensureAttachmentsDir(): Promise<void> {
  await mkdir(ATTACHMENTS_DIR, { recursive: true });
}

async function downloadAttachment(
  attachment: Attachment,
  messageId: string,
): Promise<DownloadedFile | null> {
  if (attachment.size > MAX_ATTACHMENT_SIZE) {
    console.warn(`[Attach] Skipping ${attachment.name} — ${(attachment.size / 1024 / 1024).toFixed(1)}MB exceeds limit`);
    return null;
  }

  const isImage = IMAGE_TYPES.has(attachment.contentType ?? "");
  const isText = TEXT_EXTENSIONS.test(attachment.name ?? "");

  await ensureAttachmentsDir();
  const safeName = (attachment.name ?? "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = join(ATTACHMENTS_DIR, `${messageId}-${safeName}`);

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      console.error(`[Attach] Failed to download ${attachment.name}: HTTP ${response.status}`);
      return null;
    }

    const buffer = await response.arrayBuffer();
    await Bun.write(localPath, buffer);

    const result: DownloadedFile = {
      localPath,
      originalName: attachment.name ?? "file",
      contentType: attachment.contentType,
      isImage,
    };

    if (isText && attachment.size <= MAX_INLINE_SIZE) {
      result.inlinedContent = new TextDecoder().decode(buffer);
    }

    console.log(`[Attach] Downloaded ${attachment.name} (${(attachment.size / 1024).toFixed(1)}KB) → ${localPath}`);
    return result;
  } catch (err) {
    console.error(`[Attach] Download error for ${attachment.name}:`, err);
    return null;
  }
}

async function processAttachments(message: Message): Promise<AttachmentContext> {
  const ctx: AttachmentContext = {
    imageFiles: [],
    textContent: [],
    fileReferences: [],
    allPaths: [],
  };

  if (message.attachments.size === 0) return ctx;

  const downloads = await Promise.all(
    Array.from(message.attachments.values()).map((att) => downloadAttachment(att, message.id)),
  );

  for (const file of downloads) {
    if (!file) continue;
    ctx.allPaths.push(file.localPath);

    if (file.isImage) {
      ctx.imageFiles.push(file);
    } else if (file.inlinedContent) {
      ctx.textContent.push(
        `--- File: ${file.originalName} ---\n${file.inlinedContent}\n--- End of ${file.originalName} ---`,
      );
    } else {
      ctx.fileReferences.push(
        `File "${file.originalName}" saved at: ${file.localPath} (use Read tool to view)`,
      );
    }
  }

  return ctx;
}

async function cleanupAttachments(paths: string[]): Promise<void> {
  for (const p of paths) {
    try { await unlink(p); } catch { /* already gone */ }
  }
}

interface SpawnResult {
  text: string;
  sessionId: string | null;
}

async function spawnAgent(
  agentName: string,
  model: string,
  prompt: string,
  channelName = "",
  resumeSessionId?: string,
): Promise<SpawnResult> {
  const HARD_PROMPT_LIMIT = 150_000;
  if (prompt.length > HARD_PROMPT_LIMIT) {
    console.error(`[Spawn] ${agentName} prompt HARD CAPPED from ${prompt.length} to ${HARD_PROMPT_LIMIT} chars`);
    prompt = prompt.slice(0, HARD_PROMPT_LIMIT) + "\n\n[... prompt truncated due to length ...]";
  }

  const args = [CLAUDE_PATH];

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  args.push("-p", prompt, "--output-format", "json");
  if (model !== "claude") args.push("--model", model);

  const mode = resumeSessionId ? "RESUME" : "COLD";
  console.log(`[Spawn] ${agentName} (${model}) [${mode}] — prompt: ${prompt.length} chars`);

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_DIR,
    env: cleanEnv(),
  });

  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    proc.kill();
    console.warn(`[Spawn] ${agentName} timed out after ${CLAUDE_TIMEOUT / 1000}s`);
  }, CLAUDE_TIMEOUT);

  const key = processKey(channelName, agentName);
  activeProcesses.set(key, { proc, agent: agentName, channel: channelName, startedAt: Date.now(), timer });

  const chunks: Buffer[] = [];
  for await (const chunk of proc.stdout) {
    chunks.push(Buffer.from(chunk));
  }
  clearTimeout(timer);
  await proc.exited;

  const wasStopped = !activeProcesses.has(key);
  activeProcesses.delete(key);

  if (wasStopped) {
    return { text: "", sessionId: null };
  }

  const rawOutput = Buffer.concat(chunks).toString("utf-8").trim();

  if (didTimeout) {
    const timeoutMin = Math.round(CLAUDE_TIMEOUT / 60_000);
    let sessionId: string | null = null;
    try {
      const parsed = JSON.parse(rawOutput);
      sessionId = parsed.session_id || null;
    } catch {}
    const text = rawOutput
      ? `⏱️ *Timed out after ${timeoutMin} min — here's what I had so far:*\n\n${rawOutput}`
      : `⏱️ *Timed out after ${timeoutMin} min. The task was too complex. Try breaking it into smaller steps.*`;
    return { text, sessionId };
  }

  try {
    const parsed = JSON.parse(rawOutput);
    const sessionId = parsed.session_id || null;
    const text = parsed.result || "";
    console.log(`[Spawn] ${agentName} response: ${text.length} chars`);
    return { text, sessionId };
  } catch {
    console.warn(`[Spawn] ${agentName} JSON parse failed, using raw output`);
    return { text: rawOutput, sessionId: null };
  }
}

// ── Prompt builder (with memory) ─────────────────────────────────────────────

async function buildPrompt(
  agentName: string,
  userMessage: string,
  channelName: string,
  attachments?: AttachmentContext,
): Promise<string> {
  const profile = await loadAgentProfile(agentName);

  const [memoryContext, recentExchanges] = await Promise.all([
    getRelevantContext(null, userMessage).catch(() => ""),
    getRecentExchanges(channelName, 15).catch(() => []),
  ]);

  const MAX_HISTORY_CHARS = 8_000;
  let historyBlock = "";
  if (recentExchanges.length > 0) {
    const formatted: string[] = [];
    let charCount = 0;
    for (let i = recentExchanges.length - 1; i >= 0; i--) {
      const e = recentExchanges[i];
      const entry = `User: ${e.user}\nResponse: ${e.assistant}`;
      if (charCount + entry.length > MAX_HISTORY_CHARS && formatted.length > 0) break;
      formatted.unshift(entry);
      charCount += entry.length;
    }
    historyBlock = `RECENT CONVERSATION IN THIS CHANNEL (last ${formatted.length} exchanges):\n` +
      formatted.join("\n\n");
  }

  const MAX_MEMORY_CHARS = 4_000;
  const cappedMemory = memoryContext ? memoryContext.slice(0, MAX_MEMORY_CHARS) : "";

  const attachmentBlock = (() => {
    if (!attachments) return null;
    const parts: string[] = [];

    if (attachments.imageFiles.length > 0) {
      parts.push("ATTACHED IMAGES (use the Read tool on each path to view):");
      for (const img of attachments.imageFiles) {
        parts.push(`  - ${img.originalName}: ${img.localPath}`);
      }
      parts.push("IMPORTANT: You MUST use the Read tool on the image file paths above to see the images.");
    }

    if (attachments.textContent.length > 0) {
      parts.push("ATTACHED FILE CONTENTS:");
      parts.push(...attachments.textContent);
    }

    if (attachments.fileReferences.length > 0) {
      parts.push("ATTACHED FILES:");
      parts.push(...attachments.fileReferences);
    }

    return parts.length > 0 ? parts.join("\n") : null;
  })();

  let prompt = [
    profile,
    "---",
    cappedMemory || null,
    historyBlock || null,
    attachmentBlock || null,
    `User is messaging you in Discord channel #${channelName}.`,
    `User: ${userMessage}`,
    "",
    `Respond as ${agentName}. Be concise and direct. Keep response under 1800 characters for Discord.`,
    `If you need to run scripts or check files, do so and report results.`,
    `You may use [REMEMBER: fact] to store important facts to long-term memory.`,
    `IMPORTANT: ALWAYS include conversational text in your response. Never respond with ONLY [REMEMBER:]/[GOAL:]/[DONE:] tags.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const MAX_PROMPT_CHARS = 100_000;
  if (prompt.length > MAX_PROMPT_CHARS) {
    console.warn(`[Prompt] ${agentName} prompt too large (${prompt.length} chars), truncating...`);
    prompt = [
      profile,
      "---",
      cappedMemory || null,
      attachmentBlock || null,
      `User is messaging you in Discord channel #${channelName}.`,
      `User: ${userMessage}`,
      "",
      `Respond as ${agentName}. Be concise and direct. Keep response under 1800 characters for Discord.`,
      `You may use [REMEMBER: fact] to store important facts to long-term memory.`,
      `IMPORTANT: ALWAYS include conversational text in your response.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  console.log(`[Prompt] ${agentName}: profile=${profile.length} memory=${cappedMemory.length} history=${historyBlock.length} total=${prompt.length}`);
  return prompt;
}

// ── Lightweight prompt for resumed sessions ─────────────────────────────────

async function buildResumePrompt(
  agentName: string,
  userMessage: string,
  channelName: string,
  attachments?: AttachmentContext,
): Promise<string> {
  const memoryContext = await getRelevantContext(null, userMessage).catch(() => "");
  const MAX_MEMORY_CHARS = 4_000;
  const cappedMemory = memoryContext ? memoryContext.slice(0, MAX_MEMORY_CHARS) : "";

  const attachmentBlock = (() => {
    if (!attachments) return null;
    const parts: string[] = [];
    if (attachments.imageFiles.length > 0) {
      parts.push("ATTACHED IMAGES (use the Read tool on each path to view):");
      for (const img of attachments.imageFiles) {
        parts.push(`  - ${img.originalName}: ${img.localPath}`);
      }
    }
    if (attachments.textContent.length > 0) {
      parts.push("ATTACHED FILE CONTENTS:");
      parts.push(...attachments.textContent);
    }
    if (attachments.fileReferences.length > 0) {
      parts.push("ATTACHED FILES:");
      parts.push(...attachments.fileReferences);
    }
    return parts.length > 0 ? parts.join("\n") : null;
  })();

  const prompt = [
    cappedMemory ? `RELEVANT MEMORIES:\n${cappedMemory}` : null,
    attachmentBlock || null,
    `User: ${userMessage}`,
    "",
    `Respond as ${agentName}. Be concise and direct. Keep response under 1800 characters for Discord.`,
    `You may use [REMEMBER: fact] to store important facts to long-term memory.`,
    `IMPORTANT: ALWAYS include conversational text in your response.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return prompt;
}

// ── Post-response memory processing ─────────────────────────────────────────

async function processResponse(
  agentName: string,
  channelKey: string,
  userMessage: string,
  rawResponse: string,
): Promise<string> {
  const cleaned = await processMemoryIntents(null, rawResponse).catch(() => rawResponse);
  const response = cleaned || rawResponse.replace(/\[(REMEMBER|GOAL|DONE):\s*.+?\]/gi, "").trim() || rawResponse;

  extractMemories(userMessage, response)
    .then(async (memories) => {
      for (const mem of memories) {
        await storeMemory(mem, { type: "auto-extract", source: `discord-${agentName}` }).catch(() => {});
      }
      if (memories.length > 0) {
        console.log(`[Memory] Stored ${memories.length} extracted memories from ${agentName}`);
      }
    })
    .catch(() => {});

  await appendExchange(channelKey, userMessage, `[${agentName}] ${response}`).catch(() => {});

  return response;
}

// ── Smart dispatch ───────────────────────────────────────────────────────────

async function identifyAgents(message: string, pool: string[]): Promise<string[]> {
  // Build agent descriptions from loaded profiles (or use pool names as fallback)
  const agentList = pool.join(", ");
  const prompt = `You are a routing system. Which agents from the list should respond to this message?

Available agents: ${agentList}

User's message: "${message}"

Return ONLY a JSON array of 1-3 agent names. No other text. Example: ["agent1","agent2"]
Default to the first agent in the list if unclear.`;

  const result = await spawnAgent("router", "haiku", prompt);

  try {
    const match = result.text.match(/\[.*?\]/s);
    if (!match) return [pool[0]];
    const parsed = JSON.parse(match[0]) as string[];
    return parsed.filter((a) => pool.includes(a)).slice(0, 3);
  } catch {
    console.warn(`[Dispatch] Parse failed: ${result.text.substring(0, 100)}`);
    return [pool[0]];
  }
}

// ── Discord message send (handles 2000 char limit) ───────────────────────────

async function sendChunked(channel: TextChannel, text: string, prefix = ""): Promise<void> {
  const full = prefix + text;
  if (full.length <= 2000) {
    await channel.send(full);
    return;
  }
  if (prefix) await channel.send(prefix);
  const chunks = text.match(/.{1,1900}/gs) || [text];
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

async function handleMessage(message: Message): Promise<void> {
  if (message.author.id !== OWNER_USER_ID) return;
  if (message.author.bot) return;
  if (!("name" in message.channel)) return;

  const channelName = (message.channel as TextChannel).name;
  const text = message.content.trim();

  // ── Stop commands ─────────────────────────────────────────────────────────
  const lowerText = text.toLowerCase();
  const isStopAll = lowerText === "!stopall" || lowerText === "stopall" || lowerText === "/stopall";
  const stopMatch = !isStopAll && text.match(/^[!/]?stop(?:\s+(\w+))?$/i);
  if (isStopAll || stopMatch) {
    const ch = message.channel as TextChannel;
    const targetAgent = stopMatch ? stopMatch[1]?.toLowerCase() : undefined;

    if (isStopAll) {
      const count = activeProcesses.size;
      if (count === 0) {
        await ch.send("No agents running right now.");
        return;
      }
      for (const [key, entry] of activeProcesses) {
        clearTimeout(entry.timer);
        entry.stopTyping?.();
        try { entry.proc.kill(); } catch {}
        activeProcesses.delete(key);
      }
      await ch.send(`🛑 Stopped ${count} running agent(s).`);
      return;
    }

    if (targetAgent) {
      let killed = false;
      for (const [key, entry] of activeProcesses) {
        if (entry.agent === targetAgent) {
          clearTimeout(entry.timer);
          entry.stopTyping?.();
          try { entry.proc.kill(); } catch {}
          activeProcesses.delete(key);
          await ch.send(`🛑 Stopped **${targetAgent}**.`);
          killed = true;
          break;
        }
      }
      if (!killed) await ch.send(`No active process found for **${targetAgent}**.`);
      return;
    }

    let killed = false;
    for (const [key, entry] of activeProcesses) {
      if (entry.channel === channelName) {
        clearTimeout(entry.timer);
        entry.stopTyping?.();
        try { entry.proc.kill(); } catch {}
        activeProcesses.delete(key);
        await ch.send(`🛑 Stopped **${entry.agent}**.`);
        killed = true;
        break;
      }
    }
    if (!killed) await ch.send("Nothing running in this channel.");
    return;
  }

  // ── Session management commands ───────────────────────────────────────────
  if (lowerText === "!newsession" || lowerText === "/newsession") {
    const ch = message.channel as TextChannel;
    const config = channelMap[channelName];
    if (config && config.type === "direct") {
      clearSession(channelName, config.agent);
      await ch.send(`🔄 Session cleared for **${config.agent}**. Next message will cold-start.`);
    } else {
      let cleared = 0;
      for (const key of Object.keys(sessionStore)) {
        if (key.startsWith(`${channelName}:`)) {
          delete sessionStore[key];
          cleared++;
        }
      }
      await saveSessions();
      await ch.send(cleared > 0
        ? `🔄 Cleared ${cleared} session(s) for #${channelName}.`
        : `No active sessions in #${channelName}.`);
    }
    return;
  }

  if (lowerText === "!sessions" || lowerText === "/sessions") {
    const ch = message.channel as TextChannel;
    const entries = Object.entries(sessionStore);
    if (entries.length === 0) {
      await ch.send("No active sessions.");
      return;
    }
    const lines = entries.map(([key, s]) => {
      const age = Math.round((Date.now() - new Date(s.lastActivity).getTime()) / 60_000);
      return `**${key}** — ${s.messageCount} msgs, last active ${age}m ago`;
    });
    await ch.send(`📋 **Active Sessions:**\n${lines.join("\n")}`);
    return;
  }

  const config = channelMap[channelName];
  if (!config || config.type === "webhook-feed") return;

  const hasAttachments = message.attachments.size > 0;
  if (!text && !hasAttachments) return;

  const effectiveText = text || "[See attached files]";
  const attachmentCtx = hasAttachments ? await processAttachments(message) : undefined;

  console.log(`[Msg] #${channelName}: "${effectiveText.substring(0, 80)}"${hasAttachments ? ` +${message.attachments.size} attachment(s)` : ""}`);

  const ch = message.channel as TextChannel;
  await ch.sendTyping().catch(() => {});

  const startTyping = (agent: string) => {
    let elapsed = 0;
    const id = setInterval(async () => {
      elapsed += 8;
      await ch.sendTyping().catch(() => {});
      if (elapsed % 48 === 0) {
        const label = elapsed >= 60 ? `${Math.round(elapsed / 60)} min` : `${elapsed}s`;
        await ch.send(`⏳ *${agent} is still working… (${label})*`).catch(() => {});
      }
    }, 8_000);
    return () => clearInterval(id);
  };

  const activeStopFns: Array<() => void> = [];
  try {
    if (config.type === "direct") {
      const stopTyping = startTyping(config.agent);
      activeStopFns.push(stopTyping);
      const pKey = processKey(channelName, config.agent);

      const existingSession = getSession(channelName, config.agent);
      let prompt: string;
      let resumeId: string | undefined;

      if (existingSession) {
        prompt = await buildResumePrompt(config.agent, effectiveText, channelName, attachmentCtx);
        resumeId = existingSession.sessionId;
      } else {
        prompt = await buildPrompt(config.agent, effectiveText, channelName, attachmentCtx);
      }

      let resultPromise = spawnAgent(config.agent, config.model, prompt, channelName, resumeId);
      if (activeProcesses.has(pKey)) activeProcesses.get(pKey)!.stopTyping = stopTyping;
      let result = await resultPromise;

      if (resumeId && !result.text && !result.sessionId) {
        console.warn(`[Direct] ${config.agent} resume failed — falling back to cold start`);
        clearSession(channelName, config.agent);
        prompt = await buildPrompt(config.agent, effectiveText, channelName, attachmentCtx);
        resultPromise = spawnAgent(config.agent, config.model, prompt, channelName);
        if (activeProcesses.has(pKey)) activeProcesses.get(pKey)!.stopTyping = stopTyping;
        result = await resultPromise;
      }

      stopTyping();
      if (!result.text) return;

      if (result.sessionId) {
        setSession(channelName, config.agent, result.sessionId);
      }

      const response = await processResponse(config.agent, channelName, effectiveText, result.text);
      await sendChunked(ch, response || "(no response)");

    } else if (config.type === "smart-dispatch") {
      const routingHint = hasAttachments
        ? `${effectiveText} [includes ${message.attachments.size} attachment(s)]`
        : effectiveText;
      const agents = await identifyAgents(routingHint, config.agents);
      await ch.send(`Routing to **${agents.join(", ")}**...`);

      const agentTasks = agents.map(async (agentName) => {
        const agentCfg = channelMap[agentName] as DirectChannel | undefined;
        const model = agentCfg?.model || "sonnet";
        const stopTyping = startTyping(agentName);

        try {
          const prompt = await buildPrompt(agentName, effectiveText, channelName, attachmentCtx);
          const resultPromise = spawnAgent(agentName, model, prompt, channelName);
          const aKey = processKey(channelName, agentName);
          if (activeProcesses.has(aKey)) activeProcesses.get(aKey)!.stopTyping = stopTyping;
          const result = await resultPromise;
          stopTyping();
          if (!result.text) return;
          const response = await processResponse(agentName, channelName, effectiveText, result.text);
          await sendChunked(ch, response || "(no response)", `**[${agentName.toUpperCase()}]**\n`);
        } catch (agentErr) {
          stopTyping();
          const errMsg = agentErr instanceof Error ? agentErr.message : String(agentErr);
          await ch.send(`**[${agentName.toUpperCase()}]** Error: ${errMsg.substring(0, 200)}`).catch(() => {});
        }
      });
      await Promise.all(agentTasks);

    } else if (config.type === "broadcast") {
      const broadcastTasks = config.agents.map(async (agentDef) => {
        const stopTyping = startTyping(agentDef.name);
        try {
          const prompt = await buildPrompt(agentDef.name, effectiveText, channelName, attachmentCtx);
          const resultPromise = spawnAgent(agentDef.name, agentDef.model, prompt, channelName);
          const bKey = processKey(channelName, agentDef.name);
          if (activeProcesses.has(bKey)) activeProcesses.get(bKey)!.stopTyping = stopTyping;
          const result = await resultPromise;
          stopTyping();
          if (!result.text) return;
          const response = await processResponse(agentDef.name, channelName, effectiveText, result.text);
          await sendChunked(ch, response || "(no response)", `**[${agentDef.name.toUpperCase()}]**\n`);
        } catch (agentErr) {
          stopTyping();
          const errMsg = agentErr instanceof Error ? agentErr.message : String(agentErr);
          await ch.send(`**[${agentDef.name.toUpperCase()}]** Error: ${errMsg.substring(0, 200)}`).catch(() => {});
        }
      });
      await Promise.all(broadcastTasks);
    }
  } catch (err) {
    for (const stop of activeStopFns) stop();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Handler] Error in #${channelName}:`, msg);
    await ch.send(`Error: ${msg.substring(0, 200)}`).catch(() => {});
  } finally {
    if (attachmentCtx?.allPaths.length) {
      await cleanupAttachments(attachmentCtx.allPaths);
    }
  }
}

// ── Webhook feed server ──────────────────────────────────────────────────────

async function startWebhookServer(): Promise<void> {
  if (!FEED_WEBHOOK) {
    console.warn("[Webhook] DISCORD_FEED_WEBHOOK_URL not set — agent-feed posts disabled");
    return;
  }

  Bun.serve({
    port: WEBHOOK_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST") return new Response("Not Found", { status: 404 });

      // Agent report → per-agent Discord channel
      if (url.pathname === "/webhook/agent-report") {
        let body: { agent?: string; message?: string };
        try {
          body = (await req.json()) as { agent?: string; message?: string };
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const { agent, message } = body;
        if (!agent || !message) return new Response("Missing agent or message", { status: 400 });

        try {
          const guild = client.guilds.cache.get(GUILD_ID);
          if (!guild) return new Response("Guild not found", { status: 503 });

          const channel = guild.channels.cache.find(
            (ch) => ch.name === agent && ch.isTextBased()
          ) as TextChannel | undefined;

          if (!channel) return new Response("Channel not found", { status: 404 });

          await sendChunked(channel, message, `**[${agent.toUpperCase()} — Report]**\n`);
          return new Response("OK", { status: 200 });
        } catch (err) {
          console.error(`[Webhook] Agent report error:`, err);
          return new Response("Internal error", { status: 500 });
        }
      }

      // Agent feed → #agent-feed webhook
      if (url.pathname !== "/webhook/agent-feed") {
        return new Response("Not Found", { status: 404 });
      }

      let body: { agent?: string; message?: string };
      try {
        body = (await req.json()) as { agent?: string; message?: string };
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const { agent, message } = body;
      if (!agent || !message) return new Response("Missing agent or message", { status: 400 });

      try {
        const res = await fetch(FEED_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `**[${agent.toUpperCase()}]** ${message}` }),
        });
        if (!res.ok) return new Response("Discord webhook failed", { status: 502 });
        return new Response("OK", { status: 200 });
      } catch (err) {
        console.error("[Webhook] Error:", err);
        return new Response("Internal error", { status: 500 });
      }
    },
  });

  console.log(`[Webhook] Agent feed endpoint on port ${WEBHOOK_PORT}`);
}

// ── Discord client ────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[Discord] Ready as ${c.user.tag} — guild: ${GUILD_ID}`);
});

client.on(Events.MessageCreate, async (msg) => {
  if (msg.guildId !== GUILD_ID) return;
  await handleMessage(msg).catch((err) => {
    console.error("[Discord] Unhandled error:", err);
  });
});

// ── Startup ───────────────────────────────────────────────────────────────────

await loadChannelConfig();
await loadSessions();
await ensureAttachmentsDir();
await startWebhookServer();
await client.login(BOT_TOKEN);
console.log("[Discord] Bot online — memory loop + session persistence active");
