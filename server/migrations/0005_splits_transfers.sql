-- E2.S4–S5: split lines and transfer pairing (FR-15, FR-16).
--
-- Representation decisions (architecture §5, binding for E3/E4/E6):
--
--  * SPLITS are child rows IN THIS SAME TABLE with parent_id set. The parent
--    carries the account-facing total (and NULL category); each child carries
--    category + amount + memo and the children must sum exactly to the parent
--    (enforced in ledger code — FR-15). Child rows MIRROR the parent's date/
--    status/approved so the budget engine's activity GROUP BY (category, date)
--    sees lines directly, with no join. Every balance SUM and the register
--    listing must therefore filter parent_id IS NULL (children would double
--    count); E3's activity sum keys on category_id, which is NULL on split
--    parents — so it naturally counts lines once.
--
--  * TRANSFERS are two ordinary rows sharing a transfer_id (FR-16). Edits to
--    amount/date cascade to the peer (amount negated); deletes remove both.
--    Cleared status stays per-side (FR-17). Transfer rows have NULL payee_id —
--    the "Transfer: <other account>" pseudo-payee is derived on read and never
--    enters the suggestable payee list (S5 AC-4).
ALTER TABLE transactions ADD COLUMN parent_id TEXT REFERENCES transactions(id);
ALTER TABLE transactions ADD COLUMN transfer_id TEXT;

-- Children-of-parent lookup (register lines, cascade delete).
CREATE INDEX idx_transactions_parent ON transactions(parent_id);
-- Peer lookup for cascades and "Transfer: X" rendering.
CREATE INDEX idx_transactions_transfer ON transactions(transfer_id);
