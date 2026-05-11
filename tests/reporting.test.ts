import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import request from 'supertest';
import app from '../src/app';
import db from '../src/db';
import { testApiKeys } from './setup';

// ─── Shared state ─────────────────────────────────────────────────────────────

// loan IDs inserted in beforeAll
let rptLoan1Id: string; // active, personal_loan, Good band, Engineering
let rptLoan2Id: string; // active, salary_advance, Fair band, Sales
let rptLoan3Id: string; // written_off, personal_loan, Poor band, Engineering
let rptLoan4Id: string; // active, personal_loan, Good band — created April, disbursed May (vintage bug)

// Use alice (admin) for all report requests
const adminKey = () => testApiKeys['alice'];
const underwriterKey = () => testApiKeys['bob'];

// Deterministic test-period dates (no collision with today-based data from other test files)
const DPD_DATE = '2026-03-15';          // DPD records date for NPA/aging tests
const COLL_START = '2026-02-01';        // Collection efficiency test period
const COLL_END = '2026-02-28';
const VINTAGE_CREATED = '2026-04-15T00:00:00.000Z'; // loan4 created in April
const VINTAGE_DISBURSED = '2026-05-01T00:00:00.000Z'; // loan4 disbursed in May

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  const ts = new Date().toISOString();

  // ── Users / Employees / Borrowers ──────────────────────────────────────────

  const insertUser = (username: string, role: string) => {
    const userId = uuidv4();
    const apiKey = `rgk_${crypto.randomBytes(24).toString('hex')}`;
    db.prepare(
      `INSERT INTO users (id, username, email, api_key, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(userId, username, `${username}@metropay.io`, apiKey, role, ts, ts);
    return userId;
  };

  const insertEmployee = (userId: string, department: string, salary: number) => {
    const employeeId = uuidv4();
    db.prepare(
      `INSERT INTO employees
         (id, user_id, payflow_wallet_id, department, designation, department_risk_tier,
          monthly_salary, joined_at, manager_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 2, ?, ?, NULL, ?)`
    ).run(employeeId, userId, uuidv4(), department, 'Staff', salary, ts, ts);
    return employeeId;
  };

  const insertBorrower = (employeeId: string, band: string) => {
    const borrowerId = uuidv4();
    db.prepare(
      `INSERT INTO borrowers
         (id, employee_id, current_score, current_band, credit_limit, available_limit,
          kyc_status, kyc_verified_at, last_scored_at, created_at, updated_at)
       VALUES (?, ?, 700, ?, 10000000, 10000000, 'passed', ?, ?, ?, ?)`
    ).run(borrowerId, employeeId, band, ts, ts, ts, ts);
    return borrowerId;
  };

  // Borrower 1: Good band, Engineering
  const u1 = insertUser('rpt_eng1', 'employee');
  const e1 = insertEmployee(u1, 'Engineering', 2000000);
  const b1 = insertBorrower(e1, 'Good');

  // Borrower 2: Fair band, Sales
  const u2 = insertUser('rpt_sales1', 'employee');
  const e2 = insertEmployee(u2, 'Sales', 1200000);
  const b2 = insertBorrower(e2, 'Fair');

  // Borrower 3: Poor band, Engineering (will be written off)
  const u3 = insertUser('rpt_eng2', 'employee');
  const e3 = insertEmployee(u3, 'Engineering', 800000);
  const b3 = insertBorrower(e3, 'Poor');

  // ── Loan Applications ───────────────────────────────────────────────────────

  const insertApp = (borrowerId: string, amount: number, band: string) => {
    const appId = uuidv4();
    db.prepare(
      `INSERT INTO loan_applications
         (id, borrower_id, product_type, requested_amount, requested_tenure_months, purpose,
          status, approval_tier, score_at_application, band_at_application,
          available_limit_at_application, submitted_at, created_at, updated_at)
       VALUES (?, ?, 'personal_loan', ?, 12, 'Test', 'approved', 'auto', 700, ?, 10000000, ?, ?, ?)`
    ).run(appId, borrowerId, amount, band, ts, ts, ts);
    return appId;
  };

  const app1Id = insertApp(b1, 500000, 'Good');
  const app2Id = insertApp(b2, 300000, 'Fair');
  const app3Id = insertApp(b3, 200000, 'Poor');
  const app4Id = insertApp(b1, 100000, 'Good'); // loan4: same borrower as loan1

  // ── Loans ───────────────────────────────────────────────────────────────────

  const insertLoan = (
    appId: string, borrowerId: string, productType: string,
    principal: number, status: string, createdAt: string,
  ) => {
    const loanId = uuidv4();
    db.prepare(
      `INSERT INTO loans
         (id, application_id, borrower_id, product_type, principal_amount, tenure_months,
          annual_interest_rate_bps, processing_fee_amount, status, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 12, 1200, 0, ?, ?, ?, ?)`
    ).run(loanId, appId, borrowerId, productType, principal, status, createdAt, createdAt, createdAt);
    return loanId;
  };

  rptLoan1Id = insertLoan(app1Id, b1, 'personal_loan', 500000, 'active', ts);
  rptLoan2Id = insertLoan(app2Id, b2, 'salary_advance', 300000, 'active', ts);
  rptLoan3Id = insertLoan(app3Id, b3, 'personal_loan', 200000, 'written_off', ts);
  // loan4: created in April 2026 (different month from disbursed_at in May)
  rptLoan4Id = insertLoan(app4Id, b1, 'personal_loan', 100000, 'active', VINTAGE_CREATED);

  // ── Disbursements ───────────────────────────────────────────────────────────

  const insertDisbursement = (loanId: string, amount: number, disbursedAt: string | null) => {
    const status = disbursedAt ? 'completed' : 'pending';
    db.prepare(
      `INSERT INTO disbursements
         (id, loan_id, requested_amount, processing_fee, net_disbursed_amount,
          payflow_transaction_id, status, error_message, disbursed_at, created_at)
       VALUES (?, ?, ?, 0, ?, 'txn-rpt', ?, NULL, ?, ?)`
    ).run(uuidv4(), loanId, amount, amount, status, disbursedAt, ts);
  };

  insertDisbursement(rptLoan1Id, 500000, ts);
  insertDisbursement(rptLoan2Id, 300000, ts);
  insertDisbursement(rptLoan3Id, 200000, ts);
  // loan4: disbursed in May 2026 — different month from created_at (April)
  insertDisbursement(rptLoan4Id, 100000, VINTAGE_DISBURSED);

  // ── DPD Records (at DPD_DATE for NPA/aging tests) ──────────────────────────

  // loan1: 1-30 bucket (active — should appear in bucket sums for aging)
  db.prepare(
    `INSERT INTO dpd_records
       (id, loan_id, as_of_date, days_past_due, overdue_emi_count,
        overdue_principal, overdue_interest, overdue_penalty, bucket, created_at)
     VALUES (?, ?, ?, 15, 1, 50000, 5000, 0, '1-30', ?)`
  ).run(uuidv4(), rptLoan1Id, DPD_DATE, ts);

  // loan3 (written_off): 90+ bucket — BUG RG-021: included in NPA numerator
  db.prepare(
    `INSERT INTO dpd_records
       (id, loan_id, as_of_date, days_past_due, overdue_emi_count,
        overdue_principal, overdue_interest, overdue_penalty, bucket, created_at)
     VALUES (?, ?, ?, 95, 4, 200000, 20000, 5000, '90+', ?)`
  ).run(uuidv4(), rptLoan3Id, DPD_DATE, ts);

  // ── EMI Schedules (for February 2026 — collection efficiency tests) ─────────

  db.prepare(
    `INSERT INTO emi_schedules
       (id, loan_id, installment_number, due_date, emi_amount, principal_component,
        interest_component, opening_balance, closing_balance, status, paid_amount, paid_at, late_penalty)
     VALUES (?, ?, 1, '2026-02-15', 50000, 45000, 5000, 500000, 455000, 'overdue', 0, NULL, 0)`
  ).run(uuidv4(), rptLoan1Id);

  db.prepare(
    `INSERT INTO emi_schedules
       (id, loan_id, installment_number, due_date, emi_amount, principal_component,
        interest_component, opening_balance, closing_balance, status, paid_amount, paid_at, late_penalty)
     VALUES (?, ?, 1, '2026-02-20', 30000, 27000, 3000, 300000, 273000, 'overdue', 0, NULL, 0)`
  ).run(uuidv4(), rptLoan2Id);

  // ── Repayments (February 2026) ──────────────────────────────────────────────

  // Regular EMI repayment (loan1) — type 'auto_emi' is the normal EMI collection type
  db.prepare(
    `INSERT INTO repayments
       (id, loan_id, emi_schedule_id, type, amount, principal_paid, interest_paid,
        late_penalty_paid, prepayment_penalty_paid, payflow_transaction_id,
        status, error_message, initiated_at, completed_at)
     VALUES (?, ?, NULL, 'auto_emi', 50000, 45000, 5000, 0, 0,
             'txn-rpt-emi', 'completed', NULL, '2026-02-15T09:00:00.000Z', '2026-02-15T10:00:00.000Z')`
  ).run(uuidv4(), rptLoan1Id);

  // Prepayment (loan2) — BUG RG-023: included in collected → efficiency > 100%
  db.prepare(
    `INSERT INTO repayments
       (id, loan_id, emi_schedule_id, type, amount, principal_paid, interest_paid,
        late_penalty_paid, prepayment_penalty_paid, payflow_transaction_id,
        status, error_message, initiated_at, completed_at)
     VALUES (?, ?, NULL, 'partial_prepayment', 300000, 300000, 0, 0, 0,
             'txn-rpt-prepay', 'completed', NULL, '2026-02-20T09:00:00.000Z', '2026-02-20T10:00:00.000Z')`
  ).run(uuidv4(), rptLoan2Id);

  // ── Write-off (loan3) ───────────────────────────────────────────────────────

  const aliceId = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get('alice') as { id: string };

  db.prepare(
    `INSERT INTO write_offs
       (id, loan_id, outstanding_at_write_off, principal_lost, interest_lost,
        penalty_lost, reason, written_off_by_user_id, created_at)
     VALUES (?, ?, 220000, 200000, 15000, 5000, 'No payment for 120 days', ?, ?)`
  ).run(uuidv4(), rptLoan3Id, aliceId.id, ts);
});

// ─── GET /api/v1/reports/portfolio ────────────────────────────────────────────

describe('GET /api/v1/reports/portfolio', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/reports/portfolio');
    expect(res.status).toBe(401);
  });

  it('returns 403 for employee role', async () => {
    const res = await request(app)
      .get('/api/v1/reports/portfolio')
      .set('X-API-Key', testApiKeys['frank']);
    expect(res.status).toBe(403);
  });

  it('returns 200 with correct structure for admin', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/portfolio?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', adminKey());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data.as_of_date).toBe(DPD_DATE);

    // Summary fields
    expect(data.summary).toMatchObject({
      total_outstanding: expect.stringMatching(/^\d+\.\d{2}$/),
      active_loans_count: expect.any(Number),
      total_disbursed_to_date: expect.stringMatching(/^\d+\.\d{2}$/),
      total_collected_to_date: expect.stringMatching(/^\d+\.\d{2}$/),
      written_off_amount: expect.stringMatching(/^\d+\.\d{2}$/),
    });

    // Risk metrics
    expect(data.risk_metrics).toMatchObject({
      npa_amount: expect.stringMatching(/^\d+\.\d{2}$/),
      npa_ratio: expect.stringMatching(/^\d+\.\d{2}$/),
      collection_efficiency: expect.stringMatching(/^\d+\.\d{2}$/),
      avg_dpd_active: expect.any(Number),
    });

    expect(Array.isArray(data.by_product)).toBe(true);
    expect(Array.isArray(data.by_band)).toBe(true);
    expect(data.compared_with).toBeNull();
  });

  it('returns 200 for senior_underwriter role', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/portfolio?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', underwriterKey());
    expect(res.status).toBe(200);
  });

  it('by_product includes personal_loan and salary_advance entries', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/portfolio?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', adminKey());

    const products = res.body.data.by_product.map((p: { product: string }) => p.product);
    expect(products).toContain('personal_loan');
    expect(products).toContain('salary_advance');
  });

  it('by_band includes Good and Fair entries', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/portfolio?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', adminKey());

    const bands = res.body.data.by_band.map((b: { band: string }) => b.band);
    expect(bands).toContain('Good');
    expect(bands).toContain('Fair');
  });

  it('compare_with param populates compared_with field', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/portfolio?as_of_date=${DPD_DATE}&compare_with=2026-01-15`)
      .set('X-API-Key', adminKey());

    expect(res.status).toBe(200);
    const cw = res.body.data.compared_with;
    expect(cw).not.toBeNull();
    expect(cw.as_of_date).toBe('2026-01-15');
    expect(cw).toHaveProperty('npa_amount');
    expect(cw).toHaveProperty('npa_ratio');
    expect(cw).toHaveProperty('collection_efficiency');
  });

  it('written_off_amount reflects the write-off we created', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/portfolio?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', adminKey());

    // We wrote off rptLoan3 with outstanding_at_write_off=220000 paise = 2200.00 SIM
    const writtenOff = parseFloat(res.body.data.summary.written_off_amount);
    expect(writtenOff).toBeGreaterThanOrEqual(2200);
  });

  // BUG RG-021: NPA ratio is inflated because numerator includes written_off loans
  it('BUG RG-021: NPA ratio > 0 even though no active loans are in 90+ bucket', async () => {
    // Our DPD setup: only rptLoan3 (written_off) has a 90+ record on DPD_DATE.
    // rptLoan1 is in 1-30. rptLoan2 and rptLoan4 have no DPD record on DPD_DATE.
    // Correct NPA: 0 (no active loans in 90+)
    // Bugged NPA: > 0 (written_off loan's overdue counts in numerator)
    const res = await request(app)
      .get(`/api/v1/reports/portfolio?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', adminKey());

    const npaRatio = parseFloat(res.body.data.risk_metrics.npa_ratio);
    expect(npaRatio).toBeGreaterThan(0); // BUG: should be 0.00

    const npaAmount = parseFloat(res.body.data.risk_metrics.npa_amount);
    expect(npaAmount).toBeGreaterThan(0); // BUG: numerator includes written_off loan
  });

  // BUG RG-023: Collection efficiency exceeds 100% when prepayments exist
  it('BUG RG-023: collection_efficiency exceeds 100% due to prepayments', async () => {
    // February 2026: EMI due = 50000+30000=80000, collected = 50000+300000=350000
    // Efficiency = 350000/80000 * 100 = 437.5% (bugged)
    // Without bug (EMI payments only): 50000/80000 * 100 = 62.5%
    const res = await request(app)
      .get(`/api/v1/reports/portfolio?as_of_date=${COLL_END}`)
      .set('X-API-Key', adminKey());

    expect(res.status).toBe(200);
    const efficiency = parseFloat(res.body.data.risk_metrics.collection_efficiency);
    expect(efficiency).toBeGreaterThan(100); // BUG: should be ≤100
  });
});

// ─── GET /api/v1/reports/aging ────────────────────────────────────────────────

describe('GET /api/v1/reports/aging', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/reports/aging');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct structure', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/aging?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', adminKey());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data.as_of_date).toBe(DPD_DATE);
    expect(Array.isArray(data.buckets)).toBe(true);
    expect(data.total_outstanding).toMatch(/^\d+\.\d{2}$/);
  });

  it('buckets include 1-30 and 90+ entries for our DPD date', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/aging?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', adminKey());

    const bucketNames = res.body.data.buckets.map((b: { bucket: string }) => b.bucket);
    expect(bucketNames).toContain('1-30');
    expect(bucketNames).toContain('90+');
  });

  it('bucket entries have required fields', async () => {
    const res = await request(app)
      .get(`/api/v1/reports/aging?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', adminKey());

    for (const bucket of res.body.data.buckets) {
      expect(bucket).toHaveProperty('bucket');
      expect(bucket).toHaveProperty('loan_count');
      expect(bucket).toHaveProperty('outstanding');
      expect(typeof bucket.loan_count).toBe('number');
      expect(bucket.outstanding).toMatch(/^\d+\.\d{2}$/);
    }
  });

  // BUG RG-024: sum of bucket oustandings ≠ total_outstanding
  it('BUG RG-024: sum of bucket oustandings does not equal total_outstanding', async () => {
    // Buckets use dpd_records overdue amounts: loan1=(55000), loan3=(220000) → sum=275000 paise
    // total uses principal_amount of non-written_off/closed/prepaid/restructured loans
    // These are fundamentally different metrics → mismatch
    const res = await request(app)
      .get(`/api/v1/reports/aging?as_of_date=${DPD_DATE}`)
      .set('X-API-Key', adminKey());

    const buckets: Array<{ outstanding: string }> = res.body.data.buckets;
    const bucketSum = buckets.reduce((sum, b) => sum + parseFloat(b.outstanding), 0);
    const total = parseFloat(res.body.data.total_outstanding);

    // Totals should NOT match (BUG RG-024)
    expect(bucketSum).not.toBeCloseTo(total, 0);
  });
});

