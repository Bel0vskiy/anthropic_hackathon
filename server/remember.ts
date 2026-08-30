// The room's memory: one small JSON file, keyed by person. A refresh used to
// wipe everything; now the conversation, the mood trail, and the moment of the
// last goodbye survive — the room can greet you like somewhere you've been.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatTurn } from "./claude.js";

const FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".room-memory.json"
);

export interface MoodStamp {
  t: number; // epoch ms
  valence: number;
  energy: number;
  label: string;
}

export interface PersonMemory {
  name: string;
  lastSeen: number;
  visits: number;
  lastMood: MoodStamp | null;
  /** Mood trail across sessions, oldest first, capped. */
  moods: MoodStamp[];
  /** Last one-word topic the room heard, for the welcome-back note. */
  topic: string | null;
  history: ChatTurn[];
}

const HISTORY_CAP = 40;
const MOODS_CAP = 64;

function loadAll(): Record<string, PersonMemory> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {}; // first run, or a corrupted file — start fresh
  }
}

let store = loadAll();
let writeTimer: NodeJS.Timeout | null = null;

function flush(): void {
  writeTimer = null;
  try {
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch (err: any) {
    console.error("[memory] write failed:", err?.message ?? err);
  }
}

/** Load (or lazily create) one person's memory. */
export function getPerson(key: string, name: string | null): PersonMemory {
  let m = store[key];
  if (!m) {
    m = store[key] = {
      name: name ?? key,
      lastSeen: 0,
      visits: 0,
      lastMood: null,
      moods: [],
      topic: null,
      history: [],
    };
  }
  return m;
}

/** Persist one person's memory, debounced — a burst of turns is one write. */
export function savePerson(key: string, m: PersonMemory): void {
  m.lastSeen = Date.now();
  m.history = m.history.slice(-HISTORY_CAP);
  m.moods = m.moods.slice(-MOODS_CAP);
  store[key] = m;
  if (!writeTimer) writeTimer = setTimeout(flush, 500);
}

/** What a returning visitor should be greeted with. */
export function recall(key: string): {
  known: boolean;
  name: string | null;
  lastSeen: number;
  visits: number;
  lastMood: MoodStamp | null;
  topic: string | null;
} {
  const m = store[key];
  if (!m || m.history.length === 0) {
    return { known: false, name: null, lastSeen: 0, visits: 0, lastMood: null, topic: null };
  }
  return {
    known: true,
    name: m.name,
    lastSeen: m.lastSeen,
    visits: m.visits,
    lastMood: m.lastMood,
    topic: m.topic,
  };
}