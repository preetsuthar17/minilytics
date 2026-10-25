const DAY_MS = 86_400_000;

/** Days to keep raw data, from the optional RETENTION_DAYS setting. Null means keep everything. */
export function retentionDays(value: string | undefined): number | null {
  const days = Number(value);
  return Number.isInteger(days) && days > 0 ? days : null;
}

export function retentionCutoff(days: number, now: number) {
  return now - days * DAY_MS;
}

/**
 * Deletes events, sessions and visitors older than the cutoff. Old payments keep their amount and date
 * (so revenue totals stay correct) but lose the visitor, session and customer details.
 */
export function retentionStatements(db: D1Database, cutoff: number) {
  return [
    db.prepare('DELETE FROM events WHERE ts < ?').bind(cutoff),
    db.prepare('DELETE FROM sessions WHERE last_seen_at < ?').bind(cutoff),
    db
      .prepare(
        'DELETE FROM visitors WHERE first_seen < ? AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.site_id = visitors.site_id AND s.visitor_id = visitors.id)',
      )
      .bind(cutoff),
    db
      .prepare(
        'UPDATE payments SET visitor_id = NULL, session_id = NULL, customer_id = NULL, email = NULL, name = NULL WHERE ts < ? AND (visitor_id IS NOT NULL OR session_id IS NOT NULL OR customer_id IS NOT NULL OR email IS NOT NULL OR name IS NOT NULL)',
      )
      .bind(cutoff),
    db.prepare('DELETE FROM payment_claims WHERE ts < ?').bind(cutoff),
    db.prepare('DELETE FROM login_failures WHERE ts < ?').bind(cutoff),
  ];
}

export async function purgeOldData(db: D1Database, value: string | undefined, now = Date.now()) {
  const days = retentionDays(value);
  if (days === null) return null;
  const cutoff = retentionCutoff(days, now);
  await db.batch(retentionStatements(db, cutoff));
  return cutoff;
}
