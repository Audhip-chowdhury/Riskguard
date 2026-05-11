# RiskGuard — Phase 2: Loan Origination & Underwriting

> **Prerequisites**: Phase 1 must be complete. Read `phase0-setup.md` for conventions.
>
> **Goal**: Borrowers apply for loans across 5 product types. Auto-approval rules, manual underwriter review, committee review for large amounts, denial appeals, and conflict-of-interest checks.
>
> **Bugs to inject**: RG-006, RG-007, RG-008, RG-009, RG-010
>
> **DO NOT modify or break any Phase 1 code.**

---

## Migration 002

```sql
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

-- Seed interest rates
INSERT INTO interest_rate_config (id, product_type, score_band, base_rate_bps, risk_premium_bps) VALUES
    -- Salary advance: 12-24% annual
    (lower(hex(randomblob(16))), 'salary_advance', 'Excellent', 1200, 0),
    (lower(hex(randomblob(16))), 'salary_advance', 'Very Good', 1200, 200),
    (lower(hex(randomblob(16))), 'salary_advance', 'Good', 1200, 500),
    (lower(hex(randomblob(16))), 'salary_advance', 'Fair', 1200, 1000),
    (lower(hex(randomblob(16))), 'salary_advance', 'Poor', 1200, 1200),
    -- Personal loan: 10-18%
    (lower(hex(randomblob(16))), 'personal_loan', 'Excellent', 1000, 0),
    (lower(hex(randomblob(16))), 'personal_loan', 'Very Good', 1000, 150),
    (lower(hex(randomblob(16))), 'personal_loan', 'Good', 1000, 400),
    (lower(hex(randomblob(16))), 'personal_loan', 'Fair', 1000, 800),
    (lower(hex(randomblob(16))), 'personal_loan', 'Poor', 1000, 1000),
    -- (similar entries for line_of_credit, bnpl, emergency_loan)
    (lower(hex(randomblob(16))), 'line_of_credit', 'Excellent', 1400, 0),
    (lower(hex(randomblob(16))), 'line_of_credit', 'Very Good', 1400, 200),
    (lower(hex(randomblob(16))), 'line_of_credit', 'Good', 1400, 500),
    (lower(hex(randomblob(16))), 'line_of_credit', 'Fair', 1400, 1000),
    (lower(hex(randomblob(16))), 'line_of_credit', 'Poor', 1400, 1500),
    (lower(hex(randomblob(16))), 'bnpl', 'Excellent', 0, 0),  -- 0% for BNPL excellent
    (lower(hex(randomblob(16))), 'bnpl', 'Very Good', 600, 100),
    (lower(hex(randomblob(16))), 'bnpl', 'Good', 600, 300),
    (lower(hex(randomblob(16))), 'bnpl', 'Fair', 600, 600),
    (lower(hex(randomblob(16))), 'bnpl', 'Poor', 600, 800),
    (lower(hex(randomblob(16))), 'emergency_loan', 'Excellent', 800, 0),
    (lower(hex(randomblob(16))), 'emergency_loan', 'Very Good', 800, 200),
    (lower(hex(randomblob(16))), 'emergency_loan', 'Good', 800, 400),
    (lower(hex(randomblob(16))), 'emergency_loan', 'Fair', 800, 700),
    (lower(hex(randomblob(16))), 'emergency_loan', 'Poor', 800, 1000);
```

---

## Auto-Approval Rules

Auto-approval triggers when ALL conditions met:
- `requested_amount <= 50,000 SIM` (5,000,000 paise)
- `score >= 700`
- `debt_ratio < 0.4` (i.e., existing active debt < 40% of monthly salary)
- KYC status = `passed`
- `available_limit >= requested_amount`

If any fails → routed to manual review.

**Manual review tier:** amounts 50,001 – 500,000 SIM. Single underwriter approves.

**Committee review tier:** amounts > 500,000 SIM. Two underwriters required (one of which must be `senior_underwriter`).

---

## Endpoints

### POST /api/v1/loans/apply

Submit a loan application.

**Headers:**
```
X-API-Key: <borrower's key>
Idempotency-Key: <unique>
```

