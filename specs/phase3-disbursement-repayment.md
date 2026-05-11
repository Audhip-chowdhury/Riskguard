# RiskGuard — Phase 3: Disbursement & Repayment

> **Prerequisites**: Phases 1-2 must be complete. Read `phase0-setup.md` for conventions.
>
> **Goal**: Disburse approved loans via PayFlow into borrower wallets. Generate reducing-balance EMI schedules. A background worker auto-debits EMIs via PayFlow on due dates. Support manual repayment, partial prepayment, and full prepayment with penalty.
>
> **Bugs to inject**: RG-011, RG-012, RG-013, RG-014, RG-015
>
> **DO NOT modify or break any Phase 1-2 code.**

---

## Migration 003

```sql
-- migrations/003_disbursement_repayment.sql

CREATE TABLE disbursements (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL UNIQUE REFERENCES loans(id),
    requested_amount INTEGER NOT NULL,
    processing_fee INTEGER NOT NULL DEFAULT 0,
    net_disbursed_amount INTEGER NOT NULL,  -- requested - processing_fee
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
    emi_amount INTEGER NOT NULL,           -- total EMI in paise
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
    emi_schedule_id TEXT REFERENCES emi_schedules(id),  -- null if not tied to a specific EMI
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
```

---

## EMI Formula

```typescript
// src/services/emi.service.ts

/**
 * Standard reducing-balance EMI formula:
 *   EMI = P * r * (1 + r)^n / ((1 + r)^n - 1)
 * Where:
 *   P = principal (paise, integer)
 *   r = monthly interest rate as decimal (annual_rate_bps / 12 / 10000)
 *   n = tenure in months
 */
export function computeEmi(principal: number, annualRateBps: number, tenureMonths: number): number {
  if (annualRateBps === 0) {
    return Math.round(principal / tenureMonths);
  }
  
  const r = annualRateBps / 12 / 10000;  // monthly rate as decimal
  
  // BUG RG-011: Floating point accumulation
  // Using Math.pow with floats, results in trailing decimals
  // We round at the end, but the rounding error compounds across the schedule
  // because each EMI's interest is computed against a float balance
  
  const factor = Math.pow(1 + r, tenureMonths);
  const emi = (principal * r * factor) / (factor - 1);
  return Math.round(emi);
}

export function generateEmiSchedule(loan: Loan, disbursedAt: Date): EmiScheduleEntry[] {
  const emi = computeEmi(loan.principal_amount, loan.annual_interest_rate_bps, loan.tenure_months);
  const schedule: EmiScheduleEntry[] = [];
  
  let balance = loan.principal_amount;  // INTEGER paise
  
  for (let i = 1; i <= loan.tenure_months; i++) {
    const dueDate = addMonths(disbursedAt, i);
    const monthlyRate = loan.annual_interest_rate_bps / 12 / 10000;
    
    // BUG RG-011 continued: interest is computed on float balance
    // Even though balance is stored as integer, the multiplication produces floats
    const interestComponent = Math.round(balance * monthlyRate);
    const principalComponent = emi - interestComponent;
    const newBalance = balance - principalComponent;
    
    schedule.push({
      installment_number: i,
      due_date: dueDate.toISOString().split('T')[0],
      emi_amount: emi,
      principal_component: principalComponent,
      interest_component: interestComponent,
      opening_balance: balance,
      closing_balance: newBalance,
      status: 'scheduled',
    });
    
    balance = newBalance;
  }
  
  // BUG RG-011: After all iterations, `balance` is rarely exactly 0
  // For a typical 24-month loan, balance ends up at +/- 0.50 SIM (50 paise)
  // The schedule is generated as-is without correcting the final installment
  // This means the loan can never be fully "closed" — outstanding remains
  
  return schedule;
}
```

---

## Endpoints

### POST /api/v1/loans/:id/disburse

Disburse an approved loan via PayFlow.

**Headers:**
```
Idempotency-Key: <unique>
```

