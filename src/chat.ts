// Chat DOM helpers: streaming-safe message elements.
import { mdInline } from "./md";

export function addUserMessage(text: string): void {
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  document.getElementById("messages")!.appendChild(el);
  scrollDown();
}

/** Creates the assistant message element; the fn appends chunks and
 * re-renders the whole message through the tiny markdown filter. */
export function startAssistantMessage(): (text: string) => void {
  const el = document.createElement("div");
  el.className = "msg assistant";
  document.getElementById("messages")!.appendChild(el);
  scrollDown();
  let raw = "";
  return (chunk: string) => {
    raw += chunk;
    el.innerHTML = mdInline(raw);
    scrollDown();
  };
}

export function addSystemNote(text: string): void {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.style.opacity = "0.45";
  el.style.fontSize = "12px";
  el.textContent = text;
  document.getElementById("messages")!.appendChild(el);
  scrollDown();
}

export function updateStatus(moodLabel: string | null): void {
  const dot = document.getElementById("mood-dot")!;
  const moodEl = document.getElementById("mood-label")!;
  if (moodLabel) {
    moodEl.textContent = moodLabel;
    const colors: Record<string, string> = {
      // text classifier
      warm: "#e9b96a",
      low: "#6a7de9",
      // voice circumplex labels
      excited: "#f0c87a",
      content: "#b8c98a",
      neutral: "#9a9aa8",
      angry: "#c96a5a",
      sad: "#5a6bd6",
    };
    const color = colors[moodLabel] ?? "#555";
    dot.style.background = color;
    dot.style.boxShadow = `0 0 12px ${color}`;
  }
}

function scrollDown(): void {
  const msgs = document.getElementById("messages")!;
  msgs.scrollTop = msgs.scrollHeight;
}