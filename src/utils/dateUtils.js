// Date strings har jagah se alag format me aa sakti hain (ISO datetime
// attribute, "July 10, 2026" jaisa human-readable text, etc.) - JS ka
// built-in Date parser in-mein se zyada ko handle kar leta hai.
// Guessing kabhi nahi karte - agar parse na ho, to null return hota hai
// aur us post ko "date unknown" maan ke skip kiya jaata hai (safe default).
function parseDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Range ke start ke liye din ki shuruaat (00:00:00.000)
function startOfDay(dateStr) {
  const d = parseDateSafe(dateStr);
  if (!d) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

// Range ke end ke liye din ka aakhri pal (23:59:59.999) - taaki us poore
// din ke posts bhi range me shamil ho jaayein
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
