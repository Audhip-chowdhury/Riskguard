# RiskGuard — Phase 1: Borrower Profile & Credit Score

> **Prerequisites**: Read `phase0-setup.md` first for tech stack, project structure, and conventions.
>
> **Goal**: Set up the full RiskGuard project from scratch. Implement borrower profiles, multi-factor credit scoring, score history, and credit limit assignment.
>
> **Bugs to inject**: RG-001, RG-002, RG-003, RG-004, RG-005

---

## What to Build in This Phase

1. Initialize the npm project with TypeScript and all dependencies.
2. Create `.env.example` and the SQLite migration runner.
3. Implement middleware: auth, idempotency, error handler, request logger.
4. Implement the PayFlow service module (will be used heavily in Phase 3).
5. Implement the ComplyHub stub service.
6. Create migration 001.
7. Implement borrower CRUD endpoints, scoring engine, score history.
8. Create seed data (employees that mirror PayFlow users).
9. Write tests.
10. Inject all 5 bugs exactly as documented below.

---

## Migration 001

```sql
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
```

---

## Scoring Algorithm

```typescript
// src/services/scoring.service.ts

// Score range: 0-1000
// Each factor returns a sub-score 0-1000
// Final score = weighted average of factor sub-scores

interface FactorResult {
  factor: string;
  raw_value: number;
  sub_score: number;  // 0-1000
  weight: number;     // basis points (2500 = 25%)
}

function computeTenureSubScore(joinedAt: Date): number {
  const yearsAtCompany = (Date.now() - joinedAt.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (yearsAtCompany < 0.5) return 100;       // < 6 months
  if (yearsAtCompany < 1) return 300;          // 6-12 months
  if (yearsAtCompany < 2) return 500;          // 1-2 years
  if (yearsAtCompany < 5) return 750;          // 2-5 years
  return 950;                                  // 5+ years
}

function computeSalarySubScore(monthlySalary: number): number {
  // monthlySalary in paise
  const salaryInSim = monthlySalary / 100;
  if (salaryInSim < 30000) return 200;
  if (salaryInSim < 60000) return 450;
  if (salaryInSim < 100000) return 650;
  if (salaryInSim < 200000) return 800;
  return 950;
}

function computeDebtRatioSubScore(activeDebt: number, monthlySalary: number): number {
  const ratio = activeDebt / monthlySalary;
  if (ratio < 0.1) return 950;
  if (ratio < 0.25) return 800;
  if (ratio < 0.4) return 600;
  if (ratio < 0.6) return 350;
  return 100;
}

function computeRepaymentHistorySubScore(borrowerId: string): number {
  // For first-time borrowers (no history), return neutral 600
  // Otherwise based on past loans:
  //   - 0 missed payments: 950
  //   - 1-2 missed payments: 700
  //   - 3-5 missed payments: 400
  //   - 6+ missed payments: 150
  //   - Any default/write-off: 50
  // Phase 1: stub this since there are no loans yet
  return 600;
}

function computeDepartmentRiskSubScore(tier: number): number {
  // tier 1 = safest, tier 5 = riskiest
  const map: Record<number, number> = { 1: 950, 2: 800, 3: 600, 4: 400, 5: 200 };
  return map[tier] ?? 600;
}
```

---

## Endpoints

### POST /api/v1/borrowers

Create or retrieve borrower profile for an employee. Auto-runs initial scoring.

**Request:**
```json
{
  "employee_id": "uuid"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "employee_id": "uuid",
    "current_score": 720,
    "current_band": "Good",
    "credit_limit": "100000.00",
    "available_limit": "100000.00",
    "kyc_status": "passed",
    "last_scored_at": "..."
  }
}
```

**Business Rules:**
- If borrower already exists, return existing (200).
- On creation, runs ComplyHub stub `checkKyc` (always returns "passed").
- On creation, runs full scoring and creates initial snapshot.
- Credit limit derived from band per table in roadmap.

---

### GET /api/v1/borrowers/:id

