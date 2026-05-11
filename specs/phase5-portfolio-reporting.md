# RiskGuard — Phase 5: Portfolio Reporting & Risk Analytics

> **Prerequisites**: Phases 1-4 must be complete. Read `phase0-setup.md` for conventions.
>
> **Goal**: Portfolio dashboard, aging analysis, vintage curves, concentration risk reporting, and Expected Credit Loss projections for risk and finance teams.
>
> **Bugs to inject**: RG-021, RG-022, RG-023, RG-024, RG-025
>
> **DO NOT modify or break any Phase 1-4 code.**

---

## Migration 005

```sql
-- migrations/005_portfolio_reporting.sql

-- Daily portfolio snapshots (one row per day, computed by a daily job or on-demand by dashboard)
CREATE TABLE portfolio_snapshots (
    id TEXT PRIMARY KEY,
    as_of_date TEXT NOT NULL UNIQUE,
    total_outstanding INTEGER NOT NULL,
    total_active_loans INTEGER NOT NULL,
    total_disbursed_to_date INTEGER NOT NULL,
    total_collected_to_date INTEGER NOT NULL,
    npa_amount INTEGER NOT NULL,           -- outstanding in 90+ DPD bucket
    npa_ratio_bps INTEGER NOT NULL,        -- basis points (e.g., 250 = 2.50%)
    collection_efficiency_bps INTEGER NOT NULL,
    written_off_amount INTEGER NOT NULL,
    avg_dpd_active_loans INTEGER NOT NULL,
    snapshot_metadata TEXT,  -- JSON: breakdowns
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Configurable risk alerting thresholds
CREATE TABLE risk_thresholds (
    id TEXT PRIMARY KEY,
    metric_name TEXT UNIQUE NOT NULL,  -- 'npa_ratio', 'collection_efficiency', 'avg_dpd'
    threshold_value INTEGER NOT NULL,   -- in same units as metric
    comparison TEXT NOT NULL CHECK (comparison IN ('above', 'below')),
    alert_enabled INTEGER NOT NULL DEFAULT 1,
    last_breached_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Expected Credit Loss projections (simplified IFRS 9-style)
CREATE TABLE ecl_projections (
    id TEXT PRIMARY KEY,
    as_of_date TEXT NOT NULL,
    score_band TEXT NOT NULL,
    exposure_at_default INTEGER NOT NULL,           -- EAD
    probability_of_default_bps INTEGER NOT NULL,    -- PD in bps
    loss_given_default_bps INTEGER NOT NULL,        -- LGD in bps
    expected_credit_loss INTEGER NOT NULL,          -- EAD * PD * LGD
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(as_of_date, score_band)
);

-- Probability of Default lookup by score band (configurable, used in ECL)
CREATE TABLE pd_lookup (
    id TEXT PRIMARY KEY,
    score_band TEXT UNIQUE NOT NULL,
    pd_12_months_bps INTEGER NOT NULL,       -- 12-month PD in basis points
    lgd_bps INTEGER NOT NULL DEFAULT 4500,    -- default LGD: 45%
    is_active INTEGER NOT NULL DEFAULT 1
);

-- Seed PD lookup
INSERT INTO pd_lookup (id, score_band, pd_12_months_bps, lgd_bps) VALUES
    (lower(hex(randomblob(16))), 'Excellent', 50, 4500),
    (lower(hex(randomblob(16))), 'Very Good', 150, 4500),
    (lower(hex(randomblob(16))), 'Good', 400, 4500),
    (lower(hex(randomblob(16))), 'Fair', 1200, 5500),
    (lower(hex(randomblob(16))), 'Poor', 3500, 6500);
```

> **Note for migration**: At a later date the `score_band` values in `pd_lookup` were planned to be uppercased for consistency. The Phase 5 migration changes the values to UPPERCASE. Implement this as: insert the table values as `'EXCELLENT'`, `'VERY GOOD'`, `'GOOD'`, `'FAIR'`, `'POOR'` (uppercase) — but the rest of the codebase continues using mixed-case band names. This sets up BUG RG-025.

---

## Key Metrics & Formulas

```typescript
// src/services/reporting.service.ts

// NPA Ratio = (outstanding in 90+ DPD) / (total active outstanding)
// Collection Efficiency = (EMIs collected in period) / (EMIs due in period)
// Default Rate = (written-off loans by vintage) / (originated loans by vintage)
// Average DPD = sum(DPD across active loans) / count(active loans)
// ECL = sum over score bands of (EAD * PD * LGD)
```

---

## Endpoints

### GET /api/v1/reports/portfolio

Top-level portfolio dashboard.

**Query params:**
- `as_of_date` — defaults to today
- `compare_with` — optional date for delta comparison

