/**
 * user_profiles is the authoritative source of display_name / email / dept.
 * Operators populate it by hand (INSERT / UPDATE) or via their own import
 * tool — no HTTP API layer. Queries that surface display_name overlay this
 * table on top of whatever fallback source each site originally used, so
 * hand-curated names always win.
 */

// { username: display_name } from user_profiles only. No fallback.
// Use when the caller already has its own fallback source (e.g. admin page
// falls back to allowed_users.name).
async function getProfilesNameMap(db) {
  const map = {};
  try {
    const rows = await db('user_profiles')
      .select('username', 'display_name')
      .whereNotNull('display_name')
      .andWhere('display_name', '!=', '');
    for (const r of rows) map[r.username] = r.display_name;
  } catch {}
  return map;
}

// { username: display_name } merging user_profiles (winner) + daily_stats (fallback).
// Use for stats endpoints whose fallback is daily_stats.display_name.
async function getDisplayNameMap(db) {
  const map = {};
  try {
    const statsRows = await db('daily_stats')
      .select('username', 'display_name')
      .whereNotNull('display_name')
      .andWhere('display_name', '!=', '')
      .groupBy('username');
    for (const r of statsRows) map[r.username] = r.display_name;
  } catch {}

  Object.assign(map, await getProfilesNameMap(db));
  return map;
}

module.exports = { getProfilesNameMap, getDisplayNameMap };
