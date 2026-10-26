-- Per-visitor lookups: visit counts on the Journey tab, the visitor profile and payment credit.
CREATE INDEX IF NOT EXISTS sessions_visitor_time ON sessions (site_id, visitor_id, started_at);
CREATE INDEX IF NOT EXISTS events_visitor_time ON events (site_id, visitor_id, ts);
CREATE INDEX IF NOT EXISTS payments_visitor ON payments (site_id, visitor_id);
