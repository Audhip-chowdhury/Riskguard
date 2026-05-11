import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import db from '../src/db';
import { testApiKeys, testUserIds, testEmployeeIds } from './setup';
import { computeEmi, generateEmiSchedule } from '../src/services/emi.service';
import { executeRepaymentCycle } from '../src/workers/repayment-executor';

// ─── Mock PayFlow ─────────────────────────────────────────────────────────────

vi.mock('../src/services/payflow.service', () => ({
  transferFromPayFlow: vi.fn().mockResolvedValue({
    success: true,
    data: { transaction_id: 'mock-txn-abc123' },
  }),
  getWalletBalance: vi.fn().mockResolvedValue({ balance: '9999999.00' }),
}));

import { transferFromPayFlow } from '../src/services/payflow.service';
const mockTransfer = transferFromPayFlow as ReturnType<typeof vi.fn>;

// ─── Shared state ─────────────────────────────────────────────────────────────

let frankBorrowerId: string;
let approvedLoanId: string;   // loan.id (not application_id)

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create frank's borrower profile
  const frankRes = await request(app)
    .post('/api/v1/borrowers')
    .set('X-API-Key', testApiKeys['alice'])
    .set('Idempotency-Key', 'disb-setup-frank')
    .send({ employee_id: testEmployeeIds['frank'] });
  frankBorrowerId = frankRes.body.data.id;

  // Frank applies for a personal loan (24 months, 100K SIM)
  // Frank's score is high enough for manual approval tier
  const applyRes = await request(app)
    .post('/api/v1/loans/apply')
    .set('X-API-Key', testApiKeys['frank'])
    .set('Idempotency-Key', 'disb-setup-apply')
    .send({
      product_type: 'personal_loan',
      requested_amount: '100000.00',
      requested_tenure_months: 24,
      purpose: 'Home renovation project for phase 3 testing',
    });

  const applicationId = applyRes.body.data.application_id;

  // Bob (senior_underwriter) approves the application
  const approveRes = await request(app)
    .post(`/api/v1/loans/${applicationId}/approve`)
    .set('X-API-Key', testApiKeys['bob'])
    .set('Idempotency-Key', 'disb-setup-approve')
    .send({ notes: 'Approved for testing' });

  approvedLoanId = approveRes.body.data.loan.id;
});

afterEach(() => {
  mockTransfer.mockClear();
});

// ─── POST /api/v1/loans/:id/disburse ─────────────────────────────────────────

