const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

// CP-ABE Encryption Configuration
const MASTER_KEY = crypto.randomBytes(32); // In production, this should be safely stored
const ALGORITHM = 'aes-256-gcm';

// Generate encryption key for a patient
function generatePatientKey(patientId) {
  return crypto.scryptSync(`patient-${patientId}`, 'salt', 32);
}

// Encrypt assessment data with CP-ABE policy
function encryptAssessment(data, patientId, policy) {
  const key = generatePatientKey(patientId);
  const iv = crypto.randomBytes(12); // GCM recommends 12-byte IV
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  // Set AAD (Additional Authenticated Data) - the policy
  cipher.setAAD(Buffer.from(policy));

  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    encrypted: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    policy: policy
  };
}

// Decrypt assessment data if user attributes satisfy policy
function decryptAssessment(encryptedData, userAttributes) {
  try {
    const parsed = typeof encryptedData === 'string' ? JSON.parse(encryptedData) : encryptedData;
    const { encrypted, iv, authTag, policy } = parsed;

    // Check if user attributes satisfy the policy
    if (!checkPolicy(policy, userAttributes)) {
      throw new Error('Access denied: policy not satisfied');
    }

    const patientId = userAttributes.patientId;
    const key = generatePatientKey(patientId);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAAD(Buffer.from(policy));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  } catch (error) {
    throw new Error('Decryption failed or access denied: ' + error.message);
  }
}

// Check if user attributes satisfy the CP-ABE policy
function checkPolicy(policy, userAttributes) {
  const { role, userId, patientId } = userAttributes;

  // Policy: "role:doctor OR userId:{patientId}"
  // role: doctor can always access
  if (role === 'doctor') {
    return true;
  }

  // role: patient can only access if userId (requestingUser.id) == patientId
  // Convert both to string for comparison
  if (role === 'patient' && String(userId) === String(patientId)) {
    return true;
  }

  return false; // Admin blocked or policy not satisfied
}

function toPostgresQuery(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function run(sql, params = []) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Set it to your Neon Postgres connection string.');
  }

  let query = toPostgresQuery(sql);
  if (/^\s*insert\s+/i.test(query) && !/\breturning\b/i.test(query)) {
    query = query.replace(/;?\s*$/, ' RETURNING id');
  }

  const result = await pool.query(query, params);
  return {
    lastID: result.rows[0]?.id,
    changes: result.rowCount,
    rows: result.rows,
  };
}

async function get(sql, params = []) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Set it to your Neon Postgres connection string.');
  }

  const result = await pool.query(toPostgresQuery(sql), params);
  return result.rows[0];
}

async function getAll(sql, params = []) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Set it to your Neon Postgres connection string.');
  }

  const result = await pool.query(toPostgresQuery(sql), params);
  return result.rows;
}

