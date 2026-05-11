-- migrations/005_portfolio_reporting.sql

-- Daily portfolio snapshots (one row per day)
CREATE TABLE portfolio_snapshots (
    id TEXT PRIMARY KEY,
    as_of_date TEXT NOT NULL UNIQUE,
    total_outstanding INTEGER NOT NULL,
    total_active_loans INTEGER NOT NULL,
    total_disbursed_to_date INTEGER NOT NULL,
    total_collected_to_date INTEGER NOT NULL,
    npa_amount INTEGER NOT NULL,
    npa_ratio_bps INTEGER NOT NULL,
    collection_efficiency_bps INTEGER NOT NULL,
    written_off_amount INTEGER NOT NULL,
    avg_dpd_active_loans INTEGER NOT NULL,
    snapshot_metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Configurable risk alerting thresholds
CREATE TABLE risk_thresholds (
    id TEXT PRIMARY KEY,
    metric_name TEXT UNIQUE NOT NULL,
    threshold_value INTEGER NOT NULL,
    comparison TEXT NOT NULL CHECK (comparison IN ('above', 'below')),
    alert_enabled INTEGER NOT NULL DEFAULT 1,
    last_breached_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Expected Credit Loss projections (IFRS 9-style)
CREATE TABLE ecl_projections (
    id TEXT PRIMARY KEY,
    as_of_date TEXT NOT NULL,
    score_band TEXT NOT NULL,
    exposure_at_default INTEGER NOT NULL,
    probability_of_default_bps INTEGER NOT NULL,
    loss_given_default_bps INTEGER NOT NULL,
    expected_credit_loss INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(as_of_date, score_band)
);

-- Probability of Default lookup by score band
CREATE TABLE pd_lookup (
    id TEXT PRIMARY KEY,
    score_band TEXT UNIQUE NOT NULL,
    pd_12_months_bps INTEGER NOT NULL,
    lgd_bps INTEGER NOT NULL DEFAULT 4500,
    is_active INTEGER NOT NULL DEFAULT 1
);

-- BUG RG-025: Band names stored as UPPERCASE here, but borrowers.current_band uses mixed case
-- ('Good' vs 'GOOD') → SQLite case-sensitive match fails → PD = 0 → ECL = 0
INSERT INTO pd_lookup (id, score_band, pd_12_months_bps, lgd_bps) VALUES
    (lower(hex(randomblob(16))), 'EXCELLENT', 50, 4500),
    (lower(hex(randomblob(16))), 'VERY GOOD', 150, 4500),
    (lower(hex(randomblob(16))), 'GOOD', 400, 4500),
    (lower(hex(randomblob(16))), 'FAIR', 1200, 5500),
    (lower(hex(randomblob(16))), 'POOR', 3500, 6500);
