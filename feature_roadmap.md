# RiskGuard — Product & Feature Reference

**Product:** RiskGuard | **Company:** MetroPay

---

## What Is RiskGuard?

RiskGuard is MetroPay's internal credit risk and underwriting platform. It manages the full lifecycle of employee loans: from credit scoring and origination through disbursement, repayment tracking, collections, and executive-level portfolio risk reporting. It applies configurable underwriting rules — including automatic, manual, and committee-based approval tiers — and uses a reducing-balance EMI model for all loan calculations. Risk officers use RiskGuard to monitor NPA ratios, delinquency aging, vintage cohort performance, concentration risk, and Expected Credit Loss projections across the active portfolio.

---

## System Integrations

| System     | Role                        | Port   | Status          |
|------------|-----------------------------|--------|-----------------|
| PayFlow    | Payment execution           | 3000   | Live            |
| ComplyHub  | AML / KYC compliance checks | —      | Stubbed (hooks present, not wired) |

### PayFlow Integration Points

| Event                    | PayFlow Call                         | Direction |
|--------------------------|--------------------------------------|-----------|
| Loan disbursement        | `POST /transfers` (lending → borrower wallet) | Outbound |
| EMI auto-debit (worker)  | `POST /transfers` (borrower → lending wallet) | Outbound |
| Manual repayment         | `POST /transfers` (borrower → lending wallet) | Outbound |
| Prepayment               | `POST /transfers` (borrower → lending wallet) | Outbound |
| Recovery (post write-off)| `POST /transfers` (borrower → lending wallet) | Outbound |

### ComplyHub Stub Hooks

| Hook Point                  | Intended Check          | Current State |
|-----------------------------|-------------------------|---------------|
| Borrower registration       | KYC identity check      | Stubbed — always passes |
| Loan application submission | AML transaction screen  | Stubbed — always passes |
| Large disbursement (>50k)   | Enhanced due diligence  | Stubbed — always passes |

---

## Phase Overview

| Phase | Name                              | API Endpoints | Workers         | Intentional Bugs |
|-------|-----------------------------------|---------------|-----------------|------------------|
| 1     | Borrower Profiles & Credit Scoring | 5             | —               | RG-001 to RG-005 |
| 2     | Loan Origination & Underwriting   | 6             | —               | RG-006 to RG-010 |
| 3     | Disbursement & Repayment          | 5             | repayment-executor | RG-011 to RG-015 |
| 4     | Collections & Default Management  | 5             | dpd-tracker     | RG-016 to RG-020 |
| 5     | Portfolio Reporting & Risk Analytics | 5          | —               | RG-021 to RG-025 |

---

## Phase 1 — Borrower Profiles & Credit Scoring

### Goal

Phase 1 establishes the borrower identity layer. Employees from PayFlow's employee directory are registered as RiskGuard borrowers, and a multi-factor credit scoring engine computes a 0–1000 score using salary, tenure, job grade, and historical loan performance. Scores are stored in a versioned history, and admins can issue manual adjustments with a rationale.

### Features

- Register employees as borrowers (pulls profile data from PayFlow)
- Multi-factor credit score computation (salary, tenure, job grade, repayment history)
- Score band assignment: Excellent (800+), Good (700–799), Fair (600–699), Poor (<600)
- Versioned score history per borrower
- Manual score adjustment with admin-only access and audit trail

### API Endpoints

| Method | Path                                   | Description                          |
|--------|----------------------------------------|--------------------------------------|
| POST   | `/api/v1/borrowers`                    | Register borrower from employee      |
| GET    | `/api/v1/borrowers/:id`                | Get borrower profile and current score |
| POST   | `/api/v1/borrowers/:id/recompute-score`| Trigger score recomputation          |
| GET    | `/api/v1/borrowers/:id/score-history`  | List score history (newest first)    |
| POST   | `/api/v1/borrowers/:id/manual-adjust`  | Admin manual score override          |

### Bugs

| ID      | Severity | Description                                                                 |
|---------|----------|-----------------------------------------------------------------------------|
| RG-001  | Medium   | Score weights applied before normalisation, skewing all composite scores    |
| RG-002  | High     | Zero-salary employees produce NaN credit score (no guard against divide-by-zero) |
| RG-003  | Medium   | Band boundary at 600 misclassifies: score of exactly 600 placed in Fair instead of Good |
| RG-004  | Low      | Score history returned in ascending order instead of newest-first           |
| RG-005  | High     | Manual adjustment accepts out-of-range values (e.g., −200 or 1500); no min/max validation |

