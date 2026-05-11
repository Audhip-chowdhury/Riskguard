-- migrations/003_disbursement_repayment.sql

CREATE TABLE disbursements (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL UNIQUE REFERENCES loans(id),
    requested_amount INTEGER NOT NULL,
    processing_fee INTEGER NOT NULL DEFAULT 0,
    net_disbursed_amount INTEGER NOT NULL,
    payflow_transaction_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    error_message TEXT,
    disbursed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE emi_schedules (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL REFERENCES loans(id),
    installment_number INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    emi_amount INTEGER NOT NULL,
    principal_component INTEGER NOT NULL,
    interest_component INTEGER NOT NULL,
    opening_balance INTEGER NOT NULL,
    closing_balance INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'paid', 'partial', 'overdue', 'superseded')),
    paid_amount INTEGER NOT NULL DEFAULT 0,
    paid_at TEXT,
    late_penalty INTEGER NOT NULL DEFAULT 0,
    UNIQUE(loan_id, installment_number)
);

CREATE INDEX idx_emi_due ON emi_schedules(due_date, status) WHERE status = 'scheduled';
CREATE INDEX idx_emi_loan ON emi_schedules(loan_id, installment_number);

CREATE TABLE repayments (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL REFERENCES loans(id),
    emi_schedule_id TEXT REFERENCES emi_schedules(id),
    type TEXT NOT NULL CHECK (type IN ('auto_emi', 'manual', 'partial_prepayment', 'full_prepayment')),
    amount INTEGER NOT NULL,
    principal_paid INTEGER NOT NULL DEFAULT 0,
    interest_paid INTEGER NOT NULL DEFAULT 0,
    late_penalty_paid INTEGER NOT NULL DEFAULT 0,
    prepayment_penalty_paid INTEGER NOT NULL DEFAULT 0,
    payflow_transaction_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    error_message TEXT,
    initiated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX idx_repayments_loan ON repayments(loan_id, initiated_at DESC);

CREATE TABLE prepayments (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL REFERENCES loans(id),
    type TEXT NOT NULL CHECK (type IN ('partial', 'full')),
    prepayment_amount INTEGER NOT NULL,
    penalty_amount INTEGER NOT NULL,
    outstanding_at_prepayment INTEGER NOT NULL,
    repayment_id TEXT NOT NULL REFERENCES repayments(id),
    schedule_recalculated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