// ─── GET /api/v1/reports/vintage ─────────────────────────────────────────────

describe('GET /api/v1/reports/vintage', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/reports/vintage');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct structure', async () => {
    const res = await request(app)
      .get('/api/v1/reports/vintage?period_months=12')
      .set('X-API-Key', adminKey());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.vintages)).toBe(true);
  });

  it('uses default period_months=12 when not specified', async () => {
    const res = await request(app)
      .get('/api/v1/reports/vintage')
      .set('X-API-Key', adminKey());
    expect(res.status).toBe(200);
  });

  it('vintage entries have required fields', async () => {
    const res = await request(app)
      .get('/api/v1/reports/vintage?period_months=12')
      .set('X-API-Key', adminKey());

    for (const v of res.body.data.vintages) {
      expect(v).toHaveProperty('vintage_month');
      expect(v).toHaveProperty('loans_originated');
      expect(v).toHaveProperty('total_disbursed');
      expect(v).toHaveProperty('defaulted_count');
      expect(v).toHaveProperty('written_off_count');
      expect(v).toHaveProperty('currently_overdue_count');
      expect(v).toHaveProperty('default_rate_bps');
      expect(v).toHaveProperty('loss_rate_bps');
    }
  });

  // BUG RG-022: rptLoan4 has created_at=2026-04-15, disbursed_at=2026-05-01
  // The bugged query groups by created_at, so loan4 shows up in '2026-04' vintage
  it('BUG RG-022: loan created in April but disbursed in May appears in April vintage', async () => {
    const res = await request(app)
      .get('/api/v1/reports/vintage?period_months=12')
      .set('X-API-Key', adminKey());

    const vintages: Array<{ vintage_month: string; loans_originated: number }> =
      res.body.data.vintages;

    // The April vintage should exist and include rptLoan4 (because of created_at bug)
    const aprilVintage = vintages.find(v => v.vintage_month === '2026-04');
    expect(aprilVintage).toBeDefined();
    // rptLoan4 is the only loan with created_at in April 2026
    expect(aprilVintage!.loans_originated).toBeGreaterThanOrEqual(1);

    // If the bug were fixed (using disbursed_at), the April vintage would be empty
    // and May would have loan4. This demonstrates the misclassification.
  });

  it('default_rate_bps and loss_rate_bps are non-negative integers', async () => {
    const res = await request(app)
      .get('/api/v1/reports/vintage?period_months=12')
      .set('X-API-Key', adminKey());

    for (const v of res.body.data.vintages) {
      expect(v.default_rate_bps).toBeGreaterThanOrEqual(0);
      expect(v.loss_rate_bps).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(v.default_rate_bps)).toBe(true);
      expect(Number.isInteger(v.loss_rate_bps)).toBe(true);
    }
  });
});

