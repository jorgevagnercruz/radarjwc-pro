ALTER TABLE payment_receipts ALTER COLUMN plan_type DROP NOT NULL;
ALTER TABLE payment_receipts ALTER COLUMN amount_cents DROP NOT NULL;
ALTER TABLE payment_receipts ALTER COLUMN paid_at DROP NOT NULL;