async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    )
  `);

  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`);

  await run(`
    CREATE TABLE IF NOT EXISTS invites (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

await run(`
    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      patient_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      middle_name TEXT,
      last_name TEXT NOT NULL,
      suffix TEXT,
      email TEXT NOT NULL,
      mobile TEXT NOT NULL,
      date_of_birth TEXT NOT NULL,
      age INTEGER NOT NULL,
      sex TEXT NOT NULL,
      civil_status TEXT NOT NULL,
      address TEXT NOT NULL,
      address2 TEXT,
      philhealth_number TEXT,
      id_type TEXT,
      national_id_number TEXT,
      disability TEXT,
      security_question TEXT NOT NULL,
      security_answer TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS disability TEXT;`);
  await run(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS id_type TEXT;`);
  await run(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS address2 TEXT;`);
  await run(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS national_id_number TEXT;`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 1;`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires_at TEXT;`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TEXT;`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_forfeited_at TEXT;`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_notice_sent_at TEXT;`);
  await run(`ALTER TABLE patients ALTER COLUMN mobile DROP NOT NULL;`);

  await run(`
    CREATE TABLE IF NOT EXISTS login_otps (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS patient_assessments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      assessment_json TEXT NOT NULL,
      assessment_encrypted TEXT,
      policy TEXT NOT NULL DEFAULT 'role:doctor OR userId:{userId}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`ALTER TABLE patient_assessments ADD COLUMN IF NOT EXISTS assessment_encrypted TEXT;`);
  await run(`ALTER TABLE patient_assessments ADD COLUMN IF NOT EXISTS policy TEXT NOT NULL DEFAULT 'role:doctor OR userId:{userId}';`);

await run(`
    CREATE TABLE IF NOT EXISTS consultations (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      consultation_date TEXT,
      consultation_time TEXT,
      consultation_time_end TEXT,
      concerns TEXT NOT NULL,
      notes TEXT,
      diagnostic_result TEXT,
      prescription TEXT,
      result_updated_at TEXT,
      is_late INTEGER DEFAULT 0,
      missed_notified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (patient_id) REFERENCES users(id),
      FOREIGN KEY (doctor_id) REFERENCES users(id)
    )
  `);

  await run(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS is_late INTEGER DEFAULT 0;`);
  await run(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS consultation_time_end TEXT;`);
  await run(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS missed_notified_at TEXT;`);
  await run(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS diagnostic_result TEXT;`);
  await run(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS prescription TEXT;`);
  await run(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS result_updated_at TEXT;`);
  await run(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS consultation_source TEXT NOT NULL DEFAULT 'online';`);

  await run(`
    CREATE TABLE IF NOT EXISTS doctor_availability (
      id SERIAL PRIMARY KEY,
      doctor_id INTEGER NOT NULL,
      available_date TEXT NOT NULL,
      available_time_slots TEXT NOT NULL, -- JSON array of time slots
      created_at TEXT NOT NULL,
      FOREIGN KEY (doctor_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS doctor_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      license_number TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS staff_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      position TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      target_user_id INTEGER,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (target_user_id) REFERENCES users(id)
    )
  `);
  await dedupeDoctorAvailability();
  await run(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_user_id INTEGER;`);

  await run(`
    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (resolved_by) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS reschedule_requests (
      id SERIAL PRIMARY KEY,
      consultation_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      new_date TEXT NOT NULL,
      new_time TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      FOREIGN KEY (consultation_id) REFERENCES consultations(id),
      FOREIGN KEY (patient_id) REFERENCES users(id),
      FOREIGN KEY (doctor_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS message_board (
      id SERIAL PRIMARY KEY,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      consultation_id INTEGER,
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (from_user_id) REFERENCES users(id),
      FOREIGN KEY (to_user_id) REFERENCES users(id),
      FOREIGN KEY (consultation_id) REFERENCES consultations(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS patient_record_files (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL,
      uploaded_by INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_data TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (patient_id) REFERENCES users(id),
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      user_role TEXT,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      details TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
}

async function createUser({
  role,
  email,
  password,
  displayName,
  emailVerified = true,
  status = 'active',
  emailVerificationToken = null,
  emailVerificationExpiresAt = null,
}) {
  const passwordHash = await bcrypt.hash(password, 10);
  const createdAt = new Date().toISOString();
  const verifiedValue = emailVerified ? 1 : 0;
  const emailVerifiedAt = emailVerified ? createdAt : null;

  const result = await run(
    `INSERT INTO users (role, email, password_hash, display_name, status, email_verified, email_verification_token, email_verification_expires_at, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [role, email.toLowerCase(), passwordHash, displayName || null, status, verifiedValue, emailVerificationToken, emailVerificationExpiresAt, emailVerifiedAt, createdAt]
  );

  return {
    id: result.lastID,
    role,
    email: email.toLowerCase(),
    displayName: displayName || null,
    status,
    emailVerified: verifiedValue,
    emailVerificationToken,
    emailVerificationExpiresAt,
    emailVerifiedAt,
    createdAt,
  };
}

async function getUserByEmail(email) {
  const row = await get(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase()]);
  return row ? row : null;
}

async function validateCredentials(email, password) {
  const user = await getUserByEmail(email);
  if (!user) return null;
  if (user.status && user.status !== 'active') return null;
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;
  return user;
}

async function getUserById(id) {
  const row = await get(`SELECT * FROM users WHERE id = ?`, [id]);
  return row ? row : null;
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

async function createLoginOtp({ userId, email, otp, expiresAt }) {
  const createdAt = new Date().toISOString();
  await run(`UPDATE login_otps SET used = 1 WHERE user_id = ? AND used = 0`, [userId]);
  const result = await run(
    `INSERT INTO login_otps (user_id, email, otp_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
    [userId, email.toLowerCase(), hashOtp(otp), expiresAt, createdAt]
  );
  return { id: result.lastID, userId, email: email.toLowerCase(), expiresAt, createdAt };
}

async function verifyLoginOtp({ userId, otp }) {
  const row = await get(
    `SELECT * FROM login_otps WHERE user_id = ? AND used = 0 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!row) return { ok: false, message: 'No OTP request found. Please login again to request a new OTP.' };
  if (new Date(row.expires_at) < new Date()) {
    return { ok: false, message: 'OTP expired. Please login again to request a new OTP.' };
  }
  if (row.otp_hash !== hashOtp(otp)) {
    return { ok: false, message: 'Invalid OTP.' };
  }
  await run(`UPDATE login_otps SET used = 1 WHERE id = ?`, [row.id]);
  return { ok: true };
}

async function markUserEmailVerified(userId) {
  const verifiedAt = new Date().toISOString();
  return run(
    `UPDATE users SET email_verified = 1, email_verified_at = COALESCE(email_verified_at, ?), email_verification_token = NULL WHERE id = ?`,
    [verifiedAt, userId]
  );
}

async function getUserByVerificationToken(token) {
  const row = await get(`SELECT * FROM users WHERE email_verification_token = ?`, [token]);
  return row || null;
}

async function markUserRegistrationNoticeSent(userId) {
  const sentAt = new Date().toISOString();
  return run(`UPDATE users SET registration_notice_sent_at = ? WHERE id = ?`, [sentAt, userId]);
}

async function markUserRegistrationForfeited(userId) {
  const forfeitedAt = new Date().toISOString();
  return run(`UPDATE users SET status = 'inactive', registration_forfeited_at = ? WHERE id = ?`, [forfeitedAt, userId]);
}

async function getDoctorUser() {
  const row = await get(`SELECT * FROM users WHERE role = 'doctor' LIMIT 1`);
  return row ? row : null;
}

async function createInvite({ token, expiresAt, createdBy }) {
  const createdAt = new Date().toISOString();
  const result = await run(
    `INSERT INTO invites (token, expires_at, created_by, created_at) VALUES (?, ?, ?, ?)`,
    [token, expiresAt, createdBy, createdAt]
  );
  return {
    id: result.lastID,
    token,
    expiresAt,
    createdBy,
    createdAt,
    used: 0,
  };
}

async function getInviteByToken(token) {
  const row = await get(`SELECT * FROM invites WHERE token = ?`, [token]);
  return row ? row : null;
}

async function markInviteUsed(token) {
  return run(`UPDATE invites SET used = 1 WHERE token = ?`, [token]);
}

function generatePatientId(userId) {
  // Simple patient ID generator: P-<userId>-<timestamp>
  return `P-${userId}-${Date.now()}`;
}

async function createPatientProfile({
  userId,
  username,
  firstName,
  middleName,
  lastName,
  suffix,
  email,
  mobile,
  dateOfBirth,
  age,
  sex,
  civilStatus,
  address,
  address2,
  philhealthNumber,
  idType,
  nationalIdNumber,
  securityQuestion,
  securityAnswer,
}) {
  const createdAt = new Date().toISOString();
  const patientId = generatePatientId(userId);

  await run(
    `INSERT INTO patients (
      user_id,
      patient_id,
      username,
      first_name,
      middle_name,
      last_name,
      suffix,
      email,
      mobile || null,
      date_of_birth,
      age,
      sex,
      civil_status,
      address,
      address2,
      philhealth_number,
      id_type,
      national_id_number,
      security_question,
      security_answer,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      patientId,
      username,
      firstName,
      middleName || null,
      lastName,
      suffix || null,
      email,
      mobile,
      dateOfBirth,
      age,
      sex,
      civilStatus,
      address,
      address2 || null,
      philhealthNumber || null,
      idType || null,
      nationalIdNumber || null,
      securityQuestion,
      securityAnswer,
      createdAt,
    ]
  );

  return {
    userId,
    patientId,
    username,
    firstName,
    middleName: middleName || null,
    lastName,
    suffix: suffix || null,
    email,
    mobile: mobile || null,
    dateOfBirth,
    age,
    sex,
    civilStatus,
    address,
    address2: address2 || null,
    philhealthNumber: philhealthNumber || null,
    idType: idType || null,
    nationalIdNumber: nationalIdNumber || null,
    securityQuestion,
    createdAt,
  };
}

async function createConsultation({ patientId, doctorId, concerns, consultationDate, consultationTime, consultationSource = 'online' }) {
  const createdAt = new Date().toISOString();
  const updatedAt = createdAt;
  const source = ['walk-in', 'online'].includes(String(consultationSource || '').toLowerCase())
    ? String(consultationSource).toLowerCase()
    : 'online';
  const result = await run(
    `INSERT INTO consultations (patient_id, doctor_id, status, consultation_date, consultation_time, consultation_source, concerns, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [patientId, doctorId, 'pending', consultationDate || null, consultationTime || null, source, concerns, createdAt, updatedAt]
  );
  return { id: result.lastID, patientId, doctorId, status: 'pending', consultationDate: consultationDate || null, consultationTime: consultationTime || null, consultationSource: source, concerns, createdAt, updatedAt };
}

const ACTIVE_CONSULTATION_STATUS_SQL = `LOWER(TRIM(COALESCE(status, 'pending'))) NOT IN ('cancelled', 'denied', 'rejected', 'completed', 'finished', 'done', 'resolved', 'marked-no-show')`;

async function countDoctorConsultationsForDate(doctorId, consultationDate, excludeConsultationId = null) {
  const conditions = [
    `doctor_id = ?`,
    `consultation_date = ?`,
    ACTIVE_CONSULTATION_STATUS_SQL,
  ];
  const params = [doctorId, consultationDate];

  if (excludeConsultationId) {
    conditions.push(`id != ?`);
    params.push(excludeConsultationId);
  }

  const row = await get(
    `SELECT COUNT(*) AS count FROM consultations WHERE ${conditions.join(' AND ')}`,
    params
  );
  return Number(row?.count || 0);
}

async function countDoctorConsultationsForDateTime(doctorId, consultationDate, consultationTime, excludeConsultationId = null) {
  if (!doctorId || !consultationDate || !consultationTime) return 0;

  const conditions = [
    `doctor_id = ?`,
    `consultation_date = ?`,
    `consultation_time = ?`,
    ACTIVE_CONSULTATION_STATUS_SQL,
  ];
  const params = [doctorId, consultationDate, consultationTime];

  if (excludeConsultationId) {
    conditions.push(`id != ?`);
    params.push(excludeConsultationId);
  }

  const row = await get(
    `SELECT COUNT(*) AS count FROM consultations WHERE ${conditions.join(' AND ')}`,
    params
  );
  return Number(row?.count || 0);
}

async function getActiveConsultationByPatient(patientId, excludeConsultationId = null) {
  const conditions = [
    `patient_id = ?`,
    ACTIVE_CONSULTATION_STATUS_SQL,
  ];
  const params = [patientId];

  if (excludeConsultationId) {
    conditions.push(`id != ?`);
    params.push(excludeConsultationId);
  }

  const row = await get(
    `SELECT * FROM consultations WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`,
    params
  );
  return row || null;
}

async function getConsultationsByPatient(patientId) {
  const rows = await getAll(`SELECT c.*, u.display_name as doctor_name FROM consultations c LEFT JOIN users u ON c.doctor_id = u.id WHERE c.patient_id = ? ORDER BY c.created_at DESC`, [patientId]);
  return rows;
}

async function getOverduePendingConsultations(today) {
  return getAll(
    `SELECT c.*, pu.display_name AS patient_name, du.display_name AS doctor_name
     FROM consultations c
     LEFT JOIN users pu ON pu.id = c.patient_id
     LEFT JOIN users du ON du.id = c.doctor_id
     WHERE c.status = 'pending'
       AND c.consultation_date IS NOT NULL
       AND c.consultation_date != ''
       AND c.consultation_date < ?
       AND c.missed_notified_at IS NULL
     ORDER BY c.consultation_date ASC`,
    [today]
  );
}

async function markConsultationMissedNotified(consultationId) {
  const notifiedAt = new Date().toISOString();
  return run(
    `UPDATE consultations SET is_late = 1, missed_notified_at = ?, updated_at = ? WHERE id = ?`,
    [notifiedAt, notifiedAt, consultationId]
  );
}

async function getDoctorAvailability() {
  const rows = await getAll(`SELECT da.*, u.display_name as doctor_name FROM doctor_availability da JOIN users u ON da.doctor_id = u.id ORDER BY da.available_date`);
  return rows;
}

async function dedupeDoctorAvailability() {
  const duplicates = await getAll(`
    SELECT doctor_id, available_date, COUNT(*) AS count
    FROM doctor_availability
    GROUP BY doctor_id, available_date
    HAVING COUNT(*) > 1
  `);

  for (const duplicate of duplicates) {
    const rows = await getAll(
      `SELECT * FROM doctor_availability WHERE doctor_id = ? AND available_date = ? ORDER BY id ASC`,
      [duplicate.doctor_id, duplicate.available_date]
    );
    const keeper = rows[0];
    const mergedSlots = Array.from(new Set(rows.flatMap(row => JSON.parse(row.available_time_slots || '[]')))).sort();
    await run(
      `UPDATE doctor_availability SET available_time_slots = ? WHERE id = ?`,
      [JSON.stringify(mergedSlots), keeper.id]
    );
    for (const row of rows.slice(1)) {
      await run(`DELETE FROM doctor_availability WHERE id = ?`, [row.id]);
    }
  }
}

async function createNotification({ userId, type, message, targetUserId = null }) {
  const createdAt = new Date().toISOString();
  const result = await run(
    `INSERT INTO notifications (user_id, target_user_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)`,
    [userId, targetUserId, type, message, createdAt]
  );
  return { id: result.lastID, userId, targetUserId, type, message, read: 0, createdAt };
}

async function getNotificationsByUser(userId) {
  const rows = await getAll(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
  return rows;
}

async function markNotificationRead(notificationId) {
  return run(`UPDATE notifications SET read = 1 WHERE id = ?`, [notificationId]);
}

async function getPatientProfile(userId) {
  const row = await get(`SELECT p.*, pa.assessment_json FROM patients p LEFT JOIN patient_assessments pa ON p.user_id = pa.user_id WHERE p.user_id = ?`, [userId]);
  return row;
}

async function updatePatientProfile(userId, updates) {
  const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(userId);
  return run(`UPDATE patients SET ${fields} WHERE user_id = ?`, values);
}

async function createPatientAssessment({ userId, assessment }) {
  const createdAt = new Date().toISOString();
  
  // CP-ABE: Encrypt assessment with policy (doctor or patient can access)
  const policy = `role:doctor OR userId:${userId}`;
  const encryptedData = encryptAssessment(assessment, userId, policy);
  
  const result = await run(
    `INSERT INTO patient_assessments (user_id, assessment_json, assessment_encrypted, policy, created_at) VALUES (?, ?, ?, ?, ?)`,
    [userId, JSON.stringify(assessment), JSON.stringify(encryptedData), policy, createdAt]
  );
  return { id: result.lastID, userId, assessment, createdAt };
}

// Retrieve and decrypt assessment with policy checking
async function getPatientAssessmentByUserId(userId, requestingUser) {
  const row = await get(
    `SELECT * FROM patient_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  
  if (!row) return null;
  
  // CP-ABE: Check policy before decryption
  const userAttributes = {
    role: requestingUser.role,
    userId: requestingUser.id,
    patientId: userId
  };
  
  // Verify access is allowed
  if (requestingUser.role === 'admin') {
    throw new Error('Access denied: admins cannot access patient assessments');
  }
  
  if (!checkPolicy(row.policy, userAttributes)) {
    throw new Error('Access denied: policy not satisfied');
  }
  
  // Decrypt the assessment
  if (row.assessment_encrypted) {
    try {
      row.assessment = decryptAssessment(row.assessment_encrypted, userAttributes);
    } catch (error) {
      throw new Error('Failed to decrypt assessment');
    }
  }
  
  return row;
}

// Doctor-specific functions
async function getConsultationsByDoctor(doctorId) {
  const rows = await getAll(
    `SELECT c.*, p.first_name, p.middle_name, p.last_name, p.email, p.mobile, pa.assessment_json 
     FROM consultations c 
     JOIN patients p ON c.patient_id = p.user_id 
     LEFT JOIN patient_assessments pa ON c.patient_id = pa.user_id 
     WHERE c.doctor_id = ?
     ORDER BY c.created_at DESC`,
    [doctorId]
  );
  return rows;
}

async function getConsultationById(consultationId) {
  const row = await get(
    `SELECT c.*, p.first_name, p.middle_name, p.last_name, p.email, p.mobile, p.date_of_birth, p.age, p.sex, p.address, p.address2, pa.assessment_json 
     FROM consultations c 
     JOIN patients p ON c.patient_id = p.user_id 
     LEFT JOIN patient_assessments pa ON c.patient_id = pa.user_id 
     WHERE c.id = ?`,
    [consultationId]
  );
  return row;
}

async function updateConsultation(consultationId, updates) {
  const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(new Date().toISOString());
  values.push(consultationId);
  return run(`UPDATE consultations SET ${fields}, updated_at = ? WHERE id = ?`, values);
}

async function setDoctorAvailability({ doctorId, availableDate, timeSlots }) {
  const createdAt = new Date().toISOString();
  const existing = await get(
    `SELECT * FROM doctor_availability WHERE doctor_id = ? AND available_date = ? ORDER BY id ASC LIMIT 1`,
    [doctorId, availableDate]
  );

  if (existing) {
    const currentSlots = JSON.parse(existing.available_time_slots || '[]');
    const mergedSlots = Array.from(new Set([...currentSlots, ...timeSlots])).sort();
    await run(
      `UPDATE doctor_availability SET available_time_slots = ? WHERE id = ?`,
      [JSON.stringify(mergedSlots), existing.id]
    );
    return { id: existing.id, doctorId, availableDate, timeSlots: mergedSlots, createdAt: existing.created_at };
  }

  const result = await run(
    `INSERT INTO doctor_availability (doctor_id, available_date, available_time_slots, created_at) VALUES (?, ?, ?, ?)`,
    [doctorId, availableDate, JSON.stringify(timeSlots), createdAt]
  );
  return { id: result.lastID, doctorId, availableDate, timeSlots, createdAt };
}

async function updateDoctorAvailability(availabilityId, { doctorId, availableDate, timeSlots }) {
  const current = await get(
    `SELECT * FROM doctor_availability WHERE id = ?`,
    [availabilityId]
  );
  if (!current) return { changes: 0 };

  const ownerId = doctorId || current.doctor_id;
  const duplicate = await get(
    `SELECT * FROM doctor_availability WHERE doctor_id = ? AND available_date = ? AND id != ? ORDER BY id ASC LIMIT 1`,
    [ownerId, availableDate, availabilityId]
  );

  if (duplicate) {
    const duplicateSlots = JSON.parse(duplicate.available_time_slots || '[]');
    const mergedSlots = Array.from(new Set([...duplicateSlots, ...timeSlots])).sort();
    await run(
      `UPDATE doctor_availability SET available_time_slots = ? WHERE id = ?`,
      [JSON.stringify(mergedSlots), duplicate.id]
    );
    await run(`DELETE FROM doctor_availability WHERE id = ?`, [availabilityId]);
    return { changes: 1, mergedIntoId: duplicate.id };
  }

  return run(
    `UPDATE doctor_availability SET available_date = ?, available_time_slots = ? WHERE id = ?`,
    [availableDate, JSON.stringify(timeSlots), availabilityId]
  );
}

async function deleteDoctorAvailability(availabilityId, doctorId) {
  return run(`DELETE FROM doctor_availability WHERE id = ? AND doctor_id = ?`, [availabilityId, doctorId]);
}

async function getDoctorAvailabilityByDoctor(doctorId) {
  const rows = await getAll(
    `SELECT * FROM doctor_availability WHERE doctor_id = ? ORDER BY available_date`,
    [doctorId]
  );
  return rows;
}

async function getDoctorProfile(userId) {
  const row = await get(
    `SELECT u.*, dp.license_number,
            (SELECT COUNT(*) FROM consultations WHERE doctor_id = u.id) as total_consultations
     FROM users u
     LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
     WHERE u.id = ? AND u.role = 'doctor'`,
    [userId]
  );
  return row;
}

async function createDoctorProfile({ userId, licenseNumber }) {
  const createdAt = new Date().toISOString();
  await run(
    `INSERT INTO doctor_profiles (user_id, license_number, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [userId, licenseNumber, createdAt, createdAt]
  );
  return { userId, licenseNumber, createdAt, updatedAt: createdAt };
}

async function createStaffProfile({ userId, position }) {
  const createdAt = new Date().toISOString();
  await run(
    `INSERT INTO staff_profiles (user_id, position, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [userId, position, createdAt, createdAt]
  );
  return { userId, position, createdAt, updatedAt: createdAt };
}

async function getAllUsers({ search, role, status } = {}) {
  const conditions = [];
  const params = [];

  if (role) {
    conditions.push(`role = ?`);
    params.push(role);
  }

  if (status) {
    conditions.push(`status = ?`);
    params.push(status);
  }

  if (search) {
    conditions.push(`(email ILIKE ? OR display_name ILIKE ? OR CAST(id AS TEXT) = ?)`);
    params.push(`%${search}%`, `%${search}%`, search);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await getAll(
    `SELECT id, role, email, display_name, status, created_at FROM users ${where} ORDER BY created_at DESC`,
    params
  );
  return rows;
}

async function createAuditLog({ userId, userRole, action, resource, status = 'success', details }) {
  await ensureAuditLogsTable();
  const createdAt = new Date().toISOString();
  const result = await run(
    `INSERT INTO audit_logs (user_id, user_role, action, resource, status, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId || null, userRole || null, action, resource, status, details || null, createdAt]
  );
  return { id: result.lastID, userId, userRole, action, resource, status, details, createdAt };
}

async function getAuditLogs({ role, action, date } = {}) {
  await ensureAuditLogsTable();
  const conditions = [];
  const params = [];

  if (role) {
    conditions.push(`user_role = ?`);
    params.push(role);
  }
  if (action) {
    conditions.push(`action = ?`);
    params.push(action);
  }
  if (date) {
    conditions.push(`LEFT(created_at, 10) = ?`);
    params.push(date);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return getAll(
    `SELECT al.*, u.display_name, u.email
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     ${where}
     ORDER BY al.created_at DESC
     LIMIT 100`,
    params
  );
}

async function ensureAuditLogsTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      user_role TEXT,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      details TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
}

async function updateUserStatus(userId, status) {
  return run(`UPDATE users SET status = ? WHERE id = ?`, [status, userId]);
}

async function updateUser(userId, { displayName, email, role }) {
  const updates = [];
  const params = [];

  if (displayName !== undefined) {
    updates.push(`display_name = ?`);
    params.push(displayName);
  }
  if (email !== undefined) {
    updates.push(`email = ?`);
    params.push(email.toLowerCase());
  }
  if (role !== undefined) {
    updates.push(`role = ?`);
    params.push(role);
  }

  if (!updates.length) {
    return null;
  }

  params.push(userId);
  return run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
}

async function updateUserPassword(userId, password) {
  const passwordHash = await bcrypt.hash(password, 10);
  return run(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, userId]);
}

async function updatePatientAssessmentRecord(recordId, assessment) {
  return run(
    `UPDATE patient_assessments SET assessment_json = ? WHERE id = ?`,
    [JSON.stringify(assessment), recordId]
  );
}

async function createPasswordResetRequest(userId, email) {
  const existing = await get(
    `SELECT * FROM password_reset_requests WHERE user_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`,
    [userId]
  );
  if (existing) return existing;

  const requestedAt = new Date().toISOString();
  const result = await run(
    `INSERT INTO password_reset_requests (user_id, email, status, requested_at) VALUES (?, ?, 'pending', ?)`,
    [userId, email.toLowerCase(), requestedAt]
  );
  return { id: result.lastID, user_id: userId, email: email.toLowerCase(), status: 'pending', requested_at: requestedAt };
}

async function getPasswordResetRequests(status = 'pending') {
  const params = [];
  let where = '';
  if (status && status !== 'all') {
    where = 'WHERE pr.status = ?';
    params.push(status);
  }

  const rows = await getAll(
    `SELECT pr.*, u.display_name, u.role, resolver.display_name AS resolved_by_name
     FROM password_reset_requests pr
     JOIN users u ON u.id = pr.user_id
     LEFT JOIN users resolver ON resolver.id = pr.resolved_by
     ${where}
     ORDER BY pr.requested_at DESC`,
    params
  );
  return rows || [];
}

async function resolvePasswordResetRequest(requestId, adminId) {
  const resolvedAt = new Date().toISOString();
  return run(
    `UPDATE password_reset_requests SET status = 'completed', resolved_at = ?, resolved_by = ? WHERE id = ?`,
    [resolvedAt, adminId, requestId]
  );
}

async function deleteUserCascade(userId) {
  await run(`DELETE FROM login_otps WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM message_board WHERE from_user_id = ? OR to_user_id = ?`, [userId, userId]);
  await run(`DELETE FROM reschedule_requests WHERE patient_id = ? OR doctor_id = ?`, [userId, userId]);
  await run(`DELETE FROM notifications WHERE user_id = ? OR target_user_id = ?`, [userId, userId]);
  await run(`DELETE FROM password_reset_requests WHERE user_id = ? OR resolved_by = ?`, [userId, userId]);
  await run(`DELETE FROM audit_logs WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM doctor_availability WHERE doctor_id = ?`, [userId]);
  await run(`DELETE FROM consultations WHERE patient_id = ? OR doctor_id = ?`, [userId, userId]);
  await run(`DELETE FROM patient_record_files WHERE patient_id = ? OR uploaded_by = ?`, [userId, userId]);
  await run(`DELETE FROM patient_assessments WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM patients WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM doctor_profiles WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM staff_profiles WHERE user_id = ?`, [userId]);
  await run(`DELETE FROM invites WHERE created_by = ?`, [userId]);
  const result = await run(`DELETE FROM users WHERE id = ?`, [userId]);
  return { deleted: result.changes || 0 };
}

async function updateDoctorProfile(userId, updates) {
  const result = await run(
    `UPDATE users SET display_name = ? WHERE id = ?`,
    [updates.display_name || updates.name, userId]
  );

  if (updates.license_number !== undefined || updates.licenseNumber !== undefined) {
    const licenseNumber = updates.license_number || updates.licenseNumber;
    const updatedAt = new Date().toISOString();
    await run(
      `INSERT INTO doctor_profiles (user_id, license_number, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET license_number = excluded.license_number, updated_at = excluded.updated_at`,
      [userId, licenseNumber, updatedAt, updatedAt]
    );
  }

  return result;
}

async function getAllPatientsWithConsultations(doctorId) {
  const rows = await getAll(
    `SELECT p.*, u.email, u.display_name,
            (SELECT COUNT(*) FROM consultations WHERE patient_id = p.user_id AND doctor_id = ?) as total_consultations
     FROM patients p
     JOIN users u ON p.user_id = u.id
     ORDER BY p.first_name ASC`,
    [doctorId]
  );
  return rows || [];
}

async function getPatientEMR(patientId) {
  const row = await get(
    `SELECT p.*, pa.assessment_json FROM patients p LEFT JOIN patient_assessments pa ON p.user_id = pa.user_id WHERE p.user_id = ?`,
    [patientId]
  );
  return row;
}

async function createPatientRecordFile({ patientId, uploadedBy, fileName, mimeType, fileSize, fileData, notes }) {
  const createdAt = new Date().toISOString();
  const result = await run(
    `INSERT INTO patient_record_files (patient_id, uploaded_by, file_name, mime_type, file_size, file_data, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [patientId, uploadedBy, fileName, mimeType, fileSize, fileData, notes || null, createdAt]
  );

  return {
    id: result.lastID,
    patient_id: patientId,
    uploaded_by: uploadedBy,
    file_name: fileName,
    mime_type: mimeType,
    file_size: fileSize,
    notes: notes || null,
    created_at: createdAt,
  };
}

async function getPatientRecordFiles(patientId) {
  return getAll(
    `SELECT id, patient_id, uploaded_by, file_name, mime_type, file_size, notes, created_at
     FROM patient_record_files
     WHERE patient_id = ?
     ORDER BY created_at DESC`,
    [patientId]
  );
}

async function getPatientRecordFileById(fileId) {
  const row = await get(`SELECT * FROM patient_record_files WHERE id = ?`, [fileId]);
  return row || null;
}

async function getAdminStats() {
  const totalUsers = (await get(`SELECT COUNT(*) AS count FROM users`)).count || 0;
  const activeDoctors = (await get(`
    SELECT COUNT(DISTINCT id) AS count
    FROM users
    WHERE LOWER(TRIM(role)) = 'doctor'
      AND LOWER(COALESCE(NULLIF(TRIM(status), ''), 'active')) <> 'inactive'
  `)).count || 0;
  const activeConsultations = (await get(`SELECT COUNT(*) AS count FROM consultations WHERE status IN ('pending', 'scheduled', 'under-review')`)).count || 0;
  const totalConsultations = (await get(`SELECT COUNT(*) AS count FROM consultations`)).count || 0;
  const emrRecords = (await get(`SELECT COUNT(*) AS count FROM patient_assessments`)).count || 0;
  const qrCodes = (await get(`SELECT COUNT(*) AS count FROM invites`)).count || 0;

  return {
    totalUsers,
    activeDoctors,
    activeConsultations,
    totalConsultations,
    emrRecords,
    qrCodes,
  };
}

async function getAdminReportData({ search = '', startDate = '', endDate = '' } = {}) {
  const searchValue = String(search || '').trim();
  const startValue = String(startDate || '').trim();
  const endValue = String(endDate || '').trim();
  const consultationConditions = [];
  const consultationParams = [];

  if (searchValue) {
    consultationConditions.push(`(
      CAST(c.id AS TEXT) ILIKE ?
      OR COALESCE(pu.display_name, '') ILIKE ?
      OR COALESCE(du.display_name, '') ILIKE ?
      OR COALESCE(c.status, '') ILIKE ?
      OR COALESCE(c.concerns, '') ILIKE ?
    )`);
    consultationParams.push(`%${searchValue}%`, `%${searchValue}%`, `%${searchValue}%`, `%${searchValue}%`, `%${searchValue}%`);
  }

  if (startValue) {
    consultationConditions.push(`COALESCE(c.consultation_date, substr(c.created_at, 1, 10)) >= ?`);
    consultationParams.push(startValue);
  }

  if (endValue) {
    consultationConditions.push(`COALESCE(c.consultation_date, substr(c.created_at, 1, 10)) <= ?`);
    consultationParams.push(endValue);
  }

  const consultationWhere = consultationConditions.length ? `WHERE ${consultationConditions.join(' AND ')}` : '';

  const userRoleCounts = await getAll(`
    SELECT role, COUNT(*) AS count
    FROM users
    GROUP BY role
    ORDER BY role
  `);

  const userStatusCounts = await getAll(`
    SELECT status, COUNT(*) AS count
    FROM users
    GROUP BY status
    ORDER BY status
  `);

  const recentUsers = await getAll(`
    SELECT id, role, email, display_name, status, created_at
    FROM users
    ORDER BY created_at DESC
    LIMIT 10
  `);

  const consultationStatusCounts = await getAll(`
    SELECT status, COUNT(*) AS count
    FROM consultations
    GROUP BY status
    ORDER BY count DESC
  `);

  const consultationDailyTrend = await getAll(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
    FROM consultations
    GROUP BY substr(created_at, 1, 10)
    ORDER BY day DESC
    LIMIT 14
  `);

  const recentConsultations = await getAll(`
    SELECT
      c.id,
      c.status,
      c.concerns,
      c.consultation_date,
      c.consultation_time,
      c.consultation_time_end,
      COALESCE(c.consultation_source, 'online') AS consultation_source,
      c.created_at,
      c.updated_at,
      pu.display_name AS patient_name,
      du.display_name AS doctor_name
    FROM consultations c
    LEFT JOIN users pu ON c.patient_id = pu.id
    LEFT JOIN users du ON c.doctor_id = du.id
    ${consultationWhere}
    ORDER BY c.updated_at DESC
    LIMIT 10
  `, consultationParams);

  const protectedEmrs = (await get(`SELECT COUNT(*) AS count FROM patient_assessments WHERE assessment_encrypted IS NOT NULL AND assessment_encrypted != ''`)).count || 0;
  const totalEmrs = (await get(`SELECT COUNT(*) AS count FROM patient_assessments`)).count || 0;
  const passwordResetCounts = await getAll(`
    SELECT status, COUNT(*) AS count
    FROM password_reset_requests
    GROUP BY status
    ORDER BY status
  `);
  const inviteCounts = await getAll(`
    SELECT
      CASE
        WHEN used = 1 THEN 'used'
        WHEN expires_at::timestamptz < now() THEN 'expired'
        ELSE 'active'
      END AS status,
      COUNT(*) AS count
    FROM invites
    GROUP BY status
    ORDER BY status
  `);
  const notificationCounts = await getAll(`
    SELECT type, COUNT(*) AS count
    FROM notifications
    GROUP BY type
    ORDER BY count DESC
    LIMIT 10
  `);

  const totalUsers = (await get(`SELECT COUNT(*) AS count FROM users`)).count || 0;
  const totalConsultations = (await get(`SELECT COUNT(*) AS count FROM consultations`)).count || 0;
  const activeConsultations = (await get(`SELECT COUNT(*) AS count FROM consultations WHERE status IN ('pending', 'scheduled', 'under-review')`)).count || 0;
  const totalMessages = (await get(`SELECT COUNT(*) AS count FROM message_board`)).count || 0;
  const unreadMessages = (await get(`SELECT COUNT(*) AS count FROM message_board WHERE is_read = 0`)).count || 0;

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      totalUsers,
      totalConsultations,
      activeConsultations,
      totalEmrs,
      protectedEmrs,
      totalMessages,
      unreadMessages,
    },
    users: {
      byRole: userRoleCounts || [],
      byStatus: userStatusCounts || [],
      recent: recentUsers || [],
    },
    consultations: {
      byStatus: consultationStatusCounts || [],
      dailyTrend: (consultationDailyTrend || []).reverse(),
      recent: recentConsultations || [],
    },
    security: {
      protectedEmrs,
      totalEmrs,
      passwordResetRequests: passwordResetCounts || [],
      invites: inviteCounts || [],
      notifications: notificationCounts || [],
    },
  };
}

async function getAllEMRRecords({ search } = {}) {
  const conditions = [];
  const params = [];

  if (search) {
    const normalizedSearchId = String(search).replace(/^#?(PT|EMR)/i, '').replace(/^0+/, '') || search;
    conditions.push(`(
      p.first_name ILIKE ?
      OR p.last_name ILIKE ?
      OR CONCAT(p.first_name, ' ', p.last_name) ILIKE ?
      OR CAST(p.user_id AS TEXT) = ?
      OR CAST(pa.id AS TEXT) = ?
    )`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, normalizedSearchId, normalizedSearchId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await getAll(`
    SELECT 
      pa.id,
      p.user_id,
      p.first_name,
      p.last_name,
      pa.assessment_json,
      pa.created_at
    FROM patient_assessments pa
    JOIN patients p ON pa.user_id = p.user_id
    ${where}
    ORDER BY pa.created_at DESC
  `, params);
  return rows || [];
}

async function getDiagnosticReportData(doctorId) {
  const assessments = await getAll(`
    SELECT
      pa.id,
      pa.user_id,
      pa.assessment_json,
      pa.created_at,
      p.first_name,
      p.last_name,
      p.age,
      p.sex,
      u.display_name AS patient_name
    FROM patient_assessments pa
    JOIN patients p ON pa.user_id = p.user_id
    JOIN users u ON u.id = pa.user_id
    ORDER BY pa.created_at DESC
    LIMIT 50
  `);

  const consultationStatus = await getAll(
    `SELECT status, COUNT(*) AS count
     FROM consultations
     WHERE doctor_id = ?
     GROUP BY status
     ORDER BY count DESC`,
    [doctorId]
  );

  const totals = await get(
    `SELECT
       COUNT(*) AS total_consultations,
       SUM(CASE WHEN status IN ('pending', 'scheduled', 'under-review') THEN 1 ELSE 0 END) AS active_consultations
     FROM consultations
     WHERE doctor_id = ?`,
    [doctorId]
  );

  const dailyTrend = await getAll(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
     FROM consultations
     WHERE doctor_id = ?
     GROUP BY substr(created_at, 1, 10)
     ORDER BY day DESC
     LIMIT 14`,
    [doctorId]
  );

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      totalConsultations: Number(totals?.total_consultations || 0),
      activeConsultations: Number(totals?.active_consultations || 0),
    },
    consultationStatus: consultationStatus || [],
    dailyTrend: (dailyTrend || []).reverse(),
    assessments: assessments || [],
  };
}

async function getPatientHistoryReport({ search = '', startDate = '', endDate = '' } = {}) {
  const conditions = [];
  const params = [];
  const searchValue = String(search || '').trim();

  if (searchValue) {
    conditions.push(`(
      CAST(c.id AS TEXT) ILIKE ?
      OR COALESCE(pu.display_name, '') ILIKE ?
      OR COALESCE(du.display_name, '') ILIKE ?
      OR COALESCE(p.first_name, '') ILIKE ?
      OR COALESCE(p.last_name, '') ILIKE ?
      OR COALESCE(c.status, '') ILIKE ?
    )`);
    params.push(`%${searchValue}%`, `%${searchValue}%`, `%${searchValue}%`, `%${searchValue}%`, `%${searchValue}%`, `%${searchValue}%`);
  }

  if (startDate) {
    conditions.push(`COALESCE(c.consultation_date, substr(c.created_at, 1, 10)) >= ?`);
    params.push(startDate);
  }

  if (endDate) {
    conditions.push(`COALESCE(c.consultation_date, substr(c.created_at, 1, 10)) <= ?`);
    params.push(endDate);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await getAll(`
    SELECT
      c.id AS transaction_id,
      c.patient_id,
      c.doctor_id,
      c.status,
      c.concerns,
      c.consultation_date,
      c.consultation_time,
      c.consultation_time_end,
      COALESCE(c.consultation_source, 'online') AS consultation_source,
      c.created_at,
      c.updated_at,
      pu.display_name AS patient_name,
      du.display_name AS doctor_name,
      p.mobile,
      p.email AS patient_email
    FROM consultations c
    LEFT JOIN users pu ON c.patient_id = pu.id
    LEFT JOIN users du ON c.doctor_id = du.id
    LEFT JOIN patients p ON p.user_id = c.patient_id
    ${where}
    ORDER BY COALESCE(c.consultation_date, substr(c.created_at, 1, 10)) DESC, c.created_at DESC
  `, params);

  return rows || [];
}

async function getAllConsultations({ status, date } = {}) {
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push(`LOWER(c.status) = LOWER(?)`);
    params.push(status);
  }

  if (date) {
    conditions.push(`COALESCE(c.consultation_date, substr(c.created_at, 1, 10)) = ?`);
    params.push(date);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await getAll(`
    SELECT 
      c.id,
      c.patient_id,
      c.doctor_id,
      c.status,
      c.concerns,
      c.consultation_date,
      c.consultation_time,
      c.consultation_time_end,
      COALESCE(c.consultation_source, 'online') AS consultation_source,
      c.created_at,
      c.updated_at,
      pu.display_name as patient_name,
      du.display_name as doctor_name
    FROM consultations c
    LEFT JOIN users pu ON c.patient_id = pu.id
    LEFT JOIN users du ON c.doctor_id = du.id
    ${where}
    ORDER BY c.created_at DESC
  `, params);
  return rows || [];
}

async function getStaffConsultationQueue() {
  const rows = await getAll(`
    SELECT
      c.id,
      c.patient_id,
      c.doctor_id,
      c.status,
      c.concerns,
      c.notes,
      c.diagnostic_result,
      c.prescription,
      c.result_updated_at,
      c.consultation_date,
      c.consultation_time,
      c.consultation_time_end,
      c.is_late,
      c.created_at,
      c.updated_at,
      p.first_name,
      p.middle_name,
      p.last_name,
      p.mobile,
      p.email AS patient_email,
      p.age,
      p.sex,
      p.disability,
      pu.display_name AS patient_name,
      du.display_name AS doctor_name,
      rr.id AS reschedule_request_id,
      rr.new_date AS reschedule_new_date,
      rr.new_time AS reschedule_new_time,
      rr.reason AS reschedule_reason,
      rr.status AS reschedule_status,
      rr.created_at AS reschedule_created_at
    FROM consultations c
    LEFT JOIN patients p ON p.user_id = c.patient_id
    LEFT JOIN users pu ON pu.id = c.patient_id
    LEFT JOIN users du ON du.id = c.doctor_id
    LEFT JOIN (
      SELECT r1.*
      FROM reschedule_requests r1
      JOIN (
        SELECT consultation_id, MAX(created_at) AS latest_created_at
        FROM reschedule_requests
        GROUP BY consultation_id
      ) latest
        ON latest.consultation_id = r1.consultation_id
       AND latest.latest_created_at = r1.created_at
    ) rr ON rr.consultation_id = c.id
    ORDER BY
      CASE
        WHEN p.age >= 60 THEN 0
        WHEN p.disability IS NOT NULL AND TRIM(p.disability) != '' THEN 0
        ELSE 1
      END,
      CASE
        WHEN LOWER(COALESCE(rr.status, '')) = 'pending' THEN 0
        WHEN LOWER(COALESCE(c.status, '')) = 'pending' THEN 0
        ELSE 1
      END,
      COALESCE(c.consultation_date, c.created_at) ASC,
      COALESCE(c.consultation_time, '00:00') ASC
  `);
  return rows || [];
}

async function getAllInvites() {
  const rows = await getAll(`
    SELECT 
      i.id,
      i.token,
      i.expires_at,
      i.used,
      i.created_by,
      i.created_at,
      u.display_name
    FROM invites i
    LEFT JOIN users u ON i.created_by = u.id
    ORDER BY i.created_at DESC
  `);
  return rows || [];
}

async function getDoctorAccessPermissions() {
  const rows = await getAll(`
    SELECT
      u.id,
      u.display_name,
      u.role,
      CASE
        WHEN u.role = 'admin' THEN 'System administration'
        WHEN u.role = 'doctor' THEN 'Patient consultations and EMRs'
        WHEN u.role = 'staff' THEN 'Clinic schedules and patient invites'
        WHEN u.role = 'patient' THEN 'Own profile, consultations, and records'
        ELSE 'Limited system access'
      END as resource_type,
      CASE
        WHEN u.role = 'admin' THEN 'MANAGE USERS / MONITOR SYSTEM'
        WHEN u.role = 'doctor' THEN 'READ EMR / UPDATE CONSULTATIONS'
        WHEN u.role = 'staff' THEN 'SCHEDULE / INVITE'
        WHEN u.role = 'patient' THEN 'READ OWN / UPLOAD OWN'
        ELSE 'READ'
      END as permission_level,
      u.created_at as assigned_date
    FROM users u
    WHERE u.role IN ('admin', 'doctor', 'staff', 'patient')
    ORDER BY
      CASE u.role
        WHEN 'admin' THEN 1
        WHEN 'doctor' THEN 2
        WHEN 'staff' THEN 3
        WHEN 'patient' THEN 4
        ELSE 5
      END,
      u.created_at DESC
  `);
  return rows || [];
}

module.exports = {
  init,
  createUser,
  getUserByEmail,
  validateCredentials,
  getUserById,
  createLoginOtp,
  verifyLoginOtp,
  markUserEmailVerified,
  getUserByVerificationToken,
  markUserRegistrationNoticeSent,
  markUserRegistrationForfeited,
  getDoctorUser,
  createInvite,
  getInviteByToken,
  markInviteUsed,
  createPatientProfile,
  createPatientAssessment,
  createConsultation,
  countDoctorConsultationsForDate,
  countDoctorConsultationsForDateTime,
  getActiveConsultationByPatient,
  getConsultationsByPatient,
  getDoctorAvailability,
  createNotification,
  getNotificationsByUser,
  markNotificationRead,
  getPatientProfile,
  updatePatientProfile,
  getConsultationsByDoctor,
  getConsultationById,
  updateConsultation,
  setDoctorAvailability,
  updateDoctorAvailability,
  deleteDoctorAvailability,
  getDoctorAvailabilityByDoctor,
  getDoctorProfile,
  createDoctorProfile,
  createStaffProfile,
  getAllUsers,
  updateUserStatus,
  updateUser,
  updateUserPassword,
  updatePatientAssessmentRecord,
  createAuditLog,
  getAuditLogs,
  createPasswordResetRequest,
  getPasswordResetRequests,
  resolvePasswordResetRequest,
  deleteUserCascade,
  updateDoctorProfile,
  getAllPatientsWithConsultations,
  getPatientEMR,
  createPatientRecordFile,
  getPatientRecordFiles,
  getPatientRecordFileById,
  getAdminStats,
  getAdminReportData,
  getPatientHistoryReport,
  getAllEMRRecords,
  getDiagnosticReportData,
  getAllConsultations,
  getOverduePendingConsultations,
  markConsultationMissedNotified,
  getStaffConsultationQueue,
  getAllInvites,
  getDoctorAccessPermissions,
  // CP-ABE Functions
  encryptAssessment,
  decryptAssessment,
  checkPolicy,
  getPatientAssessmentByUserId,
};