// ─── GET /api/v1/reports/concentration ───────────────────────────────────────

describe('GET /api/v1/reports/concentration', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/reports/concentration?cut=department');
    expect(res.status).toBe(401);
  });

  it('returns 400 when cut is missing', async () => {
    const res = await request(app)
      .get('/api/v1/reports/concentration')
      .set('X-API-Key', adminKey());
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid cut value', async () => {
    const res = await request(app)
      .get('/api/v1/reports/concentration?cut=invalid_cut')
      .set('X-API-Key', adminKey());
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('department cut returns correct structure with HHI', async () => {
    const res = await request(app)
      .get('/api/v1/reports/concentration?cut=department')
      .set('X-API-Key', adminKey());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data.cut).toBe('department');
    expect(Array.isArray(data.groups)).toBe(true);
    expect(typeof data.herfindahl_index).toBe('number');
    expect(data.herfindahl_index).toBeGreaterThan(0);
    expect(data.herfindahl_index).toBeLessThanOrEqual(10000);
  });

  it('department cut includes Engineering and Sales groups from our loans', async () => {
    const res = await request(app)
      .get('/api/v1/reports/concentration?cut=department')
      .set('X-API-Key', adminKey());

    const groups = res.body.data.groups;
    const keys = groups.map((g: { key: string }) => g.key);
    expect(keys).toContain('Engineering');
    expect(keys).toContain('Sales');
  });

  it('group entries have required fields', async () => {
    const res = await request(app)
      .get('/api/v1/reports/concentration?cut=product_type')
      .set('X-API-Key', adminKey());

    for (const g of res.body.data.groups) {
      expect(g).toHaveProperty('key');
      expect(g).toHaveProperty('outstanding');
      expect(g).toHaveProperty('loan_count');
      expect(g).toHaveProperty('percentage_of_portfolio');
      expect(g.outstanding).toMatch(/^\d+\.\d{2}$/);
      expect(g.percentage_of_portfolio).toBeGreaterThanOrEqual(0);
    }
  });

  it('product_type cut returns personal_loan and salary_advance', async () => {
    const res = await request(app)
      .get('/api/v1/reports/concentration?cut=product_type')
      .set('X-API-Key', adminKey());

    const keys = res.body.data.groups.map((g: { key: string }) => g.key);
    expect(keys).toContain('personal_loan');
    expect(keys).toContain('salary_advance');
  });

  it('score_band cut returns Good and Fair groups', async () => {
    const res = await request(app)
      .get('/api/v1/reports/concentration?cut=score_band')
      .set('X-API-Key', adminKey());

    const keys = res.body.data.groups.map((g: { key: string }) => g.key);
    expect(keys).toContain('Good');
    expect(keys).toContain('Fair');
  });

  it('amount_band cut returns valid buckets', async () => {
    const res = await request(app)
      .get('/api/v1/reports/concentration?cut=amount_band')
      .set('X-API-Key', adminKey());

    expect(res.status).toBe(200);
    const validBands = ['under_10k', '10k_to_50k', '50k_to_100k', 'over_100k'];
    for (const g of res.body.data.groups) {
      expect(validBands).toContain(g.key);
    }
  });

  it('percentages across all groups sum to approximately 100', async () => {
    const res = await request(app)
      .get('/api/v1/reports/concentration?cut=product_type')
      .set('X-API-Key', adminKey());

    const totalPct = res.body.data.groups.reduce(
      (sum: number, g: { percentage_of_portfolio: number }) => sum + g.percentage_of_portfolio,
      0,
    );
    // Allow small rounding error
    expect(totalPct).toBeGreaterThan(99);
    expect(totalPct).toBeLessThan(101);
  });

  it('HHI is 10000 when a single group holds 100% of portfolio', async () => {
    // This tests the formula — it should equal sum of squared shares
    // If only one group exists: share=100%, HHI = 100^2 = 10000
    const res = await request(app)
      .get('/api/v1/reports/concentration?cut=product_type')
      .set('X-API-Key', adminKey());

    const { groups, herfindahl_index } = res.body.data;
    // Verify HHI approximates the hand-calculated value
    const handCalc = Math.round(
      groups.reduce((sum: number, g: { percentage_of_portfolio: number }) => {
        return sum + g.percentage_of_portfolio * g.percentage_of_portfolio;
      }, 0)
    );
    expect(Math.abs(herfindahl_index - handCalc)).toBeLessThanOrEqual(2); // rounding tolerance
  });
});

