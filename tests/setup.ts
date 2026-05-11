import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { beforeAll } from 'vitest';
import { runMigrations } from '../src/migrate';
import db from '../src/db';

// DATABASE_PATH is set to ./data/riskguard-test.db via vitest.config.ts env

function generateApiKey() {
  return `rgk_${crypto.randomBytes(24).toString('hex')}`;
}

export const testApiKeys: Record<string, string> = {};
export const testUserIds: Record<string, string> = {};
export const testEmployeeIds: Record<string, string> = {};

beforeAll(() => {
  // Wipe and re-create schema (Phase 2 tables listed before Phase 1 to respect FK order)
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    DROP TABLE IF EXISTS ecl_projections;
    DROP TABLE IF EXISTS pd_lookup;
    DROP TABLE IF EXISTS risk_thresholds;
    DROP TABLE IF EXISTS portfolio_snapshots;
    DROP TABLE IF EXISTS recoveries;
    DROP TABLE IF EXISTS write_offs;
    DROP TABLE IF EXISTS restructurings;
    DROP TABLE IF EXISTS collections_assignments;
    DROP TABLE IF EXISTS collections_actions;
    DROP TABLE IF EXISTS dpd_records;
    DROP TABLE IF EXISTS prepayments;
    DROP TABLE IF EXISTS repayments;
    DROP TABLE IF EXISTS emi_schedules;
    DROP TABLE IF EXISTS disbursements;
    DROP TABLE IF EXISTS appeals;
    DROP TABLE IF EXISTS underwriting_decisions;
    DROP TABLE IF EXISTS loans;
    DROP TABLE IF EXISTS loan_applications;
    DROP TABLE IF EXISTS interest_rate_config;
    DROP TABLE IF EXISTS score_snapshots;
    DROP TABLE IF EXISTS manual_adjustments;
    DROP TABLE IF EXISTS borrowers;
    DROP TABLE IF EXISTS employees;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS scoring_factors;
    DROP TABLE IF EXISTS idempotency_store;
    DROP TABLE IF EXISTS _migrations;
  `);
  db.exec('PRAGMA foreign_keys = ON');

  runMigrations();

  const users = [
    { username: 'alice',   role: 'admin',              department: 'Finance',     designation: 'CFO',                salary: 50000000,  tenure_years: 8,   risk_tier: 1 },
    { username: 'bob',     role: 'senior_underwriter', department: 'Risk',        designation: 'Head of Risk',       salary: 35000000,  tenure_years: 5,   risk_tier: 1 },
    { username: 'charlie', role: 'underwriter',        department: 'Risk',        designation: 'Underwriter',        salary: 18000000,  tenure_years: 3,   risk_tier: 2 },
    // diana: second senior_underwriter for committee second-approval tests
    { username: 'diana',   role: 'senior_underwriter', department: 'Risk',        designation: 'Senior Underwriter', salary: 28000000,  tenure_years: 6,   risk_tier: 1 },
    // frank: employee whose manager will be charlie (for RG-006 conflict-of-interest test)
    { username: 'frank',   role: 'employee',           department: 'Engineering', designation: 'Senior Engineer',    salary: 22000000,  tenure_years: 3,   risk_tier: 3 },
    { username: 'iris',    role: 'employee',           department: 'Sales',       designation: 'Sales Rep',          salary: 8000000,   tenure_years: 0.3, risk_tier: 5 },
    { username: 'jack',    role: 'employee',           department: 'Engineering', designation: 'Engineer',           salary: 0,         tenure_years: 0.1, risk_tier: 3 },
    // evan: second plain underwriter (for committee second-approval rejection test)
    { username: 'evan',    role: 'underwriter',        department: 'Risk',        designation: 'Junior Underwriter', salary: 15000000,  tenure_years: 2,   risk_tier: 2 },
    // grace: high-salary employee for committee-review amount tests
    { username: 'grace',   role: 'employee',           department: 'Executive',   designation: 'VP Engineering',    salary: 100000000, tenure_years: 10,  risk_tier: 1 },
  ];

  // Insert all users (manager_user_id set later)
  for (const u of users) {
    const userId = uuidv4();
    const apiKey = generateApiKey();
    const ts = new Date().toISOString();
    testUserIds[u.username] = userId;
    testApiKeys[u.username] = apiKey;

    db.prepare(
      `INSERT INTO users (id, username, email, api_key, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(userId, u.username, `${u.username}@metropay.io`, apiKey, u.role, ts, ts);

    const employeeId = uuidv4();
    testEmployeeIds[u.username] = employeeId;
    const joinedAt = new Date(Date.now() - u.tenure_years * 365.25 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(
      `INSERT INTO employees
         (id, user_id, payflow_wallet_id, department, designation, department_risk_tier,
          monthly_salary, joined_at, manager_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(employeeId, userId, uuidv4(), u.department, u.designation, u.risk_tier, u.salary, joinedAt, null, ts);
  }

  // Set frank's manager to charlie (for BUG RG-006 conflict-of-interest test)
  db.prepare(
    `UPDATE employees SET manager_user_id = ? WHERE id = ?`
  ).run(testUserIds['charlie'], testEmployeeIds['frank']);
});
