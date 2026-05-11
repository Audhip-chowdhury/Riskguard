-- migrations/001_borrowers_scoring.sql

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'underwriter', 'senior_underwriter', 'collections_agent', 'admin')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Employee details (mirrors what PayFlow has for users, with HR-style data needed for scoring)
CREATE TABLE employees (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    payflow_wallet_id TEXT NOT NULL,  -- borrower's PayFlow wallet
    department TEXT NOT NULL,
    designation TEXT NOT NULL,
    department_risk_tier INTEGER NOT NULL DEFAULT 3 CHECK (department_risk_tier BETWEEN 1 AND 5), -- 1=safest, 5=riskiest
    monthly_salary INTEGER NOT NULL,  -- in paise
    joined_at TEXT NOT NULL,
    manager_user_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_employees_user ON employees(user_id);
CREATE INDEX idx_employees_manager ON employees(manager_user_id);

-- Borrower profile (one per employee, created on first interaction)
CREATE TABLE borrowers (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL UNIQUE REFERENCES employees(id),
    current_score INTEGER NOT NULL DEFAULT 0,
    current_band TEXT NOT NULL DEFAULT 'Poor' CHECK (current_band IN ('Poor', 'Fair', 'Good', 'Very Good', 'Excellent')),
    credit_limit INTEGER NOT NULL DEFAULT 0,  -- in paise
    available_limit INTEGER NOT NULL DEFAULT 0,  -- credit_limit minus active exposure
    kyc_status TEXT NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'passed', 'failed')),
    kyc_verified_at TEXT,
    last_scored_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Configurable scoring weights
CREATE TABLE scoring_factors (
    id TEXT PRIMARY KEY,
    factor_name TEXT UNIQUE NOT NULL,
    weight INTEGER NOT NULL,  -- percentage * 100, e.g., 25% = 2500
    is_active INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Score snapshots (immutable history)
CREATE TABLE score_snapshots (
    id TEXT PRIMARY KEY,
    borrower_id TEXT NOT NULL REFERENCES borrowers(id),
    score INTEGER NOT NULL,
    band TEXT NOT NULL,
    factor_breakdown TEXT NOT NULL,  -- JSON: { "tenure": 200, "salary": 150, ... }
    credit_limit_at_snapshot INTEGER NOT NULL,
    reason TEXT NOT NULL,  -- e.g., 'initial', 'recompute', 'after_loan_disbursed'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_snapshots_borrower ON score_snapshots(borrower_id, created_at DESC);

-- Manual adjustments by admins (immutable audit trail)
CREATE TABLE manual_adjustments (
    id TEXT PRIMARY KEY,
    borrower_id TEXT NOT NULL REFERENCES borrowers(id),
    admin_user_id TEXT NOT NULL REFERENCES users(id),
    previous_score INTEGER NOT NULL,
    new_score INTEGER NOT NULL,
    previous_limit INTEGER NOT NULL,
    new_limit INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Idempotency store
CREATE TABLE idempotency_store (
    key_hash TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    api_key_id TEXT NOT NULL,
    request_payload_hash TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL DEFAULT (datetime('now', '+24 hours'))
);

CREATE INDEX idx_idempotency_expires ON idempotency_store(expires_at);

-- Seed default scoring factors
INSERT INTO scoring_factors (id, factor_name, weight, description) VALUES
    (lower(hex(randomblob(16))), 'tenure', 2500, 'Years at company'),
    (lower(hex(randomblob(16))), 'salary', 3000, 'Monthly salary level'),
    (lower(hex(randomblob(16))), 'debt_ratio', 2000, 'Existing debt as % of salary'),
    (lower(hex(randomblob(16))), 'repayment_history', 2000, 'Historical loan performance'),
    (lower(hex(randomblob(16))), 'department_risk', 500, 'Department risk tier');