---

## Phase 2 — Loan Origination & Underwriting

### Goal

Phase 2 implements the loan application pipeline and three-tier underwriting engine. Applications are auto-approved if all risk thresholds pass, assigned to individual underwriters for manual review in borderline cases, or escalated to a credit committee for large exposures. Interest rates are computed from a base rate plus a risk premium in basis points. Rejected applications may be appealed once, and applicants may withdraw before a decision is issued.

### Features

- Loan application submission with debt-ratio check
- Three-tier underwriting: auto-approve, manual underwriter, credit committee
- Conflict-of-interest enforcement (approver cannot be related to borrower's manager chain)
- Interest rate model: base rate + risk premium (in basis points)
- Single-appeal flow for rejected applications
- Application withdrawal (pre-decision only)

### API Endpoints

| Method | Path                        | Description                                  |
|--------|-----------------------------|----------------------------------------------|
| POST   | `/api/v1/loans/apply`       | Submit a new loan application                |
| GET    | `/api/v1/loans/:id`         | Get application details and underwriting state |
| POST   | `/api/v1/loans/:id/approve` | Approve (underwriter or committee member)    |
| POST   | `/api/v1/loans/:id/reject`  | Reject the application with reason           |
| POST   | `/api/v1/loans/:id/appeal`  | Appeal a rejection                           |
| POST   | `/api/v1/loans/:id/withdraw`| Withdraw a pending application               |

### Bugs

| ID      | Severity | Description                                                                         |
|---------|----------|-------------------------------------------------------------------------------------|
| RG-006  | High     | Conflict-of-interest check only blocks self-approval; manager hierarchy not checked |
| RG-007  | High     | First-time borrowers store null debt ratio, which bypasses the debt-ratio threshold |
| RG-008  | Medium   | Risk premium stored as percent (e.g., 2) instead of basis points (200); rate 100× too low |
| RG-009  | Medium   | No duplicate-appeal guard; the same application can be appealed multiple times      |
| RG-010  | Medium   | Withdrawal allowed on any status including approved/disbursed; missing state check  |

---

## Phase 3 — Disbursement & Repayment

### Goal

Phase 3 covers the money movement layer. Approved loans are disbursed via a PayFlow wallet transfer, net of a processing fee. An EMI schedule is generated using a reducing-balance interest model. A background worker (`repayment-executor`) runs daily to auto-debit due installments and apply late fees after a grace period. Borrowers can also make manual repayments or full/partial prepayments (subject to a prepayment penalty within the lock-in window).

### Features

- Loan disbursement via PayFlow (net of processing fee)
- Reducing-balance EMI schedule generation
- Manual EMI repayment
- Full and partial prepayment with penalty calculation
- Loan statement with transaction history
- `repayment-executor` worker: daily auto-debit and late-fee application

### API Endpoints

| Method | Path                        | Description                              |
|--------|-----------------------------|------------------------------------------|
| POST   | `/api/v1/loans/:id/disburse`  | Disburse approved loan via PayFlow     |
| GET    | `/api/v1/loans/:id/schedule`  | Get full EMI schedule                  |
| POST   | `/api/v1/loans/:id/repay`     | Record a manual EMI payment            |
| POST   | `/api/v1/loans/:id/prepay`    | Full or partial prepayment             |
| GET    | `/api/v1/loans/:id/statement` | Get loan transaction statement         |

### Workers

| Worker              | Trigger | Behaviour                                                    |
|---------------------|---------|--------------------------------------------------------------|
| repayment-executor  | Cron / manual | Debits due EMIs via PayFlow; applies late fees past grace period |

### Bugs

| ID      | Severity | Description                                                                                 |
|---------|----------|---------------------------------------------------------------------------------------------|
| RG-011  | Medium   | Floating-point accumulation in EMI schedule; closing balance ends ~50 paise short of zero   |
| RG-012  | High     | Worker reads due EMIs once at start; no re-check before debit → double charge if borrower repays manually in the window |
| RG-013  | Medium   | Late-fee base incorrectly includes principal portion of the EMI being paid                  |
| RG-014  | Low      | Grace-period off-by-one: fee applied at DPD ≥ 5 instead of DPD > 5 (day 5 incorrectly penalised) |
| RG-015  | Low      | Processing fee deducted at disbursement not recorded in statement; only net amount shown    |

---

## Phase 4 — Collections & Default Management

### Goal

Phase 4 introduces the delinquency management layer. A background worker (`dpd-tracker`) runs daily to compute Days Past Due for all active loans and classify them into delinquency buckets. Operations teams use a collections queue to prioritise outreach, assign dedicated collections agents, and initiate formal resolution paths: loan restructuring, write-off, or post-write-off recovery recording.

### Features

- DPD computation and delinquency bucket classification (current, 1–30, 31–60, 61–90, 90+)
- Collections queue with priority ranking
- Collections agent assignment
- Loan restructuring (new terms, revised EMI schedule)
- Write-off of non-performing loans
- Recovery recording post write-off
- `dpd-tracker` worker: daily DPD refresh

### API Endpoints

| Method | Path                                   | Description                              |
|--------|----------------------------------------|------------------------------------------|
| POST   | `/api/v1/loans/:id/restructure`        | Restructure an overdue loan              |
| POST   | `/api/v1/loans/:id/write-off`          | Write off a non-performing loan          |
| POST   | `/api/v1/loans/:id/record-recovery`    | Record recovery on a written-off loan   |
| GET    | `/api/v1/collections/queue`            | Get prioritised collections queue        |
| POST   | `/api/v1/collections/:id/assign-agent` | Assign a collections agent to a case    |

### Workers

| Worker      | Trigger       | Behaviour                                                         |
|-------------|---------------|-------------------------------------------------------------------|
| dpd-tracker | Cron / manual | Recomputes DPD for all active loans; updates delinquency buckets  |

### Bugs

| ID      | Severity | Description                                                                                    |
|---------|----------|------------------------------------------------------------------------------------------------|
| RG-016  | Medium   | DPD computed using timezone-naive JS Date arithmetic; can be off by ±1 day near midnight UTC   |
| RG-017  | High     | Old EMI schedule entries not marked superseded on restructure; appear as overdue in collections |
| RG-018  | High     | Credit exposure not reduced after write-off; written-off principal still counts against utilisation |
| RG-019  | Medium   | DPD bucket boundaries overlap at 30, 60, 90 days; a loan at exactly DPD=30 appears in two buckets |
| RG-020  | High     | No role check on agent assignment; any active user (including employees) can be assigned        |

---

## Phase 5 — Portfolio Reporting & Risk Analytics

### Goal

Phase 5 delivers the executive reporting layer. Risk officers and finance leadership can monitor the active portfolio via a dashboard showing total book size, NPA ratio, and collection efficiency. Supporting reports provide aging analysis, vintage cohort default curves, sectoral/grade concentration risk, and forward-looking Expected Credit Loss projections using a PD/LGD/EAD model.

### Features

- Portfolio dashboard: book size, NPA ratio, collection efficiency
- Delinquency aging report (by bucket and outstanding amount)
- Vintage cohort report (default rate by disbursement month)
- Concentration risk report (by department, job grade, loan amount band)
- ECL projection using PD/LGD/EAD model with credit-band-level PD lookup

### API Endpoints

| Method | Path                          | Description                                   |
|--------|-------------------------------|-----------------------------------------------|
| GET    | `/api/v1/reports/portfolio`   | Portfolio summary and NPA metrics             |
| GET    | `/api/v1/reports/aging`       | Delinquency aging breakdown                   |
| GET    | `/api/v1/reports/vintage`     | Vintage cohort default-rate curves            |
| GET    | `/api/v1/reports/concentration` | Concentration risk by segment               |
| GET    | `/api/v1/reports/ecl`         | Expected Credit Loss projections              |

### Bugs

| ID      | Severity | Description                                                                                      |
|---------|----------|--------------------------------------------------------------------------------------------------|
| RG-021  | Medium   | NPA ratio numerator includes written-off loans, overstating the NPA rate                        |
| RG-022  | Medium   | Vintage report grouped by application date instead of disbursement date; up to 14-day cohort skew |
| RG-023  | Low      | Collection efficiency includes prepayments; should count only scheduled EMI payments             |
| RG-024  | Medium   | Aging report uses outstanding amount for bucket sums but principal amount for the total; metrics mixed |
| RG-025  | High     | ECL PD lookup fails silently: band names stored uppercase ('GOOD') vs mixed-case borrower records ('Good') |

---

## Complete Bug Manifest

| ID      | Phase | Severity | Discovery Difficulty | Category                 | Description                                                                       |
|---------|-------|----------|----------------------|--------------------------|-----------------------------------------------------------------------------------|
| RG-001  | 1     | Medium   | Critical             | Algorithm / Calculation  | Score weights applied before normalisation, skewing composite scores              |
| RG-002  | 1     | High     | Medium               | Input Validation         | Zero-salary borrower produces NaN credit score                                    |
| RG-003  | 1     | Medium   | Medium               | Boundary Condition       | Score of exactly 600 misclassified as Fair instead of Good                        |
| RG-004  | 1     | Low      | Easy                 | Sort Order               | Score history returned oldest-first instead of newest-first                       |
| RG-005  | 1     | High     | Easy                 | Input Validation         | Manual adjustment accepts out-of-range scores (e.g., −200 or 1500)               |
| RG-006  | 2     | High     | Critical             | Authorization            | Conflict-of-interest check omits manager hierarchy; only blocks direct self-approval |
| RG-007  | 2     | High     | Hard                 | Edge Case / Business Rule | Null debt ratio for first-time borrowers bypasses the debt-ratio threshold check  |
| RG-008  | 2     | Medium   | Hard                 | Unit / Data Model        | Risk premium stored as percent instead of basis points; effective rate 100× too low |
| RG-009  | 2     | Medium   | Easy                 | Business Rule            | No duplicate-appeal guard; applications can be appealed more than once            |
| RG-010  | 2     | Medium   | Medium               | State Machine            | Withdrawal permitted on approved/disbursed loans; missing status validation       |
| RG-011  | 3     | Medium   | Critical             | Floating Point / Precision | EMI schedule closing balance off by ~50 paise due to floating-point accumulation |
| RG-012  | 3     | High     | Hard                 | Race Condition (TOCTOU)  | Worker reads due EMIs once; no re-check before debit can cause double-charge      |
| RG-013  | 3     | Medium   | Hard                 | Calculation              | Late-fee base includes principal of current EMI, overstating the penalty          |
| RG-014  | 3     | Low      | Easy                 | Off-by-One               | Grace period boundary at DPD ≥ 5 instead of DPD > 5; day 5 incorrectly penalised |
| RG-015  | 3     | Low      | Medium               | Audit Trail / Completeness | Processing fee not recorded in transaction statement; only net disbursed shown   |
| RG-016  | 4     | Medium   | Critical             | Date / Time              | DPD computed with timezone-naive arithmetic; can be ±1 day near midnight UTC      |
| RG-017  | 4     | High     | Medium               | Data Consistency         | Old EMI entries not superseded on restructure; remain active in collections queue |
| RG-018  | 4     | High     | Hard                 | Data Consistency / State | Written-off principal not removed from credit exposure, blocking future borrowing  |
| RG-019  | 4     | Medium   | Medium               | Query Logic / Boundary   | Delinquency bucket boundaries overlap; DPD=30 loan appears in both 1–30 and 31–60 |
| RG-020  | 4     | High     | Easy                 | Authorization            | Collections agent assignment has no role check; any user can be assigned          |
| RG-021  | 5     | Medium   | Critical             | Query Logic              | NPA numerator includes written-off loans, inflating the reported NPA ratio        |
| RG-022  | 5     | Medium   | Hard                 | Query Logic / Data Model | Vintage cohorts grouped by application date, not disbursement date                |
| RG-023  | 5     | Low      | Medium               | Query Logic / Definition | Collection efficiency numerator includes prepayment transactions                  |
| RG-024  | 5     | Medium   | Hard                 | Data Consistency / Metrics | Aging report mixes outstanding amounts (buckets) with principal amounts (total)  |
| RG-025  | 5     | High     | Hard                 | Data Integrity           | ECL PD lookup fails silently due to case mismatch (GOOD vs Good) in band names    |

---

## Data Flow

```
PayFlow Employee Directory
        │
        ▼
   [POST /borrowers]
        │
        ▼
  Borrower Profile ──── Credit Score ──── Score History
        │
        ▼
   [POST /loans/apply]
        │
        ▼
  Loan Application ──── Underwriting Engine ──── Decision
        │                     │
        │           (auto / manual / committee)
        │
        ▼
  [POST /loans/:id/disburse]
        │
        ▼
  PayFlow Transfer ──── Disbursement Record
        │
        ▼
  EMI Schedule ──── repayment-executor (worker)
        │                    │
        │            PayFlow auto-debit
        │
        ▼
  Repayment Records
        │
        ▼
  dpd-tracker (worker)
        │
        ▼
  DPD Records ──── Collections Queue ──── Agent Assignment
        │
        ├── Restructure ──► New EMI Schedule
        ├── Write-Off   ──► Recovery Record
        │
        ▼
  Reporting Layer
  ├── Portfolio Dashboard
  ├── Aging Report
  ├── Vintage Report
  ├── Concentration Risk
  └── ECL Projections
```