// ─── GET /api/v1/reports/ecl ─────────────────────────────────────────────────

describe('GET /api/v1/reports/ecl — BUG RG-025', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/reports/ecl');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct structure', async () => {
    const res = await request(app)
      .get('/api/v1/reports/ecl')
      .set('X-API-Key', adminKey());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data).toHaveProperty('as_of_date');
    expect(data).toHaveProperty('total_expected_credit_loss');
    expect(data).toHaveProperty('breakdown');
    expect(Array.isArray(data.breakdown)).toBe(true);
  });

  it('breakdown entries include active loan bands (Good, Fair)', async () => {
    const res = await request(app)
      .get('/api/v1/reports/ecl')
      .set('X-API-Key', adminKey());

    const bands = res.body.data.breakdown.map((e: { score_band: string }) => e.score_band);
    expect(bands).toContain('Good');
    expect(bands).toContain('Fair');
  });

  // BUG RG-025: pd_lookup uses UPPERCASE ('GOOD') but borrowers use mixed case ('Good')
  // SQLite case-sensitive string match → no row found → pd=0 → ECL=0
  it('BUG RG-025: all breakdown entries have probability_of_default_bps = 0 (case mismatch)', async () => {
    const res = await request(app)
      .get('/api/v1/reports/ecl')
      .set('X-API-Key', adminKey());

    const breakdown: Array<{ probability_of_default_bps: number; score_band: string }> =
      res.body.data.breakdown;

    // Every entry has PD=0 because the case-sensitive lookup fails
    for (const entry of breakdown) {
      expect(entry.probability_of_default_bps).toBe(0);
    }
  });

  it('BUG RG-025: total_expected_credit_loss is 0.00 despite active loan exposure', async () => {
    const res = await request(app)
      .get('/api/v1/reports/ecl')
      .set('X-API-Key', adminKey());

    const { data } = res.body;
    // There are active loans with non-zero principal, so ECL should be > 0 if PD were found
    const breakdown: Array<{ exposure_at_default: string }> = data.breakdown;
    const totalExposure = breakdown.reduce(
      (sum, e) => sum + parseFloat(e.exposure_at_default), 0
    );
    expect(totalExposure).toBeGreaterThan(0); // Non-zero exposure exists

    // But ECL is 0 because PD lookup fails (BUG RG-025)
    expect(data.total_expected_credit_loss).toBe('0.00');
  });

  it('breakdown entries have correct structure', async () => {
    const res = await request(app)
      .get('/api/v1/reports/ecl')
      .set('X-API-Key', adminKey());

    for (const entry of res.body.data.breakdown) {
      expect(entry).toHaveProperty('score_band');
      expect(entry).toHaveProperty('exposure_at_default');
      expect(entry).toHaveProperty('probability_of_default_bps');
      expect(entry).toHaveProperty('loss_given_default_bps');
      expect(entry).toHaveProperty('expected_credit_loss');
      expect(entry.exposure_at_default).toMatch(/^\d+\.\d{2}$/);
      expect(entry.expected_credit_loss).toMatch(/^\d+\.\d{2}$/);
    }
  });
});