**Request:**
```json
{
  "product_type": "personal_loan",
  "requested_amount": "75000.00",
  "requested_tenure_months": 12,
  "purpose": "Home renovation"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "application_id": "uuid",
    "status": "approved",
    "approval_tier": "auto",
    "score_at_application": 750,
    "band_at_application": "Very Good",
    "available_limit_at_application": "300000.00",
    "loan_id": "uuid",
    "interest_rate": "11.50",
    "submitted_at": "..."
  }
}
```

**Business Rules:**
- Borrower must exist with KYC passed.
- Cannot apply if has an open (`submitted`, `under_review`, `committee_review`) application of same product type.
- Snapshot of score/band/limit/debt_ratio captured at application time.
- ComplyHub stub `screenAml` runs (always passes).
- If auto-approval rules pass → status='approved', a Loan record is created.
- Otherwise → status='under_review' (or 'committee_review' if amount > 500K).

**🐛 BUG RG-007 — INJECT THIS (High):**

```typescript
// src/services/underwriting.service.ts

function checkAutoApproval(application: LoanApplication): { passes: boolean; failedRules: string[] } {
  const failedRules: string[] = [];
  
  if (application.requested_amount > 5000000) failedRules.push('amount_exceeds_auto_limit');
  if (application.score_at_application < 700) failedRules.push('score_below_threshold');
  
  // BUG RG-007: debt_ratio_at_application is null for first-time borrowers (no active debt)
  // JavaScript: `null < 0.4` evaluates to true (null coerces to 0)
  // So first-time borrowers ALWAYS pass this check, even if they shouldn't
  // But specifically, when active debt is undefined (not just null), undefined < 0.4 is false
  // The bug: the && short-circuit + falsy null/0 means a missing debt_ratio is treated as passing
  
  if (application.debt_ratio_at_application != null && application.debt_ratio_at_application >= 4000) {
    // 4000 bps = 0.4 ratio
    failedRules.push('debt_ratio_too_high');
  }
  // If debt_ratio_at_application is null/undefined, no failure added — passes!
  // Correct behavior: explicitly require debt_ratio_at_application to be computed and < threshold
  
  if (application.available_limit_at_application < application.requested_amount) {
    failedRules.push('insufficient_limit');
  }
  
  return { passes: failedRules.length === 0, failedRules };
}
```

The real-world effect: first-time borrowers can auto-approve loans they shouldn't because the "debt ratio < 40%" check skips when debt_ratio is null. While this often catches the right behavior for legitimate first-timers, it bypasses risk controls for borrowers with debt that wasn't properly computed (e.g., loans in `disbursed` status not yet recorded in any aggregation).

---

### Interest Rate Calculation

```typescript
// src/services/underwriting.service.ts

function computeInterestRate(productType: string, scoreBand: string): number {
  const config = db.prepare(`
    SELECT base_rate_bps, risk_premium_bps 
    FROM interest_rate_config 
    WHERE product_type = ? AND score_band = ? AND is_active = 1
  `).get(productType, scoreBand) as { base_rate_bps: number; risk_premium_bps: number };
  
  // BUG RG-008: Returns the sum as a percentage instead of basis points
  // Correct: return config.base_rate_bps + config.risk_premium_bps (in bps)
  // Bug: treats the bps values as percentages somewhere downstream
  
  return config.base_rate_bps + config.risk_premium_bps;
}
```

**🐛 BUG RG-008 — INJECT THIS (Hard):**

The bug is more subtle. The function returns basis points correctly, but elsewhere in the codebase (the loan creation path):

```typescript
// src/services/underwriting.service.ts → createLoan

const rate = computeInterestRate(application.product_type, application.band_at_application);

// BUG RG-008: stored value mixes up basis points and percent
// rate is in basis points (e.g., 1500 = 15%)
// But when computing the loan's annual_interest_rate_bps, this adds risk_premium as if it were a percentage:
const finalRateBps = rate + (riskPremiumPercent * 100);  // double-counts risk

// Actually, simpler bug: when displaying the rate to the user in the response,
// it's formatted as if bps were percent:
return {
  // ...
  interest_rate: (finalRateBps / 100).toFixed(2),  // turns 1500 bps into "15.00%" — looks right
  // but the underlying stored value adds 500 bps as 500% somewhere in the EMI calc
};
```

To make this concrete and reproducible, implement it this way:

