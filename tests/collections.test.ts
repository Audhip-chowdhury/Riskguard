import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import request from 'supertest';
import app from '../src/app';
import db from '../src/db';
import { testApiKeys, testUserIds, testEmployeeIds } from './setup';
import { computeDpdForLoan, runDpdCycle } from '../src/workers/dpd-tracker';

// ─── Mock PayFlow ─────────────────────────────────────────────────────────────

vi.mock('../src/services/payflow.service', () => ({
  transferFromPayFlow: vi.fn().mockResolvedValue({
    success: true,
    data: { transaction_id: 'mock-txn-collections' },
  }),
  getWalletBalance: vi.fn().mockResolvedValue({ balance: '9999999.00' }),
}));

import { transferFromPayFlow } from '../src/services/payflow.service';
const mockTransfer = transferFromPayFlow as ReturnType<typeof vi.fn>;

afterEach(() => mockTransfer.mockClear());

// ─── Shared state ─────────────────────────────────────────────────────────────

let eveUserId: string;
let eveApiKey: string;

let frankBorrowerId: string;
let graceBorrowerId: string;

// Loans used across test sections
let activeLoanId: string;      // For DPD/queue/escalation tests (frank)
let restructureLoanId: string; // For restructure tests (grace)
let writeOffLoanId: string;    // For write-off/recovery tests (frank, 2nd loan)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createBorrower(employeeId: string, adminApiKey: string, idempKey: string) {
  return request(app)
    .post('/api/v1/borrowers')
    .set('X-API-Key', adminApiKey)
    .set('Idempotency-Key', idempKey)
    .send({ employee_id: employeeId });
}

