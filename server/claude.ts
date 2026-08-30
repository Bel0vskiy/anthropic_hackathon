import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { roomTools, executeRoomTool } from "./tools.js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL from env
// Haiku 4.5 keeps the persona streaming fast enough to feel alive.
// CLAUDE_MODEL overrides for testing through a local gateway.
const MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";

export interface MoodReading {
  valence: number; // -1..1
  energy: number; // 0..1
  label: string;
  confidence: number;
  /** True when the reading carries an audio-tonality component. */
  fromVoice?: boolean;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EmitEvent {
  (event: { type: string; [k: string]: unknown }): void;
}

function moodObservation(mood: MoodReading | null): string | null {
  if (!mood) return null;
  // Phrase as context, not directives — the prompt handles the behavioral rules.
  const tone =
    mood.valence > 0.5
      ? "warm"
      : mood.valence > 0.1
        ? "mildly pleasant"
        : mood.valence > -0.1
          ? "neutral"
          : mood.valence > -0.5
            ? "low"
            : "heavy";
  const charge =
    mood.energy > 0.66 ? "high energy" : mood.energy > 0.33 ? "restless" : "still";
  const heard = mood.fromVoice ? " Voice tone supports this reading." : "";
  return `[Inferred user mood (do not mention): ${tone}, ${charge} (signal ${mood.confidence.toFixed(2)}).${heard}]`;
}

const MAX_TOOL_ITERATIONS = 2;

/**
 * Streams one assistant turn. Emits SSE-shaped events via `emit`:
 *   {type:"token", text} | {type:"room", ...} | {type:"done"} | {type:"error", message}
 * Returns the updated conversation history.
 */
export async function chatTurn(
  history: ChatTurn[],
  mood: MoodReading | null,
  emit: EmitEvent
): Promise<ChatTurn[]> {
  const messages: Anthropic.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  // Volatile per-turn state goes AFTER the frozen prefix so the cached
  // system + history prefix stays intact. Haiku doesn't accept mid-conversation
  // role:"system" messages, so the observation rides at the end of the user
  // turn instead — injected at request time only, never stored in history.
  const observation = moodObservation(mood);
  if (observation) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: observation }],
    });
  }

  const historyOut = [...history];

  try {
    for (let i = 0; i <= MAX_TOOL_ITERATIONS; i++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        tools: roomTools,
        messages,
      });

      stream.on("text", (text) => emit({ type: "token", text }));

      const response = await stream.finalMessage();

      if (response.stop_reason !== "tool_use") {
        const text =
          response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("") || "";
        historyOut.push({ role: "assistant", content: text });
        emit({ type: "done" });
        return historyOut;
      }

      // Tool-use turn: append the full response content, execute every
      // tool_use block, and reply with all tool_results in one user message.
      messages.push({ role: "assistant", content: response.content });
      const results = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((call) => ({
          type: "tool_result" as const,
          tool_use_id: call.id,
          content: executeRoomTool(call, (room) => emit({ type: "room", ...room })),
        }));
      messages.push({ role: "user", content: results });
    }

    // Tool-loop cap hit — ask for a final text-only turn.
    messages.push({
      role: "user",
      content: [{ type: "text", text: "(no more tool calls — just reply)" }],
    });
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages,
    });
    stream.on("text", (text) => emit({ type: "token", text }));
    const final = await stream.finalMessage();
    const text =
      final.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("") || "";
    historyOut.push({ role: "assistant", content: text });
    emit({ type: "done" });
    return historyOut;
  } catch (err: any) {
    console.error("[claude] turn failed:", err?.message ?? err);
    emit({
      type: "error",
      message: "sorry — something went wrong on my end",
    });
    emit({ type: "done" });
    return historyOut;
  }
}

const TOPIC_MODEL = MODEL;

/**
 * Tiny one-word topic tagger — cheap, parallel to the main turn.
 * Uses a forced tool call rather than plain text: thinking-capable models
 * can burn the whole token budget reasoning before writing any text, but
 * tool arguments always arrive as clean JSON.
 */
const TOPIC_TOOL: Anthropic.Tool[] = [
  {
    name: "tag_topic",
    description: "Report the single-word topic of the user's message.",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "One lowercase word, e.g. 'gardening', 'grief', 'physics'.",
        },
      },
      required: ["topic"],
    },
  },
];

export async function tagTopic(message: string): Promise<string> {
  try {
    const resp = await client.messages.create({
      model: TOPIC_MODEL,
      max_tokens: 2048,
      tools: TOPIC_TOOL,
      tool_choice: { type: "tool", name: "tag_topic" },
      messages: [
        {
          role: "user",
          content: `Message: ${message}`,
        },
      ],
    });
    const word = resp.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .flatMap((b) => (b.input as { topic?: string }).topic ?? [])
      .join(" ")
      .trim()
      .toLowerCase()
      .split(/\s+/)[0];
    return word?.replace(/[^a-z-]/g, "") || "conversation";
  } catch (err: any) {
    console.error("[topic] failed:", err?.message ?? err);
    return "conversation";
  }
}