**Response (200):**
```json
{
  "success": true,
  "data": {
    "as_of_date": "2025-04-15",
    "summary": {
      "total_outstanding": "12500000.00",
      "active_loans_count": 87,
      "total_disbursed_to_date": "45000000.00",
      "total_collected_to_date": "32500000.00",
      "written_off_amount": "850000.00"
    },
    "risk_metrics": {
      "npa_amount": "1250000.00",
      "npa_ratio": "10.00",
      "collection_efficiency": "94.50",
      "avg_dpd_active": 12
    },
    "by_product": [
      { "product": "personal_loan", "outstanding": "...", "count": 32 },
      { "product": "salary_advance", "outstanding": "...", "count": 28 },
      // ...
    ],
    "by_band": [
      { "band": "Excellent", "outstanding": "...", "count": 5 },
      { "band": "Very Good", "outstanding": "...", "count": 12 },
      // ...
    ],
    "compared_with": null  // populated if compare_with param provided
  }
}
```

**🐛 BUG RG-021 — INJECT THIS (Critical):**

```typescript
// src/services/reporting.service.ts

async function computeNpaRatio(asOfDate: string) {
  // NPA outstanding: loans in 90+ DPD bucket
  const npaOutstanding = db.prepare(`
    SELECT COALESCE(SUM(dpd.overdue_principal + dpd.overdue_interest), 0) as npa
    FROM dpd_records dpd
    JOIN loans l ON l.id = dpd.loan_id
    WHERE dpd.bucket = '90+'
      AND dpd.as_of_date = ?
      -- BUG RG-021: Numerator INCLUDES written_off loans
      -- These are still in dpd_records (worker continues snapshotting until cleanup)
      -- Should add: AND l.status != 'written_off'
  `).get(asOfDate) as { npa: number };
  
  // Total outstanding: only ACTIVE loans
  const totalOutstanding = db.prepare(`
    SELECT COALESCE(SUM(...), 0) as total
    FROM loans l
    WHERE l.status = 'active'  -- excludes written_off (correct for denominator)
    -- but the numerator above includes them → asymmetric inclusion
  `).get() as { total: number };
  
  // Effect: NPA ratio is artificially inflated because numerator counts
  // dollars that aren't in the denominator
  
  const ratioBps = totalOutstanding.total > 0 
    ? Math.round((npaOutstanding.npa / totalOutstanding.total) * 10000)
    : 0;
  
  return { npaAmount: npaOutstanding.npa, ratioBps };
}
```

Effect: Risk dashboards show inflated NPA ratios that don't match what manual calculations from the loan books would produce. Finance team escalations follow.

---

### GET /api/v1/reports/aging

Aging analysis — loans bucketed by DPD with values.

**Query params:**
- `as_of_date` — defaults to today

**Response (200):**
```json
{
  "success": true,
  "data": {
    "as_of_date": "2025-04-15",
    "buckets": [
      { "bucket": "current", "loan_count": 65, "outstanding": "8500000.00" },
      { "bucket": "1-30", "loan_count": 12, "outstanding": "1800000.00" },
      { "bucket": "31-60", "loan_count": 5, "outstanding": "700000.00" },
      { "bucket": "61-90", "loan_count": 3, "outstanding": "300000.00" },
      { "bucket": "90+", "loan_count": 2, "outstanding": "1200000.00" }
    ],
    "total_outstanding": "12000000.00"
  }
}
```

**🐛 BUG RG-024 — INJECT THIS (Medium):**

```typescript
async function getAgingReport(asOfDate: string) {
  // Per-bucket subtotals — query A
  const buckets = db.prepare(`
    SELECT 
      dpd.bucket,
      COUNT(DISTINCT l.id) as loan_count,
      COALESCE(SUM(dpd.overdue_principal + dpd.overdue_interest), 0) as outstanding
    FROM dpd_records dpd
    JOIN loans l ON l.id = dpd.loan_id
    WHERE dpd.as_of_date = ? AND l.status = 'active'
    GROUP BY dpd.bucket
  `).all(asOfDate);
  
  // Total outstanding — query B (different computation)
  const total = db.prepare(`
    SELECT COALESCE(SUM(...), 0) as total
    FROM loans l
    WHERE l.status = 'active'
      -- BUG RG-024: Excludes 'restructured' loans from total
      -- But the bucket subtotals above include restructured loans (still in dpd_records)
      AND l.status != 'restructured'  -- redundant given the first condition, but adds intent
  `).get() as { total: number };
  
  // Better version of the bug — make it concrete:
  // The total uses a JOIN that excludes loans with no EMI schedule (restructured loans temporarily have empty schedule during rebuild)
  
  return {
    buckets,
    total_outstanding: total.total,  // Doesn't equal sum of bucket subtotals
  };
}
```

