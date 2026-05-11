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
  // Wipe and re-create schema
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
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
    { username: 'alice',   role: 'admin',              department: 'Finance',     designation: 'CFO',              salary: 50000000, tenure_years: 8,   risk_tier: 1 },
    { username: 'bob',     role: 'senior_underwriter', department: 'Risk',        designation: 'Head of Risk',     salary: 35000000, tenure_years: 5,   risk_tier: 1 },
    { username: 'charlie', role: 'underwriter',        department: 'Risk',        designation: 'Underwriter',      salary: 18000000, tenure_years: 3,   risk_tier: 2 },
    { username: 'frank',   role: 'employee',           department: 'Engineering', designation: 'Senior Engineer',  salary: 22000000, tenure_years: 3,   risk_tier: 3 },
    { username: 'iris',    role: 'employee',           department: 'Sales',       designation: 'Sales Rep',        salary: 8000000,  tenure_years: 0.3, risk_tier: 5 },
    { username: 'jack',    role: 'employee',           department: 'Engineering', designation: 'Engineer',         salary: 0,        tenure_years: 0.1, risk_tier: 3 },
  ];

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
});