Get borrower details.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "employee": {
      "id": "uuid",
      "username": "alice",
      "department": "Engineering",
      "designation": "Senior Engineer",
      "monthly_salary": "120000.00"
    },
    "current_score": 720,
    "current_band": "Good",
    "credit_limit": "100000.00",
    "available_limit": "100000.00",
    "kyc_status": "passed",
    "last_scored_at": "..."
  }
}
```

**Business Rules:**
- Employee can only view own profile unless role is `underwriter`, `senior_underwriter`, `admin`.

---

### POST /api/v1/borrowers/:id/recompute-score

Trigger fresh score computation.

**Headers:**
```
Idempotency-Key: <unique>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "previous_score": 680,
    "new_score": 720,
    "previous_band": "Good",
    "new_band": "Good",
    "previous_limit": "100000.00",
    "new_limit": "100000.00",
    "factor_breakdown": {
      "tenure": 750,
      "salary": 650,
      "debt_ratio": 800,
      "repayment_history": 600,
      "department_risk": 600
    },
    "snapshot_id": "uuid"
  }
}
```

**Business Rules:**
- Anyone with role >= `underwriter` can recompute.
- Borrower can recompute their own (rate-limited to once per day).
- Creates a new score_snapshot with `reason='recompute'`.

**🐛 BUG RG-001 — INJECT THIS (Critical):**
In `scoring.service.ts`, implement the weighted score computation like this:

```typescript
function computeFinalScore(factors: FactorResult[]): number {
  // BUG RG-001: Normalization happens AFTER weight multiplication
  // Correct order would be: normalize weights to sum to 100% first, then multiply
  
  const weightedSum = factors.reduce((sum, f) => sum + (f.sub_score * f.weight), 0);
  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  
  // Bug: dividing by totalWeight here is fine ONLY if weights are already normalized to sum to 10000 (100%)
  // But scoring_factors.weight values may not sum to 10000 in practice
  // (e.g., if an admin toggles a factor off, weights are not auto-rebalanced)
  // This causes 5-15% score drift when active weights don't sum to 10000
  
  return Math.round(weightedSum / totalWeight);
}
```

The fix (do NOT implement) would be:
```typescript
// Correct: normalize first
const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
const normalizedFactors = factors.map(f => ({ ...f, normalizedWeight: f.weight / totalWeight }));
const score = normalizedFactors.reduce((sum, f) => sum + (f.sub_score * f.normalizedWeight), 0);
```

The behavior difference: when factors are deactivated and active weights sum to (say) 9500 instead of 10000, the buggy code divides by 9500 producing slightly higher scores than the correct normalized average would.

**🐛 BUG RG-002 — INJECT THIS (High):**
In `computeDebtRatioSubScore`, when `monthlySalary` is somehow zero or undefined:

```typescript
function computeDebtRatioSubScore(activeDebt: number, monthlySalary: number): number {
  // BUG RG-002: No guard against monthlySalary being 0 or undefined
  // For new employees with no salary record, this returns NaN
  // NaN then propagates through computeFinalScore and stored as NaN in DB
  
  const ratio = activeDebt / monthlySalary;  // NaN if monthlySalary is 0/undefined
  if (ratio < 0.1) return 950;
  if (ratio < 0.25) return 800;
  if (ratio < 0.4) return 600;
  if (ratio < 0.6) return 350;
  return 100;
}
```

When NaN passes through `if (ratio < X)` all comparisons return false, falling through to `return 100`. BUT the bigger issue is when activeDebt is 0 AND monthlySalary is missing: `0 / undefined = NaN`, and downstream `NaN * weight = NaN`, poisoning the final score. Make sure NaN actually does get stored (don't add JSON.stringify guards).

**🐛 BUG RG-003 — INJECT THIS (Medium):**
In the band assignment logic:

```typescript
function assignBand(score: number): { band: string; creditLimit: number } {
  // BUG RG-003: Boundaries use > instead of >=
  // A score of exactly 600 gets "Fair" instead of "Good"
  
  if (score > 899) return { band: 'Excellent', creditLimit: 75000000 };
  if (score > 749) return { band: 'Very Good', creditLimit: 30000000 };
  if (score > 599) return { band: 'Good', creditLimit: 10000000 };
  if (score > 399) return { band: 'Fair', creditLimit: 2500000 };
  return { band: 'Poor', creditLimit: 0 };
}
```

For a score of exactly 600: `score > 599` is true, so this borrower actually gets "Good". But for score of exactly 599: should be "Fair" (since 400-599 is Fair), and the buggy code does give them "Fair" (`> 399` true, `> 599` false). The real issue is at 900 and 750 boundaries: a score of 900 should be Excellent but `> 899` puts them in Excellent correctly... wait. Let me re-state the bug clearly:

The CORRECT band definitions from the roadmap:
- 0-399: Poor
- 400-599: Fair
- 600-749: Good
- 750-899: Very Good
- 900-1000: Excellent

A score of 400 should be Fair. With `> 399`, score 400 IS Fair (correct).
A score of 600 should be Good. With `> 599`, score 600 IS Good (correct).
A score of 750 should be Very Good. With `> 749`, score 750 IS Very Good (correct).

The actual bug should be the OPPOSITE — use `>` where `>=` is needed for the upper boundary of each band. Reimplement as:

```typescript
function assignBand(score: number): { band: string; creditLimit: number } {
  // BUG RG-003: Upper boundaries use >= 900 and <= 899 inconsistently
  // A score of exactly 600 is incorrectly placed in "Fair" instead of "Good"
  
  if (score >= 900) return { band: 'Excellent', creditLimit: 75000000 };
  if (score >= 750) return { band: 'Very Good', creditLimit: 30000000 };
  if (score > 600) return { band: 'Good', creditLimit: 10000000 };  // BUG: should be >= 600
  if (score >= 400) return { band: 'Fair', creditLimit: 2500000 };
  return { band: 'Poor', creditLimit: 0 };
}
```

A borrower with score 600 will fall through to the Fair branch (since `600 > 600` is false) and get 25,000 SIM limit instead of 100,000 SIM. This is a precise boundary off-by-one bug.

---

### GET /api/v1/borrowers/:id/score-history

Returns score snapshots over time.

**Query params:** `page`, `limit`

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "score": 720,
      "band": "Good",
      "factor_breakdown": { ... },
      "credit_limit_at_snapshot": "100000.00",
      "reason": "recompute",
      "created_at": "..."
    }
  ],
  "meta": { "page": 1, "limit": 10, "total": 42 }
}
```

