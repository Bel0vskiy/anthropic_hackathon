// Minimal inline markup for the room's replies: **bold**, *italic*, `code`,
// and real line breaks. Everything is HTML-escaped before any tags are
// introduced, so the model can't inject anything the room doesn't speak.

export function mdInline(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?![\s)])/g, "$1<i>$2</i>")
    .replace(/\n/g, "<br>");
}