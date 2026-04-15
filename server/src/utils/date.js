/**
 * Date utilities — all business dates use local timezone (set TZ=Asia/Shanghai).
 */

/**
 * Format a Date as YYYY-MM-DD in local timezone.
 */
function localDate(d) {
  if (typeof d === 'string') d = new Date(d);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Get current time as local ISO string (YYYY-MM-DDTHH:mm:ss).
 */
function localNow() {
  const d = new Date();
  return `${localDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * Extract YYYY-MM-DD from any time string, converting to local timezone.
 * Handles: ISO UTC (Z), ISO with offset (+08:00), plain date (YYYY-MM-DD).
 */
function toLocalDate(timeStr) {
  if (!timeStr) return localDate(new Date());
  // Already a plain date
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeStr)) return timeStr;
  // Parse as Date (respects timezone info in the string)
  return localDate(new Date(timeStr));
}

module.exports = { localDate, localNow, toLocalDate };