**Request:** (no body required)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "disbursement_id": "uuid",
    "loan_id": "uuid",
    "requested_amount": "100000.00",
    "processing_fee": "1000.00",
    "net_disbursed_amount": "99000.00",
    "payflow_transaction_id": "uuid",
    "disbursed_at": "...",
    "schedule_generated": true,
    "first_emi_due": "2025-04-15"
  }
}
```

**Business Rules:**
- Loan must be in `approved` status (not yet disbursed).
- Caller must be `admin` or `senior_underwriter` (operational role separation).
- Processing fee = 1% of principal, capped at 2000.00 SIM.
- Calls PayFlow `POST /transfers` from lending wallet to borrower's wallet for `net_disbursed_amount`.
- Idempotency key passed to PayFlow.
- Generates EMI schedule.
- Updates loan status to `disbursed`, then `active` once schedule is generated.
- ComplyHub stub `screenAml` called pre-disbursement.

**Flow:**
1. Validate loan state.
2. Run ComplyHub AML stub.
3. Compute processing fee + net disbursement amount.
4. Call PayFlow transfer (idempotency key: `disbursement-${loan_id}`).
5. On success: create disbursement record, generate EMI schedule, update loan status.
6. On PayFlow failure: status='failed', error captured, return 502.

---

### GET /api/v1/loans/:id/schedule

Returns the EMI schedule.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "loan_id": "uuid",
    "total_emi": "9700.00",
    "tenure_months": 12,
    "installments": [
      {
        "installment_number": 1,
        "due_date": "2025-04-15",
        "emi_amount": "9700.00",
        "principal_component": "8500.00",
        "interest_component": "1200.00",
        "opening_balance": "100000.00",
        "closing_balance": "91500.00",
        "status": "scheduled",
        "paid_amount": "0.00"
      },
      // ... more installments
    ]
  }
}
```

**Business Rules:**
- Borrower can view own schedule. Underwriters/admins can view any.

---

### POST /api/v1/loans/:id/repay

Manual repayment (full EMI, partial EMI, or extra payment).

**Headers:**
```
Idempotency-Key: <unique>
```

**Request:**
```json
{
  "amount": "9700.00",
  "emi_schedule_id": "uuid"
}
```

If `emi_schedule_id` is provided, payment applied to that specific installment. If not, applied to oldest overdue/scheduled installment.

**Response (201):**
```json
{
  "success": true,
  "data": {
    "repayment_id": "uuid",
    "amount_applied": "9700.00",
    "breakdown": {
      "principal": "8500.00",
      "interest": "1200.00",
      "late_penalty": "0.00",
      "remainder": "0.00"
    },
    "emi_schedule_updated": [
      { "id": "uuid", "status": "paid", "paid_amount": "9700.00" }
    ],
    "loan_outstanding": "91500.00"
  }
}
```

**Business Rules:**
- Caller must be the borrower (or admin for assisted repayments).
- Loan must be in `active`, `defaulted` status.
- Calls PayFlow transfer from borrower's wallet to lending wallet.
- If amount > current EMI: applies remainder to next installment.
- Late penalty paid first, then interest, then principal.

---

### POST /api/v1/loans/:id/prepay

Prepayment — partial or full.

**Request:**
```json
{
  "amount": "50000.00",
  "type": "partial"
}
```

For `full`: amount is auto-computed as current outstanding + penalty.

**Response (201):**
```json
{
  "success": true,
  "data": {
    "prepayment_id": "uuid",
    "type": "partial",
    "prepayment_amount": "50000.00",
    "outstanding_at_prepayment": "75000.00",
    "penalty_amount": "1500.00",
    "total_paid": "51500.00",
    "new_outstanding": "25000.00",
    "schedule_recalculated": true,
    "remaining_emis": 4,
    "new_emi": "6500.00"
  }
}
```

**Business Rules:**
- Prepayment penalty = **2% of outstanding principal at prepayment time**.
- Partial prepayment: reduces principal, regenerates remaining EMI schedule with same tenure.
- Full prepayment: closes the loan, marks status as `prepaid`.

**🐛 BUG RG-013 — INJECT THIS (High):**

```typescript
// src/services/disbursement.service.ts

async function prepayLoan(loanId: string, prepaymentAmount: number, type: 'partial' | 'full') {
  const loan = getLoan(loanId);
  
  // Outstanding includes principal + accrued interest on current EMI
  const currentEmi = getCurrentEmi(loanId);  // returns the current scheduled EMI
  const principalPartOfCurrentEmi = currentEmi.principal_component;
  const totalOutstanding = computeTotalOutstanding(loanId);
  
  // BUG RG-013: Penalty calculated on totalOutstanding INCLUDING principal portion 
  // of the current EMI that the borrower is already about to pay
  // Correct: penalty should be on outstanding AFTER deducting current EMI's principal
  // (i.e., remaining principal AFTER current cycle)
  
  const penalty = Math.round(totalOutstanding * 0.02);  // 2% of total — too high
  
  // Effect: borrower pays penalty on principal they've already paid this cycle
  // Real fintech bug — often caught only in customer disputes
  
  // ... proceed with prepayment
}
```

