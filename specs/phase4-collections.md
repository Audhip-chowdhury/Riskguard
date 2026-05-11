# RiskGuard — Phase 4: Collections & Default Management

> **Prerequisites**: Phases 1-3 must be complete. Read `phase0-setup.md` for conventions.
>
> **Goal**: Track Days Past Due (DPD), bucket loans into delinquency stages, auto-escalate collections actions, support loan restructuring, write-offs, and post-write-off recovery.
>
> **Bugs to inject**: RG-016, RG-017, RG-018, RG-019, RG-020
>
> **DO NOT modify or break any Phase 1-3 code.**

---

## Migration 004

```sql
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
```

---

## DPD Tracker Worker

**File:** `src/workers/dpd-tracker.ts`

Runs daily at 00:00 IST. For every active loan, computes DPD and updates the bucket. Triggers escalation actions when DPD crosses thresholds.

```typescript
// src/workers/dpd-tracker.ts

async function runDpdCycle() {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];  // 'YYYY-MM-DD'
  
  // Get all active or defaulted loans
  const loans = db.prepare(`
    SELECT * FROM loans 
    WHERE status IN ('active', 'defaulted', 'restructured')
  `).all();
  
  for (const loan of loans) {
    const dpdInfo = computeDpdForLoan(loan, today);
    
    // Insert dpd_record (or update if already exists for today)
    db.prepare(`
      INSERT INTO dpd_records (id, loan_id, as_of_date, days_past_due, overdue_emi_count, 
                               overdue_principal, overdue_interest, overdue_penalty, bucket)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(loan_id, as_of_date) DO UPDATE SET
        days_past_due = excluded.days_past_due,
        overdue_emi_count = excluded.overdue_emi_count,
        overdue_principal = excluded.overdue_principal,
        overdue_interest = excluded.overdue_interest,
        overdue_penalty = excluded.overdue_penalty,
        bucket = excluded.bucket
    `).run(uuid(), loan.id, todayStr, dpdInfo.days, dpdInfo.emiCount,
           dpdInfo.principal, dpdInfo.interest, dpdInfo.penalty, dpdInfo.bucket);
    
    // Trigger escalations
    triggerEscalations(loan, dpdInfo);
  }
}

function computeDpdForLoan(loan: Loan, today: Date): DpdInfo {
  // Find the oldest unpaid EMI
  const oldestUnpaid = db.prepare(`
    SELECT * FROM emi_schedules 
    WHERE loan_id = ? AND status IN ('scheduled', 'overdue', 'partial') 
    ORDER BY due_date ASC 
    LIMIT 1
  `).get(loan.id);
  
  if (!oldestUnpaid) {
    return { days: 0, bucket: 'current', emiCount: 0, principal: 0, interest: 0, penalty: 0 };
  }
  
  // BUG RG-016: DPD computation uses naive Date arithmetic without timezone awareness
  // Both `today` and `oldestUnpaid.due_date` get converted to JS Date objects
  // JS Date.parse('2025-04-15') interprets as UTC midnight (00:00:00 UTC)
  // But the actual "end of day" for IST users is 18:30 UTC the previous day
  // So a loan due 2025-04-15 IST is actually due 2025-04-14T18:30:00 UTC
  // When we compute (today - dueDate) we systematically under-count by ~5.5 hours
  // For loans crossing day boundaries, DPD = N - 1 when it should be N
  
  const dueDate = new Date(oldestUnpaid.due_date);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysPastDue = Math.floor((today.getTime() - dueDate.getTime()) / msPerDay);
  
  // Determine bucket
  let bucket: string;
  // BUG RG-019: Bucket boundaries overlap on day 30, 60, 90
  if (daysPastDue <= 0) bucket = 'current';
  else if (daysPastDue >= 1 && daysPastDue <= 30) bucket = '1-30';
  else if (daysPastDue >= 30 && daysPastDue <= 60) bucket = '31-60';  // overlap at 30
  else if (daysPastDue >= 60 && daysPastDue <= 90) bucket = '61-90';  // overlap at 60
  else bucket = '90+';
  
  // Sum overdue amounts across all unpaid EMIs
  const allUnpaid = db.prepare(`
    SELECT * FROM emi_schedules 
    WHERE loan_id = ? AND status IN ('scheduled', 'overdue', 'partial') 
      AND due_date <= date('now')
  `).all(loan.id) as EmiSchedule[];
  
  const totals = allUnpaid.reduce((acc, e) => ({
    principal: acc.principal + (e.principal_component - (e.paid_amount > e.interest_component ? e.paid_amount - e.interest_component : 0)),
    interest: acc.interest + Math.max(0, e.interest_component - e.paid_amount),
    penalty: acc.penalty + e.late_penalty,
  }), { principal: 0, interest: 0, penalty: 0 });
  
  return {
    days: daysPastDue,
    bucket,
    emiCount: allUnpaid.length,
    ...totals,
  };
}
```

