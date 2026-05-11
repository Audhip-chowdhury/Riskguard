-- migrations/004_collections.sql

-- Daily DPD snapshots (one per loan per day)
CREATE TABLE dpd_records (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL REFERENCES loans(id),
    as_of_date TEXT NOT NULL,
    days_past_due INTEGER NOT NULL,
    overdue_emi_count INTEGER NOT NULL,
    overdue_principal INTEGER NOT NULL,
    overdue_interest INTEGER NOT NULL,
    overdue_penalty INTEGER NOT NULL,
    bucket TEXT NOT NULL CHECK (bucket IN ('current', '1-30', '31-60', '61-90', '90+')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(loan_id, as_of_date)
);

CREATE INDEX idx_dpd_loan ON dpd_records(loan_id, as_of_date DESC);
CREATE INDEX idx_dpd_bucket ON dpd_records(bucket, as_of_date);

-- Collections actions (notices sent, calls made, etc.)
CREATE TABLE collections_actions (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL REFERENCES loans(id),
    action_type TEXT NOT NULL CHECK (action_type IN (
        'reminder_sent', 'warning_sent', 'recovery_notice_sent',
        'agent_call_made', 'restructure_offered', 'npa_flagged'
    )),
    trigger_dpd INTEGER NOT NULL,
    assigned_agent_user_id TEXT REFERENCES users(id),
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_actions_loan ON collections_actions(loan_id, created_at DESC);

-- Agent assignments for active collections cases
CREATE TABLE collections_assignments (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL UNIQUE REFERENCES loans(id),
    agent_user_id TEXT NOT NULL REFERENCES users(id),
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    assigned_by_user_id TEXT NOT NULL REFERENCES users(id),
    is_active INTEGER NOT NULL DEFAULT 1
);

-- Restructured loans (new terms applied to existing loan)
CREATE TABLE restructurings (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL REFERENCES loans(id),
    previous_principal_outstanding INTEGER NOT NULL,
    previous_tenure_remaining_months INTEGER NOT NULL,
    previous_emi INTEGER NOT NULL,
    previous_annual_rate_bps INTEGER NOT NULL,
    new_tenure_months INTEGER NOT NULL,
    new_emi INTEGER NOT NULL,
    new_annual_rate_bps INTEGER NOT NULL,
    reason TEXT NOT NULL,
    approved_by_user_id TEXT NOT NULL REFERENCES users(id),
    new_schedule_generated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Write-offs (uncollectable loans)
CREATE TABLE write_offs (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL UNIQUE REFERENCES loans(id),
    outstanding_at_write_off INTEGER NOT NULL,
    principal_lost INTEGER NOT NULL,
    interest_lost INTEGER NOT NULL,
    penalty_lost INTEGER NOT NULL,
    reason TEXT NOT NULL,
    written_off_by_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Post-write-off recoveries
CREATE TABLE recoveries (
    id TEXT PRIMARY KEY,
    write_off_id TEXT NOT NULL REFERENCES write_offs(id),
    loan_id TEXT NOT NULL REFERENCES loans(id),
    recovered_amount INTEGER NOT NULL,
    recovery_source TEXT NOT NULL,  -- 'voluntary_payment', 'legal_settlement', 'asset_sale'
    payflow_transaction_id TEXT,
    notes TEXT,
    recovered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