Concrete reformulation:

```typescript
// Buckets query (sums from dpd_records, includes ALL statuses present in dpd_records)
const bucketResults = db.prepare(`
  SELECT dpd.bucket, COUNT(DISTINCT l.id) as loan_count,
         COALESCE(SUM(dpd.overdue_principal + dpd.overdue_interest), 0) as outstanding
  FROM dpd_records dpd
  JOIN loans l ON l.id = dpd.loan_id
  WHERE dpd.as_of_date = ?
  GROUP BY dpd.bucket
`).all(asOfDate);

// Total query (uses a DIFFERENT join that excludes restructured)
const totalResult = db.prepare(`
  SELECT COALESCE(SUM(l.principal_amount), 0) as total
  FROM loans l
  WHERE l.status NOT IN ('written_off', 'closed', 'prepaid', 'restructured')
`).get();

// BUG RG-024: bucket sums use overdue amounts; total uses principal_amount
// These are fundamentally different numbers; they will never match
// Plus: dpd_records bucket sums include restructured loans, total query excludes them
```

The QA-visible behavior: when you sum the `outstanding` field across all returned buckets, you get a number that doesn't match `total_outstanding`. Difference of 5-15% typically.

---

### GET /api/v1/reports/vintage

Vintage analysis — loan performance grouped by origination month.

**Query params:**
- `period_months` — how many vintages back (default 12)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "vintages": [
      {
        "vintage_month": "2024-05",
        "loans_originated": 12,
        "total_disbursed": "850000.00",
        "defaulted_count": 1,
        "written_off_count": 0,
        "currently_overdue_count": 2,
        "default_rate_bps": 833,        // 1/12 = 8.33%
        "loss_rate_bps": 0
      },
      // ... more vintages
    ]
  }
}
```

**🐛 BUG RG-022 — INJECT THIS (High):**

```typescript
async function getVintageReport(periodMonths: number) {
  // BUG RG-022: Vintages bucketed by created_at instead of disbursed_at
  // The application's created_at and the loan's disbursed_at can differ by 7-14 days
  // (application → underwriting → committee review → disbursement takes time)
  // A loan applied for in late January but disbursed in early February
  //   - is bucketed in January vintage (wrong) instead of February (right)
  // Vintage analysis is meant to track loans that ENTERED the portfolio in a given month
  // Origination date for that purpose is the disbursement date, not the application creation date
  
  const vintages = db.prepare(`
    SELECT 
      strftime('%Y-%m', l.created_at) as vintage_month,  -- BUG: should be d.disbursed_at
      COUNT(*) as loans_originated,
      SUM(l.principal_amount) as total_disbursed,
      SUM(CASE WHEN l.status = 'defaulted' THEN 1 ELSE 0 END) as defaulted_count,
      SUM(CASE WHEN l.status = 'written_off' THEN 1 ELSE 0 END) as written_off_count
    FROM loans l
    LEFT JOIN disbursements d ON d.loan_id = l.id
    WHERE l.created_at >= date('now', ?)
    GROUP BY vintage_month
    ORDER BY vintage_month DESC
  `).all(`-${periodMonths} months`);
  
  return { vintages };
}
```

Effect: month-end vintage cohorts are misclassified. A loan applied for on Jan 30, approved Feb 1, disbursed Feb 3 shows up in January vintage. Cohort performance metrics misrepresent which month the risk actually originated.

---

### GET /api/v1/reports/concentration

Concentration risk — outstanding grouped by various cuts.

**Query params:**
- `cut` — `department`, `product_type`, `score_band`, `amount_band` (required)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "cut": "department",
    "groups": [
      { "key": "Engineering", "outstanding": "5200000.00", "loan_count": 28, "percentage_of_portfolio": 41.6 },
      { "key": "Sales", "outstanding": "3800000.00", "loan_count": 22, "percentage_of_portfolio": 30.4 },
      // ...
    ],
    "herfindahl_index": 2845  // measure of concentration (0-10000)
  }
}
```

Business logic: standard SQL grouping by the requested cut. Herfindahl-Hirschman Index computed as sum of squared market shares.

---

### Collection Efficiency

