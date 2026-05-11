import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import db from '../db';
import { auth } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import { AppError } from '../middleware/error-handler';
import { now } from '../utils/date';
import { paisaToSim, simToPaisa } from '../utils/currency';
import { screenAml } from '../services/complyhub-stub.service';
import {
  checkAutoApproval,
  determineTier,
  computeInterestRate,
  createLoanRecord,
  approveApplication,
  rejectApplication,
  createAppeal,
  withdrawApplication,
} from '../services/underwriting.service';
import { LoanApplication, Loan, UnderwritingDecision, Appeal } from '../types';
import {
  disburse,
  getSchedule,
  repayLoan,
  prepayLoan,
  generateStatement,
} from '../services/disbursement.service';
import {
  restructureLoan,
  writeOffLoan,
  recordRecovery,
} from '../services/collections.service';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const restructureSchema = z.object({
  new_tenure_months: z.number().int().positive(),
  new_annual_rate_bps: z.number().int().positive(),
  reason: z.string().min(30),
});

const writeOffSchema = z.object({
  reason: z.string().min(50),
});

const recoverySchema = z.object({
  amount: z.string().regex(/^\d+\.\d{2}$/, 'Must be a decimal string like "1000.00"'),
  recovery_source: z.enum(['voluntary_payment', 'legal_settlement', 'asset_sale']),
  notes: z.string().optional(),
});

const repaySchema = z.object({
  amount: z.string().regex(/^\d+\.\d{2}$/, 'Must be a decimal string like "1000.00"'),
  emi_schedule_id: z.string().uuid().optional(),
});

const prepaySchema = z.object({
  amount: z.string().regex(/^\d+\.\d{2}$/).optional(),
  type: z.enum(['partial', 'full']),
});

const applySchema = z.object({
  product_type: z.enum(['salary_advance', 'personal_loan', 'line_of_credit', 'bnpl', 'emergency_loan']),
  requested_amount: z.string().regex(/^\d+\.\d{2}$/, 'Must be a decimal string like "1000.00"'),
  requested_tenure_months: z.number().int().positive().optional(),
  purpose: z.string().min(5),
});

const approveSchema = z.object({
  notes: z.string().optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(10),
});

