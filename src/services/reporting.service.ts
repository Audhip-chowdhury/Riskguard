import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { AppError } from '../middleware/error-handler';
import { paisaToSim } from '../utils/currency';

// ─── NPA Ratio — BUG RG-021 ──────────────────────────────────────────────────

function computeNpaRatio(asOfDate: string): { npaAmount: number; ratioBps: number } {
  // BUG RG-021: Numerator includes written_off loans (missing AND l.status != 'written_off')
  // dpd_records keeps snapshotting written_off loans until cleanup
  // → NPA ratio is artificially inflated
  const npaResult = db.prepare(`
    SELECT COALESCE(SUM(dpd.overdue_principal + dpd.overdue_interest), 0) as npa
    FROM dpd_records dpd
    JOIN loans l ON l.id = dpd.loan_id
    WHERE dpd.bucket = '90+'
      AND dpd.as_of_date = ?
  `).get(asOfDate) as { npa: number };

  // Denominator correctly excludes written_off — but numerator above does not
  const totalResult = db.prepare(`
    SELECT COALESCE(SUM(l.principal_amount), 0) as total
    FROM loans l
    WHERE l.status = 'active'
  `).get() as { total: number };

  const ratioBps = totalResult.total > 0
    ? Math.round((npaResult.npa / totalResult.total) * 10000)
    : 0;

  return { npaAmount: npaResult.npa, ratioBps };
}

// ─── Collection Efficiency — BUG RG-023 ──────────────────────────────────────

