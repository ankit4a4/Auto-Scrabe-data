// Date strings can come in different formats from different places (ISO
// datetime attribute, human-readable text like "July 10, 2026", etc.) -
// JS's built-in Date parser handles most of these.
// We never guess - if parsing fails, null is returned and that post is
// treated as "date unknown" and skipped (safe default).
function parseDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Start of the day for the range's start (00:00:00.000)
function startOfDay(dateStr) {
  const d = parseDateSafe(dateStr);
  if (!d) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

// The last moment of the day for the range's end (23:59:59.999) - so
// posts throughout that entire day are also included in the range
function endOfDay(dateStr) {
  const d = parseDateSafe(dateStr);
  if (!d) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatDateForLog(date) {
  if (!date) return "N/A";
  return date.toISOString().split("T")[0];
}

module.exports = { parseDateSafe, startOfDay, endOfDay, formatDateForLog };
