import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { logger } from '../config';
import { Loan, EmiSchedule } from '../types';

interface DpdInfo {
  days: number;
  bucket: string;
  emiCount: number;
  principal: number;
  interest: number;
  penalty: number;
}

// ─── DPD Computation (BUG RG-016) ─────────────────────────────────────────────

export function computeDpdForLoan(loan: Loan, today: Date): DpdInfo {
  const oldestUnpaid = db.prepare(`
    SELECT * FROM emi_schedules
    WHERE loan_id = ? AND status IN ('scheduled', 'overdue', 'partial')
    ORDER BY due_date ASC
    LIMIT 1
  `).get(loan.id) as EmiSchedule | undefined;

  if (!oldestUnpaid) {
    return { days: 0, bucket: 'current', emiCount: 0, principal: 0, interest: 0, penalty: 0 };
  }

  // BUG RG-016: DPD computation uses naive Date arithmetic without timezone awareness.
  // Both `today` and `oldestUnpaid.due_date` get converted to JS Date objects.
  // JS Date.parse('2025-04-15') interprets as UTC midnight (00:00:00 UTC),
  // but the actual "end of day" for IST users is 18:30 UTC the SAME calendar day.
  // When the worker runs at e.g. 19:00 UTC (= midnight IST the next day),
  // the difference is under-counted by ~5.5 hours → daysPastDue = N-1 instead of N.
  // The 90-day NPA threshold is hit a full day late.
  const dueDate = new Date(oldestUnpaid.due_date);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysPastDue = Math.floor((today.getTime() - dueDate.getTime()) / msPerDay);

  // BUG RG-019: Bucket boundaries overlap on days 30, 60, 90.
  // This is an if-else chain, so DPD=30 hits the FIRST matching branch ('1-30').
  // However the queue endpoint uses BETWEEN [30, 60] for '31-60', so a loan stored
  // in bucket '1-30' at DPD=30 also appears in the '31-60' queue → same loan in two buckets.
  let bucket: string;
  if (daysPastDue <= 0) bucket = 'current';
  else if (daysPastDue >= 1 && daysPastDue <= 30) bucket = '1-30';
  else if (daysPastDue >= 30 && daysPastDue <= 60) bucket = '31-60'; // BUG RG-019: overlap at 30
  else if (daysPastDue >= 60 && daysPastDue <= 90) bucket = '61-90'; // BUG RG-019: overlap at 60
  else bucket = '90+';

  // Sum overdue amounts across all unpaid EMIs that are already due
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

// ─── Escalation Logic ─────────────────────────────────────────────────────────

function triggerEscalations(loan: Loan, dpdInfo: DpdInfo): void {
  const thresholds = [
    { dpd: 1,  action: 'reminder_sent' },
    { dpd: 30, action: 'warning_sent' },
    { dpd: 60, action: 'recovery_notice_sent' },
    { dpd: 90, action: 'npa_flagged' },
  ] as const;

  for (const t of thresholds) {
    if (dpdInfo.days >= t.dpd) {
      const existing = db.prepare(`
        SELECT 1 FROM collections_actions
        WHERE loan_id = ? AND action_type = ?
      `).get(loan.id, t.action);

      if (!existing) {
        db.prepare(`
          INSERT INTO collections_actions (id, loan_id, action_type, trigger_dpd)
          VALUES (?, ?, ?, ?)
        `).run(uuidv4(), loan.id, t.action, dpdInfo.days);

        if (t.action === 'npa_flagged' && loan.status !== 'defaulted') {
          db.prepare(
            `UPDATE loans SET status='defaulted', updated_at=datetime('now') WHERE id=?`
          ).run(loan.id);
        }
      }
    }
  }
}

// ─── DPD Cycle Runner ─────────────────────────────────────────────────────────

export async function runDpdCycle(): Promise<{ processed: number }> {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const loans = db.prepare(`
    SELECT * FROM loans
    WHERE status IN ('active', 'defaulted', 'restructured')
  `).all() as Loan[];

  let processed = 0;

  for (const loan of loans) {
    try {
      const dpdInfo = computeDpdForLoan(loan, today);

      db.prepare(`
        INSERT INTO dpd_records
          (id, loan_id, as_of_date, days_past_due, overdue_emi_count,
           overdue_principal, overdue_interest, overdue_penalty, bucket)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(loan_id, as_of_date) DO UPDATE SET
          days_past_due = excluded.days_past_due,
          overdue_emi_count = excluded.overdue_emi_count,
          overdue_principal = excluded.overdue_principal,
          overdue_interest = excluded.overdue_interest,
          overdue_penalty = excluded.overdue_penalty,
          bucket = excluded.bucket
      `).run(
        uuidv4(), loan.id, todayStr,
        dpdInfo.days, dpdInfo.emiCount,
        dpdInfo.principal, dpdInfo.interest, dpdInfo.penalty,
        dpdInfo.bucket
      );

      triggerEscalations(loan, dpdInfo);
      processed++;
    } catch (err) {
      logger.error({ loanId: loan.id, err }, 'DPD tracker failed for loan');
    }
  }

  return { processed };
}

if (require.main === module) {
  runDpdCycle()
    .then(({ processed }) => {
      console.log(`DPD cycle complete. Processed: ${processed}`);
      process.exit(0);
    })
    .catch(err => {
      console.error('DPD cycle error:', err);
      process.exit(1);
    });
}