```typescript
// src/services/reporting.service.ts

async function computeCollectionEfficiency(periodStart: string, periodEnd: string) {
  // EMIs scheduled to be due in period
  const dueAmount = db.prepare(`
    SELECT COALESCE(SUM(emi_amount), 0) as due
    FROM emi_schedules
    WHERE due_date >= ? AND due_date <= ?
      AND status IN ('paid', 'partial', 'overdue', 'scheduled')
  `).get(periodStart, periodEnd) as { due: number };
  
  // EMIs collected in period (includes ALL repayments — manual, auto, prepayments)
  const collectedAmount = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as collected
    FROM repayments
    WHERE completed_at >= ? AND completed_at <= ?
      AND status = 'completed'
    -- BUG RG-023: Includes 'partial_prepayment' and 'full_prepayment' types
    -- These shouldn't count toward "on-schedule collection efficiency"
    -- Borrowers prepaying heavily make efficiency exceed 100%
  `).get(periodStart, periodEnd) as { collected: number };
  
  const efficiencyBps = dueAmount.due > 0
    ? Math.round((collectedAmount.collected / dueAmount.due) * 10000)
    : 0;
  
  return { dueAmount: dueAmount.due, collectedAmount: collectedAmount.collected, efficiencyBps };
}
```

**🐛 BUG RG-023 — INJECT THIS (Medium):** Implemented above. Prepayments inflate collection efficiency above 100%. Dashboards built on the assumption that efficiency is 0-100% break or render confusing UI.

---

### Expected Credit Loss Computation

```typescript
// src/services/reporting.service.ts

async function computeEcl(asOfDate: string) {
  // Group active loans by score band, sum exposure
  const exposures = db.prepare(`
    SELECT 
      b.current_band as score_band,
      COALESCE(SUM(/* outstanding */ ...), 0) as ead
    FROM loans l
    JOIN borrowers b ON b.id = l.borrower_id
    WHERE l.status = 'active'
    GROUP BY b.current_band
  `).all() as { score_band: string; ead: number }[];
  
  let totalEcl = 0;
  const breakdown: any[] = [];
  
  for (const exp of exposures) {
    // BUG RG-025: pd_lookup table stores band names in UPPERCASE (from migration 005)
    // But b.current_band is stored as mixed case ('Good', 'Very Good', etc.)
    // SQLite is CASE-SENSITIVE by default for string comparison
    // 'Good' != 'GOOD' → no row returned → PD defaults to 0 → ECL = 0 for all loans
    
    const pdConfig = db.prepare(`
      SELECT pd_12_months_bps, lgd_bps 
      FROM pd_lookup 
      WHERE score_band = ?
    `).get(exp.score_band) as { pd_12_months_bps: number; lgd_bps: number } | undefined;
    
    const pd = pdConfig?.pd_12_months_bps ?? 0;
    const lgd = pdConfig?.lgd_bps ?? 4500;
    
    // ECL = EAD × PD × LGD (all in proper units)
    const ecl = Math.round((exp.ead * pd * lgd) / (10000 * 10000));
    
    totalEcl += ecl;
    breakdown.push({ score_band: exp.score_band, ead: exp.ead, pd, lgd, ecl });
  }
  
  return { totalEcl, breakdown };
}
```

**🐛 BUG RG-025 — INJECT THIS (Low):** Implemented above. The migration changed `pd_lookup` band names to UPPERCASE, but `borrowers.current_band` continues to store mixed case. SQLite string comparison is case-sensitive by default. The lookup returns undefined, PD defaults to 0, total ECL = 0. Risk reports show implausibly low ECL — eventually caught by finance team but the report serves a quiet 0 for weeks.

---

## Tests to Write

1. **Portfolio dashboard**: aggregations, by-product and by-band breakdowns.
2. **NPA ratio**: BUG RG-021 — numerator includes written_off, denominator doesn't.
3. **Aging report**: BUG RG-024 — bucket sums don't equal total.
4. **Vintage**: BUG RG-022 — buckets by created_at not disbursed_at.
5. **Concentration**: HHI computation, group sorting.
6. **Collection efficiency**: BUG RG-023 — exceeds 100% with prepayments.
7. **ECL**: BUG RG-025 — total ECL is 0 due to case-sensitive band lookup.

---

## Bug Summary for This Phase

| ID | Severity | Where | What |
|----|----------|-------|------|
| RG-021 | Critical | `reporting.service.ts → computeNpaRatio` | NPA numerator includes written_off loans, denominator excludes them → inflated ratio |
| RG-022 | High | `reporting.service.ts → getVintageReport` | Vintages bucketed by `created_at` instead of `disbursed_at` → cohort misclassification |
| RG-023 | Medium | `reporting.service.ts → computeCollectionEfficiency` | Prepayments counted as "collected" → efficiency exceeds 100% |
| RG-024 | Medium | `reporting.service.ts → getAgingReport` | Bucket subtotals and total use different queries → totals don't add up |
| RG-025 | Low | `reporting.service.ts → computeEcl` | pd_lookup uses UPPERCASE bands but borrower bands are mixed case → PD lookup returns 0 → ECL = 0 |