```typescript
// In createLoan:
const baseRate = config.base_rate_bps;        // e.g., 1000 (= 10%)
const riskPremium = config.risk_premium_bps;  // e.g., 500 (= 5%)

// BUG RG-008: risk_premium added as percent (multiplied by 100) instead of as bps
// Should be: baseRate + riskPremium  (e.g., 1000 + 500 = 1500 bps = 15%)
// Bug:       baseRate + (riskPremium * 100)  (e.g., 1000 + 50000 = 51000 bps = 510%)
const totalRateBps = baseRate + (riskPremium * 100);

// Wait — that's way too obvious. Make it more realistic:
// The bug is the OPPOSITE — config stores in bps but UI/calc treats as percent
// Reimplement:

// In computeInterestRate:
function computeInterestRate(productType: string, scoreBand: string): number {
  const config = db.prepare(`...`).get(productType, scoreBand);
  // BUG RG-008: Treats bps as percent — risk_premium_bps of 500 (= 5%) becomes +5% added to base
  // For a Fair-band personal loan: base=1000bps (10%), risk_premium=800bps (8%)
  // Correct: 1000 + 800 = 1800 bps = 18%
  // Bug: stores 1000 + 800 = 1800 in DB BUT treats display as "1000 bps + 8 percent = 18%" (coincidentally same)
  // The bug only manifests when bps/100 doesn't equal the intended percent — for unusual basis point values
  
  return config.base_rate_bps + config.risk_premium_bps;
}
```

**Cleaner formulation of RG-008:** The bug is that when admin configures a risk premium, the form field is labeled "Risk Premium (%)" but the value is stored in `risk_premium_bps` column without multiplying by 100. So an admin enters "5" (intending 5%, i.e., 500 bps) but it's stored as 5 bps (0.05%). The display layer divides by 100 thinking it's bps. Net effect: the configured risk premium is 100x smaller than intended, so risky borrowers don't actually pay higher rates. This is a quiet bug that only QAs find by checking actual rates against the rate table.

For implementation, just label the migration column as `risk_premium_bps` but in the seed data USE percent values (e.g., insert `5` to mean 5%) which is wrong since it's labeled bps. The phase 3 EMI calculation uses the stored value as bps, so rates come out 100x smaller than intended.

```sql
-- Buggy seed
INSERT INTO interest_rate_config VALUES (..., 1200, 0),    -- "0% premium for Excellent" but stored as 0 bps — coincidentally correct
INSERT INTO interest_rate_config VALUES (..., 1200, 5),    -- intent: "5% premium" but stored as 5 bps (0.05%) — way too small
```

---

### GET /api/v1/loans/:id

Returns either application details (if not yet a loan) or full loan info.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "application": { ... },
    "loan": { ... } | null,
    "decisions": [ ... ],
    "appeals": [ ... ]
  }
}
```

---

### POST /api/v1/loans/:id/approve

Approve an application. Path: application_id.

**Request:**
```json
{
  "notes": "Verified employment, recommending approval"
}
```

**Business Rules:**
- Caller must be `underwriter` or `senior_underwriter`.
- Application must be in `under_review` or `committee_review` status.
- For `committee_review`: requires two approvals. First approval keeps status as `committee_review` but records first reviewer. Second approval (must be different user, must be senior_underwriter) flips to approved.
- **Conflict-of-interest check: underwriter cannot approve own application OR application from a direct report.**

**🐛 BUG RG-006 — INJECT THIS (Critical):**

```typescript
// src/services/underwriting.service.ts

