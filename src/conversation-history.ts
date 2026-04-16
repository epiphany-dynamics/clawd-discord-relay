/**
 * Conversation History Manager
 * Stores per-user conversation exchanges in a local JSON file.
 * Used to inject recent context into each Claude prompt.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "/root", ".claude-relay");
const HISTORY_FILE = join(RELAY_DIR, "conversation_history.json");
const MAX_EXCHANGES_PER_USER = 50;

export interface Exchange {
  timestamp: string;
  user: string;
  assistant: string;
}

interface HistoryStore {
  [userId: string]: Exchange[];
}

let historyCache: HistoryStore | null = null;

async function loadHistory(): Promise<HistoryStore> {
  if (historyCache) return historyCache;
  try {
    const content = await readFile(HISTORY_FILE, "utf-8");
    historyCache = JSON.parse(content);
    return historyCache!;
  } catch {
    historyCache = {};
    return historyCache;
  }
}

async function saveHistory(store: HistoryStore): Promise<void> {
  historyCache = store;
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(store, null, 2));
}

/**
 * Get the last N exchanges for a user.
 */
export async function getRecentExchanges(userId: string, count: number = 10): Promise<Exchange[]> {
  const store = await loadHistory();
  const exchanges = store[userId] || [];
  return exchanges.slice(-count);
}

/**
 * Append a new exchange and persist to disk.
 */
export async function appendExchange(userId: string, userMsg: string, assistantMsg: string): Promise<void> {
  const store = await loadHistory();
  if (!store[userId]) store[userId] = [];

  store[userId].push({
    timestamp: new Date().toISOString(),
    user: userMsg.substring(0, 5000),
    assistant: assistantMsg.substring(0, 5000),
  });

  // Trim to max
  if (store[userId].length > MAX_EXCHANGES_PER_USER) {
    store[userId] = store[userId].slice(-MAX_EXCHANGES_PER_USER);
  }

  await saveHistory(store);
}