const appealSchema = z.object({
  reason: z.string().min(10),
  additional_info: z.string().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatApplication(app: LoanApplication) {
  return {
    id: app.id,
    borrower_id: app.borrower_id,
    product_type: app.product_type,
    requested_amount: paisaToSim(app.requested_amount),
    requested_tenure_months: app.requested_tenure_months,
    purpose: app.purpose,
    status: app.status,
    approval_tier: app.approval_tier,
    score_at_application: app.score_at_application,
    band_at_application: app.band_at_application,
    available_limit_at_application: paisaToSim(app.available_limit_at_application),
    debt_ratio_at_application: app.debt_ratio_at_application,
    submitted_at: app.submitted_at,
    reviewed_by_user_id: app.reviewed_by_user_id,
    reviewed_at: app.reviewed_at,
    committee_reviewed_by_user_id: app.committee_reviewed_by_user_id,
    committee_reviewed_at: app.committee_reviewed_at,
    rejection_reason: app.rejection_reason,
    created_at: app.created_at,
    updated_at: app.updated_at,
  };
}

function formatLoan(loan: Loan) {
  return {
    id: loan.id,
    application_id: loan.application_id,
    borrower_id: loan.borrower_id,
    product_type: loan.product_type,
    principal_amount: paisaToSim(loan.principal_amount),
    tenure_months: loan.tenure_months,
    annual_interest_rate_bps: loan.annual_interest_rate_bps,
    interest_rate: (loan.annual_interest_rate_bps / 100).toFixed(2),
    processing_fee_amount: paisaToSim(loan.processing_fee_amount),
    status: loan.status,
    approved_at: loan.approved_at,
    created_at: loan.created_at,
    updated_at: loan.updated_at,
  };
}

// ─── POST /api/v1/loans/apply ─────────────────────────────────────────────────

router.post('/apply', auth, idempotency, async (req: Request, res: Response) => {
  const body = applySchema.parse(req.body);
  const user = req.user!;
  const requestedAmountPaise = simToPaisa(body.requested_amount);

  // Look up employee and borrower for the authenticated user
  const employee = db
    .prepare('SELECT * FROM employees WHERE user_id = ?')
    .get(user.id) as { id: string; monthly_salary: number } | undefined;

  if (!employee) throw new AppError(404, 'NOT_FOUND', 'No employee record for this user');

  const borrower = db
    .prepare('SELECT * FROM borrowers WHERE employee_id = ?')
    .get(employee.id) as {
      id: string; current_score: number; current_band: string;
      available_limit: number; kyc_status: string;
    } | undefined;

  if (!borrower) throw new AppError(404, 'NOT_FOUND', 'Borrower profile not found');

  if (borrower.kyc_status !== 'passed') {
    throw new AppError(422, 'KYC_FAILED', 'KYC must be passed before applying for a loan');
  }

  // Block duplicate open applications for same product type
  const openApp = db
    .prepare(
      `SELECT id FROM loan_applications
       WHERE borrower_id = ? AND product_type = ? AND status IN ('submitted','under_review','committee_review')`
    )
    .get(borrower.id, body.product_type) as { id: string } | undefined;

  if (openApp) {
    throw new AppError(409, 'CONFLICT', `An open ${body.product_type} application already exists`);
  }

  // AML screen (stub — always passes)
  await screenAml(uuidv4(), body.requested_amount);

  // Compute debt_ratio_at_application
  // BUG RG-007: stores null when no active loans (correct would be 0); null bypasses the
  // debt-ratio threshold check in checkAutoApproval.
  const debtRow = db
    .prepare(
      `SELECT COALESCE(SUM(principal_amount), 0) AS total
       FROM loans WHERE borrower_id = ? AND status IN ('disbursed', 'active')`
    )
    .get(borrower.id) as { total: number };

  const debtRatioAtApplication =
    debtRow.total > 0 && employee.monthly_salary > 0
      ? Math.round((debtRow.total / employee.monthly_salary) * 10000)
      : null;

  const ts = now();
  const applicationId = uuidv4();

  const applicationData = {
    id: applicationId,
    borrower_id: borrower.id,
    product_type: body.product_type,
    requested_amount: requestedAmountPaise,
    requested_tenure_months: body.requested_tenure_months ?? null,
    purpose: body.purpose,
    score_at_application: borrower.current_score,
    band_at_application: borrower.current_band,
    available_limit_at_application: borrower.available_limit,
    debt_ratio_at_application: debtRatioAtApplication,
  };

  // Determine routing
  const autoCheck = checkAutoApproval(applicationData, borrower.kyc_status);

  let initialStatus: string;
  let approvalTier: string | null = null;

  if (autoCheck.passes) {
    initialStatus = 'approved';
    approvalTier = 'auto';
  } else if (requestedAmountPaise > 50000000) {
    initialStatus = 'committee_review';
    approvalTier = 'committee';
  } else {
    initialStatus = 'under_review';
    approvalTier = 'manual';
  }

  // Persist application
  db.prepare(
    `INSERT INTO loan_applications
       (id, borrower_id, product_type, requested_amount, requested_tenure_months,
        purpose, status, approval_tier, score_at_application, band_at_application,
        available_limit_at_application, debt_ratio_at_application,
        submitted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    applicationId, borrower.id, body.product_type, requestedAmountPaise,
    applicationData.requested_tenure_months, body.purpose,
    initialStatus, approvalTier,
    borrower.current_score, borrower.current_band,
    borrower.available_limit, debtRatioAtApplication,
    ts, ts, ts
  );

  const savedApp = db
    .prepare('SELECT * FROM loan_applications WHERE id = ?')
    .get(applicationId) as LoanApplication;

  let loanId: string | undefined;
  let rateBps: number | undefined;

  if (initialStatus === 'approved') {
    // Determine system user for auto-approval decisions (use a sentinel)
    const systemUserId = db
      .prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`)
      .get() as { id: string } | undefined;

    const result = createLoanRecord(savedApp, 'auto', systemUserId?.id ?? applicationId, 'Auto-approved');
    loanId = result.loanId;
    rateBps = result.rateBps;
  }

  const responseData: Record<string, unknown> = {
    application_id: applicationId,
    status: initialStatus,
    approval_tier: approvalTier,
    score_at_application: borrower.current_score,
    band_at_application: borrower.current_band,
    available_limit_at_application: paisaToSim(borrower.available_limit),
    submitted_at: ts,
  };

  if (loanId && rateBps !== undefined) {
    responseData.loan_id = loanId;
    responseData.interest_rate = (rateBps / 100).toFixed(2);
  }

  return res.status(201).json({ success: true, data: responseData });
});

// ─── GET /api/v1/loans/:id ────────────────────────────────────────────────────

router.get('/:id', auth, (req: Request, res: Response) => {
  const application = db
    .prepare('SELECT * FROM loan_applications WHERE id = ?')
    .get(req.params.id) as LoanApplication | undefined;

  if (!application) throw new AppError(404, 'NOT_FOUND', 'Application not found');

  const user = req.user!;
  const elevated = ['underwriter', 'senior_underwriter', 'admin'].includes(user.role);

  if (!elevated) {
    // Verify borrower ownership
    const borrower = db
      .prepare(`SELECT b.id FROM borrowers b JOIN employees e ON e.id = b.employee_id WHERE e.user_id = ?`)
      .get(user.id) as { id: string } | undefined;
    if (!borrower || borrower.id !== application.borrower_id) {
      throw new AppError(403, 'FORBIDDEN', 'You can only view your own applications');
    }
  }

  const loan = db
    .prepare('SELECT * FROM loans WHERE application_id = ?')
    .get(req.params.id) as Loan | undefined;

  const decisions = db
    .prepare('SELECT * FROM underwriting_decisions WHERE application_id = ? ORDER BY decided_at ASC')
    .all(req.params.id) as UnderwritingDecision[];

  const appeals = db
    .prepare('SELECT * FROM appeals WHERE application_id = ? ORDER BY created_at ASC')
    .all(req.params.id) as Appeal[];

  return res.json({
    success: true,
    data: {
      application: formatApplication(application),
      loan: loan ? formatLoan(loan) : null,
      decisions: decisions.map(d => ({
        id: d.id,
        decision: d.decision,
        decided_by_user_id: d.decided_by_user_id,
        decision_tier: d.decision_tier,
        notes: d.notes,
        rules_evaluated: d.rules_evaluated ? JSON.parse(d.rules_evaluated) : null,
        decided_at: d.decided_at,
      })),
      appeals: appeals.map(a => ({
        id: a.id,
        reason: a.reason,
        additional_info: a.additional_info,
        status: a.status,
        reviewed_by_user_id: a.reviewed_by_user_id,
        reviewed_at: a.reviewed_at,
        review_notes: a.review_notes,
        created_at: a.created_at,
      })),
    },
  });
});

// ─── POST /api/v1/loans/:id/approve ──────────────────────────────────────────

router.post('/:id/approve', auth, idempotency, (req: Request, res: Response) => {
  const { notes } = approveSchema.parse(req.body);
  const result = approveApplication(req.params.id, req.user!.id, notes);

  const application = db
    .prepare('SELECT * FROM loan_applications WHERE id = ?')
    .get(req.params.id) as LoanApplication;

  const loan = result.loanId
    ? (db.prepare('SELECT * FROM loans WHERE id = ?').get(result.loanId) as Loan)
    : null;

  return res.json({
    success: true,
    data: {
      application_id: req.params.id,
      status: result.status,
      message: result.message,
      loan: loan ? formatLoan(loan) : null,
    },
  });
});

// ─── POST /api/v1/loans/:id/reject ───────────────────────────────────────────

router.post('/:id/reject', auth, idempotency, (req: Request, res: Response) => {
  const { reason } = rejectSchema.parse(req.body);
  rejectApplication(req.params.id, req.user!.id, reason);

  return res.json({
    success: true,
    data: { application_id: req.params.id, status: 'rejected', rejection_reason: reason },
  });
});

// ─── POST /api/v1/loans/:id/appeal ───────────────────────────────────────────

router.post('/:id/appeal', auth, idempotency, (req: Request, res: Response) => {
  const { reason, additional_info } = appealSchema.parse(req.body);
  const appeal = createAppeal(req.params.id, req.user!.id, reason, additional_info);

  return res.status(201).json({
    success: true,
    data: {
      appeal_id: appeal.id,
      application_id: req.params.id,
      status: appeal.status,
      reason: appeal.reason,
      created_at: appeal.created_at,
    },
  });
});

// ─── POST /api/v1/loans/:id/withdraw ─────────────────────────────────────────

router.post('/:id/withdraw', auth, idempotency, (req: Request, res: Response) => {
  withdrawApplication(req.params.id, req.user!.id);
  return res.json({
    success: true,
    data: { application_id: req.params.id, status: 'withdrawn' },
  });
});

// ─── POST /api/v1/loans/:id/disburse ─────────────────────────────────────────

router.post('/:id/disburse', auth, idempotency, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!['admin', 'senior_underwriter'].includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Only admin or senior_underwriter can disburse loans');
  }
  const data = await disburse(req.params.id, user.id);
  return res.json({ success: true, data });
});

