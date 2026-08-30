// Minimal inline markup for the room's replies: **bold**, *italic*, `code`,
// and real line breaks. Everything is HTML-escaped before any tags are
// introduced, so the model can't inject anything the room doesn't speak.

/** If a marker appears an odd number of times, its last (dangling) half is a
 *  piece mid-arrival — drop it so the reveal never flashes raw asterisks. */
function stripDangling(s: string, marker: string): string {
  if ((s.split(marker).length - 1) % 2 === 1) {
    const i = s.lastIndexOf(marker);
    return s.slice(0, i) + s.slice(i + marker.length);
  }
  return s;
}

export function mdInline(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // While text arrives in pieces, a marker can be split across chunks.
  const balanced = stripDangling(stripDangling(esc, "**"), "`");
  return balanced
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?![\s)])/g, "$1<i>$2</i>")
    .replace(/\n/g, "<br>");
}