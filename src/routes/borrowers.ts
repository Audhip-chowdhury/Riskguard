import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import db from '../db';
import { auth } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import { AppError } from '../middleware/error-handler';
import {
  computeScore,
  assignBand,
  manualAdjustSchema,
} from '../services/scoring.service';
import { checkKyc, logAuditEvent } from '../services/complyhub-stub.service';
import { paisaToSim, simToPaisa } from '../utils/currency';
import { getPagination } from '../utils/pagination';
import { now } from '../utils/date';

const router = Router();

const createBorrowerSchema = z.object({
  employee_id: z.string().uuid(),
});

// POST /api/v1/borrowers
router.post('/', auth, idempotency, async (req: Request, res: Response) => {
  const { employee_id } = createBorrowerSchema.parse(req.body);

  const employee = db
    .prepare(
      `SELECT e.*, u.id AS user_id, u.username
       FROM employees e
       JOIN users u ON u.id = e.user_id
       WHERE e.id = ?`
    )
    .get(employee_id) as (Record<string, unknown> & {
      id: string;
      user_id: string;
      monthly_salary: number;
      department_risk_tier: number;
      joined_at: string;
    }) | undefined;

  if (!employee) throw new AppError(404, 'NOT_FOUND', 'Employee not found');

  const existing = db
    .prepare('SELECT * FROM borrowers WHERE employee_id = ?')
    .get(employee_id) as Record<string, unknown> | undefined;

  if (existing) {
    return res.status(200).json({ success: true, data: formatBorrower(existing) });
  }

  const kyc = await checkKyc(employee_id);

  const { score, band, creditLimit, factorBreakdown } = computeScore({
    borrowerId: '',
    joinedAt: employee.joined_at,
    monthlySalary: employee.monthly_salary,
    departmentRiskTier: employee.department_risk_tier,
  });

  const borrowerId = uuidv4();
  const ts = now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO borrowers
         (id, employee_id, current_score, current_band, credit_limit, available_limit,
          kyc_status, kyc_verified_at, last_scored_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      borrowerId, employee_id, score, band, creditLimit, creditLimit,
      kyc.status, kyc.verified_at, ts, ts, ts
    );

    db.prepare(
      `INSERT INTO score_snapshots
         (id, borrower_id, score, band, factor_breakdown, credit_limit_at_snapshot, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), borrowerId, score, band, JSON.stringify(factorBreakdown), creditLimit, 'initial', ts);
  })();

  await logAuditEvent({ event: 'borrower_created', borrower_id: borrowerId, user_id: req.user!.id });

  const borrower = db.prepare('SELECT * FROM borrowers WHERE id = ?').get(borrowerId) as Record<string, unknown>;
  return res.status(201).json({ success: true, data: formatBorrower(borrower) });
});

// GET /api/v1/borrowers/:id
router.get('/:id', auth, (req: Request, res: Response) => {
  const row = db
    .prepare(
      `SELECT b.*, e.id AS emp_id, e.monthly_salary, e.department, e.designation,
              e.joined_at, e.user_id, u.username
       FROM borrowers b
       JOIN employees e ON e.id = b.employee_id
       JOIN users u ON u.id = e.user_id
       WHERE b.id = ?`
    )
    .get(req.params.id) as (Record<string, unknown> & {
      id: string; emp_id: string; user_id: string; username: string;
      department: string; designation: string; monthly_salary: number;
      current_score: number; current_band: string; credit_limit: number;
      available_limit: number; kyc_status: string; last_scored_at: string | null;
    }) | undefined;

  if (!row) throw new AppError(404, 'NOT_FOUND', 'Borrower not found');

  const user = req.user!;
  const elevated = ['underwriter', 'senior_underwriter', 'admin'].includes(user.role);
  if (!elevated && row.user_id !== user.id) {
    throw new AppError(403, 'FORBIDDEN', 'You can only view your own profile');
  }

  return res.json({
    success: true,
    data: {
      id: row.id,
      employee: {
        id: row.emp_id,
        username: row.username,
        department: row.department,
        designation: row.designation,
        monthly_salary: paisaToSim(row.monthly_salary),
      },
      current_score: row.current_score,
      current_band: row.current_band,
      credit_limit: paisaToSim(row.credit_limit),
      available_limit: paisaToSim(row.available_limit),
      kyc_status: row.kyc_status,
      last_scored_at: row.last_scored_at,
    },
  });
});

// POST /api/v1/borrowers/:id/recompute-score
router.post('/:id/recompute-score', auth, idempotency, async (req: Request, res: Response) => {
  const user = req.user!;
  const borrower = db
    .prepare(
      `SELECT b.*, e.monthly_salary, e.department_risk_tier, e.joined_at, e.user_id
       FROM borrowers b
       JOIN employees e ON e.id = b.employee_id
       WHERE b.id = ?`
    )
    .get(req.params.id) as (Record<string, unknown> & {
      id: string; user_id: string; current_score: number; current_band: string;
      credit_limit: number; monthly_salary: number; department_risk_tier: number; joined_at: string;
    }) | undefined;

  if (!borrower) throw new AppError(404, 'NOT_FOUND', 'Borrower not found');

  const elevated = ['underwriter', 'senior_underwriter', 'admin'].includes(user.role);
  const isOwn = borrower.user_id === user.id;

  if (!elevated && !isOwn) {
    throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions to recompute score');
  }

  if (isOwn && !elevated) {
    const last = db
      .prepare(
        `SELECT created_at FROM score_snapshots
         WHERE borrower_id = ? AND reason = 'recompute'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(borrower.id) as { created_at: string } | undefined;

    if (last && new Date(last.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      throw new AppError(429, 'RATE_LIMITED', 'Score recompute is limited to once per day');
    }
  }

  const previousScore = borrower.current_score;
  const previousBand = borrower.current_band;
  const previousLimit = borrower.credit_limit;

  const { score, band, creditLimit, factorBreakdown } = computeScore({
    borrowerId: borrower.id,
    joinedAt: borrower.joined_at,
    monthlySalary: borrower.monthly_salary,
    departmentRiskTier: borrower.department_risk_tier,
  });

  const ts = now();
  const snapshotId = uuidv4();

  db.transaction(() => {
    db.prepare(
      `UPDATE borrowers
       SET current_score = ?, current_band = ?, credit_limit = ?, last_scored_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(score, band, creditLimit, ts, ts, borrower.id);

    db.prepare(
      `INSERT INTO score_snapshots
         (id, borrower_id, score, band, factor_breakdown, credit_limit_at_snapshot, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(snapshotId, borrower.id, score, band, JSON.stringify(factorBreakdown), creditLimit, 'recompute', ts);
  })();

  await logAuditEvent({ event: 'score_recomputed', borrower_id: borrower.id, user_id: user.id });

  return res.json({
    success: true,
    data: {
      previous_score: previousScore,
      new_score: score,
      previous_band: previousBand,
      new_band: band,
      previous_limit: paisaToSim(previousLimit),
      new_limit: paisaToSim(creditLimit),
      factor_breakdown: factorBreakdown,
      snapshot_id: snapshotId,
    },
  });
});

// GET /api/v1/borrowers/:id/score-history
router.get('/:id/score-history', auth, (req: Request, res: Response) => {
  const borrower = db
    .prepare('SELECT id FROM borrowers WHERE id = ?')
    .get(req.params.id) as { id: string } | undefined;
  if (!borrower) throw new AppError(404, 'NOT_FOUND', 'Borrower not found');

  const { page, limit, offset } = getPagination(req.query as Record<string, unknown>);

  const total = (
    db
      .prepare('SELECT COUNT(*) AS count FROM score_snapshots WHERE borrower_id = ?')
      .get(req.params.id) as { count: number }
  ).count;

  const snapshots = db
    .prepare(
      `SELECT * FROM score_snapshots
       WHERE borrower_id = ?
       ORDER BY created_at ASC
       LIMIT ? OFFSET ?`
      // BUG RG-004: ASC instead of DESC despite documentation saying newest-first
    )
    .all(req.params.id, limit, offset) as Array<{
      id: string; score: number; band: string; factor_breakdown: string;
      credit_limit_at_snapshot: number; reason: string; created_at: string;
    }>;

  return res.json({
    success: true,
    data: snapshots.map(s => ({
      id: s.id,
      score: s.score,
      band: s.band,
      factor_breakdown: JSON.parse(s.factor_breakdown),
      credit_limit_at_snapshot: paisaToSim(s.credit_limit_at_snapshot),
      reason: s.reason,
      created_at: s.created_at,
    })),
    meta: { page, limit, total },
  });
});

// POST /api/v1/borrowers/:id/manual-adjust
router.post('/:id/manual-adjust', auth, idempotency, async (req: Request, res: Response) => {
  if (req.user!.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only admins can perform manual adjustments');
  }

  const body = manualAdjustSchema.parse(req.body);

  const borrower = db
    .prepare('SELECT * FROM borrowers WHERE id = ?')
    .get(req.params.id) as (Record<string, unknown> & {
      id: string; current_score: number; current_band: string; credit_limit: number;
    }) | undefined;
  if (!borrower) throw new AppError(404, 'NOT_FOUND', 'Borrower not found');

  const newCreditLimit = simToPaisa(body.new_credit_limit);
  const { band } = assignBand(body.new_score);
  const ts = now();
  const adjustmentId = uuidv4();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO manual_adjustments
         (id, borrower_id, admin_user_id, previous_score, new_score,
          previous_limit, new_limit, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      adjustmentId, borrower.id, req.user!.id,
      borrower.current_score, body.new_score,
      borrower.credit_limit, newCreditLimit,
      body.reason, ts
    );

    db.prepare(
      `UPDATE borrowers
       SET current_score = ?, current_band = ?, credit_limit = ?, last_scored_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(body.new_score, band, newCreditLimit, ts, ts, borrower.id);

    db.prepare(
      `INSERT INTO score_snapshots
         (id, borrower_id, score, band, factor_breakdown, credit_limit_at_snapshot, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv4(), borrower.id, body.new_score, band,
      JSON.stringify({ manual: true }), newCreditLimit, 'manual_adjustment', ts
    );
  })();

  await logAuditEvent({ event: 'manual_adjustment', borrower_id: borrower.id, admin_id: req.user!.id });

  return res.json({
    success: true,
    data: {
      adjustment_id: adjustmentId,
      previous_score: borrower.current_score,
      new_score: body.new_score,
      previous_limit: paisaToSim(borrower.credit_limit),
      new_limit: body.new_credit_limit,
      applied_at: ts,
    },
  });
});

function formatBorrower(b: Record<string, unknown>) {
  return {
    id: b.id,
    employee_id: b.employee_id,
    current_score: b.current_score,
    current_band: b.current_band,
    credit_limit: paisaToSim(b.credit_limit as number),
    available_limit: paisaToSim(b.available_limit as number),
    kyc_status: b.kyc_status,
    last_scored_at: b.last_scored_at,
  };
}

export default router;