// ─── GET /api/v1/loans/:id/schedule ──────────────────────────────────────────

router.get('/:id/schedule', auth, (req: Request, res: Response) => {
  const user = req.user!;
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id) as Loan | undefined;
  if (!loan) throw new AppError(404, 'NOT_FOUND', 'Loan not found');

  const elevated = ['underwriter', 'senior_underwriter', 'admin'].includes(user.role);
  if (!elevated) {
    const borrower = db
      .prepare(`SELECT b.id FROM borrowers b JOIN employees e ON e.id = b.employee_id WHERE e.user_id = ?`)
      .get(user.id) as { id: string } | undefined;
    if (!borrower || borrower.id !== loan.borrower_id) {
      throw new AppError(403, 'FORBIDDEN', 'You can only view your own loan schedule');
    }
  }

  const data = getSchedule(req.params.id);
  return res.json({ success: true, data });
});

// ─── POST /api/v1/loans/:id/repay ────────────────────────────────────────────

router.post('/:id/repay', auth, idempotency, async (req: Request, res: Response) => {
  const { amount, emi_schedule_id } = repaySchema.parse(req.body);
  const amountPaise = simToPaisa(amount);
  const data = await repayLoan(req.params.id, amountPaise, emi_schedule_id, req.user!.id);
  return res.status(201).json({ success: true, data });
});