---

### GET /api/v1/loans/:id/statement

Returns full account statement.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "loan_id": "uuid",
    "principal_amount": "100000.00",
    "current_outstanding": "75000.00",
    "total_paid_to_date": "26500.00",
    "transactions": [
      { "type": "disbursement", "amount": "99000.00", "date": "..." },
      { "type": "processing_fee", "amount": "1000.00", "date": "..." },
      { "type": "emi_payment", "amount": "9700.00", "principal": "8500.00", "interest": "1200.00", "date": "..." },
      // ... more
    ]
  }
}
```

**🐛 BUG RG-015 — INJECT THIS (Low):**

```typescript
async function generateStatement(loanId: string) {
  // BUG RG-015: The processing fee (deducted at disbursement) is NOT included in transactions list
  // Disbursement shows net_disbursed_amount only
  // Statement sums show: disbursed (99000) + EMIs paid = ledger
  // But borrower's actual outflow: principal (100000) + interest + fees + penalties
  
  const transactions = [];
  
  // Disbursement (shows only net, fee is hidden)
  const disbursement = getDisbursement(loanId);
  transactions.push({
    type: 'disbursement',
    amount: formatAmount(disbursement.net_disbursed_amount),  // BUG: should also show processing_fee separately
    date: disbursement.disbursed_at,
  });
  
  // EMI payments
  const repayments = getRepayments(loanId);
  // ...
  
  return { transactions };
}
```

The bug: borrowers see a phantom shortfall — their statement shows they received 99,000 but they owe interest on 100,000. The processing fee is recorded in the disbursements table but never appears in the statement endpoint. Customer support gets confused calls.

---

## Repayment Executor Worker

**File:** `src/workers/repayment-executor.ts`

Runs daily (configurable interval). Auto-debits due EMIs via PayFlow.

```typescript
async function executeRepaymentCycle() {
  // BUG RG-012 introduced here
  
  // Fetch all EMIs due today and earlier that are still scheduled
  const dueEmis = db.prepare(`
    SELECT * FROM emi_schedules 
    WHERE due_date <= date('now') 
      AND status IN ('scheduled', 'overdue')
  `).all();
  
  for (const emi of dueEmis) {
    try {
      // BUG RG-012: Worker doesn't re-check EMI status before debiting
      // If borrower made a manual repayment between the SELECT and the debit, 
      // emi.status was 'scheduled' in our snapshot but now 'paid' in DB
      // The worker still proceeds with PayFlow transfer → double charge
      
      const loan = getLoan(emi.loan_id);
      const borrower = getBorrower(loan.borrower_id);
      const employee = getEmployee(borrower.employee_id);
      
      // Late penalty calculation
      const today = new Date();
      const dueDate = new Date(emi.due_date);
      const daysPastDue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      
      // Grace period: 5 days
      let lateFee = 0;
      if (daysPastDue > 5) {  // BUG RG-014: should be >= 6 or > 4? See below
        // Penalty: 2% of EMI per day past due (after grace)
        const daysAfterGrace = daysPastDue - 5;
        lateFee = Math.min(
          Math.round(emi.emi_amount * 0.02 * daysAfterGrace),
          emi.emi_amount  // capped at 100% of EMI
        );
      }
      
      const totalDebit = emi.emi_amount + lateFee;
      
      // Call PayFlow
      const txnResult = await transferFromPayFlow({
        fromWalletId: employee.payflow_wallet_id,
        toWalletId: process.env.LENDING_WALLET_ID!,
        amount: formatAmount(totalDebit),
        description: `EMI #${emi.installment_number} for loan ${loan.id}`,
        idempotencyKey: `emi-debit-${emi.id}`,
      });
      
      // Update EMI status
      db.prepare(`
        UPDATE emi_schedules 
        SET status='paid', paid_amount=?, paid_at=datetime('now'), late_penalty=?
        WHERE id=?
      `).run(totalDebit, lateFee, emi.id);
      
      // Create repayment record
      // ...
      
    } catch (err) {
      // Log failure, mark EMI as overdue
      db.prepare(`UPDATE emi_schedules SET status='overdue' WHERE id=?`).run(emi.id);
    }
  }
}
```

**🐛 BUG RG-012 — INJECT THIS (High):**
Already shown above. The worker reads EMIs at start of cycle, processes them serially. Race condition: borrower can manually repay between fetch and worker debit, causing double-charge through PayFlow.

**🐛 BUG RG-014 — INJECT THIS (Medium):**

```typescript
// Grace period: 5 days
// Intent: late penalty applies starting day 6 (after a full 5-day grace)
// So daysPastDue should be > 5 (i.e., 6, 7, 8...) for late fee

