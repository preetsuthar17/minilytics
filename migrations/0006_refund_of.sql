-- Which payment a refund belongs to, so a refund follows its payment when that payment gets linked to a visitor later.
ALTER TABLE payments ADD COLUMN refund_of TEXT;
UPDATE payments SET refund_of = substr(id, 8) WHERE kind = 'refund' AND refund_of IS NULL AND id LIKE 'refund\_%' ESCAPE '\';
UPDATE payments SET refund_of = substr(id, 1, length(id) - 7) WHERE kind = 'refund' AND refund_of IS NULL AND id LIKE '%:refund';
CREATE INDEX IF NOT EXISTS payments_refund_of ON payments (site_id, refund_of);