function computeCollectionEfficiency(
  periodStart: string,
  periodEnd: string,
): { dueAmount: number; collectedAmount: number; efficiencyBps: number } {
  const dueResult = db.prepare(`
    SELECT COALESCE(SUM(emi_amount), 0) as due
    FROM emi_schedules
    WHERE due_date >= ? AND due_date <= ?
      AND status IN ('paid', 'partial', 'overdue', 'scheduled')
  `).get(periodStart, periodEnd) as { due: number };

  // BUG RG-023: Includes 'partial_prepayment' and 'full_prepayment' repayment types.
  // Should add: AND type = 'emi_payment'
  // Prepayments inflate efficiency above 100%, breaking dashboards that assume 0-100%.
  const collectedResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as collected
    FROM repayments
    WHERE completed_at >= ? AND completed_at <= ?
      AND status = 'completed'
  `).get(periodStart, periodEnd) as { collected: number };

  const efficiencyBps = dueResult.due > 0
    ? Math.round((collectedResult.collected / dueResult.due) * 10000)
    : 0;

  return {
    dueAmount: dueResult.due,
    collectedAmount: collectedResult.collected,
    efficiencyBps,
  };
}

// ─── Portfolio Dashboard ──────────────────────────────────────────────────────

export function getPortfolioDashboard(asOfDate: string, compareWith?: string) {
  const periodStart = asOfDate.slice(0, 7) + '-01';

  const totalOutstanding = (db.prepare(`
    SELECT COALESCE(SUM(l.principal_amount), 0) as total
    FROM loans l WHERE l.status = 'active'
  `).get() as { total: number }).total;

  const activeCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM loans WHERE status = 'active'
  `).get() as { cnt: number }).cnt;

  const totalDisbursed = (db.prepare(`
    SELECT COALESCE(SUM(net_disbursed_amount), 0) as total
    FROM disbursements WHERE status = 'completed'
  `).get() as { total: number }).total;

  const totalCollected = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM repayments WHERE status = 'completed'
  `).get() as { total: number }).total;

  const writtenOff = (db.prepare(`
    SELECT COALESCE(SUM(outstanding_at_write_off), 0) as total FROM write_offs
  `).get() as { total: number }).total;

  const { npaAmount, ratioBps } = computeNpaRatio(asOfDate);
  const { efficiencyBps } = computeCollectionEfficiency(periodStart, asOfDate);

  const avgDpdRow = db.prepare(`
    SELECT COALESCE(CAST(ROUND(AVG(dpd.days_past_due)) AS INTEGER), 0) as avg_dpd
    FROM dpd_records dpd
    JOIN loans l ON l.id = dpd.loan_id
    WHERE dpd.as_of_date = ? AND l.status = 'active'
  `).get(asOfDate) as { avg_dpd: number };

  const byProduct = (db.prepare(`
    SELECT
      l.product_type as product,
      COUNT(*) as count,
      COALESCE(SUM(l.principal_amount), 0) as outstanding
    FROM loans l
    WHERE l.status = 'active'
    GROUP BY l.product_type
    ORDER BY outstanding DESC
  `).all() as { product: string; count: number; outstanding: number }[]).map(r => ({
    product: r.product,
    outstanding: paisaToSim(r.outstanding),
    count: r.count,
  }));

  const byBand = (db.prepare(`
    SELECT
      b.current_band as band,
      COUNT(*) as count,
      COALESCE(SUM(l.principal_amount), 0) as outstanding
    FROM loans l
    JOIN borrowers b ON b.id = l.borrower_id
    WHERE l.status = 'active'
    GROUP BY b.current_band
    ORDER BY outstanding DESC
  `).all() as { band: string; count: number; outstanding: number }[]).map(r => ({
    band: r.band,
    outstanding: paisaToSim(r.outstanding),
    count: r.count,
  }));

  let comparedWith = null;
  if (compareWith) {
    const cwPeriodStart = compareWith.slice(0, 7) + '-01';
    const cwNpa = computeNpaRatio(compareWith);
    const cwEff = computeCollectionEfficiency(cwPeriodStart, compareWith);
    comparedWith = {
      as_of_date: compareWith,
      npa_amount: paisaToSim(cwNpa.npaAmount),
      npa_ratio: (cwNpa.ratioBps / 100).toFixed(2),
      collection_efficiency: (cwEff.efficiencyBps / 100).toFixed(2),
    };
  }

  return {
    as_of_date: asOfDate,
    summary: {
      total_outstanding: paisaToSim(totalOutstanding),
      active_loans_count: activeCount,
      total_disbursed_to_date: paisaToSim(totalDisbursed),
      total_collected_to_date: paisaToSim(totalCollected),
      written_off_amount: paisaToSim(writtenOff),
    },
    risk_metrics: {
      npa_amount: paisaToSim(npaAmount),
      npa_ratio: (ratioBps / 100).toFixed(2),
      collection_efficiency: (efficiencyBps / 100).toFixed(2),
      avg_dpd_active: avgDpdRow.avg_dpd,
    },
    by_product: byProduct,
    by_band: byBand,
    compared_with: comparedWith,
  };
}

// ─── Aging Report — BUG RG-024 ───────────────────────────────────────────────

export function getAgingReport(asOfDate: string) {
  // Bucket outstanding: overdue amounts from dpd_records (no loan status filter)
  const bucketResults = (db.prepare(`
    SELECT
      dpd.bucket,
      COUNT(DISTINCT l.id) as loan_count,
      COALESCE(SUM(dpd.overdue_principal + dpd.overdue_interest), 0) as outstanding
    FROM dpd_records dpd
    JOIN loans l ON l.id = dpd.loan_id
    WHERE dpd.as_of_date = ?
    GROUP BY dpd.bucket
  `).all(asOfDate) as { bucket: string; loan_count: number; outstanding: number }[]).map(r => ({
    bucket: r.bucket,
    loan_count: r.loan_count,
    outstanding: paisaToSim(r.outstanding),
  }));

  // BUG RG-024: Total uses principal_amount (different metric than overdue amounts above)
  // Plus excludes restructured loans while bucket query includes them via dpd_records
  // → sum of bucket oustandings ≠ total_outstanding
  const totalResult = db.prepare(`
    SELECT COALESCE(SUM(l.principal_amount), 0) as total
    FROM loans l
    WHERE l.status NOT IN ('written_off', 'closed', 'prepaid', 'restructured')
  `).get() as { total: number };

  return {
    as_of_date: asOfDate,
    buckets: bucketResults,
    total_outstanding: paisaToSim(totalResult.total),
  };
}

// ─── Vintage Report — BUG RG-022 ─────────────────────────────────────────────

export function getVintageReport(periodMonths: number) {
  // BUG RG-022: Groups by created_at instead of disbursed_at.
  // Applications → underwriting → committee → disbursement can take 7-14 days.
  // A loan applied Jan 30, disbursed Feb 3 is bucketed in January (wrong).
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', l.created_at) as vintage_month,
      COUNT(*) as loans_originated,
      COALESCE(SUM(l.principal_amount), 0) as total_disbursed,
      SUM(CASE WHEN l.status = 'defaulted' THEN 1 ELSE 0 END) as defaulted_count,
      SUM(CASE WHEN l.status = 'written_off' THEN 1 ELSE 0 END) as written_off_count,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM dpd_records dpd
        WHERE dpd.loan_id = l.id
          AND dpd.as_of_date = date('now')
          AND dpd.days_past_due > 0
      ) THEN 1 ELSE 0 END) as currently_overdue_count
    FROM loans l
    LEFT JOIN disbursements d ON d.loan_id = l.id
    WHERE l.created_at >= date('now', ?)
    GROUP BY vintage_month
    ORDER BY vintage_month DESC
  `).all(`-${periodMonths} months`) as {
    vintage_month: string;
    loans_originated: number;
    total_disbursed: number;
    defaulted_count: number;
    written_off_count: number;
    currently_overdue_count: number;
  }[];

  const vintages = rows.map(r => ({
    vintage_month: r.vintage_month,
    loans_originated: r.loans_originated,
    total_disbursed: paisaToSim(r.total_disbursed),
    defaulted_count: r.defaulted_count,
    written_off_count: r.written_off_count,
    currently_overdue_count: r.currently_overdue_count,
    default_rate_bps: r.loans_originated > 0
      ? Math.round((r.defaulted_count / r.loans_originated) * 10000)
      : 0,
    loss_rate_bps: r.loans_originated > 0
      ? Math.round((r.written_off_count / r.loans_originated) * 10000)
      : 0,
  }));

  return { vintages };
}