async function applyAndDisburse(
  borrowerApiKey: string,
  approverApiKey: string,
  productType: string,
  amount: string,
  tenureMonths: number,
  prefix: string
): Promise<string> {
  const applyRes = await request(app)
    .post('/api/v1/loans/apply')
    .set('X-API-Key', borrowerApiKey)
    .set('Idempotency-Key', `${prefix}-apply`)
    .send({
      product_type: productType,
      requested_amount: amount,
      requested_tenure_months: tenureMonths,
      purpose: `Test loan for ${prefix} collections scenario`,
    });

  const applicationId = applyRes.body.data.application_id;

  // Approve if not auto-approved
  if (applyRes.body.data.status !== 'approved') {
    await request(app)
      .post(`/api/v1/loans/${applicationId}/approve`)
      .set('X-API-Key', approverApiKey)
      .set('Idempotency-Key', `${prefix}-approve`)
      .send({ notes: 'Approved for collections test' });
  }

  // Get loan id from application
  const appData = db
    .prepare('SELECT * FROM loans WHERE application_id = ?')
    .get(applicationId) as { id: string } | undefined;
  const loanId = appData!.id;

  // Disburse
  await request(app)
    .post(`/api/v1/loans/${loanId}/disburse`)
    .set('X-API-Key', approverApiKey)
    .set('Idempotency-Key', `${prefix}-disburse`)
    .send({});

  return loanId;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create Eve — collections_agent
  eveUserId = uuidv4();
  eveApiKey = `rgk_${crypto.randomBytes(24).toString('hex')}`;
  const ts = new Date().toISOString();
  const eveEmployeeId = uuidv4();
  db.prepare(
    `INSERT INTO users (id, username, email, api_key, role, is_active, created_at, updated_at)
     VALUES (?, 'eve', 'eve@metropay.io', ?, 'collections_agent', 1, ?, ?)`
  ).run(eveUserId, eveApiKey, ts, ts);
  db.prepare(
    `INSERT INTO employees
       (id, user_id, payflow_wallet_id, department, designation, department_risk_tier,
        monthly_salary, joined_at, manager_user_id, created_at)
     VALUES (?, ?, ?, 'Collections', 'Collections Agent', 2, 20000000, ?, NULL, ?)`
  ).run(eveEmployeeId, eveUserId, uuidv4(), new Date(Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000).toISOString(), ts);

  // Create Frank's borrower profile
  const frankRes = await createBorrower(testEmployeeIds['frank'], testApiKeys['alice'], 'coll-frank-brrwr');
  frankBorrowerId = frankRes.body.data.id;

  // Create Grace's borrower profile
  const graceRes = await createBorrower(testEmployeeIds['grace'], testApiKeys['alice'], 'coll-grace-brrwr');
  graceBorrowerId = graceRes.body.data.id;

  // Loan 1 (Frank — personal_loan): for DPD / queue / escalation tests
  activeLoanId = await applyAndDisburse(
    testApiKeys['frank'],
    testApiKeys['bob'],
    'personal_loan',
    '50000.00',
    12,
    'coll-frank-active'
  );

  // Loan 2 (Grace — salary_advance): for restructure tests
  restructureLoanId = await applyAndDisburse(
    testApiKeys['grace'],
    testApiKeys['bob'],
    'salary_advance',
    '20000.00',
    6,
    'coll-grace-restruct'
  );

  // Loan 3 (Frank — emergency_loan): for write-off/recovery tests
  writeOffLoanId = await applyAndDisburse(
    testApiKeys['frank'],
    testApiKeys['bob'],
    'emergency_loan',
    '10000.00',
    6,
    'coll-frank-writeoff'
  );

  // Make writeOffLoan defaulted: set all EMIs to overdue 91 days ago, set loan status defaulted
  db.prepare(
    `UPDATE emi_schedules SET status='overdue', due_date=date('now','-91 days') WHERE loan_id=?`
  ).run(writeOffLoanId);
  db.prepare(`UPDATE loans SET status='defaulted' WHERE id=?`).run(writeOffLoanId);
  // Insert a DPD record so write-off eligibility check passes
  db.prepare(`
    INSERT INTO dpd_records
      (id, loan_id, as_of_date, days_past_due, overdue_emi_count,
       overdue_principal, overdue_interest, overdue_penalty, bucket)
    VALUES (?, ?, date('now'), 91, 3, 1000000, 50000, 0, '90+')
  `).run(uuidv4(), writeOffLoanId);

  // For activeLoanId: make one EMI overdue 31 days ago (for queue / escalation tests)
  const firstEmi = db.prepare(
    `SELECT id FROM emi_schedules WHERE loan_id=? ORDER BY installment_number ASC LIMIT 1`
  ).get(activeLoanId) as { id: string };
  db.prepare(
    `UPDATE emi_schedules SET status='overdue', due_date=date('now','-31 days') WHERE id=?`
  ).run(firstEmi.id);
});

// ─── DPD Computation: BUG RG-016 ─────────────────────────────────────────────

