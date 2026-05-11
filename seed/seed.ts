import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

// Must set DATABASE_PATH before importing db
import db from '../src/db';
import { runMigrations } from '../src/migrate';

runMigrations();

interface SeedUser {
  username: string;
  email: string;
  role: string;
  department: string;
  designation: string;
  salary: number;       // paise
  tenure_years: number;
  risk_tier: number;
  manager?: string;     // username of manager
}

const seedUsers: SeedUser[] = [
  { username: 'alice',   email: 'alice@metropay.io',   role: 'admin',               department: 'Finance',     designation: 'CFO',                          salary: 50000000, tenure_years: 8,   risk_tier: 1 },
  { username: 'bob',     email: 'bob@metropay.io',     role: 'senior_underwriter',  department: 'Risk',        designation: 'Head of Risk',                 salary: 35000000, tenure_years: 5,   risk_tier: 1 },
  { username: 'charlie', email: 'charlie@metropay.io', role: 'underwriter',         department: 'Risk',        designation: 'Underwriter',                  salary: 18000000, tenure_years: 3,   risk_tier: 2, manager: 'bob' },
  { username: 'diana',   email: 'diana@metropay.io',   role: 'underwriter',         department: 'Risk',        designation: 'Underwriter',                  salary: 17000000, tenure_years: 2,   risk_tier: 2, manager: 'bob' },
  { username: 'eve',     email: 'eve@metropay.io',     role: 'collections_agent',   department: 'Collections', designation: 'Senior Collections Agent',     salary: 12000000, tenure_years: 4,   risk_tier: 3 },
  { username: 'frank',   email: 'frank@metropay.io',   role: 'employee',            department: 'Engineering', designation: 'Senior Engineer',              salary: 22000000, tenure_years: 3,   risk_tier: 3 },
  { username: 'grace',   email: 'grace@metropay.io',   role: 'employee',            department: 'Engineering', designation: 'Engineer',                     salary: 14000000, tenure_years: 1,   risk_tier: 3 },
  { username: 'henry',   email: 'henry@metropay.io',   role: 'employee',            department: 'Marketing',   designation: 'Marketing Manager',            salary: 16000000, tenure_years: 2,   risk_tier: 4 },
  { username: 'iris',    email: 'iris@metropay.io',    role: 'employee',            department: 'Sales',       designation: 'Sales Rep',                    salary: 8000000,  tenure_years: 0.3, risk_tier: 5 },
  { username: 'jack',    email: 'jack@metropay.io',    role: 'employee',            department: 'Engineering', designation: 'Engineer',                     salary: 0,        tenure_years: 0.1, risk_tier: 3 },
];

const generateApiKey = () => `rgk_${crypto.randomBytes(24).toString('hex')}`;

// Wipe existing seed data
db.exec('DELETE FROM employees');
db.exec('DELETE FROM users');

const userIds: Record<string, string> = {};
const apiKeys: Record<string, string> = {};

// Insert users
for (const u of seedUsers) {
  const userId = uuidv4();
  const apiKey = generateApiKey();
  userIds[u.username] = userId;
  apiKeys[u.username] = apiKey;

  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, email, api_key, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(userId, u.username, u.email, apiKey, u.role, ts, ts);
}

// Insert employees
for (const u of seedUsers) {
  const employeeId = uuidv4();
  const walletId = uuidv4(); // fake PayFlow wallet ID for Phase 1
  const joinedAt = new Date(Date.now() - u.tenure_years * 365.25 * 24 * 60 * 60 * 1000).toISOString();
  const managerId = u.manager ? userIds[u.manager] : null;

  db.prepare(
    `INSERT INTO employees
       (id, user_id, payflow_wallet_id, department, designation, department_risk_tier,
        monthly_salary, joined_at, manager_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    employeeId, userIds[u.username], walletId,
    u.department, u.designation, u.risk_tier,
    u.salary, joinedAt, managerId, new Date().toISOString()
  );
}

console.log('\n=== RiskGuard Seed Complete ===');
console.log('\nAPI Keys:');
for (const [username, apiKey] of Object.entries(apiKeys)) {
  console.log(`  ${username.padEnd(10)}: ${apiKey}`);
}
console.log('\nNote: Use X-API-Key header with these values to authenticate.\n');