**🐛 BUG RG-004 — INJECT THIS (Low):**
The endpoint claims to return snapshots in descending order (newest first), but the SQL is:

```typescript
const snapshots = db.prepare(`
  SELECT * FROM score_snapshots
  WHERE borrower_id = ?
  ORDER BY created_at ASC
  LIMIT ? OFFSET ?
`).all(borrowerId, limit, offset);
// BUG RG-004: ASC instead of DESC despite documentation saying newest-first
```

---

### POST /api/v1/borrowers/:id/manual-adjust

Admin-only manual override of score and limit.

**Request:**
```json
{
  "new_score": 850,
  "new_credit_limit": "200000.00",
  "reason": "Senior leadership exception per CFO email dated 2025-03-10"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "adjustment_id": "uuid",
    "previous_score": 720,
    "new_score": 850,
    "previous_limit": "100000.00",
    "new_limit": "200000.00",
    "applied_at": "..."
  }
}
```

**Business Rules:**
- Only `admin` role can perform this.
- `reason` is required (min 20 characters).
- Stores in `manual_adjustments` table for audit.
- Updates borrower's `current_score`, `current_band`, `credit_limit`.
- Creates a score_snapshot with `reason='manual_adjustment'`.

**🐛 BUG RG-005 — INJECT THIS (Easy):**

```typescript
// src/services/scoring.service.ts

export const manualAdjustSchema = z.object({
  new_score: z.number(),  // BUG RG-005: no .min(0).max(1000) — accepts any number
  new_credit_limit: z.string().regex(/^\d+\.\d{2}$/),
  reason: z.string().min(20),
});

// BUG RG-005: Admin can pass new_score = 1500 or -200 and it gets stored
// The validation only ensures it's a number, not that it's in valid range
```