describe('DPD computation — BUG RG-016 (naive UTC under-count)', () => {
  it('shows correct DPD when running at midday UTC', () => {
    // A loan due yesterday: simple case, both UTC and IST agree
    const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(activeLoanId) as any;
    // Insert a temp EMI due 5 days ago
    const tempId = uuidv4();
    db.prepare(`
      INSERT INTO emi_schedules
        (id, loan_id, installment_number, due_date, emi_amount,
         principal_component, interest_component, opening_balance, closing_balance, status)
      VALUES (?, ?, 999, date('now','-5 days'), 100000, 80000, 20000, 5000000, 4920000, 'overdue')
    `).run(tempId, activeLoanId);

    const today = new Date(); // midday UTC on any day
    const dpd = computeDpdForLoan(loan, today);
    expect(dpd.days).toBeGreaterThanOrEqual(5);

    db.prepare('DELETE FROM emi_schedules WHERE id=?').run(tempId);
  });

  it('BUG RG-016: DPD under-counted when running at IST midnight (18:30–23:59 UTC)', () => {
    // Simulate: a loan due on '2025-04-14'.
    // At 19:00 UTC on April 14 (= midnight IST April 15), IST users see it as April 15 —
    // the loan was due yesterday by IST reckoning → should be DPD=1.
    // Naive UTC: (2025-04-14T19:00Z − 2025-04-14T00:00Z) = 19 hours → 0 days → DPD=0 (bug).

    const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(activeLoanId) as any;
    const tempId = uuidv4();
    db.prepare(`
      INSERT INTO emi_schedules
        (id, loan_id, installment_number, due_date, emi_amount,
         principal_component, interest_component, opening_balance, closing_balance, status)
      VALUES (?, ?, 888, '2025-04-14', 100000, 80000, 20000, 5000000, 4920000, 'overdue')
    `).run(tempId, activeLoanId);

    // 19:00 UTC on 2025-04-14 = midnight IST on 2025-04-15
    const istMidnight = new Date('2025-04-14T19:00:00.000Z');
    const dpd = computeDpdForLoan(loan, istMidnight);

    // BUG RG-016: naive calculation gives 0 (same UTC day), should be 1 by IST
    expect(dpd.days).toBe(0);
    // Document the correct IST-aware value would be 1

    db.prepare('DELETE FROM emi_schedules WHERE id=?').run(tempId);
  });

  it('BUG RG-016: at 90-day NPA boundary, NPA triggered a day late', () => {
    // Loan due on '2025-01-15'. At 19:00 UTC on 2025-04-14 (= 00:30 IST Apr 15),
    // IST sees it as Apr 15 — exactly 90 days since Jan 15 → NPA should trigger.
    // Naive UTC: (2025-04-14T19:00Z − 2025-01-15T00:00Z) = 89.79 days → 89 → no NPA yet (bug).
    const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(activeLoanId) as any;
    const tempId = uuidv4();
    db.prepare(`
      INSERT INTO emi_schedules
        (id, loan_id, installment_number, due_date, emi_amount,
         principal_component, interest_component, opening_balance, closing_balance, status)
      VALUES (?, ?, 777, '2025-01-15', 100000, 80000, 20000, 5000000, 4920000, 'overdue')
    `).run(tempId, activeLoanId);

    // 19:00 UTC on 2025-04-14 = 00:30 IST on Apr 15 → IST reckons 90 days past Jan 15
    const today = new Date('2025-04-14T19:00:00.000Z');
    const dpd = computeDpdForLoan(loan, today);

    // Cleanup before assert so future failures don't leave a stale EMI
    db.prepare('DELETE FROM emi_schedules WHERE id=?').run(tempId);

    // Naive UTC gives 89 days (under-count) — NPA threshold of 90 not yet reached
    expect(dpd.days).toBe(89);
  });
});

// ─── Bucket Assignment: BUG RG-019 ───────────────────────────────────────────

describe('Bucket assignment — BUG RG-019 (overlapping boundaries)', () => {
  function getbucket(daysAgo: number): string {
    const loan = db.prepare('SELECT * FROM loans WHERE id=?').get(activeLoanId) as any;
    // Hide existing overdue EMIs so only the temp EMI determines DPD
    db.prepare(`UPDATE emi_schedules SET status='paid' WHERE loan_id=? AND status='overdue'`).run(activeLoanId);
    const tempId = uuidv4();
    db.prepare(`
      INSERT INTO emi_schedules
        (id, loan_id, installment_number, due_date, emi_amount,
         principal_component, interest_component, opening_balance, closing_balance, status)
      VALUES (?, ?, 500, date('now',?), 100000, 80000, 20000, 5000000, 4920000, 'overdue')
    `).run(tempId, activeLoanId, `-${daysAgo} days`);

    const today = new Date();
    const dpd = computeDpdForLoan(loan, today);
    const bucket = dpd.bucket;

    db.prepare('DELETE FROM emi_schedules WHERE id=?').run(tempId);
    // Restore EMI #1 to overdue for subsequent tests (queue, escalation)
    db.prepare(`UPDATE emi_schedules SET status='overdue' WHERE loan_id=? AND installment_number=1`).run(activeLoanId);
    return bucket;
  }

  it('DPD=0 → current', () => expect(getbucket(0)).toBe('current'));
  it('DPD=1 → 1-30', () => expect(getbucket(1)).toBe('1-30'));
  it('DPD=30 → 1-30 (first matching branch, not 31-60)', () => expect(getbucket(30)).toBe('1-30'));
  it('DPD=31 → 31-60', () => expect(getbucket(31)).toBe('31-60'));
  it('DPD=60 → 31-60 (first matching branch, not 61-90)', () => expect(getbucket(60)).toBe('31-60'));
  it('DPD=61 → 61-90', () => expect(getbucket(61)).toBe('61-90'));
  it('DPD=90 → 61-90 (first matching branch, not 90+)', () => expect(getbucket(90)).toBe('61-90'));
  it('DPD=91 → 90+', () => expect(getbucket(91)).toBe('90+'));
});

