# RiskGuard

**Internal credit risk and underwriting platform** | MetroPay

![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-205%20passing-brightgreen)

---

## Overview

RiskGuard is MetroPay's internal platform for credit scoring, loan origination, underwriting, collections, and portfolio risk reporting. It integrates with the PayFlow payment system for disbursements and repayments, and exposes a REST API consumed by internal tooling and operations teams.

See [feature_roadmap.md](feature_roadmap.md) for full feature and product details.

---

## Quick Start

```bash
git clone https://github.com/Audhip-chowdhury/Riskguard.git
cd Riskguard
npm install
npm run migrate
npm run seed
npm run dev
```

Server runs on **http://localhost:3001**

> PayFlow (port 3000) must be running for disbursement and repayment flows.

---

## API Authentication

All requests require an `X-API-Key` header and an `Idempotency-Key` header on all `POST`/`PATCH` requests.

After running `npm run seed`, the following users are available. Retrieve their API keys from the `users` table (`SELECT username, api_key, role FROM users;`):

| Username | Role               | Description                   |
|----------|--------------------|-------------------------------|
| alice    | admin              | CFO — full access             |
| bob      | senior_underwriter | Head of Risk — can approve    |
| charlie  | underwriter        | Underwriter                   |
| diana    | underwriter        | Underwriter                   |
| eve      | collections_agent  | Senior Collections Agent      |
| frank    | employee           | Senior Engineer (borrower)    |
| grace    | employee           | Engineer (borrower)           |
| henry    | employee           | Marketing Manager (borrower)  |
| iris     | employee           | Sales Rep (borrower)          |
| jack     | employee           | Engineer (borrower)           |

---

## Running Tests

```bash
npm test
```

205 tests across 5 phases. Tests use an in-memory SQLite database and do not require PayFlow to be running.

---

## API Reference

All endpoints are prefixed with `/api/v1`.

### Phase 1 — Borrower Profiles & Credit Scoring

| Method | Path                                   | Description                        |
|--------|----------------------------------------|------------------------------------|
| POST   | `/borrowers`                           | Register a borrower from employee  |
| GET    | `/borrowers/:id`                       | Get borrower profile and score     |
| POST   | `/borrowers/:id/recompute-score`       | Recompute credit score             |
| GET    | `/borrowers/:id/score-history`         | Get score history (newest first)   |
| POST   | `/borrowers/:id/manual-adjust`         | Admin manual score adjustment      |

### Phase 2 — Loan Origination & Underwriting

| Method | Path                     | Description                                   |
|--------|--------------------------|-----------------------------------------------|
| POST   | `/loans/apply`           | Submit a loan application                     |
| GET    | `/loans/:id`             | Get loan application details                  |
| POST   | `/loans/:id/approve`     | Approve a loan (underwriter / committee)      |
| POST   | `/loans/:id/reject`      | Reject a loan application                     |
| POST   | `/loans/:id/appeal`      | Appeal a rejected application                 |
| POST   | `/loans/:id/withdraw`    | Withdraw a pending application                |

### Phase 3 — Disbursement & Repayment

| Method | Path                     | Description                                   |
|--------|--------------------------|-----------------------------------------------|
| POST   | `/loans/:id/disburse`    | Disburse an approved loan via PayFlow         |
| GET    | `/loans/:id/schedule`    | Get EMI repayment schedule                    |
| POST   | `/loans/:id/repay`       | Record a manual EMI repayment                 |
| POST   | `/loans/:id/prepay`      | Make a full or partial prepayment             |
| GET    | `/loans/:id/statement`   | Get loan transaction statement                |

### Phase 4 — Collections & Default Management

| Method | Path                              | Description                            |
|--------|-----------------------------------|----------------------------------------|
| POST   | `/loans/:id/restructure`          | Restructure an overdue loan            |
| POST   | `/loans/:id/write-off`            | Write off a non-performing loan        |
| POST   | `/loans/:id/record-recovery`      | Record post-write-off recovery         |
| GET    | `/collections/queue`              | Get the active collections queue       |
| POST   | `/collections/:id/assign-agent`   | Assign a collections agent to a loan   |

### Phase 5 — Portfolio Reporting & Risk Analytics

| Method | Path                       | Description                              |
|--------|----------------------------|------------------------------------------|
| GET    | `/reports/portfolio`       | Portfolio dashboard and NPA metrics      |
| GET    | `/reports/aging`           | Delinquency aging report                 |
| GET    | `/reports/vintage`         | Vintage cohort performance report        |
| GET    | `/reports/concentration`   | Concentration risk by segment            |
| GET    | `/reports/ecl`             | Expected Credit Loss (ECL) projections   |

---

## Background Workers

Two workers run outside the request cycle. Start them independently:

```bash
npm run worker:repayment   # repayment-executor
npm run worker:dpd         # dpd-tracker
```

| Worker               | Script                              | Purpose                                                              |
|----------------------|-------------------------------------|----------------------------------------------------------------------|
| repayment-executor   | `src/workers/repayment-executor.ts` | Debits due EMIs from borrower accounts via PayFlow; applies late fees|
| dpd-tracker          | `src/workers/dpd-tracker.ts`        | Computes Days Past Due and updates delinquency bucket classifications |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```
NODE_ENV=development
PORT=3001
LOG_LEVEL=debug
DATABASE_PATH=./data/riskguard.db

# PayFlow integration
PAYFLOW_BASE_URL=http://localhost:3000
PAYFLOW_API_KEY=pfk_riskguard_service_key
LENDING_WALLET_ID=<seeded-on-first-run>
```

---

## Intentional Bugs

> This codebase contains 25 intentional bugs for QA training. See [feature_roadmap.md](feature_roadmap.md) for details.

Each bug is marked with a `// BUG RG-XXX` comment in the source. They are spread across scoring, underwriting, repayment, collections, and reporting logic — ranging from off-by-one errors and unit mismatches to race conditions and data-consistency issues.

---

## Project Structure

```
src/
  routes/        API route handlers
  services/      Business logic (scoring, underwriting, disbursement, collections, reporting)
  workers/       Background workers (repayment-executor, dpd-tracker)
  middleware/    Auth, validation, error handling
  db.ts          SQLite connection (better-sqlite3)
  migrate.ts     Migration runner
seed/
  seed.ts        Dev seed data
specs/
  phase0-setup.md … phase5-portfolio-reporting.md
```
