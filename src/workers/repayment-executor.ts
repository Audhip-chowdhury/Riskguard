import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { transferFromPayFlow } from '../services/payflow.service';
import { paisaToSim } from '../utils/currency';
import { now } from '../utils/date';
import { config, logger } from '../config';

export async function executeRepaymentCycle(): Promise<{ processed: number; failed: number }> {
  // BUG RG-012: Worker reads all due EMIs once at the start of the cycle.
  // If a borrower makes a manual repayment between this SELECT and the PayFlow debit below,
  // emi.status was 'scheduled' in our snapshot but is now 'paid' in the DB.
  // The worker still proceeds with the PayFlow transfer → double charge.
  const dueEmis = db
    .prepare(
      `SELECT es.*, l.borrower_id as loan_borrower_id
       FROM emi_schedules es
       JOIN loans l ON l.id = es.loan_id
       WHERE es.due_date <= date('now')
         AND es.status IN ('scheduled', 'overdue')`
    )
    .all() as Array<{
      id: string;
      loan_id: string;
      installment_number: number;
      emi_amount: number;
      due_date: string;
      loan_borrower_id: string;
    }>;

  let processed = 0;
  let failed = 0;

  for (const emi of dueEmis) {
    try {
      // BUG RG-012: No re-check of EMI status here before debiting.
      // Correct code would add:
      //   const fresh = db.prepare('SELECT status FROM emi_schedules WHERE id=?').get(emi.id);
      //   if (fresh.status === 'paid') continue;

      const borrower = db
        .prepare('SELECT * FROM borrowers WHERE id = ?')
        .get(emi.loan_borrower_id) as { id: string; employee_id: string };
      const employee = db
        .prepare('SELECT * FROM employees WHERE id = ?')
        .get(borrower.employee_id) as { payflow_wallet_id: string };

      const today = new Date();
      const dueDate = new Date(emi.due_date);
      const msPerDay = 1000 * 60 * 60 * 24;
      const daysPastDue = Math.floor((today.getTime() - dueDate.getTime()) / msPerDay);

      // BUG RG-014: Grace period boundary off by one day.
      // Correct: lateFee applies when daysPastDue > 5 (day 6+, giving a full 5-day grace period).
      // Bug: lateFee branch fires when daysPastDue >= 5 (day 5+, only 4 days of grace).
      // Effect on day 5: daysAfterGrace = 0 so lateFee = 0, but the branch fires —
      // any code that treats entering this branch as "overdue" activates prematurely.
      let lateFee = 0;
      if (daysPastDue >= 5) { // BUG RG-014: should be > 5
        const daysAfterGrace = daysPastDue - 5;
        lateFee = Math.min(
          Math.round(emi.emi_amount * 0.02 * daysAfterGrace),
          emi.emi_amount
        );
      }

      const totalDebit = emi.emi_amount + lateFee;

      const txnResult = await transferFromPayFlow({
        fromWalletId: employee.payflow_wallet_id,
        toWalletId: config.lendingWalletId,
        amount: paisaToSim(totalDebit),
        description: `EMI #${emi.installment_number} for loan ${emi.loan_id}`,
        idempotencyKey: `emi-debit-${emi.id}`,
      });

      const completedAt = now();
      const r = txnResult as Record<string, unknown>;
      const txnId =
        ((r?.data as Record<string, unknown>)?.transaction_id as string) ??
        (r?.transaction_id as string) ??
        'unknown';

      db.prepare(
        `UPDATE emi_schedules SET status='paid', paid_amount=?, paid_at=datetime('now'), late_penalty=? WHERE id=?`
      ).run(totalDebit, lateFee, emi.id);

      const repaymentId = uuidv4();
      db.prepare(
        `INSERT INTO repayments
           (id, loan_id, emi_schedule_id, type, amount, late_penalty_paid,
            payflow_transaction_id, status, initiated_at, completed_at)
         VALUES (?, ?, ?, 'auto_emi', ?, ?, ?, 'completed', ?, ?)`
      ).run(repaymentId, emi.loan_id, emi.id, totalDebit, lateFee, txnId, completedAt, completedAt);

      processed++;
    } catch (err) {
      logger.error({ emiId: emi.id, err }, 'Worker failed to process EMI');
      db.prepare(`UPDATE emi_schedules SET status='overdue' WHERE id=?`).run(emi.id);
      failed++;
    }
  }

  return { processed, failed };
}

if (require.main === module) {
  executeRepaymentCycle()
    .then(({ processed, failed }) => {
      console.log(`Repayment cycle complete. Processed: ${processed}, Failed: ${failed}`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Repayment cycle error:', err);
      process.exit(1);
    });
}