// ─── Collections Queue ────────────────────────────────────────────────────────

describe('GET /api/v1/collections/queue', () => {
  // Insert a DPD=30 record for activeLoanId so we can test the RG-019 overlap
  beforeAll(() => {
    db.prepare(`
      INSERT INTO dpd_records
        (id, loan_id, as_of_date, days_past_due, overdue_emi_count,
         overdue_principal, overdue_interest, overdue_penalty, bucket)
      VALUES (?, ?, date('now'), 30, 1, 500000, 20000, 0, '1-30')
      ON CONFLICT(loan_id, as_of_date) DO UPDATE SET
        days_past_due=30, bucket='1-30'
    `).run(uuidv4(), activeLoanId);
  });

  it('returns 401 without API key', async () => {
    const res = await request(app).get('/api/v1/collections/queue');
    expect(res.status).toBe(401);
  });

  it('returns 403 for employee role', async () => {
    const res = await request(app)
      .get('/api/v1/collections/queue')
      .set('X-API-Key', testApiKeys['frank']);
    expect(res.status).toBe(403);
  });

  it('returns 200 with data for admin', async () => {
    const res = await request(app)
      .get('/api/v1/collections/queue')
      .set('X-API-Key', testApiKeys['alice']);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('total');
  });

  it('filters by bucket=1-30', async () => {
    const res = await request(app)
      .get('/api/v1/collections/queue?bucket=1-30')
      .set('X-API-Key', testApiKeys['alice']);
    expect(res.status).toBe(200);
    const loanIds = res.body.data.map((d: any) => d.loan_id);
    expect(loanIds).toContain(activeLoanId);
  });

  it('BUG RG-019: loan at DPD=30 (stored as 1-30) also appears in 31-60 queue', async () => {
    const res1 = await request(app)
      .get('/api/v1/collections/queue?bucket=1-30')
      .set('X-API-Key', testApiKeys['alice']);
    const res2 = await request(app)
      .get('/api/v1/collections/queue?bucket=31-60')
      .set('X-API-Key', testApiKeys['alice']);

    const in130 = res1.body.data.map((d: any) => d.loan_id);
    const in3160 = res2.body.data.map((d: any) => d.loan_id);

    // BUG RG-019: same loan appears in both buckets due to BETWEEN [30,60] overlap
    expect(in130).toContain(activeLoanId);
    expect(in3160).toContain(activeLoanId); // also appears here — the bug
  });

  it('collections_agent defaults to seeing only their assigned loans', async () => {
    // Eve has no assigned loans yet → empty queue
    const res = await request(app)
      .get('/api/v1/collections/queue')
      .set('X-API-Key', eveApiKey);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('returns response with required fields', async () => {
    const res = await request(app)
      .get('/api/v1/collections/queue?bucket=1-30')
      .set('X-API-Key', testApiKeys['alice']);
    expect(res.status).toBe(200);
    if (res.body.data.length > 0) {
      const item = res.body.data[0];
      expect(item).toHaveProperty('loan_id');
      expect(item).toHaveProperty('days_past_due');
      expect(item).toHaveProperty('bucket');
      expect(item).toHaveProperty('overdue_amount');
      expect(item).toHaveProperty('outstanding_total');
      expect(item).toHaveProperty('assigned_agent');
      expect(item).toHaveProperty('last_action');
    }
  });
});

// ─── Escalation Actions ───────────────────────────────────────────────────────

describe('Escalation actions', () => {
  let escalationLoanId: string;

  beforeAll(async () => {
    // Create a fresh loan with Grace (auto-approved — high score)
    escalationLoanId = await applyAndDisburse(
      testApiKeys['grace'],
      testApiKeys['bob'],
      'bnpl',
      '5000.00',
      3,
      'coll-esc-grace'
    );
    // Set first EMI to 31 days overdue
    db.prepare(
      `UPDATE emi_schedules SET status='overdue', due_date=date('now','-31 days')
       WHERE loan_id=? AND installment_number=(SELECT MIN(installment_number) FROM emi_schedules WHERE loan_id=?)`
    ).run(escalationLoanId, escalationLoanId);
  });

  it('runDpdCycle creates reminder_sent at DPD>=1 and warning_sent at DPD>=30', async () => {
    await runDpdCycle();

    const actions = db.prepare(
      `SELECT action_type FROM collections_actions WHERE loan_id=? ORDER BY created_at`
    ).all(escalationLoanId) as { action_type: string }[];

    const types = actions.map(a => a.action_type);
    expect(types).toContain('reminder_sent');
    expect(types).toContain('warning_sent');
    expect(types).not.toContain('recovery_notice_sent');
    expect(types).not.toContain('npa_flagged');
  });

  it('no duplicate escalation actions on second cycle run', async () => {
    await runDpdCycle();

    const reminderCount = (db.prepare(
      `SELECT COUNT(*) as cnt FROM collections_actions WHERE loan_id=? AND action_type='reminder_sent'`
    ).get(escalationLoanId) as { cnt: number }).cnt;

    expect(reminderCount).toBe(1);
  });

  it('creates recovery_notice_sent at DPD>=60', async () => {
    // Push first EMI to 61 days overdue
    db.prepare(
      `UPDATE emi_schedules SET due_date=date('now','-61 days')
       WHERE loan_id=? AND status='overdue'`
    ).run(escalationLoanId);

    await runDpdCycle();

    const actions = db.prepare(
      `SELECT action_type FROM collections_actions WHERE loan_id=?`
    ).all(escalationLoanId) as { action_type: string }[];
    const types = actions.map(a => a.action_type);
    expect(types).toContain('recovery_notice_sent');
  });

  it('NPA flagging at DPD>=90: npa_flagged action created and loan status → defaulted', async () => {
    db.prepare(
      `UPDATE emi_schedules SET due_date=date('now','-91 days')
       WHERE loan_id=? AND status='overdue'`
    ).run(escalationLoanId);

    await runDpdCycle();

    const actions = db.prepare(
      `SELECT action_type FROM collections_actions WHERE loan_id=?`
    ).all(escalationLoanId) as { action_type: string }[];
    expect(actions.map(a => a.action_type)).toContain('npa_flagged');

    const loan = db.prepare('SELECT status FROM loans WHERE id=?').get(escalationLoanId) as { status: string };
    expect(loan.status).toBe('defaulted');
  });
});

// ─── Restructure: BUG RG-017 ─────────────────────────────────────────────────

describe('POST /api/v1/loans/:id/restructure — BUG RG-017', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).post(`/api/v1/loans/${restructureLoanId}/restructure`).send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for employee role', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${restructureLoanId}/restructure`)
      .set('X-API-Key', testApiKeys['frank'])
      .send({ new_tenure_months: 12, new_annual_rate_bps: 1500, reason: 'x'.repeat(30) });
    expect(res.status).toBe(403);
  });

  it('returns 400 when reason is too short', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${restructureLoanId}/restructure`)
      .set('X-API-Key', testApiKeys['bob'])
      .send({ new_tenure_months: 12, new_annual_rate_bps: 1500, reason: 'short' });
    expect(res.status).toBe(400);
  });

  it('successfully restructures loan and creates restructuring record', async () => {
    const previousSchedule = db.prepare(
      `SELECT * FROM emi_schedules WHERE loan_id=? AND status IN ('scheduled','overdue','partial')`
    ).all(restructureLoanId);

    const res = await request(app)
      .post(`/api/v1/loans/${restructureLoanId}/restructure`)
      .set('X-API-Key', testApiKeys['bob'])
      .send({
        new_tenure_months: 12,
        new_annual_rate_bps: 1500,
        reason: 'Borrower lost secondary income. Extending tenure to reduce monthly burden.',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('restructuring_id');
    expect(res.body.data).toHaveProperty('new_schedule_generated', true);
    expect(res.body.data.new.tenure_months).toBe(12);

    // Verify loan is now 'restructured'
    const loan = db.prepare('SELECT status FROM loans WHERE id=?').get(restructureLoanId) as { status: string };
    expect(loan.status).toBe('restructured');

    // Verify restructuring record created
    const recs = db.prepare('SELECT * FROM restructurings WHERE loan_id=?').all(restructureLoanId);
    expect(recs.length).toBeGreaterThan(0);

    // BUG RG-017: old EMI schedule entries are NOT superseded — they remain scheduled/overdue
    const stillActive = db.prepare(
      `SELECT COUNT(*) as cnt FROM emi_schedules
       WHERE loan_id=? AND status IN ('scheduled','overdue','partial')
         AND installment_number IN (${previousSchedule.map(() => '?').join(',')})`
    ).get(restructureLoanId, ...previousSchedule.map((e: any) => e.installment_number)) as { cnt: number };

    // BUG: old entries still exist alongside new ones (not superseded)
    expect(stillActive.cnt).toBeGreaterThan(0);
  });

  it('BUG RG-017: repayment worker would process both old and new EMIs (double charge)', () => {
    // After restructure, both old (scheduled/overdue) and new (scheduled) EMIs coexist.
    // The repayment-executor query: WHERE status IN ('scheduled','overdue') AND due_date<=today
    // will pick up entries from both schedules on their due dates → borrower charged twice.
    const allActive = db.prepare(
      `SELECT COUNT(*) as cnt FROM emi_schedules
       WHERE loan_id=? AND status IN ('scheduled','overdue','partial')`
    ).get(restructureLoanId) as { cnt: number };

    // Should have been 0 old + N new; BUG: has old + new combined
    expect(allActive.cnt).toBeGreaterThan(6); // 6 remaining old + 12 new = 18+ entries
  });
});

// ─── Write-Off: BUG RG-018 ───────────────────────────────────────────────────

describe('POST /api/v1/loans/:id/write-off — BUG RG-018', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).post(`/api/v1/loans/${writeOffLoanId}/write-off`).send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${writeOffLoanId}/write-off`)
      .set('X-API-Key', testApiKeys['bob'])
      .send({ reason: 'x'.repeat(50) });
    expect(res.status).toBe(403);
  });

  it('returns 400 when reason is too short', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${writeOffLoanId}/write-off`)
      .set('X-API-Key', testApiKeys['alice'])
      .send({ reason: 'too short' });
    expect(res.status).toBe(400);
  });

  it('returns 422 when loan is not defaulted or in 90+ DPD', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${activeLoanId}/write-off`)
      .set('X-API-Key', testApiKeys['alice'])
      .send({ reason: 'x'.repeat(50) });
    expect(res.status).toBe(422);
  });

  it('successfully writes off a defaulted loan', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${writeOffLoanId}/write-off`)
      .set('X-API-Key', testApiKeys['alice'])
      .send({
        reason: 'Borrower terminated employment 90 days ago. No contact established despite multiple recovery notices. Legal pursuit not cost-effective.',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('write_off_id');
    expect(res.body.data).toHaveProperty('outstanding_at_write_off');

    // Verify loan status flipped to written_off
    const loan = db.prepare('SELECT status FROM loans WHERE id=?').get(writeOffLoanId) as { status: string };
    expect(loan.status).toBe('written_off');
  });

  it('BUG RG-018: borrower can immediately apply for new credit after write-off', async () => {
    // After write-off the written-off loan is no longer 'active', so debt_ratio drops.
    // Without any credit flag, Frank can apply and be considered for new credit.
    // This test documents the bug: a write-off SHOULD block new applications but doesn't.
    const borrowerBefore = db.prepare(
      'SELECT current_score, available_limit FROM borrowers WHERE id=?'
    ).get(frankBorrowerId) as { current_score: number; available_limit: number };

    // Attempt a new loan application for Frank
    const applyRes = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', 'coll-rg018-new-app')
      .send({
        product_type: 'bnpl',
        requested_amount: '1000.00',
        requested_tenure_months: 3,
        purpose: 'Test application post write-off for RG-018',
      });

    // BUG RG-018: application succeeds — no write-off flag prevents it
    // Should fail with a credit restriction error, but doesn't
    expect([200, 201]).toContain(applyRes.status);
    expect(applyRes.body.success).toBe(true);

    // Score and limit are unchanged — no penalty applied (the bug)
    const borrowerAfter = db.prepare(
      'SELECT current_score, available_limit FROM borrowers WHERE id=?'
    ).get(frankBorrowerId) as { current_score: number; available_limit: number };
    expect(borrowerAfter.current_score).toBe(borrowerBefore.current_score);
  });
});

// ─── Recovery ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/loans/:id/record-recovery', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).post(`/api/v1/loans/${writeOffLoanId}/record-recovery`).send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for underwriter role', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${writeOffLoanId}/record-recovery`)
      .set('X-API-Key', testApiKeys['charlie'])
      .send({ amount: '1000.00', recovery_source: 'voluntary_payment' });
    expect(res.status).toBe(403);
  });

  it('returns 422 when loan is not written_off', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${activeLoanId}/record-recovery`)
      .set('X-API-Key', testApiKeys['alice'])
      .send({ amount: '1000.00', recovery_source: 'voluntary_payment' });
    expect(res.status).toBe(422);
  });

  it('records recovery, calls PayFlow, returns recovery record', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${writeOffLoanId}/record-recovery`)
      .set('X-API-Key', testApiKeys['alice'])
      .send({
        amount: '5000.00',
        recovery_source: 'voluntary_payment',
        notes: "Borrower's former manager facilitated voluntary repayment",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('recovery_id');
    expect(res.body.data.recovered_amount).toBe('5000.00');
    expect(res.body.data.recovery_source).toBe('voluntary_payment');
    expect(res.body.data.payflow_transaction_id).toBe('mock-txn-collections');
    expect(mockTransfer).toHaveBeenCalledOnce();
  });

  it('collections_agent can also record recovery', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${writeOffLoanId}/record-recovery`)
      .set('X-API-Key', eveApiKey)
      .send({ amount: '1000.00', recovery_source: 'legal_settlement' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('recovery record is linked to write_off record', () => {
    const writeOff = db.prepare('SELECT id FROM write_offs WHERE loan_id=?').get(writeOffLoanId) as { id: string };
    const recovery = db.prepare('SELECT * FROM recoveries WHERE loan_id=?').get(writeOffLoanId) as any;
    expect(recovery.write_off_id).toBe(writeOff.id);
    expect(recovery.loan_id).toBe(writeOffLoanId);
  });
});

// ─── Agent Assignment: BUG RG-020 ────────────────────────────────────────────

describe('POST /api/v1/collections/:id/assign-agent — BUG RG-020', () => {
  let agentTestLoanId: string;

  beforeAll(async () => {
    // Create a separate Grace loan and put it in 61+ DPD
    agentTestLoanId = await applyAndDisburse(
      testApiKeys['grace'],
      testApiKeys['bob'],
      'line_of_credit',
      '8000.00',
      6,
      'coll-agent-assign'
    );
    // Set to 61 days overdue + insert DPD record
    db.prepare(
      `UPDATE emi_schedules SET status='overdue', due_date=date('now','-61 days') WHERE loan_id=?`
    ).run(agentTestLoanId);
    db.prepare(
      `INSERT INTO dpd_records
         (id, loan_id, as_of_date, days_past_due, overdue_emi_count,
          overdue_principal, overdue_interest, overdue_penalty, bucket)
       VALUES (?, ?, date('now'), 61, 2, 800000, 30000, 0, '61-90')
       ON CONFLICT(loan_id, as_of_date) DO UPDATE SET days_past_due=61, bucket='61-90'`
    ).run(uuidv4(), agentTestLoanId);
  });

  it('returns 401 without API key', async () => {
    const res = await request(app)
      .post(`/api/v1/collections/${agentTestLoanId}/assign-agent`)
      .send({ agent_user_id: eveUserId });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(app)
      .post(`/api/v1/collections/${agentTestLoanId}/assign-agent`)
      .set('X-API-Key', testApiKeys['bob'])
      .send({ agent_user_id: eveUserId });
    expect(res.status).toBe(403);
  });

  it('returns 422 when loan is not in 60+ DPD bucket', async () => {
    // activeLoanId is in 1-30 bucket (DPD=30)
    const res = await request(app)
      .post(`/api/v1/collections/${activeLoanId}/assign-agent`)
      .set('X-API-Key', testApiKeys['alice'])
      .send({ agent_user_id: eveUserId });
    expect(res.status).toBe(422);
  });

  it('successfully assigns a collections_agent to a 60+ DPD loan', async () => {
    const res = await request(app)
      .post(`/api/v1/collections/${agentTestLoanId}/assign-agent`)
      .set('X-API-Key', testApiKeys['alice'])
      .send({ agent_user_id: eveUserId, notes: 'Eve has prior experience with this department' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.agent_user_id).toBe(eveUserId);

    // Verify DB record
    const assignment = db.prepare(
      'SELECT * FROM collections_assignments WHERE loan_id=?'
    ).get(agentTestLoanId) as any;
    expect(assignment).toBeTruthy();
    expect(assignment.agent_user_id).toBe(eveUserId);
    expect(assignment.is_active).toBe(1);
  });

  it('BUG RG-020: any user (regardless of role) can be assigned as collections agent', async () => {
    // Bob is senior_underwriter — should NOT be assignable as collections agent,
    // but BUG RG-020 means there is no role check, so this succeeds.
    const res = await request(app)
      .post(`/api/v1/collections/${agentTestLoanId}/assign-agent`)
      .set('X-API-Key', testApiKeys['alice'])
      .send({ agent_user_id: testUserIds['bob'], notes: 'Bob should not be a collections agent' });

    // BUG RG-020: succeeds (should return 422 VALIDATION_ERROR)
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.agent_username).toBe('bob');
  });

  it('reassigning replaces previous assignment', async () => {
    // After the above tests, the latest assignment for agentTestLoanId is bob.
    // Reassign to Eve.
    const res = await request(app)
      .post(`/api/v1/collections/${agentTestLoanId}/assign-agent`)
      .set('X-API-Key', testApiKeys['alice'])
      .send({ agent_user_id: eveUserId });

    expect(res.status).toBe(201);

    // Only one assignment record should exist (UNIQUE on loan_id)
    const assignments = db.prepare(
      'SELECT COUNT(*) as cnt FROM collections_assignments WHERE loan_id=?'
    ).get(agentTestLoanId) as { cnt: number };
    expect(assignments.cnt).toBe(1);

    const current = db.prepare(
      'SELECT agent_user_id FROM collections_assignments WHERE loan_id=?'
    ).get(agentTestLoanId) as { agent_user_id: string };
    expect(current.agent_user_id).toBe(eveUserId);
  });

  it('assigned agent appears in collections queue', async () => {
    const res = await request(app)
      .get(`/api/v1/collections/queue?bucket=61-90`)
      .set('X-API-Key', testApiKeys['alice']);
    expect(res.status).toBe(200);

    const entry = res.body.data.find((d: any) => d.loan_id === agentTestLoanId);
    expect(entry).toBeTruthy();
    expect(entry.assigned_agent).toBeTruthy();
    expect(entry.assigned_agent.id).toBe(eveUserId);
  });
});