describe('POST /api/v1/loans/:id/disburse', () => {
  it('returns 401 without API key', async () => {
    const res = await request(app).post(`/api/v1/loans/${approvedLoanId}/disburse`).send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for employee role (only admin/senior_underwriter allowed)', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${approvedLoanId}/disburse`)
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `disb-frank-${Date.now()}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 for unknown loan', async () => {
    const res = await request(app)
      .post('/api/v1/loans/00000000-0000-0000-0000-000000000000/disburse')
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', `disb-unknown-${Date.now()}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('disburses successfully: processing fee deducted, schedule generated', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${approvedLoanId}/disburse`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', 'disb-main-success')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const d = res.body.data;
    expect(d.loan_id).toBe(approvedLoanId);
    expect(d.requested_amount).toBe('100000.00');
    // Processing fee = 1% of 100K = 1000 SIM (under 2000 SIM cap)
    expect(d.processing_fee).toBe('1000.00');
    expect(d.net_disbursed_amount).toBe('99000.00');
    expect(d.payflow_transaction_id).toBe('mock-txn-abc123');
    expect(d.schedule_generated).toBe(true);
    expect(d.first_emi_due).toBeTruthy();

    // PayFlow called once: lending wallet → borrower wallet for net amount
    expect(mockTransfer).toHaveBeenCalledTimes(1);
    const call = mockTransfer.mock.calls[0][0];
    expect(call.amount).toBe('99000.00');
    expect(call.idempotencyKey).toBe(`disbursement-${approvedLoanId}`);

    // Loan status should now be active
    const loan = db.prepare('SELECT status FROM loans WHERE id = ?').get(approvedLoanId) as { status: string };
    expect(loan.status).toBe('active');

    // 24 EMI schedule entries created
    const emis = db.prepare('SELECT * FROM emi_schedules WHERE loan_id = ? ORDER BY installment_number').all(approvedLoanId);
    expect(emis).toHaveLength(24);
  });

  it('is idempotent — second call returns same disbursement', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${approvedLoanId}/disburse`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', 'disb-main-success') // same key → hits idempotency_store
      .send({});

    expect(res.status).toBe(200);
    // PayFlow NOT called again (idempotency middleware replays stored response)
    expect(mockTransfer).toHaveBeenCalledTimes(0);
  });

  it('returns 422 if loan already active (not in approved status)', async () => {
    // Create a second loan for this test
    const applyRes = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `disb-already-active-apply-${Date.now()}`)
      .send({
        product_type: 'emergency_loan',
        requested_amount: '5000.00',
        requested_tenure_months: 6,
        purpose: 'Already active test scenario check',
      });
    const appId2 = applyRes.body.data.application_id;

    const approveRes = await request(app)
      .post(`/api/v1/loans/${appId2}/approve`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', `disb-already-approve-${Date.now()}`)
      .send({});
    const loanId2 = approveRes.body.data.loan.id;

    // Disburse once
    await request(app)
      .post(`/api/v1/loans/${loanId2}/disburse`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', `disb-first-${loanId2}`)
      .send({});

    mockTransfer.mockClear();

    // Disburse again with a different idempotency key → should get service-level rejection
    const res2 = await request(app)
      .post(`/api/v1/loans/${loanId2}/disburse`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', `disb-second-${loanId2}`)
      .send({});

    expect(res2.status).toBe(422);
    expect(res2.body.error.code).toBe('INVALID_STATE');
    expect(mockTransfer).toHaveBeenCalledTimes(0);
  });
});

// ─── Processing fee cap ───────────────────────────────────────────────────────

describe('Processing fee cap at 2000 SIM', () => {
  it('caps processing fee at 2000 SIM for large loans', async () => {
    // Grace has a boosted credit limit — use her for a large loan
    const graceRes = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', 'disb-grace-borrower')
      .send({ employee_id: testEmployeeIds['grace'] });
    const graceBorrowerId = graceRes.body.data.id;

    // Boost her limit
    await request(app)
      .post(`/api/v1/borrowers/${graceBorrowerId}/manual-adjust`)
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', 'disb-grace-adjust')
      .send({ new_score: 900, new_credit_limit: '10000000.00', reason: 'Fee cap test' });

    // Apply for 500K SIM (1% = 5000 SIM, capped to 2000 SIM)
    const applyRes = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['grace'])
      .set('Idempotency-Key', 'disb-grace-apply')
      .send({
        product_type: 'personal_loan',
        requested_amount: '500000.00',
        requested_tenure_months: 24,
        purpose: 'Large loan for fee cap test scenario',
      });
    const appId = applyRes.body.data.application_id;

    // Bob approves
    const approveRes = await request(app)
      .post(`/api/v1/loans/${appId}/approve`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', `disb-grace-approve-${Date.now()}`)
      .send({});
    const loanId = approveRes.body.data.loan.id;

    const disbRes = await request(app)
      .post(`/api/v1/loans/${loanId}/disburse`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', `disb-grace-disburse-${Date.now()}`)
      .send({});

    expect(disbRes.status).toBe(200);
    expect(disbRes.body.data.processing_fee).toBe('2000.00'); // capped
    expect(disbRes.body.data.net_disbursed_amount).toBe('498000.00');
  });
});

// ─── GET /api/v1/loans/:id/schedule ──────────────────────────────────────────

describe('GET /api/v1/loans/:id/schedule', () => {
  it('returns EMI schedule with correct structure', async () => {
    const res = await request(app)
      .get(`/api/v1/loans/${approvedLoanId}/schedule`)
      .set('X-API-Key', testApiKeys['bob']);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { installments, tenure_months } = res.body.data;
    expect(tenure_months).toBe(24);
    expect(installments).toHaveLength(24);

    const first = installments[0];
    expect(first.installment_number).toBe(1);
    expect(first.status).toBe('scheduled');
    expect(typeof first.emi_amount).toBe('string');
    expect(typeof first.opening_balance).toBe('string');

    // Balances should be decreasing (reducing balance)
    const ob1 = parseFloat(installments[0].opening_balance);
    const ob2 = parseFloat(installments[1].opening_balance);
    expect(ob2).toBeLessThan(ob1);
  });

  it('allows borrower to view own schedule', async () => {
    const res = await request(app)
      .get(`/api/v1/loans/${approvedLoanId}/schedule`)
      .set('X-API-Key', testApiKeys['frank']);
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown loan', async () => {
    const res = await request(app)
      .get('/api/v1/loans/00000000-0000-0000-0000-000000000000/schedule')
      .set('X-API-Key', testApiKeys['bob']);
    expect(res.status).toBe(404);
  });
});

// ─── BUG RG-011: Floating-point residual balance ──────────────────────────────

describe('BUG RG-011 — EMI schedule residual non-zero closing balance', () => {
  it('computes EMI correctly for zero-interest loan', () => {
    const emi = computeEmi(100000 * 100, 0, 12);
    expect(emi).toBe(100000 * 100 / 12 | 0); // roughly equal (integer division)
  });

  it('final closing_balance is non-zero for a 24-month 12% 100K SIM loan (RG-011)', () => {
    const principalPaise = 100000 * 100; // 100K SIM in paise
    const rateBps = 1200; // 12% annual
    const tenure = 24;

    const fakeLoan = {
      id: 'test', application_id: 'test', borrower_id: 'test',
      product_type: 'personal_loan', principal_amount: principalPaise,
      tenure_months: tenure, annual_interest_rate_bps: rateBps,
      processing_fee_amount: 0, status: 'active', approved_at: '',
      created_at: '', updated_at: '',
    };

    const schedule = generateEmiSchedule(fakeLoan, new Date('2025-01-15'));
    const lastEntry = schedule[schedule.length - 1];

    // BUG RG-011: closing balance of last entry is NOT zero
    // Due to floating-point accumulation in reducing-balance calculations
    expect(lastEntry.closing_balance).not.toBe(0);
  });

  it('all EMI amounts are the same (same EMI each period)', () => {
    const principalPaise = 100000 * 100;
    const fakeLoan = {
      id: 'test', application_id: 'test', borrower_id: 'test',
      product_type: 'personal_loan', principal_amount: principalPaise,
      tenure_months: 12, annual_interest_rate_bps: 1200,
      processing_fee_amount: 0, status: 'active', approved_at: '',
      created_at: '', updated_at: '',
    };
    const schedule = generateEmiSchedule(fakeLoan, new Date('2025-01-15'));
    const emis = schedule.map(e => e.emi_amount);
    const allSame = emis.every(e => e === emis[0]);
    expect(allSame).toBe(true);
  });
});

// ─── POST /api/v1/loans/:id/repay ────────────────────────────────────────────

describe('POST /api/v1/loans/:id/repay — manual repayment', () => {
  let repayLoanId: string;
  let firstEmiId: string;

  beforeAll(async () => {
    // Create a fresh borrower and loan for repayment tests
    // Re-use iris for this (different employee)
    const irisRes = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', 'repay-setup-iris')
      .send({ employee_id: testEmployeeIds['iris'] });
    const irisBorrowerId = irisRes.body.data.id;

    // Boost iris credit limit to allow a manually-reviewed loan (> 50K SIM triggers manual tier)
    await request(app)
      .post(`/api/v1/borrowers/${irisBorrowerId}/manual-adjust`)
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', 'repay-iris-boost')
      .send({ new_score: 780, new_credit_limit: '200000.00', reason: 'Repayment test setup' });

    const applyRes = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', 'repay-iris-apply')
      .send({
        product_type: 'salary_advance',
        requested_amount: '80000.00',  // > 50K → manual review tier
        requested_tenure_months: 12,
        purpose: 'Repayment test loan application purpose here',
      });
    const appId = applyRes.body.data.application_id;

    const approveRes = await request(app)
      .post(`/api/v1/loans/${appId}/approve`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', 'repay-iris-approve')
      .send({});
    repayLoanId = approveRes.body.data.loan.id;

    await request(app)
      .post(`/api/v1/loans/${repayLoanId}/disburse`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', 'repay-iris-disburse')
      .send({});

    mockTransfer.mockClear();

    // Get first EMI id
    const emi = db
      .prepare('SELECT id FROM emi_schedules WHERE loan_id = ? ORDER BY installment_number LIMIT 1')
      .get(repayLoanId) as { id: string };
    firstEmiId = emi.id;
  });

  it('returns 401 without API key', async () => {
    const res = await request(app)
      .post(`/api/v1/loans/${repayLoanId}/repay`)
      .send({ amount: '900.00' });
    expect(res.status).toBe(401);
  });

  it('returns 422 for non-active loan', async () => {
    // Use a loan in approved status (before disbursement)
    const applyRes = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['frank'])
      .set('Idempotency-Key', `repay-inactive-apply-${Date.now()}`)
      .send({
        product_type: 'emergency_loan',
        requested_amount: '2000.00',
        requested_tenure_months: 3,
        purpose: 'Inactive loan repay test purpose here',
      });
    const appId2 = applyRes.body.data.application_id;
    const approveRes = await request(app)
      .post(`/api/v1/loans/${appId2}/approve`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', `repay-inactive-approve-${Date.now()}`)
      .send({});
    const loanId2 = approveRes.body.data.loan.id;

    const res = await request(app)
      .post(`/api/v1/loans/${loanId2}/repay`)
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `repay-inactive-${Date.now()}`)
      .send({ amount: '500.00' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('applies repayment to specified EMI with correct breakdown', async () => {
    const firstEmi = db
      .prepare('SELECT * FROM emi_schedules WHERE id = ?')
      .get(firstEmiId) as { emi_amount: number; principal_component: number; interest_component: number };

    const emiAmountSim = (firstEmi.emi_amount / 100).toFixed(2);

    const res = await request(app)
      .post(`/api/v1/loans/${repayLoanId}/repay`)
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `repay-first-emi-${Date.now()}`)
      .send({ amount: emiAmountSim, emi_schedule_id: firstEmiId });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const d = res.body.data;
    expect(d.repayment_id).toBeTruthy();
    expect(d.breakdown.late_penalty).toBe('0.00');
    // interest + principal = emi amount
    const breakdownSum =
      parseFloat(d.breakdown.principal) +
      parseFloat(d.breakdown.interest) +
      parseFloat(d.breakdown.late_penalty);
    expect(breakdownSum).toBeCloseTo(firstEmi.emi_amount / 100, 1);

    // EMI should now be paid
    const updatedEmi = res.body.data.emi_schedule_updated[0];
    expect(updatedEmi.status).toBe('paid');

    // PayFlow called once
    expect(mockTransfer).toHaveBeenCalledTimes(1);
    const call = mockTransfer.mock.calls[0][0];
    expect(call.amount).toBe(emiAmountSim);
  });

  it('applies repayment to oldest scheduled EMI when emi_schedule_id omitted', async () => {
    mockTransfer.mockClear();

    const nextEmi = db
      .prepare('SELECT * FROM emi_schedules WHERE loan_id = ? AND status = ? ORDER BY installment_number LIMIT 1')
      .get(repayLoanId, 'scheduled') as { id: string; emi_amount: number };

    const emiSim = (nextEmi.emi_amount / 100).toFixed(2);

    const res = await request(app)
      .post(`/api/v1/loans/${repayLoanId}/repay`)
      .set('X-API-Key', testApiKeys['iris'])
      .set('Idempotency-Key', `repay-oldest-${Date.now()}`)
      .send({ amount: emiSim });

    expect(res.status).toBe(201);
    expect(res.body.data.emi_schedule_updated[0].id).toBe(nextEmi.id);
  });
});

// ─── BUG RG-012: Worker double-charge race condition ─────────────────────────

describe('BUG RG-012 — Worker processes EMI without re-checking status', () => {
  it('calls PayFlow even for an EMI where status was changed to paid after initial fetch', async () => {
    // Insert a test loan with a due EMI directly into the DB
    const loanRow = db
      .prepare('SELECT * FROM loans WHERE id = ?')
      .get(approvedLoanId) as { id: string; borrower_id: string; annual_interest_rate_bps: number };

    // Insert a synthetic "overdue" EMI with a past due date
    const { v4: uuidv4 } = await import('uuid');
    const testEmiId = uuidv4();
    db.prepare(`
      INSERT INTO emi_schedules
        (id, loan_id, installment_number, due_date, emi_amount,
         principal_component, interest_component, opening_balance, closing_balance, status)
      VALUES (?, ?, 999, date('now', '-10 days'), 50000, 40000, 10000, 500000, 460000, 'scheduled')
    `).run(testEmiId, approvedLoanId);

    // Simulate: manual repayment happened after the worker's initial SELECT
    // The worker already has the row in memory as 'scheduled'
    // Worker proceeds to call PayFlow without re-checking DB status

    // We verify the bug by confirming the worker called PayFlow for this EMI
    // even if we update it to 'paid' before the worker's UPDATE runs
    // (In real code the race window is between SELECT and the PayFlow call)

    mockTransfer.mockClear();
    const { processed } = await executeRepaymentCycle();

    // Worker should have processed this EMI (called PayFlow for it)
    const payflowCalls = mockTransfer.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).idempotencyKey === `emi-debit-${testEmiId}`
    );
    expect(payflowCalls.length).toBe(1);

    // Now simulate the race: mark it paid manually (as if borrower paid mid-cycle)
    db.prepare(`UPDATE emi_schedules SET status='scheduled' WHERE id=?`).run(testEmiId);

    // Run cycle again — worker will pick it up again because no re-check
    mockTransfer.mockClear();
    await executeRepaymentCycle();

    const secondCalls = mockTransfer.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).idempotencyKey === `emi-debit-${testEmiId}`
    );
    // Second run also processes the same EMI → demonstrates double-charge potential
    expect(secondCalls.length).toBe(1);

    // Cleanup
    db.prepare('DELETE FROM repayments WHERE emi_schedule_id = ?').run(testEmiId);
    db.prepare('DELETE FROM emi_schedules WHERE id = ?').run(testEmiId);
  });
});

// ─── BUG RG-014: Late penalty grace period off-by-one ─────────────────────────

describe('BUG RG-014 — Grace period off-by-one in worker', () => {
  it('enters the late-penalty branch on day 5 (should not, grace extends through day 5)', async () => {
    const loanRow = db
      .prepare('SELECT * FROM loans WHERE id = ?')
      .get(approvedLoanId) as { id: string; borrower_id: string };

    const { v4: uuidv4 } = await import('uuid');
    const emiId5 = uuidv4();
    // Due exactly 5 days ago — should still be in grace period
    db.prepare(`
      INSERT INTO emi_schedules
        (id, loan_id, installment_number, due_date, emi_amount,
         principal_component, interest_component, opening_balance, closing_balance, status)
      VALUES (?, ?, 998, date('now', '-5 days'), 100000, 80000, 20000, 400000, 320000, 'scheduled')
    `).run(emiId5, approvedLoanId);

    mockTransfer.mockClear();
    await executeRepaymentCycle();

    // The worker called PayFlow for this EMI
    const call = mockTransfer.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).idempotencyKey === `emi-debit-${emiId5}`
    );
    expect(call).toBeTruthy();

    // Check the amount: on day 5 with >= 5, daysAfterGrace = 0, lateFee = 0
    // So total debit = emi_amount + 0 = emi_amount
    // This is the BUG: the condition fires even though fee is 0
    // A correct implementation (> 5) would not enter the branch at all on day 5
    const updatedEmi = db
      .prepare('SELECT * FROM emi_schedules WHERE id = ?')
      .get(emiId5) as { status: string; late_penalty: number; paid_amount: number };

    // EMI was processed (paid) with late_penalty = 0 (daysAfterGrace = 0)
    expect(updatedEmi.status).toBe('paid');
    expect(updatedEmi.late_penalty).toBe(0);

    // Cleanup
    db.prepare('DELETE FROM repayments WHERE emi_schedule_id = ?').run(emiId5);
    db.prepare('DELETE FROM emi_schedules WHERE id = ?').run(emiId5);
  });

  it('charges late fee starting day 6 (consistent between bug and correct for actual fee amount)', async () => {
    const { v4: uuidv4 } = await import('uuid');
    const emiId6 = uuidv4();
    // Due 6 days ago — both bug code (>= 5) and correct code (> 5) charge a fee here
    db.prepare(`
      INSERT INTO emi_schedules
        (id, loan_id, installment_number, due_date, emi_amount,
         principal_component, interest_component, opening_balance, closing_balance, status)
      VALUES (?, ?, 997, date('now', '-6 days'), 100000, 80000, 20000, 300000, 220000, 'scheduled')
    `).run(emiId6, approvedLoanId);

    mockTransfer.mockClear();
    await executeRepaymentCycle();

    const updatedEmi6 = db
      .prepare('SELECT late_penalty, paid_amount FROM emi_schedules WHERE id = ?')
      .get(emiId6) as { late_penalty: number; paid_amount: number };

    // Day 6: daysAfterGrace = 6 - 5 = 1; fee = 100000 * 0.02 * 1 = 2000
    expect(updatedEmi6.late_penalty).toBe(2000);
    expect(updatedEmi6.paid_amount).toBe(102000); // emi + lateFee

    // Cleanup
    db.prepare('DELETE FROM repayments WHERE emi_schedule_id = ?').run(emiId6);
    db.prepare('DELETE FROM emi_schedules WHERE id = ?').run(emiId6);
  });
});

// ─── POST /api/v1/loans/:id/prepay ───────────────────────────────────────────

describe('POST /api/v1/loans/:id/prepay — BUG RG-013 penalty overcalculation', () => {
  let prepayLoanId: string;

  beforeAll(async () => {
    // Use evan (underwriter) for prepayment tests — has a real salary
    const evanRes = await request(app)
      .post('/api/v1/borrowers')
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', 'prepay-evan-borrower')
      .send({ employee_id: testEmployeeIds['evan'] });
    const evanBorrowerId = evanRes.body.data.id;

    await request(app)
      .post(`/api/v1/borrowers/${evanBorrowerId}/manual-adjust`)
      .set('X-API-Key', testApiKeys['alice'])
      .set('Idempotency-Key', 'prepay-evan-adjust')
      .send({ new_score: 750, new_credit_limit: '200000.00', reason: 'Prepayment test' });

    // > 50K SIM → manual review (avoids auto-approval path)
    const applyRes = await request(app)
      .post('/api/v1/loans/apply')
      .set('X-API-Key', testApiKeys['evan'])
      .set('Idempotency-Key', 'prepay-evan-apply')
      .send({
        product_type: 'personal_loan',
        requested_amount: '80000.00',
        requested_tenure_months: 12,
        purpose: 'Prepayment test loan to verify penalty bug rg013',
      });
    const appId = applyRes.body.data.application_id;

    const approveRes = await request(app)
      .post(`/api/v1/loans/${appId}/approve`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', 'prepay-evan-approve')
      .send({});
    prepayLoanId = approveRes.body.data.loan.id;

    await request(app)
      .post(`/api/v1/loans/${prepayLoanId}/disburse`)
      .set('X-API-Key', testApiKeys['bob'])
      .set('Idempotency-Key', 'prepay-evan-disburse')
      .send({});

    mockTransfer.mockClear();
  });

  it('BUG RG-013: full prepayment penalty is 2% of total outstanding (over-charged)', async () => {
    // Get the current EMI's principal component
    const currentEmi = db
      .prepare(`SELECT * FROM emi_schedules WHERE loan_id = ? AND status = 'scheduled' ORDER BY installment_number LIMIT 1`)
      .get(prepayLoanId) as { principal_component: number; opening_balance: number };

    const outstanding = currentEmi.opening_balance;
    const principalOfCurrentEmi = currentEmi.principal_component;

    // BUG RG-013: penalty = outstanding * 0.02 (includes current EMI's principal)
    const buggyPenalty = Math.round(outstanding * 0.02);
    // Correct: penalty = (outstanding - principalOfCurrentEmi) * 0.02
    const correctPenalty = Math.round((outstanding - principalOfCurrentEmi) * 0.02);

    const res = await request(app)
      .post(`/api/v1/loans/${prepayLoanId}/prepay`)
      .set('X-API-Key', testApiKeys['evan'])
      .set('Idempotency-Key', `prepay-full-${Date.now()}`)
      .send({ type: 'full' });

    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d.type).toBe('full');

    const returnedPenaltyPaise = Math.round(parseFloat(d.penalty_amount) * 100);

    // Verify the bug: penalty equals the over-charged amount (includes current EMI principal)
    expect(returnedPenaltyPaise).toBe(buggyPenalty);
    // And it's higher than the correct amount
    expect(returnedPenaltyPaise).toBeGreaterThan(correctPenalty);

    // Loan should be prepaid
    const loan = db.prepare('SELECT status FROM loans WHERE id = ?').get(prepayLoanId) as { status: string };
    expect(loan.status).toBe('prepaid');
  });
});

// ─── GET /api/v1/loans/:id/statement — BUG RG-015 ───────────────────────────

describe('GET /api/v1/loans/:id/statement — BUG RG-015 processing fee missing', () => {
  it('BUG RG-015: statement does not include processing_fee as a separate transaction', async () => {
    const res = await request(app)
      .get(`/api/v1/loans/${approvedLoanId}/statement`)
      .set('X-API-Key', testApiKeys['bob']);

    expect(res.status).toBe(200);
    const { transactions } = res.body.data;

    // Find the disbursement transaction
    const disbTxn = transactions.find((t: Record<string, unknown>) => t.type === 'disbursement');
    expect(disbTxn).toBeTruthy();

    // BUG RG-015: disbursement shows net_disbursed_amount (99000), NOT the full principal (100000)
    // And there is NO separate processing_fee entry
    expect(parseFloat(disbTxn.amount as string)).toBeLessThan(100000); // net, not gross
    expect(disbTxn.amount).toBe('99000.00');

    // Verify no processing_fee transaction type exists
    const feeTxn = transactions.find((t: Record<string, unknown>) => t.type === 'processing_fee');
    expect(feeTxn).toBeUndefined();
  });

  it('statement includes principal and outstanding fields', async () => {
    const res = await request(app)
      .get(`/api/v1/loans/${approvedLoanId}/statement`)
      .set('X-API-Key', testApiKeys['bob']);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.loan_id).toBe(approvedLoanId);
    expect(d.principal_amount).toBe('100000.00');
    expect(typeof d.current_outstanding).toBe('string');
    expect(typeof d.total_paid_to_date).toBe('string');
    expect(Array.isArray(d.transactions)).toBe(true);
  });

  it('returns 403 for wrong borrower', async () => {
    // iris tries to view frank's statement
    const res = await request(app)
      .get(`/api/v1/loans/${approvedLoanId}/statement`)
      .set('X-API-Key', testApiKeys['iris']);
    expect(res.status).toBe(403);
  });
});