Also: when computing the band from the manually-set score, the band logic uses the same buggy `assignBand` so out-of-range scores produce undefined band names (which still get stored as null/undefined strings).

---

## Seed Data (seed/seed.ts)

```typescript
// Mirror the PayFlow users + add HR/employee data
const seedData = [
  { username: "alice", email: "alice@metropay.io", role: "admin", department: "Finance", designation: "CFO", salary: 50000000, tenure_years: 8, risk_tier: 1 },
  { username: "bob", email: "bob@metropay.io", role: "senior_underwriter", department: "Risk", designation: "Head of Risk", salary: 35000000, tenure_years: 5, risk_tier: 1 },
  { username: "charlie", email: "charlie@metropay.io", role: "underwriter", department: "Risk", designation: "Underwriter", salary: 18000000, tenure_years: 3, risk_tier: 2 },
  { username: "diana", email: "diana@metropay.io", role: "underwriter", department: "Risk", designation: "Underwriter", salary: 17000000, tenure_years: 2, risk_tier: 2 },
  { username: "eve", email: "eve@metropay.io", role: "collections_agent", department: "Collections", designation: "Senior Collections Agent", salary: 12000000, tenure_years: 4, risk_tier: 3 },
  { username: "frank", email: "frank@metropay.io", role: "employee", department: "Engineering", designation: "Senior Engineer", salary: 22000000, tenure_years: 3, risk_tier: 3 },
  { username: "grace", email: "grace@metropay.io", role: "employee", department: "Engineering", designation: "Engineer", salary: 14000000, tenure_years: 1, risk_tier: 3 },
  { username: "henry", email: "henry@metropay.io", role: "employee", department: "Marketing", designation: "Marketing Manager", salary: 16000000, tenure_years: 2, risk_tier: 4 },
  { username: "iris", email: "iris@metropay.io", role: "employee", department: "Sales", designation: "Sales Rep", salary: 8000000, tenure_years: 0.3, risk_tier: 5 },  // new hire, low salary
  { username: "jack", email: "jack@metropay.io", role: "employee", department: "Engineering", designation: "Engineer", salary: 0, tenure_years: 0.1, risk_tier: 3 },  // edge case: zero salary record
];

// Manager assignments: bob → charlie, diana
// API key format: `rgk_${crypto.randomBytes(24).toString('hex')}`
// PayFlow wallet IDs: stored from PayFlow seed (or generated as fake UUIDs if PayFlow not running)
```

---

## Tests to Write

1. **Borrower creation**: success, duplicate returns existing, KYC stub called.
2. **Score computation**: tenure factor returns expected sub-scores, salary factor, debt ratio (zero-debt edge case → BUG RG-002 NaN), department risk.
3. **Band assignment**: test boundaries — score 600 SHOULD be Good but BUG RG-003 makes it Fair. Write test expecting buggy behavior.
4. **Recompute**: creates new snapshot, updates borrower.
5. **Score history**: pagination, ordering (BUG RG-004 ascending).
6. **Manual adjust**: admin-only, reason required, out-of-range score allowed (BUG RG-005).

---

## Bug Summary for This Phase

| ID | Severity | Where | What |
|----|----------|-------|------|
| RG-001 | Critical | `scoring.service.ts → computeFinalScore` | Weight normalization order error → 5-15% score drift when weights don't sum to 100% |
| RG-002 | Medium | `scoring.service.ts → computeDebtRatioSubScore` | Zero/missing salary produces NaN, poisons final score |
| RG-003 | Medium | `scoring.service.ts → assignBand` | Score 600 lands in "Fair" instead of "Good" due to `>` vs `>=` |
| RG-004 | Easy | `borrowers.ts → score-history` | Returns ASC instead of documented DESC |
| RG-005 | Easy | `borrowers.ts → manual-adjust` | Zod schema missing 0-1000 range validation on new_score |