// ─── POST /api/v1/loans/:id/prepay ───────────────────────────────────────────

router.post('/:id/prepay', auth, idempotency, async (req: Request, res: Response) => {
  const { amount, type } = prepaySchema.parse(req.body);
  const amountPaise = amount ? simToPaisa(amount) : undefined;
  const data = await prepayLoan(req.params.id, amountPaise, type, req.user!.id);
  return res.status(201).json({ success: true, data });
});

// ─── GET /api/v1/loans/:id/statement ─────────────────────────────────────────

router.get('/:id/statement', auth, (req: Request, res: Response) => {
  const user = req.user!;
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id) as Loan | undefined;
  if (!loan) throw new AppError(404, 'NOT_FOUND', 'Loan not found');

  const elevated = ['underwriter', 'senior_underwriter', 'admin'].includes(user.role);
  if (!elevated) {
    const borrower = db
      .prepare(`SELECT b.id FROM borrowers b JOIN employees e ON e.id = b.employee_id WHERE e.user_id = ?`)
      .get(user.id) as { id: string } | undefined;
    if (!borrower || borrower.id !== loan.borrower_id) {
      throw new AppError(403, 'FORBIDDEN', 'You can only view your own loan statement');
    }
  }

  const data = generateStatement(req.params.id);
  return res.json({ success: true, data });
});

// ─── POST /api/v1/loans/:id/restructure ──────────────────────────────────────

router.post('/:id/restructure', auth, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!['senior_underwriter', 'admin'].includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Only senior_underwriter or admin can restructure loans');
  }
  const body = restructureSchema.parse(req.body);
  const data = restructureLoan(req.params.id, body, user.id);
  return res.json({ success: true, data });
});

// ─── POST /api/v1/loans/:id/write-off ────────────────────────────────────────

router.post('/:id/write-off', auth, async (req: Request, res: Response) => {
  const user = req.user!;
  if (user.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only admin can write off loans');
  }
  const { reason } = writeOffSchema.parse(req.body);
  const data = await writeOffLoan(req.params.id, reason, user.id);
  return res.json({ success: true, data });
});

// ─── POST /api/v1/loans/:id/record-recovery ──────────────────────────────────

router.post('/:id/record-recovery', auth, async (req: Request, res: Response) => {
  const user = req.user!;
  if (!['admin', 'collections_agent'].includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Only admin or collections_agent can record recoveries');
  }
  const body = recoverySchema.parse(req.body);
  const data = await recordRecovery(req.params.id, body, user.id);
  return res.status(201).json({ success: true, data });
});

export default router;
