-- migrations/002_loan_origination.sql

-- Configurable interest rates per product + score band
CREATE TABLE interest_rate_config (
    id TEXT PRIMARY KEY,
    product_type TEXT NOT NULL CHECK (product_type IN ('salary_advance', 'personal_loan', 'line_of_credit', 'bnpl', 'emergency_loan')),
    score_band TEXT NOT NULL CHECK (score_band IN ('Poor', 'Fair', 'Good', 'Very Good', 'Excellent')),
    base_rate_bps INTEGER NOT NULL,        -- basis points, e.g., 1200 = 12.00%
    risk_premium_bps INTEGER NOT NULL,     -- additional bps based on band
    is_active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(product_type, score_band)
);

-- Loan applications (separate from loans — applications can be rejected/withdrawn before becoming loans)
CREATE TABLE loan_applications (
    id TEXT PRIMARY KEY,
    borrower_id TEXT NOT NULL REFERENCES borrowers(id),
    product_type TEXT NOT NULL CHECK (product_type IN ('salary_advance', 'personal_loan', 'line_of_credit', 'bnpl', 'emergency_loan')),
    requested_amount INTEGER NOT NULL CHECK (requested_amount > 0),  -- paise
    requested_tenure_months INTEGER,  -- nullable for line_of_credit, bnpl
    purpose TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
        'submitted', 'under_review', 'committee_review', 'approved', 'rejected', 'withdrawn'
    )),
    approval_tier TEXT CHECK (approval_tier IN ('auto', 'manual', 'committee')),
    score_at_application INTEGER NOT NULL,
    band_at_application TEXT NOT NULL,
    available_limit_at_application INTEGER NOT NULL,
    debt_ratio_at_application INTEGER,  -- ratio * 10000, e.g., 4523 = 0.4523
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by_user_id TEXT REFERENCES users(id),
    reviewed_at TEXT,
    committee_reviewed_by_user_id TEXT REFERENCES users(id),
    committee_reviewed_at TEXT,
    rejection_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_applications_borrower ON loan_applications(borrower_id, status);
CREATE INDEX idx_applications_status ON loan_applications(status, submitted_at DESC);

-- Loans (created after approval, lifecycle from disbursement onwards)
CREATE TABLE loans (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL UNIQUE REFERENCES loan_applications(id),
    borrower_id TEXT NOT NULL REFERENCES borrowers(id),
    product_type TEXT NOT NULL,
    principal_amount INTEGER NOT NULL,  -- approved amount in paise
    tenure_months INTEGER,
    annual_interest_rate_bps INTEGER NOT NULL,  -- final rate in basis points
    processing_fee_amount INTEGER NOT NULL DEFAULT 0,  -- in paise
    status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN (
        'approved', 'disbursed', 'active', 'closed', 'prepaid', 'defaulted', 'written_off', 'restructured'
    )),
    approved_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_loans_borrower ON loans(borrower_id, status);

-- Underwriting decisions (audit trail)
CREATE TABLE underwriting_decisions (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES loan_applications(id),
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'escalated_to_committee')),
    decided_by_user_id TEXT NOT NULL REFERENCES users(id),
    decision_tier TEXT NOT NULL CHECK (decision_tier IN ('auto', 'manual', 'committee')),
    notes TEXT,
    rules_evaluated TEXT,  -- JSON of which rules passed/failed
    decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_decisions_application ON underwriting_decisions(application_id, decided_at);

-- Appeals against rejections
CREATE TABLE appeals (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES loan_applications(id),
    borrower_id TEXT NOT NULL REFERENCES borrowers(id),
    reason TEXT NOT NULL,
    additional_info TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'upheld_rejection', 'reversed_to_approved')),
    reviewed_by_user_id TEXT REFERENCES users(id),
    reviewed_at TEXT,
    review_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- BUG RG-008: risk_premium values entered as percent (e.g., 2 meaning 2%) but column is labeled bps.
-- An admin entering "2" intends 2% = 200 bps, but it's stored as 2 bps (0.02%).
-- Phase 3 EMI calc uses stored value as bps, so rates come out 100x smaller than intended.
INSERT INTO interest_rate_config (id, product_type, score_band, base_rate_bps, risk_premium_bps) VALUES
    -- Salary advance: 12-24% annual (base correct, premium entered as percent not bps)
    (lower(hex(randomblob(16))), 'salary_advance', 'Excellent', 1200, 0),
    (lower(hex(randomblob(16))), 'salary_advance', 'Very Good', 1200, 2),
    (lower(hex(randomblob(16))), 'salary_advance', 'Good',      1200, 5),
    (lower(hex(randomblob(16))), 'salary_advance', 'Fair',      1200, 10),
    (lower(hex(randomblob(16))), 'salary_advance', 'Poor',      1200, 12),
    -- Personal loan: 10-18%
    (lower(hex(randomblob(16))), 'personal_loan', 'Excellent', 1000, 0),
    (lower(hex(randomblob(16))), 'personal_loan', 'Very Good', 1000, 2),
    (lower(hex(randomblob(16))), 'personal_loan', 'Good',      1000, 4),
    (lower(hex(randomblob(16))), 'personal_loan', 'Fair',      1000, 8),
    (lower(hex(randomblob(16))), 'personal_loan', 'Poor',      1000, 10),
    -- Line of credit: 14-29%
    (lower(hex(randomblob(16))), 'line_of_credit', 'Excellent', 1400, 0),
    (lower(hex(randomblob(16))), 'line_of_credit', 'Very Good', 1400, 2),
    (lower(hex(randomblob(16))), 'line_of_credit', 'Good',      1400, 5),
    (lower(hex(randomblob(16))), 'line_of_credit', 'Fair',      1400, 10),
    (lower(hex(randomblob(16))), 'line_of_credit', 'Poor',      1400, 15),
    -- BNPL: 0-14%
    (lower(hex(randomblob(16))), 'bnpl', 'Excellent', 0,   0),
    (lower(hex(randomblob(16))), 'bnpl', 'Very Good', 600, 1),
    (lower(hex(randomblob(16))), 'bnpl', 'Good',      600, 3),
    (lower(hex(randomblob(16))), 'bnpl', 'Fair',      600, 6),
    (lower(hex(randomblob(16))), 'bnpl', 'Poor',      600, 8),
    -- Emergency loan: 8-18%
    (lower(hex(randomblob(16))), 'emergency_loan', 'Excellent', 800, 0),
    (lower(hex(randomblob(16))), 'emergency_loan', 'Very Good', 800, 2),
    (lower(hex(randomblob(16))), 'emergency_loan', 'Good',      800, 4),
    (lower(hex(randomblob(16))), 'emergency_loan', 'Fair',      800, 7),
    (lower(hex(randomblob(16))), 'emergency_loan', 'Poor',      800, 10);