**🐛 BUG RG-016 — INJECT THIS (Critical):** Implemented above in `computeDpdForLoan`. The DPD calculation uses naive UTC date math, systematically under-counting DPD for IST-based loans. Loans appear 1 day less past due than they actually are. The 90-day NPA threshold is hit a full day late.

**🐛 BUG RG-019 — INJECT THIS (Medium):** Implemented above. A loan at exactly DPD=30 satisfies both `1-30` and `31-60` ranges. When `getCollectionsQueue` does `WHERE bucket = '1-30'`, it gets one set of loans; `WHERE bucket = '31-60'` gets another. But the dpd_record row stored uses the FIRST matched bucket (since it's an if-else chain), so the record itself has only one bucket. The bug manifests downstream in the queue endpoint:

```typescript
// src/routes/collections.ts → GET /collections/queue
async function getQueue(bucket: string) {
  // BUG RG-019: The queue query uses BETWEEN which is INCLUSIVE on both ends
  // A loan in record bucket '1-30' with DPD=30 also matches BETWEEN 30 AND 60
  // So the queue endpoint shows the same loan in TWO buckets
  
  let dpdRange: [number, number];
  switch (bucket) {
    case '1-30': dpdRange = [1, 30]; break;
    case '31-60': dpdRange = [30, 60]; break;  // BUG: should be [31, 60]
    case '61-90': dpdRange = [60, 90]; break;  // BUG: should be [61, 90]
    case '90+': dpdRange = [90, 9999]; break;
    default: dpdRange = [0, 0];
  }
  
  const loans = db.prepare(`
    SELECT l.*, dpd.days_past_due 
    FROM loans l
    JOIN dpd_records dpd ON dpd.loan_id = l.id 
    WHERE dpd.days_past_due BETWEEN ? AND ?
      AND dpd.as_of_date = date('now')
  `).all(dpdRange[0], dpdRange[1]);
  
  return loans;
}
```

A loan at exactly DPD=30 appears in both `1-30` and `31-60` queues — confusing collections agents.

---

## Escalation Logic

```typescript
function triggerEscalations(loan: Loan, dpdInfo: DpdInfo) {
  // Day 1: reminder
  // Day 30: warning
  // Day 60: recovery notice
  // Day 90: NPA flag, status → defaulted
  
  const thresholds = [
    { dpd: 1, action: 'reminder_sent' },
    { dpd: 30, action: 'warning_sent' },
    { dpd: 60, action: 'recovery_notice_sent' },
    { dpd: 90, action: 'npa_flagged' },
  ];
  
  for (const t of thresholds) {
    if (dpdInfo.days >= t.dpd) {
      // Check if already triggered (don't duplicate)
      const existing = db.prepare(`
        SELECT 1 FROM collections_actions 
        WHERE loan_id = ? AND action_type = ?
      `).get(loan.id, t.action);
      
      if (!existing) {
        db.prepare(`
          INSERT INTO collections_actions (id, loan_id, action_type, trigger_dpd)
          VALUES (?, ?, ?, ?)
        `).run(uuid(), loan.id, t.action, dpdInfo.days);
        
        // Special case: NPA → flip loan status to defaulted
        if (t.action === 'npa_flagged' && loan.status !== 'defaulted') {
          db.prepare(`UPDATE loans SET status='defaulted', updated_at=datetime('now') WHERE id=?`).run(loan.id);
        }
      }
    }
  }
}
```

---

## Endpoints

### GET /api/v1/collections/queue

Returns loans currently in collections, grouped by bucket.

**Query params:**
- `bucket` — filter by specific bucket (`1-30`, `31-60`, `61-90`, `90+`)
- `agent_id` — filter to loans assigned to a specific agent
- `page`, `limit`

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "loan_id": "uuid",
      "borrower": {
        "id": "uuid",
        "username": "frank",
        "department": "Engineering",
        "current_score": 620
      },
      "days_past_due": 45,
      "bucket": "31-60",
      "overdue_amount": "29400.00",
      "outstanding_total": "85000.00",
      "assigned_agent": { "id": "uuid", "username": "eve" } | null,
      "last_action": {
        "action_type": "warning_sent",
        "created_at": "..."
      }
    }
  ],
  "meta": { "page": 1, "limit": 10, "total": 24 }
}
```

**Business Rules:**
- Anyone with role >= `collections_agent` can view.
- Agents see their assigned loans by default; admins see all.

---

### POST /api/v1/loans/:id/restructure

Restructure an active loan — extend tenure, reduce EMI, or change rate.

**Request:**
```json
{
  "new_tenure_months": 24,
  "new_annual_rate_bps": 1500,
  "reason": "Borrower lost secondary income source. New tenure 24 months from current outstanding principal."
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "restructuring_id": "uuid",
    "loan_id": "uuid",
    "previous": {
      "outstanding": "75000.00",
      "remaining_emis": 8,
      "emi": "9700.00",
      "rate": "11.50"
    },
    "new": {
      "outstanding": "75000.00",
      "tenure_months": 24,
      "emi": "3650.00",
      "rate": "15.00"
    },
    "new_schedule_generated": true
  }
}
```

**Business Rules:**
- Caller must be `senior_underwriter` or `admin`.
- Loan must be `active` or `defaulted`.
- Reason required (min 30 chars).
- New tenure must be different from previous remaining.

**🐛 BUG RG-017 — INJECT THIS (High):**

```typescript
async function restructureLoan(loanId: string, params: RestructureParams, approverId: string) {
  const loan = getLoan(loanId);
  const outstanding = computeTotalOutstanding(loanId);
  
  // Compute new EMI
  const newEmi = computeEmi(outstanding, params.new_annual_rate_bps, params.new_tenure_months);
  
  // Generate new schedule
  const newSchedule = generateEmiSchedule(
    { ...loan, principal_amount: outstanding, annual_interest_rate_bps: params.new_annual_rate_bps, tenure_months: params.new_tenure_months },
    new Date()
  );
  
  db.transaction(() => {
    // Insert restructuring record
    db.prepare(`INSERT INTO restructurings (...) VALUES (...)`).run(...);
    
    // BUG RG-017: Old EMI schedule entries are NOT marked as 'superseded'
    // The new schedule is inserted alongside the old one
    // The repayment-executor worker fetches ALL scheduled EMIs
    // → both old and new EMIs get debited each cycle → double charge
    
    // Missing: db.prepare(`UPDATE emi_schedules SET status='superseded' WHERE loan_id=? AND status IN ('scheduled', 'overdue')`).run(loanId);
    
    // Insert new schedule entries
    for (const entry of newSchedule) {
      db.prepare(`INSERT INTO emi_schedules (...) VALUES (...)`).run(...);
    }
    
    // Update loan
    db.prepare(`UPDATE loans SET status='restructured', tenure_months=?, annual_interest_rate_bps=? WHERE id=?`).run(
      params.new_tenure_months, params.new_annual_rate_bps, loanId
    );
  })();
}
```

Effect: when the repayment executor runs the next day, it processes EMIs from BOTH the old and new schedules, double-charging the borrower.

---

### POST /api/v1/loans/:id/write-off

Mark a loan as uncollectable.

**Request:**
```json
{
  "reason": "Borrower terminated employment 90 days ago, no contact established despite multiple recovery notices. Asset/legal pursuit not cost-effective for this amount."
}
```

**Business Rules:**
- Caller must be `admin`.
- Loan must be in 90+ DPD bucket (or `defaulted` status).
- Reason required (min 50 chars).
- Status flips to `written_off`.

**🐛 BUG RG-018 — INJECT THIS (Medium):**

```typescript
async function writeOffLoan(loanId: string, reason: string, adminUserId: string) {
  const loan = getLoan(loanId);
  const outstanding = computeTotalOutstanding(loanId);
  
  db.transaction(() => {
    // Create write-off record
    db.prepare(`INSERT INTO write_offs (...) VALUES (...)`).run(...);
    
    // Update loan status
    db.prepare(`UPDATE loans SET status='written_off' WHERE id=?`).run(loanId);
    
    // BUG RG-018: Borrower's available_limit is NOT restored / exposure not reset
    // The written-off principal still counts against the borrower's credit utilization
    // Wait — actually the opposite bug is more impactful:
    
    // The borrower's debt_ratio calculation includes only 'active' loans
    // Once status='written_off', the debt is excluded from debt_ratio
    // BUT: there's no flag preventing the borrower from immediately applying for new credit
    // Effectively the write-off resets the credit history without any penalty
    
    // Missing: 
    //   1. Mark borrower as 'write_off_history = true' (excludes from auto-approval)
    //   2. Update credit score with default penalty
    //   3. Set borrower.available_limit to 0 until manual restoration
  })();
  
  // ComplyHub stub: log audit event (no-op for now)
  await logAuditEvent({ type: 'loan_write_off', loan_id: loanId, amount: outstanding });
}
```

Effect: a borrower whose loan was written off as uncollectable can immediately apply for and receive new loans because their credit profile shows clean (no active debt, no flag).

---

### POST /api/v1/loans/:id/record-recovery

Record a payment received after a loan was written off.

**Request:**
```json
{
  "amount": "15000.00",
  "recovery_source": "voluntary_payment",
  "notes": "Borrower's former manager facilitated voluntary repayment"
}
```

**Business Rules:**
- Caller must be `admin` or `collections_agent`.
- Loan must be in `written_off` status.
- Calls PayFlow to credit lending wallet.
- Recovery is income, not a partial unwind of write-off.

---

### POST /api/v1/collections/:id/assign-agent

Assign a collections agent to a loan.

**Request:**
```json
{
  "agent_user_id": "uuid",
  "notes": "Eve has prior experience with this department"
}
```

**Business Rules:**
- Caller must be `admin`.
- Loan must be in 60+ DPD bucket.
- Previous assignment (if any) is deactivated.

**🐛 BUG RG-020 — INJECT THIS (Low):**

```typescript
async function assignAgent(loanId: string, agentUserId: string, assignedByUserId: string, notes?: string) {
  const loan = getLoan(loanId);
  const agent = db.prepare(`SELECT * FROM users WHERE id = ?`).get(agentUserId) as User;
  
  if (!agent) throw new NotFoundError('User not found');
  
  // BUG RG-020: No check that the agent's role is 'collections_agent'
  // Should be: if (agent.role !== 'collections_agent' && agent.role !== 'admin') throw new ValidationError(...);
  
  // Just verifies user exists and proceeds
  
  // Deactivate any previous assignment
  db.prepare(`UPDATE collections_assignments SET is_active=0 WHERE loan_id=? AND is_active=1`).run(loanId);
  
  // Create new assignment
  db.prepare(`INSERT INTO collections_assignments (...) VALUES (...)`).run(
    uuid(), loanId, agentUserId, assignedByUserId
  );
}
```

Effect: admin can assign any user (including employees, underwriters) as collections agent. These users then appear in collections queue assignment dropdowns and might receive notifications/permissions they shouldn't have.

---

## Tests to Write

1. **DPD computation**: BUG RG-016 — loans IST timezone appear 1 day less past due.
2. **Bucket assignment**: boundary tests at days 0, 1, 30, 31, 60, 61, 90, 91. BUG RG-019: a DPD=30 loan appears in both `1-30` and `31-60` queue.
3. **Escalation actions**: trigger at correct DPD, no duplicates.
4. **NPA flagging at day 90**: status flips to `defaulted`.
5. **Restructuring**: new schedule, BUG RG-017 — old schedule entries not superseded.
6. **Write-off**: admin-only, requires reason, BUG RG-018 — borrower's clean credit profile after write-off.
7. **Recovery**: PayFlow credit, recorded against original loan.
8. **Agent assignment**: BUG RG-020 — non-agent role accepted.

---

## Bug Summary for This Phase

| ID | Severity | Where | What |
|----|----------|-------|------|
| RG-016 | Critical | `workers/dpd-tracker.ts → computeDpdForLoan` | Naive UTC date math under-counts DPD for IST loans by ~1 day |
| RG-017 | High | `collections.service.ts → restructureLoan` | Old EMI schedule entries not marked superseded → double charge after restructure |
| RG-018 | Medium | `collections.service.ts → writeOffLoan` | Write-off doesn't flag borrower or reset exposure → can immediately re-borrow |
| RG-019 | Medium | `collections.ts → getQueue` and DPD bucket assignment | Bucket boundaries overlap on days 30, 60, 90 → loans appear in two buckets |
| RG-020 | Low | `collections.service.ts → assignAgent` | No role check on assigned user → any user assignable as collections agent |