async function approveApplication(applicationId: string, approverUserId: string, notes?: string) {
  const application = getApplication(applicationId);
  const approver = getUser(approverUserId);
  const borrower = getBorrower(application.borrower_id);
  const borrowerEmployee = getEmployee(borrower.employee_id);
  
  // BUG RG-006: Only checks if approver is the same person as the applicant
  // Missing: check if approver is the borrower's manager (direct report relationship)
  if (borrower.employee_id === getEmployeeByUserId(approverUserId)?.id) {
    throw new ForbiddenError('Cannot approve own application');
  }
  
  // The correct check should ALSO be:
  // if (borrowerEmployee.manager_user_id === approverUserId) {
  //   throw new ForbiddenError('Cannot approve application from direct report');
  // }
  
  // ... proceed with approval
}
```

Effect: a manager who happens to also be an underwriter can approve loan applications from their direct reports — classic conflict of interest, common in real underwriting systems that didn't model the org hierarchy.

---

### POST /api/v1/loans/:id/reject

Reject an application.

**Request:**
```json
{
  "reason": "Insufficient repayment history given the requested amount"
}
```

**Business Rules:**
- Same role and conflict-of-interest checks as approve.
- `reason` is required (min 10 characters).
- Status → `rejected`, `rejection_reason` stored.

---

### POST /api/v1/loans/:id/appeal

Borrower appeals a rejection.

**Request:**
```json
{
  "reason": "I have new salary documentation that wasn't considered",
  "additional_info": "Promotion approved on 2025-02-15, attached letter"
}
```

**Business Rules:**
- Caller must be the borrower whose application was rejected.
- Application must be in `rejected` status.
- Appeal is reviewed by a different underwriter than the original (or any senior_underwriter).

**🐛 BUG RG-009 — INJECT THIS (Easy):**

```typescript
async function createAppeal(applicationId: string, borrowerUserId: string, reason: string, additionalInfo?: string) {
  const application = getApplication(applicationId);
  
  if (application.status !== 'rejected') {
    throw new InvalidStateError('Can only appeal rejected applications');
  }
  
  // BUG RG-009: No check for existing appeal — borrowers can submit multiple appeals
  // Correct behavior: only one appeal allowed per application
  // Missing: const existing = db.prepare('SELECT 1 FROM appeals WHERE application_id = ?').get(applicationId);
  //          if (existing) throw new ConflictError('Appeal already submitted for this application');
  
  return createAppealRecord({ applicationId, borrowerUserId, reason, additionalInfo });
}
```

---

### POST /api/v1/loans/:id/withdraw

Borrower withdraws their application.

**Business Rules:**
- Caller must be the borrower.
- Application must be in `submitted`, `under_review`, or `committee_review`.

**🐛 BUG RG-010 — INJECT THIS (Low):**

```typescript
async function withdrawApplication(applicationId: string, borrowerUserId: string) {
  const application = getApplication(applicationId);
  
  // BUG RG-010: Missing status check
  // Should validate: status must be in ['submitted', 'under_review', 'committee_review']
  // Bug: allows withdrawing even when status is 'approved' (and possibly disbursed)
  
  // Just updates status without state validation:
  db.prepare(`UPDATE loan_applications SET status='withdrawn', updated_at=datetime('now') WHERE id=?`).run(applicationId);
  
  // No reversal of the associated Loan record either — orphaned approved+withdrawn application
  // with an active loan still in the system.
}
```

---

## Tests to Write

1. **Application submission**: success, duplicate open application rejected, KYC check, idempotency.
2. **Auto-approval**: passes when all rules met, routes to manual review when rule fails. BUG RG-007: first-time borrower with null debt_ratio auto-approves.
3. **Manual approval**: success, conflict of interest blocks self-approval, BUG RG-006 allows manager to approve direct report.
4. **Committee approval**: requires two approvers, second must be senior_underwriter.
5. **Rejection**: with reason, role enforced.
6. **Appeal**: success, BUG RG-009 allows multiple appeals.
7. **Withdraw**: success in valid states, BUG RG-010 allows withdraw after approval.
8. **Interest rate**: BUG RG-008 makes risk premium 100x smaller than intended.

---

## Bug Summary for This Phase

| ID | Severity | Where | What |
|----|----------|-------|------|
| RG-006 | Critical | `underwriting.service.ts → approveApplication` | Conflict-of-interest check misses manager-to-direct-report relationship |
| RG-007 | Hard | `underwriting.service.ts → checkAutoApproval` | Null/undefined debt_ratio skips the threshold check → unqualified auto-approval |
| RG-008 | Hard | `interest_rate_config` seed data | Risk premium values entered as percent but column labeled bps → rates 100x smaller than intended |
| RG-009 | Easy | `underwriting.service.ts → createAppeal` | Missing existence check → multiple appeals per rejected application |
| RG-010 | Medium | `underwriting.service.ts → withdrawApplication` | Missing status validation → can withdraw approved loans |
