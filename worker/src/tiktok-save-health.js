/* Turns the saved TikTok queue health file into owner-facing problem lines.
   The text never includes a handle. */

export function tiktokSaveProblems(doc) {
  if (!doc || typeof doc !== "object") return [];
  const lines = Array.isArray(doc.lines) ? doc.lines : [];
  return lines.map((line) => String(line || "").trim()).filter(Boolean).slice(0, 4).map((text) => ({
    code: "tiktok_save_queue",
    level: "warn",
    text: text.slice(0, 300)
  }));
}