// ─── Concentration Risk ───────────────────────────────────────────────────────

const VALID_CUTS = ['department', 'product_type', 'score_band', 'amount_band'] as const;
type ConcentrationCut = (typeof VALID_CUTS)[number];

export function getConcentrationReport(cut: string) {
  if (!VALID_CUTS.includes(cut as ConcentrationCut)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Invalid cut. Must be one of: ${VALID_CUTS.join(', ')}`,
    );
  }

  let rows: { key: string; outstanding: number; loan_count: number }[];

  if (cut === 'department') {
    rows = db.prepare(`
      SELECT
        e.department as key,
        COUNT(l.id) as loan_count,
        COALESCE(SUM(l.principal_amount), 0) as outstanding
      FROM loans l
      JOIN borrowers b ON b.id = l.borrower_id
      JOIN employees e ON e.id = b.employee_id
      WHERE l.status = 'active'
      GROUP BY e.department
      ORDER BY outstanding DESC
    `).all() as { key: string; outstanding: number; loan_count: number }[];
  } else if (cut === 'product_type') {
    rows = db.prepare(`
      SELECT
        l.product_type as key,
        COUNT(l.id) as loan_count,
        COALESCE(SUM(l.principal_amount), 0) as outstanding
      FROM loans l
      WHERE l.status = 'active'
      GROUP BY l.product_type
      ORDER BY outstanding DESC
    `).all() as { key: string; outstanding: number; loan_count: number }[];
  } else if (cut === 'score_band') {
    rows = db.prepare(`
      SELECT
        b.current_band as key,
        COUNT(l.id) as loan_count,
        COALESCE(SUM(l.principal_amount), 0) as outstanding
      FROM loans l
      JOIN borrowers b ON b.id = l.borrower_id
      WHERE l.status = 'active'
      GROUP BY b.current_band
      ORDER BY outstanding DESC
    `).all() as { key: string; outstanding: number; loan_count: number }[];
  } else {
    // amount_band: in paise — 1 SIM = 100 paise
    rows = db.prepare(`
      SELECT
        CASE
          WHEN l.principal_amount < 1000000  THEN 'under_10k'
          WHEN l.principal_amount < 5000000  THEN '10k_to_50k'
          WHEN l.principal_amount < 10000000 THEN '50k_to_100k'
          ELSE 'over_100k'
        END as key,
        COUNT(l.id) as loan_count,
        COALESCE(SUM(l.principal_amount), 0) as outstanding
      FROM loans l
      WHERE l.status = 'active'
      GROUP BY key
      ORDER BY outstanding DESC
    `).all() as { key: string; outstanding: number; loan_count: number }[];
  }

  const totalOutstanding = rows.reduce((sum, r) => sum + r.outstanding, 0);

  const groups = rows.map(r => ({
    key: r.key,
    outstanding: paisaToSim(r.outstanding),
    loan_count: r.loan_count,
    percentage_of_portfolio: totalOutstanding > 0
      ? Math.round((r.outstanding / totalOutstanding) * 1000) / 10
      : 0,
  }));

  // Herfindahl-Hirschman Index: sum of squared market shares (0-10000 scale)
  const hhi = totalOutstanding > 0
    ? Math.round(
        rows.reduce((sum, r) => {
          const sharePct = (r.outstanding / totalOutstanding) * 100;
          return sum + sharePct * sharePct;
        }, 0),
      )
    : 0;

  return { cut, groups, herfindahl_index: hhi };
}

// ─── ECL — BUG RG-025 ────────────────────────────────────────────────────────

export function computeEcl(asOfDate: string) {
  const exposures = db.prepare(`
    SELECT
      b.current_band as score_band,
      COALESCE(SUM(l.principal_amount), 0) as ead
    FROM loans l
    JOIN borrowers b ON b.id = l.borrower_id
    WHERE l.status = 'active'
    GROUP BY b.current_band
  `).all() as { score_band: string; ead: number }[];

  let totalEcl = 0;
  const breakdown: Array<{
    score_band: string;
    ead: number;
    pd: number;
    lgd: number;
    ecl: number;
  }> = [];

  for (const exp of exposures) {
    // BUG RG-025: pd_lookup stores 'GOOD', 'FAIR', etc. (UPPERCASE from migration 005)
    // but exp.score_band is 'Good', 'Fair', etc. (mixed case from borrowers.current_band)
    // SQLite default string comparison is case-sensitive → no match → pdConfig = undefined
    // → pd defaults to 0 → ECL = 0 for all bands
    const pdConfig = db.prepare(`
      SELECT pd_12_months_bps, lgd_bps
      FROM pd_lookup
      WHERE score_band = ?
    `).get(exp.score_band) as { pd_12_months_bps: number; lgd_bps: number } | undefined;

    const pd = pdConfig?.pd_12_months_bps ?? 0;
    const lgd = pdConfig?.lgd_bps ?? 4500;

    const ecl = Math.round((exp.ead * pd * lgd) / (10000 * 10000));

    totalEcl += ecl;
    breakdown.push({ score_band: exp.score_band, ead: exp.ead, pd, lgd, ecl });
  }

  // Persist projection (skip if already saved for this date+band)
  for (const entry of breakdown) {
    const exists = db.prepare(
      'SELECT 1 FROM ecl_projections WHERE as_of_date = ? AND score_band = ?',
    ).get(asOfDate, entry.score_band);
    if (!exists) {
      db.prepare(`
        INSERT INTO ecl_projections
          (id, as_of_date, score_band, exposure_at_default,
           probability_of_default_bps, loss_given_default_bps, expected_credit_loss)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), asOfDate, entry.score_band,
        entry.ead, entry.pd, entry.lgd, entry.ecl,
      );
    }
  }

  return {
    as_of_date: asOfDate,
    total_expected_credit_loss: paisaToSim(totalEcl),
    breakdown: breakdown.map(e => ({
      score_band: e.score_band,
      exposure_at_default: paisaToSim(e.ead),
      probability_of_default_bps: e.pd,
      loss_given_default_bps: e.lgd,
      expected_credit_loss: paisaToSim(e.ecl),
    })),
  };
}