let lateFee = 0;
if (daysPastDue > 5) {  // This is actually correct
  // ...
}

// BUT the BUG: the grace check uses `<` somewhere else, or the days computation is off
// More precisely:
const today = new Date();
const dueDate = new Date(emi.due_date);
const msPerDay = 1000 * 60 * 60 * 24;
const daysPastDue = Math.floor((today.getTime() - dueDate.getTime()) / msPerDay);

// BUG RG-014: Math.floor on a fractional day gives the wrong count when the EMI was due "today"
// If today is Apr 20 and dueDate was Apr 20, daysPastDue = 0 (correct — not late)
// If today is Apr 25 and dueDate was Apr 20, daysPastDue = 5 — grace period, no fee
// If today is Apr 26 and dueDate was Apr 20, daysPastDue = 6 — late fee kicks in (1 day late)
// But the buggy code uses: if (daysPastDue > 5) — fires at day 6 (1 day late) — CORRECT?

// The actual bug: it should be > 5 but is implemented as >= 5
// So a borrower on day 5 (still within grace) gets charged for 0 days late (0 fee) — looks fine
// Wait — re-implement clearly:

let lateFee = 0;
if (daysPastDue >= 5) {  // BUG RG-014: should be > 5 (i.e., >= 6) to give a full 5-day grace
  // Intent of grace period: day 1, 2, 3, 4, 5 are free
  // Late fee starts day 6
  // Bug: late fee starts day 5 (4 days of grace instead of 5)
  const daysAfterGrace = daysPastDue - 5;  // = 0 on day 5 — fee is 0
  lateFee = Math.min(
    Math.round(emi.emi_amount * 0.02 * daysAfterGrace),
    emi.emi_amount
  );
}
```

The buggy behavior: on day 5 the condition is true but the fee is 0 (because daysAfterGrace = 0). On day 6, fee for 1 day. So the off-by-one only manifests when extending the comparison — actually, let me make this cleaner:

Clean form: grace period is 5 days. Borrowers should have days 0–5 free. Day 6 onwards, fee.

```typescript
// BUG RG-014: Grace period boundary off-by-one
// Correct: lateFee applies when daysPastDue > 5 (day 6+)
// Bug: lateFee applies when daysPastDue >= 5 (day 5+)
// Effect: borrowers using the full 5-day grace period get a $0 fee logged (no money lost yet)
// BUT on day 5 the EMI status flips from 'scheduled' to 'overdue' (because lateFee branch fires)
// On day 5 borrowers see "overdue" status in their app, customer support floods with questions

if (daysPastDue >= 5) {  // off-by-one
  const daysAfterGrace = daysPastDue - 5;
  lateFee = ...;
  // also: status flag flips to overdue prematurely
}
```

---

## Tests to Write

1. **Disbursement**: success, PayFlow integration, idempotency, processing fee deducted, schedule generated.
2. **EMI computation**: BUG RG-011 — schedule end balance is non-zero for non-trivial tenures (e.g., 24 months at 12% on 100K).
3. **EMI schedule retrieval**: pagination, formatting.
4. **Manual repayment**: success, applied to specific EMI, applied to oldest if not specified, breakdown calc.
5. **Worker double-debit**: BUG RG-012 — simulate manual repayment between worker fetch and debit; assert double PayFlow transfer.
6. **Late penalty**: BUG RG-014 — day 5 incorrectly flagged as "overdue".
7. **Prepayment penalty**: BUG RG-013 — penalty includes current EMI's principal portion.
8. **Statement**: BUG RG-015 — processing fee missing from transactions list.

---

## Bug Summary for This Phase

| ID | Severity | Where | What |
|----|----------|-------|------|
| RG-011 | Critical | `emi.service.ts → generateEmiSchedule` | Floating-point arithmetic causes residual non-zero balance at end of schedule → ghost outstanding |
| RG-012 | High | `workers/repayment-executor.ts` | No status re-check before PayFlow debit → manual repayment + worker run = double charge |
| RG-013 | High | `disbursement.service.ts → prepayLoan` | Prepayment penalty includes principal portion of current EMI → over-charged |
| RG-014 | Medium | `workers/repayment-executor.ts` grace check | Grace period boundary off by one day — day 5 prematurely flagged overdue |
| RG-015 | Low | `disbursement.service.ts → generateStatement` | Processing fee deducted at disbursement but missing from statement transactions |
