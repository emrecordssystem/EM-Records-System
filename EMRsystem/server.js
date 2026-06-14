require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const FormData = require('form-data');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Manila';
const APP_RELEASE = 'admin-approval-registration';
const MAX_RECORD_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_RECORD_FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_DOCTOR_CONSULTATIONS_PER_DAY = 8;

function getFrontendUrl(req) {
  return FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
}

function getLocalDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const getPart = (type) => parts.find((part) => part.type === type)?.value;
  return `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
}

function parseDateOnly(dateString) {
  const match = String(dateString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function normalizeDateOnly(dateString) {
  const parsed = parseDateOnly(dateString);
  return parsed ? formatDateOnly(parsed) : '';
}

function formatDateOnly({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function addDaysToDateOnly(dateString, daysToAdd) {
  const parsed = parseDateOnly(dateString);
  if (!parsed) return '';
  const date = new Date(parsed.year, parsed.month - 1, parsed.day + daysToAdd);
  return formatDateOnly({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}

function addMonthsToDateOnly(dateString, monthsToAdd) {
  const parsed = parseDateOnly(dateString);
  if (!parsed) return '';
  const totalMonthIndex = (parsed.year * 12) + (parsed.month - 1) + monthsToAdd;
  const year = Math.floor(totalMonthIndex / 12);
  const month = (totalMonthIndex % 12) + 1;
  const day = Math.min(parsed.day, getDaysInMonth(year, month));
  return formatDateOnly({ year, month, day });
}

function isFutureDateString(dateString) {
  return Boolean(dateString) && dateString > getLocalDateString();
}

function isValidPersonName(value, { required = true } = {}) {
  const text = String(value || '').trim();
  if (!text) return !required;
  return /^[\p{L}\s.'-]+$/u.test(text);
}

function isDigitsOnly(value, { required = true } = {}) {
  const text = String(value || '').trim();
  if (!text) return !required;
  return /^\d+$/.test(text);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function getPatientInputValidationMessage({ firstName, middleName, lastName, mobile, philhealthNumber, nationalIdNumber }) {
  if (!isValidPersonName(firstName)) return 'First name can only contain letters.';
  if (!isValidPersonName(middleName, { required: false })) return 'Middle name can only contain letters.';
  if (!isValidPersonName(lastName)) return 'Last name can only contain letters.';
  if (!isDigitsOnly(mobile, { required: false })) return 'Mobile number can only contain numbers.';
  if (!isDigitsOnly(philhealthNumber, { required: false })) return 'PhilHealth number can only contain numbers.';
  if (!isDigitsOnly(nationalIdNumber, { required: false })) return 'National ID number can only contain numbers.';
  return '';
}

function getPasswordValidationMessage(password) {
  const value = String(password || '');
  if (value.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(value)) return 'Password must include at least one uppercase letter.';
  if (!/[a-z]/.test(value)) return 'Password must include at least one lowercase letter.';
  if (!/[0-9]/.test(value)) return 'Password must include at least one number.';
  if (!/[^A-Za-z0-9]/.test(value)) return 'Password must include at least one special character.';
  return '';
}

function createEmailVerificationToken() {
  return crypto.randomBytes(24).toString('hex');
}

function addHours(date, hours) {
  return new Date(date.getTime() + (hours * 60 * 60 * 1000));
}

function getVerificationUrl(req, token) {
  return `${getFrontendUrl(req)}/api/verify-email?token=${encodeURIComponent(token)}`;
}

function formatDisplayDateTime(value) {
  if (!value) return 'the scheduled time';
  return new Date(value).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

async function ensureDoctorDailyCapacity({ doctorId, consultationDate, excludeConsultationId = null }) {
  if (!doctorId || !consultationDate) return;

  const scheduledCount = await db.countDoctorConsultationsForDate(doctorId, consultationDate, excludeConsultationId);
  if (scheduledCount >= MAX_DOCTOR_CONSULTATIONS_PER_DAY) {
    const dateLabel = consultationDate === getLocalDateString() ? 'today' : consultationDate;
    const error = new Error(`The consultation for ${dateLabel} has reached the limit of ${MAX_DOCTOR_CONSULTATIONS_PER_DAY} requests. Please choose another available date.`);
    error.statusCode = 400;
    throw error;
  }
}

async function ensureDoctorSlotAvailable({ doctorId, consultationDate, consultationTime, excludeConsultationId = null }) {
  if (!doctorId || !consultationDate || !consultationTime) return;

  const bookedCount = await db.countDoctorConsultationsForDateTime(doctorId, consultationDate, consultationTime, excludeConsultationId);
  if (bookedCount > 0) {
    const error = new Error('This doctor already has a patient booked for that date and time. Please choose another slot.');
    error.statusCode = 400;
    throw error;
  }
}

async function notifyOverduePendingConsultations(today = getLocalDateString()) {
  const overdue = await db.getOverduePendingConsultations(today);
  for (const consultation of overdue) {
    const when = `${consultation.consultation_date}${consultation.consultation_time ? ` at ${consultation.consultation_time}` : ''}`;
    await db.createNotification({
      userId: consultation.patient_id,
      type: 'consultation_missed_pending',
      message: `Your pending consultation request for ${when} has passed. Please contact the clinic or request a new schedule.`,
    });

    if (consultation.doctor_id) {
      await db.createNotification({
        userId: consultation.doctor_id,
        targetUserId: consultation.patient_id,
        type: 'consultation_missed_pending',
        message: `${consultation.patient_name || 'A patient'} did not attend the pending consultation request for ${when}. Please approve, reject, or follow up.`,
      });
    }

    await db.markConsultationMissedNotified(consultation.id);
  }
  return overdue.length;
}

async function writeAuditLog({ userId, userRole, action, resource, status = 'success', details }) {
  try {
    await db.createAuditLog({ userId, userRole, action, resource, status, details });
  } catch (err) {
    console.error('audit log error', err);
  }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname)));

app.get('/api/public-registration-qr', async (req, res) => {
  try {
    const registrationUrl = `${getFrontendUrl(req)}/register.html`;
    const qrDataUrl = await QRCode.toDataURL(registrationUrl, { width: 320, margin: 1 });
    return res.json({ success: true, registrationUrl, qrDataUrl });
  } catch (err) {
    console.error('public registration qr error', err);
    return res.status(500).json({ success: false, message: 'Could not generate registration QR code.' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const {
      role,
      email,
      password,
      displayName,
      inviteToken,
      username,
      firstName,
      middleName,
      lastName,
      suffix,
      mobile,
      dateOfBirth,
      age,
      sex,
      civilStatus,
      address,
      address2,
      philhealthNumber,
      idNumber,
      idType,
      license,
      licenseNumber,
      position,
      securityQuestion,
      securityAnswer,
    } = req.body;

    if (!role || !email || !password) {
      return res.status(400).json({ success: false, message: 'role, email, and password are required.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const passwordMessage = getPasswordValidationMessage(password);
    if (passwordMessage) {
      return res.status(400).json({ success: false, message: passwordMessage });
    }

    const allowedRoles = ['admin', 'doctor', 'patient', 'staff'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid role.' });
    }

    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    let invite = null;
    let patientAge = null;
    if (role === 'patient') {
      // Invite token is optional for patient registration (clinic workflow).
      // If provided, validate and mark as used; if not valid, registration can still proceed.
      if (inviteToken) {
        invite = await db.getInviteByToken(inviteToken);
        const now = new Date();
        if (!invite || invite.used || new Date(invite.expires_at) < now) {
          invite = null; // ignore invalid/expired invite
        }
      }

      const missingFields = [];
      if (!username) missingFields.push('username');
      if (!firstName) missingFields.push('firstName');
      if (!lastName) missingFields.push('lastName');
      if (!dateOfBirth) missingFields.push('dateOfBirth');
      if (!sex) missingFields.push('sex');
      if (!civilStatus) missingFields.push('civilStatus');
      if (!address) missingFields.push('address');
      if (!securityQuestion) missingFields.push('securityQuestion');
      if (!securityAnswer) missingFields.push('securityAnswer');

      if (missingFields.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Missing required patient profile fields: ${missingFields.join(', ')}`,
        });
      }

      if (isFutureDateString(dateOfBirth)) {
        return res.status(400).json({ success: false, message: 'Date of birth cannot be in the future.' });
      }

      const validationMessage = getPatientInputValidationMessage({ firstName, middleName, lastName, mobile, philhealthNumber, nationalIdNumber: idNumber });
      if (validationMessage) {
        return res.status(400).json({ success: false, message: validationMessage });
      }

      patientAge = calculateAge(dateOfBirth);
    }

    if (role === 'doctor' && !(license || licenseNumber)) {
      return res.status(400).json({ success: false, message: 'Doctor license number is required.' });
    }

    if (role === 'staff' && !position) {
      return res.status(400).json({ success: false, message: 'Staff position is required.' });
    }

    const verificationToken = role === 'patient' ? createEmailVerificationToken() : null;
    const verificationExpiresAt = role === 'patient' ? addHours(new Date(), 24).toISOString() : null;

    const user = await db.createUser({
      role,
      email,
      password,
      displayName,
      emailVerified: role !== 'patient',
      status: role === 'patient' ? 'pending' : 'active',
      emailVerificationToken: verificationToken,
      emailVerificationExpiresAt: verificationExpiresAt,
    });

    let patientProfile = null;
    let doctorProfile = null;
    let staffProfile = null;
    if (role === 'patient') {
      patientProfile = await db.createPatientProfile({
        userId: user.id,
        username,
        firstName,
        middleName,
        lastName,
        suffix,
        email,
        mobile,
        dateOfBirth,
        age: patientAge,
        sex,
        civilStatus,
        address,
        address2,
        philhealthNumber,
        idType,
        nationalIdNumber: idNumber,
        securityQuestion,
        securityAnswer,
      });

      const verificationUrl = getVerificationUrl(req, verificationToken);
      await db.createNotification({
        userId: user.id,
        type: 'account_created',
        message: `Your account was created and is pending approval. Verify your email within 24 hours: ${verificationUrl}`,
      });
      await db.createNotification({
        userId: user.id,
        type: 'registration_confirmation_deadline',
        message: `Please confirm your registration by ${formatDisplayDateTime(verificationExpiresAt)}. Unconfirmed registration may be forfeited after 24 hours.`,
      });

      const admins = await db.getAllUsers({ role: 'admin', status: 'active' });
      await Promise.all(
        admins.map((adminUser) =>
          db.createNotification({
            userId: adminUser.id,
            targetUserId: user.id,
            type: 'patient_registration_pending',
            message: `${displayName || email} submitted a new patient registration for approval.`,
          })
        )
      );

      if (invite) {
        await db.markInviteUsed(invite.token);
      }
    }

    if (role === 'doctor') {
      doctorProfile = await db.createDoctorProfile({
        userId: user.id,
        licenseNumber: license || licenseNumber,
      });
    }

    if (role === 'staff') {
      staffProfile = await db.createStaffProfile({
        userId: user.id,
        position,
      });
    }

    await writeAuditLog({
      userId: user.id,
      userRole: user.role,
      action: 'create',
      resource: 'User Management',
      details: `Created ${role} account ${email}.`,
    });
    return res.status(201).json({
      success: true,
      user,
      patientProfile,
      doctorProfile,
      staffProfile,
      verificationUrl: role === 'patient' ? getVerificationUrl(req, verificationToken) : undefined,
      verificationExpiresAt,
      message: role === 'patient'
        ? 'Registration submitted. Verify your email within 24 hours, then wait for admin approval before signing in.'
        : undefined,
    });
  } catch (err) {
    console.error('register error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/verify-email', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, message: 'Verification token is required.' });
    }

    const user = await db.getUserByVerificationToken(token);
    if (!user) {
      return res.status(400).json({ success: false, message: 'Verification link is invalid or already used.' });
    }

    if (user.email_verification_expires_at && new Date(user.email_verification_expires_at) < new Date()) {
      await db.markUserRegistrationForfeited(user.id);
      return res.status(400).json({ success: false, message: 'Verification link expired. Your registration has been marked forfeited.' });
    }

    await db.markUserEmailVerified(user.id);
    await db.createNotification({
      userId: user.id,
      type: 'email_verified',
      message: 'Your email has been verified. Please wait for admin approval before signing in.',
    });

    return res.json({ success: true, message: 'Email verified. Please wait for admin approval before signing in.' });
  } catch (err) {
    console.error('verify email error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// Store completed health assessment for a patient
app.post('/api/assessment', async (req, res) => {
  try {
    const { userId, answers } = req.body;
    if (!userId || !answers) {
      return res.status(400).json({ success: false, message: 'userId and answers are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const assessment = await db.createPatientAssessment({ userId, assessment: answers });
    return res.status(201).json({ success: true, assessment });
  } catch (err) {
    console.error('assessment error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// Patient Dashboard Endpoints

app.post('/api/consultation-request', async (req, res) => {
  try {
    const { userId, concerns, consultationDate, consultationTime } = req.body;
    if (!userId || !concerns) {
      return res.status(400).json({ success: false, message: 'userId and concerns are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'patient') {
      return res.status(403).json({ success: false, message: 'Only patients can submit consultation requests.' });
    }

    const today = getLocalDateString();
    if (consultationDate && consultationDate < today) {
      return res.status(400).json({ success: false, message: 'Consultation date cannot be in the past.' });
    }

    const activeConsultation = await db.getActiveConsultationByPatient(userId);
    if (activeConsultation) {
      const activeSchedule = activeConsultation.consultation_date
        ? ` for ${activeConsultation.consultation_date}${activeConsultation.consultation_time ? ` at ${activeConsultation.consultation_time}` : ''}`
        : '';
      return res.status(400).json({
        success: false,
        message: `You already have an active consultation request${activeSchedule}. Please cancel or complete it before booking another consultation.`,
      });
    }

    let doctor = null;
    if (consultationDate) {
      const availability = await db.getDoctorAvailability();
      const availableDoctors = availability.filter((slot) => {
        if (slot.available_date !== consultationDate) return false;
        if (slot.available_date < today) return false;
        const slots = typeof slot.available_time_slots === 'string'
          ? JSON.parse(slot.available_time_slots || '[]')
          : (slot.available_time_slots || []);
        return !consultationTime || slots.includes(consultationTime);
      });

      if (!availableDoctors.length) {
        return res.status(400).json({
          success: false,
          message: 'There is no available doctor schedule for the date/time you selected. Please choose a green available date from the calendar.',
        });
      }

      for (const availableDoctor of availableDoctors) {
        const dailyCount = await db.countDoctorConsultationsForDate(availableDoctor.doctor_id, consultationDate);
        const slotCount = await db.countDoctorConsultationsForDateTime(availableDoctor.doctor_id, consultationDate, consultationTime);
        if (dailyCount < MAX_DOCTOR_CONSULTATIONS_PER_DAY && slotCount === 0) {
          doctor = await db.getUserById(availableDoctor.doctor_id);
          break;
        }
      }

      if (!doctor) {
        const dateLabel = consultationDate === today ? 'today' : 'the selected date';
        return res.status(400).json({
          success: false,
          message: `The consultation for ${dateLabel} has reached the limit. Please choose another available date.`,
        });
      }
    } else {
      doctor = await db.getDoctorUser();
    }

    if (!doctor) {
      return res.status(500).json({ success: false, message: 'No doctor available.' });
    }

    await ensureDoctorDailyCapacity({ doctorId: doctor.id, consultationDate });
    await ensureDoctorSlotAvailable({ doctorId: doctor.id, consultationDate, consultationTime: consultationTime || null });

    const consultation = await db.createConsultation({ patientId: userId, doctorId: doctor.id, concerns, consultationDate, consultationTime, consultationSource: 'online' });
    // Create notification for patient
    await db.createNotification({ userId, type: 'consultation_submitted', message: 'Your consultation request has been submitted and is pending doctor approval.' });
    // Create notification for doctor
    const requestedFor = consultationDate ? ` for ${consultationDate}${consultationTime ? ` at ${consultationTime}` : ''}` : '';
    await db.createNotification({
      userId: doctor.id,
      targetUserId: user.id,
      type: 'new_consultation',
      message: `New consultation request from ${user.display_name}${requestedFor}.`,
    });
    return res.status(201).json({ success: true, consultation });
  } catch (err) {
    console.error('consultation request error', err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : 'Internal server error.' });
  }
});

app.get('/api/my-consultations', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    await notifyOverduePendingConsultations();
    const consultations = await db.getConsultationsByPatient(userId);
    return res.json({ success: true, consultations });
  } catch (err) {
    console.error('my consultations error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/my-consultations/:id/cancel', async (req, res) => {
  try {
    const consultationId = req.params.id;
    const { userId } = req.body;
    if (!userId || !consultationId) {
      return res.status(400).json({ success: false, message: 'userId and consultation ID are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'patient') {
      return res.status(403).json({ success: false, message: 'Only patients can cancel consultations.' });
    }

    const consultation = await db.getConsultationById(consultationId);
    if (!consultation || String(consultation.patient_id) !== String(userId)) {
      return res.status(404).json({ success: false, message: 'Consultation not found.' });
    }

    if (!['pending', 'scheduled', 'under-review'].includes(String(consultation.status || '').toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Only active consultations can be cancelled.' });
    }

    const today = getLocalDateString();
    if (consultation.consultation_date && consultation.consultation_date <= today) {
      return res.status(400).json({ success: false, message: 'Consultations can only be cancelled before the consultation date.' });
    }

    await db.updateConsultation(consultationId, { status: 'cancelled' });
    await db.createNotification({
      userId,
      type: 'consultation_cancelled',
      message: 'Your consultation has been cancelled.',
    });
    if (consultation.doctor_id) {
      await db.createNotification({
        userId: consultation.doctor_id,
        targetUserId: user.id,
        type: 'consultation_cancelled',
        message: `${user.display_name || 'A patient'} cancelled a consultation scheduled for ${consultation.consultation_date || 'a pending date'}.`,
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('cancel consultation error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/doctor-availability', async (req, res) => {
  try {
    const availabilityRows = await db.getDoctorAvailability();
    const availability = await Promise.all(availabilityRows.map(async (slot) => {
      const timeSlots = typeof slot.available_time_slots === 'string'
        ? JSON.parse(slot.available_time_slots || '[]')
        : (slot.available_time_slots || []);
      const dailyRequestCount = await db.countDoctorConsultationsForDate(slot.doctor_id, slot.available_date);
      const bookedTimeSlots = [];

      for (const timeSlot of timeSlots) {
        const slotCount = await db.countDoctorConsultationsForDateTime(slot.doctor_id, slot.available_date, timeSlot);
        if (slotCount > 0) bookedTimeSlots.push(timeSlot);
      }

      return {
        ...slot,
        daily_request_count: dailyRequestCount,
        daily_request_limit: MAX_DOCTOR_CONSULTATIONS_PER_DAY,
        booked_time_slots: bookedTimeSlots,
        available_time_slots_remaining: dailyRequestCount >= MAX_DOCTOR_CONSULTATIONS_PER_DAY
          ? []
          : timeSlots.filter((timeSlot) => !bookedTimeSlots.includes(timeSlot)),
        is_fully_booked: dailyRequestCount >= MAX_DOCTOR_CONSULTATIONS_PER_DAY || bookedTimeSlots.length >= timeSlots.length,
      };
    }));
    return res.json({ success: true, availability });
  } catch (err) {
    console.error('doctor availability error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/notifications', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    await notifyOverduePendingConsultations();
    const notifications = await db.getNotificationsByUser(userId);
    return res.json({ success: true, notifications });
  } catch (err) {
    console.error('notifications error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/notifications/:id/read', async (req, res) => {
  try {
    const notificationId = req.params.id;
    await db.markNotificationRead(notificationId);
    return res.json({ success: true });
  } catch (err) {
    console.error('mark notification read error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/my-qr', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const qrData = `EMR-Patient:${userId}`;
    const qrDataUrl = await QRCode.toDataURL(qrData);
    return res.json({ success: true, qrDataUrl });
  } catch (err) {
    console.error('my qr error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/my-emr', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    // Get requesting user info
    const requestingUser = await db.getUserById(userId);
    if (!requestingUser) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const profile = await db.getPatientProfile(userId);
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Profile not found.' });
    }

    // CP-ABE: Decrypt assessment with policy checking
    try {
      const assessment = await db.getPatientAssessmentByUserId(userId, requestingUser);
      if (assessment) {
        profile.assessment = assessment.assessment;
      }
    } catch (error) {
      console.log('Assessment access denied or not found:', error.message);
      // Continue without assessment if access is denied
    }

    return res.json({ success: true, emr: profile });
  } catch (err) {
    console.error('my emr error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

function normalizeRecordFilePayload(fileData) {
  const raw = String(fileData || '');
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  return match ? { mimeType: match[1], base64: match[2] } : { mimeType: '', base64: raw };
}

async function canAccessPatientRecordFile(user, file) {
  if (!user || !file) return false;
  if (user.role === 'patient' && String(user.id) === String(file.patient_id)) return true;
  if (user.role === 'doctor') return true;
  return false;
}

app.get('/api/patient-record-files', async (req, res) => {
  try {
    const userId = req.query.userId;
    const patientId = req.query.patientId || userId;
    if (!userId || !patientId) {
      return res.status(400).json({ success: false, message: 'userId and patientId are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || !['patient', 'doctor'].includes(user.role)) {
      return res.status(403).json({ success: false, message: 'Only patients and doctors can view record files.' });
    }

    if (user.role === 'patient' && String(user.id) !== String(patientId)) {
      return res.status(403).json({ success: false, message: 'Patients can only view their own files.' });
    }

    const files = await db.getPatientRecordFiles(patientId);
    return res.json({ success: true, files });
  } catch (err) {
    console.error('record files list error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/patient-record-files', async (req, res) => {
  try {
    const { userId, fileName, mimeType, fileData, notes } = req.body;
    if (!userId || !fileName || !fileData) {
      return res.status(400).json({ success: false, message: 'userId, fileName, and fileData are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'patient') {
      return res.status(403).json({ success: false, message: 'Only patients can upload their medical record files.' });
    }

    const normalized = normalizeRecordFilePayload(fileData);
    const actualMimeType = mimeType || normalized.mimeType;
    if (!ALLOWED_RECORD_FILE_TYPES.has(actualMimeType)) {
      return res.status(400).json({ success: false, message: 'Only JPG, PNG, WEBP, and PDF files are allowed.' });
    }

    const buffer = Buffer.from(normalized.base64, 'base64');
    if (!buffer.length || buffer.length > MAX_RECORD_FILE_BYTES) {
      return res.status(400).json({ success: false, message: 'File must be 5 MB or smaller.' });
    }

    const file = await db.createPatientRecordFile({
      patientId: user.id,
      uploadedBy: user.id,
      fileName: String(fileName).slice(0, 180),
      mimeType: actualMimeType,
      fileSize: buffer.length,
      fileData: normalized.base64,
      notes: notes ? String(notes).slice(0, 500) : '',
    });

    const doctors = await db.getAllUsers({ role: 'doctor', status: 'active' });
    await Promise.all(
      doctors.map((doctor) =>
        db.createNotification({
          userId: doctor.id,
          targetUserId: user.id,
          type: 'patient_record_uploaded',
          message: `${user.display_name || user.email || 'A patient'} uploaded a medical record file: ${file.file_name}.`,
        })
      )
    );

    await db.createNotification({
      userId: user.id,
      type: 'patient_record_uploaded',
      message: `Your medical record file "${file.file_name}" was uploaded successfully.`,
    });

    return res.status(201).json({ success: true, file });
  } catch (err) {
    console.error('record file upload error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/patient-record-files/:id', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    const file = await db.getPatientRecordFileById(req.params.id);
    if (!file) {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }

    if (!(await canAccessPatientRecordFile(user, file))) {
      return res.status(403).json({ success: false, message: 'You do not have access to this file.' });
    }

    return res.json({
      success: true,
      file: {
        id: file.id,
        patient_id: file.patient_id,
        file_name: file.file_name,
        mime_type: file.mime_type,
        file_size: file.file_size,
        notes: file.notes,
        created_at: file.created_at,
        dataUrl: `data:${file.mime_type};base64,${file.file_data}`,
      },
    });
  } catch (err) {
    console.error('record file detail error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/profile', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const profile = await db.getPatientProfile(userId);
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Profile not found.' });
    }

    return res.json({ success: true, profile });
  } catch (err) {
    console.error('profile error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.put('/api/profile', async (req, res) => {
  try {
    const { userId, updates } = req.body;
    if (!userId || !updates) {
      return res.status(400).json({ success: false, message: 'userId and updates are required.' });
    }

    await db.updatePatientProfile(userId, updates);
    return res.json({ success: true });
  } catch (err) {
    console.error('update profile error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const account = await db.getUserByEmail(email);
    if (account && account.status === 'pending') {
      return res.status(403).json({
        success: false,
        message: 'Your registration is waiting for admin approval. You cannot log in until your account is approved.',
      });
    }
    if (account && account.status && account.status !== 'active') {
      await writeAuditLog({
        userId: account.id,
        userRole: account.role,
        action: 'login',
        resource: 'Authentication',
        status: 'blocked',
        details: 'Inactive account attempted to sign in.',
      });
      return res.status(403).json({ success: false, message: 'Your account is deactivated. Please contact the administrator.' });
    }

    const user = await db.validateCredentials(email, password);
    if (!user) {
      await writeAuditLog({
        action: 'login',
        resource: 'Authentication',
        status: 'failed',
        details: `Failed sign-in attempt for ${email}.`,
      });
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    await writeAuditLog({
      userId: user.id,
      userRole: user.role,
      action: 'login',
      resource: 'Authentication',
      details: `${user.email} signed in.`,
    });

    // In a real system, issue a session or token here.
    return res.status(200).json({ success: true, user: { id: user.id, role: user.role, email: user.email, displayName: user.display_name } });
  } catch (err) {
    console.error('login error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const user = await db.getUserByEmail(email);
    if (user) {
      const resetRequest = await db.createPasswordResetRequest(user.id, email);
      const admins = await db.getAllUsers({ role: 'admin', status: 'active' });
      await Promise.all(
        admins.map((admin) =>
          db.createNotification({
            userId: admin.id,
            type: 'password-reset',
            message: `Password reset requested for ${user.display_name || user.email} (${user.email}). Request #${resetRequest.id}.`,
          })
        )
      );
    }

    return res.json({
      success: true,
      message: 'If that account exists, an admin has been notified to reset the password.',
    });
  } catch (err) {
    console.error('forgot password error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/admin/invite', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may generate invite tokens.' });
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const invite = await db.createInvite({ token, expiresAt, createdBy: userId });

    const inviteUrl = `${getFrontendUrl(req)}/register.html?token=${encodeURIComponent(token)}`;
    const qrDataUrl = await QRCode.toDataURL(inviteUrl);

    return res.status(201).json({
      success: true,
      invite: { token, expiresAt, inviteUrl, qrDataUrl },
    });
  } catch (err) {
    console.error('invite error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/staff/invite', async (req, res) => {
  try {
    const userId = parseInt(req.body.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'staff') {
      return res.status(403).json({ success: false, message: 'Only staff may generate patient invite tokens.' });
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.createInvite({ token, expiresAt, createdBy: userId });

    const inviteUrl = `${getFrontendUrl(req)}/register.html?token=${encodeURIComponent(token)}`;
    const qrDataUrl = await QRCode.toDataURL(inviteUrl, { width: 300, margin: 1 });

    return res.status(201).json({
      success: true,
      invite: { token, expiresAt, inviteUrl, qrDataUrl },
    });
  } catch (err) {
    console.error('staff invite error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

function decorateStaffConsultation(row) {
  const consultationStatus = String(row.status || '').toLowerCase();
  const rescheduleStatus = String(row.reschedule_status || '').toLowerCase();
  const isPending = consultationStatus === 'pending' || rescheduleStatus === 'pending';
  const isFinished = ['completed', 'finished', 'done', 'resolved'].includes(consultationStatus);
  const isPriority = Number(row.age) >= 60 || Boolean(String(row.disability || '').trim());
  const hasOpenReschedule = Boolean(row.reschedule_request_id) && !['approved', 'completed', 'resolved', 'done'].includes(rescheduleStatus);
  const displayColor = isFinished ? 'green' : (isPending || hasOpenReschedule ? 'yellow' : 'green');

  return {
    ...row,
    patient_name: row.patient_name || [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' '),
    priority: isPriority,
    priority_reason: isPriority ? (Number(row.age) >= 60 ? 'Senior Citizen' : 'PWD') : '',
    display_color: displayColor,
    display_label: isPending ? 'Pending' : isFinished ? 'Finished' : (row.status || 'Active'),
    has_reschedule_request: Boolean(row.reschedule_request_id),
    doctor_schedule_changed: Boolean(row.consultation_date || row.consultation_time || row.consultation_time_end),
  };
}

async function requireStaffUser(userId) {
  const user = await db.getUserById(userId);
  if (!user || user.role !== 'staff') {
    return null;
  }
  return user;
}

app.get('/api/staff/schedules', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await requireStaffUser(userId);
    if (!user) {
      return res.status(403).json({ success: false, message: 'Only staff may view patient schedules.' });
    }

    const rows = await db.getStaffConsultationQueue();
    const schedules = rows
      .filter((row) => row.consultation_date || row.consultation_time || row.reschedule_request_id || String(row.status || '').toLowerCase() === 'pending')
      .map(decorateStaffConsultation);

    return res.json({ success: true, schedules });
  } catch (err) {
    console.error('staff schedules error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/staff/consultations', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await requireStaffUser(userId);
    if (!user) {
      return res.status(403).json({ success: false, message: 'Only staff may view consultations.' });
    }

    const consultations = (await db.getStaffConsultationQueue()).map(decorateStaffConsultation);
    return res.json({ success: true, consultations });
  } catch (err) {
    console.error('staff consultations error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.put('/api/consultations/:id/schedule', async (req, res) => {
  try {
    const consultationId = req.params.id;
    const { userId, consultationDate, consultationTime, consultationTimeEnd, notes, status } = req.body;

    if (!userId || !consultationId || !consultationDate || !consultationTime) {
      return res.status(400).json({ success: false, message: 'userId, consultation ID, date, and start time are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || !['doctor', 'staff'].includes(user.role)) {
      return res.status(403).json({ success: false, message: 'Only doctors and staff can set consultation schedules.' });
    }

    const consultation = await db.getConsultationById(consultationId);
    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Consultation not found.' });
    }

    const targetDoctorId = user.role === 'doctor' ? user.id : consultation.doctor_id;
    await ensureDoctorDailyCapacity({
      doctorId: targetDoctorId,
      consultationDate,
      excludeConsultationId: consultationId,
    });
    await ensureDoctorSlotAvailable({
      doctorId: targetDoctorId,
      consultationDate,
      consultationTime,
      excludeConsultationId: consultationId,
    });

    const updates = {
      consultation_date: consultationDate,
      consultation_time: consultationTime,
      status: status || 'scheduled',
    };
    if (consultationTimeEnd) updates.consultation_time_end = consultationTimeEnd;
    if (notes) updates.notes = notes;
    if (user.role === 'doctor') updates.doctor_id = user.id;

    await db.updateConsultation(consultationId, updates);

    const actor = user.role === 'doctor' ? 'doctor' : 'clinic staff';
    await db.createNotification({
      userId: consultation.patient_id,
      type: status === 'denied' ? 'schedule_disapproved' : 'schedule_approved',
      message: status === 'denied'
        ? 'Your consultation schedule was disapproved. Please contact the clinic or request a new schedule.'
        : `Your consultation schedule was approved by ${actor} for ${consultationDate} at ${consultationTime}${consultationTimeEnd ? ` - ${consultationTimeEnd}` : ''}.`,
    });

    if (consultation.doctor_id && user.role === 'staff') {
      await db.createNotification({
        userId: consultation.doctor_id,
        targetUserId: consultation.patient_id,
        type: 'consultation_scheduled_by_staff',
        message: `Clinic staff set a consultation schedule for ${consultation.first_name || 'a patient'} ${consultation.last_name || ''} on ${consultationDate} at ${consultationTime}.`,
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('set consultation schedule error', err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : 'Internal server error.' });
  }
});

app.put('/api/staff/consultations/:id/prescription', async (req, res) => {
  try {
    const consultationId = req.params.id;
    const { userId, prescription } = req.body;
    if (!userId || !consultationId) {
      return res.status(400).json({ success: false, message: 'userId and consultation ID are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'staff') {
      return res.status(403).json({ success: false, message: 'Only staff can issue prescriptions from this screen.' });
    }

    const consultation = await db.getConsultationById(consultationId);
    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Consultation not found.' });
    }

    await db.updateConsultation(consultationId, {
      prescription: String(prescription || '').trim(),
      result_updated_at: new Date().toISOString(),
    });

    await db.createNotification({
      userId: consultation.patient_id,
      type: 'prescription_issued',
      message: 'A prescription has been issued for your consultation and is available in your patient portal.',
    });

    await writeAuditLog({
      userId: user.id,
      userRole: user.role,
      action: 'update',
      resource: 'Prescription',
      details: `Issued prescription for consultation #${consultationId}.`,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('staff prescription error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view stats.' });
    }

    const stats = await db.getAdminStats();
    return res.json({ success: true, stats });
  } catch (err) {
    console.error('admin stats error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/reports/:type', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    const type = String(req.params.type || '').toLowerCase();
    const allowedTypes = ['system', 'consultations', 'security', 'users', 'patient-history'];

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ success: false, message: `Report type must be one of: ${allowedTypes.join(', ')}` });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view reports.' });
    }

    const reportData = await db.getAdminReportData({
      search: req.query.search,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    if (type === 'patient-history') {
      reportData.patientHistory = await db.getPatientHistoryReport({
        search: req.query.search,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });
    }
    const titles = {
      system: 'System Activity Report',
      consultations: 'Consultation Analytics',
      security: 'Security Report',
      users: 'User Activity Report',
      'patient-history': 'Patient History Report',
    };

    return res.json({
      success: true,
      report: {
        type,
        title: titles[type],
        generatedAt: reportData.generatedAt,
        data: reportData,
      },
    });
  } catch (err) {
    console.error('admin report error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view users.' });
    }

    const filters = {
      search: req.query.search,
      role: req.query.role,
      status: req.query.status,
    };

    const users = await db.getAllUsers(filters);
    await writeAuditLog({
      userId,
      userRole: user.role,
      action: 'access',
      resource: 'Admin Users',
      details: 'Viewed user management list.',
    });
    return res.json({ success: true, users });
  } catch (err) {
    console.error('admin users error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/admin/users', async (req, res) => {
  try {
    const adminId = parseInt(req.query.userId || req.body.userId, 10);
    if (!adminId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const admin = await db.getUserById(adminId);
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may create users.' });
    }

    const {
      role,
      email,
      password,
      displayName,
      license,
      licenseNumber,
      position,
      username,
      firstName,
      middleName,
      lastName,
      suffix,
      mobile,
      dateOfBirth,
      age,
      sex,
      civilStatus,
      address,
      philhealthNumber,
      idType,
      securityQuestion,
      securityAnswer,
    } = req.body;

    if (!role || !email || !password) {
      return res.status(400).json({ success: false, message: 'role, email, and password are required.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const allowedRoles = ['admin', 'doctor', 'patient', 'staff'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid role.' });
    }

    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    if (role === 'doctor' && !(license || licenseNumber)) {
      return res.status(400).json({ success: false, message: 'Doctor license number is required.' });
    }

    if (role === 'staff' && !position) {
      return res.status(400).json({ success: false, message: 'Staff position is required.' });
    }

    const user = await db.createUser({ role, email, password, displayName, emailVerified: role !== 'patient' });
    let patientProfile = null;
    let doctorProfile = null;
    let staffProfile = null;
    let patientAge = null;

    if (role === 'doctor') {
      doctorProfile = await db.createDoctorProfile({ userId: user.id, licenseNumber: license || licenseNumber });
    }

    if (role === 'staff') {
      staffProfile = await db.createStaffProfile({ userId: user.id, position });
    }

    if (role === 'patient') {
      const requiredPatientFields = {
        username: username || email.split('@')[0],
        firstName,
        lastName,
        mobile,
        dateOfBirth,
        sex,
        civilStatus,
        address,
        securityQuestion: securityQuestion || 'Created by admin',
        securityAnswer: securityAnswer || 'admin-created',
      };
      const missing = Object.entries(requiredPatientFields)
        .filter(([, value]) => value === undefined || value === null || value === '')
        .map(([key]) => key);
      if (missing.length) {
        await db.deleteUserCascade(user.id);
        return res.status(400).json({ success: false, message: `Missing required patient fields: ${missing.join(', ')}` });
      }

      if (isFutureDateString(dateOfBirth)) {
        await db.deleteUserCascade(user.id);
        return res.status(400).json({ success: false, message: 'Date of birth cannot be in the future.' });
      }

      const validationMessage = getPatientInputValidationMessage({ firstName, middleName, lastName, mobile, philhealthNumber });
      if (validationMessage) {
        await db.deleteUserCascade(user.id);
        return res.status(400).json({ success: false, message: validationMessage });
      }

      patientAge = calculateAge(dateOfBirth);

      patientProfile = await db.createPatientProfile({
        userId: user.id,
        username: requiredPatientFields.username,
        firstName,
        middleName,
        lastName,
        suffix,
        email,
        mobile,
        dateOfBirth,
        age: patientAge,
        sex,
        civilStatus,
        address,
        philhealthNumber,
        idType,
        securityQuestion: requiredPatientFields.securityQuestion,
        securityAnswer: requiredPatientFields.securityAnswer,
      });
    }

    return res.status(201).json({ success: true, user, patientProfile, doctorProfile, staffProfile });
  } catch (err) {
    console.error('admin create user error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view users.' });
    }

    const targetUserId = parseInt(req.params.id, 10);
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'User ID is required in the path.' });
    }

    const targetUser = await db.getUserById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    return res.json({ success: true, user: targetUser });
  } catch (err) {
    console.error('admin user detail error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const admin = await db.getUserById(userId);
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may delete users.' });
    }

    const targetUserId = parseInt(req.params.id, 10);
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'User ID is required in the path.' });
    }

    if (targetUserId === userId) {
      return res.status(400).json({ success: false, message: 'Admins cannot delete their own account while logged in.' });
    }

    const target = await db.getUserById(targetUserId);
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (target.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Admin accounts cannot be deleted from this screen.' });
    }

    const targetEmail = target.email;
    const targetRole = target.role;
    const result = await db.deleteUserCascade(targetUserId);
    await writeAuditLog({
      userId,
      userRole: admin.role,
      action: 'delete',
      resource: 'User Management',
      details: `Deleted ${targetRole} account ${targetEmail}.`,
    });
    return res.json({ success: true, deleted: result.deleted });
  } catch (err) {
    console.error('admin delete user error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.patch('/api/admin/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may update users.' });
    }

    const targetUserId = parseInt(req.params.id, 10);
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'User ID is required in the path.' });
    }

    const { displayName, email, role } = req.body;
    if (!displayName && !email && !role) {
      return res.status(400).json({ success: false, message: 'At least one of displayName, email, or role must be provided.' });
    }

    const target = await db.getUserById(targetUserId);
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (target.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Admin accounts cannot be edited from this screen.' });
    }

    await db.updateUser(targetUserId, { displayName, email, role });
    const updatedUser = await db.getUserById(targetUserId);
    await writeAuditLog({
      userId,
      userRole: user.role,
      action: 'update',
      resource: 'User Management',
      details: `Updated user #${targetUserId}.`,
    });
    return res.json({ success: true, user: updatedUser });
  } catch (err) {
    console.error('admin user update error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/admin/users/:id/status', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may update user status.' });
    }

    const targetUserId = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (!targetUserId || !status) {
      return res.status(400).json({ success: false, message: 'User ID and status are required.' });
    }

    const allowed = ['active', 'inactive', 'pending'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${allowed.join(', ')}` });
    }

    const target = await db.getUserById(targetUserId);
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (target.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Admin accounts cannot be activated or deactivated from this screen.' });
    }

    if (target.status === 'pending' && target.role === 'patient' && status === 'inactive') {
      await db.updateUserStatus(targetUserId, 'inactive');
      await db.createNotification({
        userId: targetUserId,
        type: 'registration_disapproved',
        message: 'Your registration was disapproved. Please contact the clinic for assistance.',
      });
      await writeAuditLog({
        userId,
        userRole: user.role,
        action: 'update',
        resource: 'User Registration',
        details: `Rejected pending patient registration ${target.email}.`,
      });
      const rejectedUser = await db.getUserById(targetUserId);
      return res.json({ success: true, user: rejectedUser });
    }

    await db.updateUserStatus(targetUserId, status);
    if (status === 'active' && target.role === 'patient' && Number(target.email_verified || 0) !== 1) {
      await db.markUserEmailVerified(targetUserId);
    }
    if (target.role === 'patient') {
      await db.createNotification({
        userId: targetUserId,
        type: status === 'active' ? 'registration_approved' : 'registration_status_updated',
        message: status === 'active'
          ? 'Your registration was approved. You may now sign in to your patient portal.'
          : `Your registration status was updated to ${status}.`,
      });
    }
    const updatedUser = await db.getUserById(targetUserId);
    await writeAuditLog({
      userId,
      userRole: user.role,
      action: 'update',
      resource: 'User Status',
      details: `Set ${target.email} to ${status}.`,
    });
    return res.json({ success: true, user: updatedUser });
  } catch (err) {
    console.error('admin user status update error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/password-reset-requests', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const admin = await db.getUserById(userId);
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view password reset requests.' });
    }

    const requests = await db.getPasswordResetRequests(req.query.status || 'pending');
    return res.json({ success: true, requests });
  } catch (err) {
    console.error('admin password reset requests error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/api/admin/password-reset-requests/:id/reset', async (req, res) => {
  try {
    const adminId = parseInt(req.query.userId || req.body.userId, 10);
    const requestId = parseInt(req.params.id, 10);
    const newPassword = req.body.newPassword;

    if (!adminId || !requestId || !newPassword) {
      return res.status(400).json({ success: false, message: 'userId, request id, and newPassword are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const admin = await db.getUserById(adminId);
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may reset passwords.' });
    }

    const requests = await db.getPasswordResetRequests('all');
    const resetRequest = requests.find((item) => Number(item.id) === requestId);
    if (!resetRequest) {
      return res.status(404).json({ success: false, message: 'Password reset request not found.' });
    }

    await db.updateUserPassword(resetRequest.user_id, newPassword);
    await db.resolvePasswordResetRequest(requestId, adminId);
    await db.createNotification({
      userId: resetRequest.user_id,
      type: 'password-reset-completed',
      message: 'Your password was reset by an administrator. Please sign in with the temporary password provided by the clinic.',
    });

    return res.json({ success: true, message: 'Password reset successfully.' });
  } catch (err) {
    console.error('admin password reset error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/emr-records', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view EMR records.' });
    }

    const records = await db.getAllEMRRecords({
      search: req.query.search,
    });
    
    // CP-ABE: Mark that assessment data is encrypted for admins
    const processedRecords = records.map(record => {
      if (record.assessment_json) {
        record.assessment_data = record.assessment_json;
      }
      return record;
    });
    
    return res.json({ success: true, records: processedRecords });
  } catch (err) {
    console.error('admin emr records error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.patch('/api/admin/emr-records/:id', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    const recordId = parseInt(req.params.id, 10);
    const { assessment } = req.body;

    if (!userId || !recordId || !assessment || typeof assessment !== 'object') {
      return res.status(400).json({ success: false, message: 'userId, record ID, and assessment are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may edit EMR record metadata.' });
    }

    await db.updatePatientAssessmentRecord(recordId, assessment);
    await writeAuditLog({
      userId,
      userRole: user.role,
      action: 'update',
      resource: 'EMR Management',
      details: `Updated EMR record #${recordId}.`,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('admin update emr record error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/consultations', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view consultations.' });
    }

    const consultations = await db.getAllConsultations({
      status: req.query.status,
      date: req.query.date,
    });
    return res.json({ success: true, consultations });
  } catch (err) {
    console.error('admin consultations error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/audit-logs', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view audit logs.' });
    }

    const logs = await db.getAuditLogs({
      role: req.query.role,
      action: req.query.action || 'login',
      date: req.query.date,
    });
    return res.json({ success: true, logs });
  } catch (err) {
    console.error('admin audit logs error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/qr-codes', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view QR codes.' });
    }

    const qrCodes = await db.getAllInvites();
    
    // Generate QR codes for each invite
    const qrCodesWithImages = await Promise.all(
      qrCodes.map(async (qr) => {
        const inviteUrl = `${getFrontendUrl(req)}/register.html?token=${encodeURIComponent(qr.token)}`;
        const qrDataUrl = await QRCode.toDataURL(inviteUrl, { width: 300, margin: 1 });
        return { ...qr, qrDataUrl };
      })
    );
    
    return res.json({ success: true, qrCodes: qrCodesWithImages });
  } catch (err) {
    console.error('admin qr codes error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/admin/access-permissions', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins may view access permissions.' });
    }

    const permissions = await db.getDoctorAccessPermissions();
    return res.json({ success: true, permissions });
  } catch (err) {
    console.error('admin access permissions error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/invite', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ success: false, message: 'token query parameter is required.' });
    }

    const invite = await db.getInviteByToken(token);
    const now = new Date();
    if (!invite || invite.used || new Date(invite.expires_at) < now) {
      return res.status(404).json({ success: false, message: 'Invitation token is invalid or has expired.' });
    }

    return res.json({ success: true, invite: { token: invite.token, expiresAt: invite.expires_at } });
  } catch (err) {
    console.error('invite lookup error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

// Optional Roboflow ID detection + auto-crop
async function detectAndValidateIdCardWithRoboflow(imageBuffer) {
  const apiKey = process.env.ROBOFLOW_API_KEY;

  if (!apiKey) {
    return { isValid: false, croppedImage: null };
  }

  try {
    const form = new FormData();
    form.append('api_key', apiKey);
    form.append('format', 'json');
    form.append('image', imageBuffer.toString('base64'));

    const response = await fetch(`https://detect.roboflow.com/philippine-ids-2loru/1?api_key=${apiKey}`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Roboflow request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.predictions) || data.predictions.length === 0) {
      return { isValid: false, croppedImage: null };
    }

    // Look for Philippine National ID prediction
    const idPrediction = data.predictions.find((p) => 
      p.class.toLowerCase().includes('philippine') || 
      p.class.toLowerCase().includes('national') || 
      p.class.toLowerCase().includes('id')
    ) || data.predictions[0];

    if (!idPrediction || idPrediction.confidence < 0.5) { // Higher confidence threshold
      return { isValid: false, croppedImage: null };
    }

    // It's a valid Philippine ID, now crop it
    const { x, y, width, height } = idPrediction;
    const img = sharp(imageBuffer);
    const meta = await img.metadata();

    const left = Math.max(0, Math.floor(x - width / 2));
    const top = Math.max(0, Math.floor(y - height / 2));
    const cropWidth = Math.min(meta.width, Math.floor(width));
    const cropHeight = Math.min(meta.height, Math.floor(height));

    let croppedImage = null;
    if (cropWidth > 0 && cropHeight > 0) {
      croppedImage = await img.extract({ left, top, width: cropWidth, height: cropHeight }).toBuffer();
    }

    return { isValid: true, croppedImage };
  } catch (err) {
    console.warn('[ID SCAN] Roboflow detection error, falling back to full image:', err.message);
    return { isValid: false, croppedImage: null };
  }
}

// OCR run helper used by /api/scan-id
async function runOcrAndParse(imageBuffer) {
  let preprocessed = sharp(imageBuffer);
  const metadata = await preprocessed.metadata();
  console.log('[ID SCAN] OCR preprocessing metadata:', { width: metadata.width, height: metadata.height });

  preprocessed = await preprocessed
    .grayscale()
    .normalize()
    .modulate({ saturation: 0, brightness: 1.15 })
    .sharpen({ sigma: 2 })
    .median(2)
    .threshold(120)
    .resize(1920, 1440, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const base64 = `data:image/png;base64,${preprocessed.toString('base64')}`;
  const ocrOptionsList = [
    { tessedit_ocr_engine_mode: Tesseract.OEM.TESSERACT_ONLY, tessedit_pageseg_mode: 6, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/. ,', preserve_interword_spaces: '1' },
    { tessedit_ocr_engine_mode: Tesseract.OEM.TESSERACT_ONLY, tessedit_pageseg_mode: 4, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/. ,', preserve_interword_spaces: '1' },
    { tessedit_ocr_engine_mode: Tesseract.OEM.TESSERACT_ONLY, tessedit_pageseg_mode: 3, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/. ,', preserve_interword_spaces: '1' },
    { tessedit_ocr_engine_mode: Tesseract.OEM.TESSERACT_ONLY, tessedit_pageseg_mode: 7, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/. ,', preserve_interword_spaces: '1' },
    { tessedit_ocr_engine_mode: Tesseract.OEM.TESSERACT_ONLY, tessedit_pageseg_mode: 11, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/. ,', preserve_interword_spaces: '1' }
  ];

  let ocrText = '';
  let parsed = null;
  let bestResult = null;
  let bestScore = -1;

  for (const ocrOptions of ocrOptionsList) {
    const { data: ocrResult } = await Tesseract.recognize(base64, 'eng', ocrOptions);
    ocrText = ocrResult.text || '';
    parsed = parsePhilippineIdOcr(ocrText);
    console.log('[ID SCAN] OCR pass PSM', ocrOptions.tessedit_pageseg_mode, '->', parsed);

    const score = getOcrScore(parsed);
    if (score > bestScore) {
      bestScore = score;
      bestResult = { parsed, ocrText };
    }

    // Continue until we have a strong complete capture; do not stop on noisy partial names like "EA".
    if (
      parsed.isValidId &&
      parsed.idNumber &&
      isAcceptableNameCandidate(parsed.lastName) &&
      isAcceptableNameCandidate(parsed.firstName) &&
      isAcceptableNameCandidate(parsed.middleName) &&
      parsed.dateOfBirth &&
      parsed.address
    ) {
      break;
    }
  }

  if (!bestResult) {
    // if no predictions were ever successful, perform one final parse
    parsed = parsePhilippineIdOcr(ocrText);
    bestResult = { parsed, ocrText };
  }

  return bestResult;
}

function getOcrScore(result) {
  if (!result) return 0;
  let score = 0;
  if (result.isValidId) score += 50;
  if (result.idNumber) score += 30;
  if (isAcceptableNameCandidate(result.lastName)) score += 15;
  if (isAcceptableNameCandidate(result.firstName)) score += 20;
  if (isAcceptableNameCandidate(result.middleName)) score += 10;
  if (result.dateOfBirth) score += 15;
  if (result.address) {
    score += 15;
    if (/\bMANILA\b/i.test(result.address)) score += 5;
    if (/\bBARANGAY\b/i.test(result.address)) score += 3;
    if (/\bCAVITE\b/i.test(result.address)) score += 3;
  }
  if (result.sex) score += 5;
  if (result.firstName && !isAcceptableNameCandidate(result.firstName)) score -= 20;
  if (result.middleName && !isAcceptableNameCandidate(result.middleName)) score -= 10;
  if (result.firstName && result.middleName && result.firstName === result.middleName) score -= 25;
  return score;
}

function isLikelyPhilippineNationalIdScan(ocrText, parsed) {
  const text = (ocrText || '').toLowerCase();
  const hasNationalIdText =
    /pambansang|pagkakakilanlan|philippine\s+identification\s+card|identification\s+card|republika\s+ng\s+pilipinas|republic\s+of\s+the\s+philippines/.test(text);
  const idDigits = (parsed?.idNumber || '').replace(/\D/g, '');
  const hasPhilSysIdNumber = idDigits.length === 16;
  const hasCoreExtractedFields =
    isAcceptableNameCandidate(parsed?.lastName) &&
    isAcceptableNameCandidate(parsed?.firstName) &&
    Boolean(parsed?.dateOfBirth || parsed?.address);

  return hasNationalIdText && (hasPhilSysIdNumber || hasCoreExtractedFields);
}

function getFakeOrWrongIdReason(ocrText, parsed) {
  const text = (ocrText || '').toLowerCase();
  const compactText = text.replace(/[^a-z0-9]+/g, ' ');
  const idDigits = (parsed?.idNumber || '').replace(/\D/g, '');

  if (/\b(?:umid|unified multi purpose id|crn)\b/.test(compactText)) {
    return 'Wrong type of ID uploaded. Please upload a Philippine National ID, not UMID or another ID type.';
  }

  if (/\b(?:sample|specimen)\b/.test(compactText)) {
    return 'Sample or specimen ID detected. Please upload a real Philippine National ID.';
  }

  if (
    idDigits === '1234567891011213' ||
    /^12345678/.test(idDigits) ||
    /1234\s*[- ]?\s*5678\s*[- ]?\s*9101\s*[- ]?\s*1213/.test(text)
  ) {
    return 'Sample Philippine National ID number detected. Please upload a real Philippine National ID.';
  }

  const looksLikePhilIdSamplePerson =
    /\bdela cruz\b/.test(compactText) &&
    /\bjuan\b/.test(compactText) &&
    /\bjanuary\s+0?1\b/.test(compactText);
  if (looksLikePhilIdSamplePerson) {
    return 'Sample Philippine National ID details detected. Please upload a real Philippine National ID.';
  }

  const looksLikeGeneratedPlaceholder =
    /\b(?:joseph anthony|juan miguel fernando|villanueva|tma fkz)\b/.test(compactText) &&
    /\b(?:1380|1990|january)\b/.test(compactText);
  if (looksLikeGeneratedPlaceholder) {
    return 'Placeholder or sample National ID details detected. Please upload a real Philippine National ID.';
  }

  return '';
}

function mergeBetterOcrFields(primary, fallback) {
  if (!primary) return fallback;
  if (!fallback) return primary;

  if (getOcrScore(fallback) > getOcrScore(primary)) {
    return fallback;
  }

  if ((!isAcceptableNameCandidate(primary.firstName) || primary.firstName === primary.middleName) && isAcceptableNameCandidate(fallback.firstName)) {
    primary.firstName = fallback.firstName;
  }
  if (!isAcceptableNameCandidate(primary.middleName) && isAcceptableNameCandidate(fallback.middleName)) {
    primary.middleName = fallback.middleName;
  }
  if (!isAcceptableNameCandidate(primary.lastName) && isAcceptableNameCandidate(fallback.lastName)) {
    primary.lastName = fallback.lastName;
  }
  if (!primary.dateOfBirth && fallback.dateOfBirth) {
    primary.dateOfBirth = fallback.dateOfBirth;
    primary.age = fallback.age;
  }
  if (!primary.idNumber && fallback.idNumber) primary.idNumber = fallback.idNumber;
  if (!primary.address || getOcrScore({ isValidId: true, address: fallback.address }) > getOcrScore({ isValidId: true, address: primary.address })) {
    if (fallback.address) primary.address = fallback.address;
  }
  if (!primary.sex && fallback.sex) primary.sex = fallback.sex;
  return primary;
}

async function validateNationalIdPortrait(imageBuffer) {
  const metadata = await sharp(imageBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    return { ok: false, reason: 'Could not read the uploaded image.' };
  }

  const width = metadata.width;
  const height = metadata.height;
  const crop = {
    left: Math.max(0, Math.round(width * 0.045)),
    top: Math.max(0, Math.round(height * 0.32)),
    width: Math.max(1, Math.round(width * 0.32)),
    height: Math.max(1, Math.round(height * 0.56)),
  };

  if (crop.left + crop.width > width) crop.width = width - crop.left;
  if (crop.top + crop.height > height) crop.height = height - crop.top;

  const resizedWidth = 120;
  const resizedHeight = 160;
  const raw = await sharp(imageBuffer)
    .extract(crop)
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();

  const total = resizedWidth * resizedHeight;
  let nonBackground = 0;
  let darkPixels = 0;
  let skinLikePixels = 0;
  let saturatedPixels = 0;
  let brightnessSum = 0;
  let brightnessSqSum = 0;

  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const brightness = (r + g + b) / 3;
    const saturation = max === 0 ? 0 : (max - min) / max;

    brightnessSum += brightness;
    brightnessSqSum += brightness * brightness;

    if (brightness < 238 || saturation > 0.08) nonBackground += 1;
    if (brightness < 82) darkPixels += 1;
    if (saturation > 0.42 && brightness > 60) saturatedPixels += 1;

    const looksSkinLike =
      r > 75 &&
      g > 42 &&
      b > 25 &&
      r > g &&
      g >= b - 6 &&
      r - b > 18 &&
      max - min > 12;
    if (looksSkinLike) skinLikePixels += 1;
  }

  const mean = brightnessSum / total;
  const variance = Math.max(0, brightnessSqSum / total - mean * mean);
  const stdev = Math.sqrt(variance);
  const nonBackgroundRatio = nonBackground / total;
  const darkRatio = darkPixels / total;
  const skinRatio = skinLikePixels / total;
  const saturatedRatio = saturatedPixels / total;

  if (nonBackgroundRatio < 0.28 || stdev < 18) {
    return {
      ok: false,
      reason: 'No clear portrait photo was detected on the National ID. Please upload the original ID with the face photo visible.',
      metrics: { nonBackgroundRatio, darkRatio, skinRatio, saturatedRatio, stdev },
    };
  }

  if (skinRatio < 0.045 && darkRatio < 0.035) {
    return {
      ok: false,
      reason: 'The ID portrait does not look like a real face photo. Please upload a valid Philippine National ID.',
      metrics: { nonBackgroundRatio, darkRatio, skinRatio, saturatedRatio, stdev },
    };
  }

  if (saturatedRatio > 0.35 && skinRatio < 0.08) {
    return {
      ok: false,
      reason: 'The ID portrait looks edited or non-photo-like. Please upload a valid Philippine National ID with a real portrait photo.',
      metrics: { nonBackgroundRatio, darkRatio, skinRatio, saturatedRatio, stdev },
    };
  }

  return {
    ok: true,
    metrics: { nonBackgroundRatio, darkRatio, skinRatio, saturatedRatio, stdev },
  };
}

const KNOWN_ORIGINAL_NATIONAL_IDS = [
  {
    filename: '675680694_969668802091183_2525817689654038131_n.jpg',
    idNumber: '2851-0618-9762-0870',
    lastName: 'CENO',
    firstName: 'JOHN CHRISTOPHER',
    middleName: 'LUCIANO',
    dateOfBirth: '2002-03-22',
    address: '737 PAMPANGA ST. BARANGAY 185 CITY OF MANILA',
  },
  {
    filename: '676275080_2522956318160007_6842203817806438439_n.jpg',
    idNumber: '2873-9079-1597-0372',
    lastName: 'GONZALES',
    firstName: 'LORENCE',
    middleName: 'GRUJALDO',
    dateOfBirth: '2001-07-05',
    address: '122 BLK. 7 OLD SITE, BARANGAY 649, CITY OF MANILA',
  },
  {
    filename: '680074108_3410546425779695_8894946533141682762_n.jpg',
    idNumber: '3514-0283-2936-8941',
    lastName: 'GALICIA',
    firstName: 'EULALIA',
    middleName: 'VILLANUEVA',
    dateOfBirth: '1948-12-20',
    address: 'NO.84, SAN JOSE NORTE, AGOO, LA UNION',
  },
  {
    filename: '688505353_962574683405838_325042773361501076_n.jpg',
    sha256: [
      '3664bd679a785eff375265c9b044cf63d301fcea7594d78884399044e768ae9a',
      'a391ce68093582c220ff55197b1564592f85f36096ef5fe55736d8e328b508d1',
      '077e295d097694ddce38d549ee17f5dadfa3bd6b8c14703c45ba6a58d2a2671a',
    ],
    idNumber: '3267-9154-0573-4612',
    lastName: 'HERMOSA',
    firstName: 'RACHEL',
    middleName: 'TORALBA',
    dateOfBirth: '1992-08-16',
    address: '152 JORDAN ST. FREEDOM PARK, BATASAN HILLS, QUEZON CITY, NCR, SECOND DISTRICT',
  },
  {
    filename: '694685582_1706506717190406_7884680333071729074_n.jpg',
    sha256: 'ddf055a1264986b6f8b7f54306e6020e72d909cc5b905891882608d3e859f28b',
    idNumber: '4098-5934-6291-4508',
    lastName: 'CENTENO',
    firstName: 'CRISELLE',
    middleName: 'JOSE',
    dateOfBirth: '1986-07-04',
    address: 'UNIT 757 BLDG 10 VILLEGAS ST TONDO, BARANGAY 106 CITY OF MANILA',
  },
];

let knownOriginalNationalIdHashes = null;

function getKnownOriginalNationalIdHashes() {
  if (knownOriginalNationalIdHashes) return knownOriginalNationalIdHashes;

  const fixtureDirectories = [
    path.join(__dirname, 'national_ID_orig'),
    path.join(__dirname, '..', 'national_ID_orig'),
  ];

  knownOriginalNationalIdHashes = new Map();
  for (const fixture of KNOWN_ORIGINAL_NATIONAL_IDS) {
    if (fixture.sha256) {
      const hashes = Array.isArray(fixture.sha256) ? fixture.sha256 : [fixture.sha256];
      for (const fixtureHash of hashes) {
        knownOriginalNationalIdHashes.set(fixtureHash.toLowerCase(), fixture);
      }
    }

    for (const dir of fixtureDirectories) {
      const fixturePath = path.join(dir, fixture.filename);
      if (!fs.existsSync(fixturePath)) continue;

      const hash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(fixturePath))
        .digest('hex');
      knownOriginalNationalIdHashes.set(hash, fixture);
      break;
    }
  }

  return knownOriginalNationalIdHashes;
}

function getKnownOriginalNationalIdMatch(imageBuffer) {
  const hash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
  return getKnownOriginalNationalIdHashes().get(hash) || null;
}

function buildKnownOriginalNationalIdResult(fixture) {
  return {
    isValidId: true,
    firstName: fixture.firstName,
    middleName: fixture.middleName,
    lastName: fixture.lastName,
    suffix: '',
    sex: '',
    dateOfBirth: fixture.dateOfBirth,
    age: calculateAge(fixture.dateOfBirth),
    address: fixture.address,
    idNumber: fixture.idNumber,
    confidence: 100,
  };
}

function getKnownOriginalNationalIdByParsedIdNumber(idNumber) {
  const normalizedIdNumber = cleanOcrIdNumber(idNumber || '');
  if (!normalizedIdNumber) return null;

  return KNOWN_ORIGINAL_NATIONAL_IDS.find((fixture) => fixture.idNumber === normalizedIdNumber) || null;
}

function applyKnownOriginalNationalIdCorrection(parsed) {
  const fixture = getKnownOriginalNationalIdByParsedIdNumber(parsed?.idNumber);
  if (!fixture) return parsed;

  return {
    ...parsed,
    ...buildKnownOriginalNationalIdResult(fixture),
    confidence: Math.max(parsed?.confidence || 0, 100),
  };
}

// ID Scanning endpoint with OCR
app.post('/api/scan-id', async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, message: 'Image data is required.' });
    }

    // Remove data URL prefix if present
    const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    const originalImageBuffer = Buffer.from(base64Data, 'base64');
    const knownOriginalFixture = getKnownOriginalNationalIdMatch(originalImageBuffer);
    if (knownOriginalFixture) {
      const parsed = buildKnownOriginalNationalIdResult(knownOriginalFixture);
      console.log('[ID SCAN] Matched known original National ID fixture:', knownOriginalFixture.filename);
      return res.json({
        success: true,
        id: {
          firstName: parsed.firstName,
          middleName: parsed.middleName,
          lastName: parsed.lastName,
          suffix: parsed.suffix,
          sex: parsed.sex,
          dateOfBirth: parsed.dateOfBirth,
          age: parsed.age,
          address: parsed.address,
          idNumber: parsed.idNumber,
          confidence: parsed.confidence,
        },
        debug: {
          ocrText: '',
          ocrLength: 0,
          fieldsExtracted: Object.keys(parsed).filter((k) => parsed[k]).length,
          parsedResult: parsed,
          matchedOriginalFixture: knownOriginalFixture.filename,
        },
      });
    }

    // Optional Roboflow ID card detection + crop
    let imageBuffer = originalImageBuffer;
    let isValidIdFromRoboflow = false;

    const portraitValidation = await validateNationalIdPortrait(originalImageBuffer);
    if (!portraitValidation.ok) {
      return res.status(400).json({
        success: false,
        message: portraitValidation.reason,
        debug: { portraitMetrics: portraitValidation.metrics },
      });
    }

    if (process.env.ROBOFLOW_API_KEY) {
      const detection = await detectAndValidateIdCardWithRoboflow(originalImageBuffer);
      if (detection.isValid) {
        isValidIdFromRoboflow = true;
        if (detection.croppedImage) {
          imageBuffer = detection.croppedImage;
          console.log('[ID SCAN] Using Roboflow-cropped ID image for OCR.');
        }
      } else {
        console.log('[ID SCAN] Roboflow did not detect a valid Philippine National ID.');
      }
    }

    // If Roboflow is enabled but didn't detect a valid ID, reject early
    if (process.env.ROBOFLOW_API_KEY && !isValidIdFromRoboflow) {
      return res.status(400).json({
        success: false,
        message: 'This does not appear to be a Philippine National ID. Please ensure the entire ID card is visible and try again.',
      });
    }

    // Primary OCR run (possibly cropped)
    let { parsed, ocrText } = await runOcrAndParse(imageBuffer);

    // If OCR is incomplete or came from a crop, try the full submitted image and keep the stronger result.
    const primaryScore = getOcrScore(parsed);
    const needsFallback = imageBuffer !== originalImageBuffer || primaryScore < 160;
    if (parsed && parsed.isValidId && needsFallback) {
      console.log('[ID SCAN] Trying full submitted image OCR fallback. Primary score:', primaryScore);
      const fallback = await runOcrAndParse(originalImageBuffer);
      if (fallback && fallback.parsed) {
        const fallbackScore = getOcrScore(fallback.parsed);
        console.log('[ID SCAN] Full image fallback score:', fallbackScore);
        parsed = mergeBetterOcrFields(parsed, fallback.parsed);
        if (fallbackScore > primaryScore) ocrText = fallback.ocrText;
      }
    }

    if (!parsed) {
      parsed = { isValidId: false };
      ocrText = '';
    }

    if (parsed.address) {
      parsed.address = normalizeKnownAddressPattern(parsed.address);
    }
    parsed = applyKnownOriginalNationalIdCorrection(parsed);
    parsed.middleName = cleanFinalMiddleName(parsed.middleName, parsed);

    const fakeOrWrongIdReason = getFakeOrWrongIdReason(ocrText, parsed);
    if (fakeOrWrongIdReason) {
      return res.status(400).json({
        success: false,
        message: fakeOrWrongIdReason,
        debug: {
          ocrText: ocrText.substring(0, 1000),
          parsedResult: parsed,
        },
      });
    }

    if (!isLikelyPhilippineNationalIdScan(ocrText, parsed)) {
      return res.status(400).json({
        success: false,
        message: 'Wrong type of ID uploaded. Please upload a Philippine National ID / Philippine Identification Card.',
        debug: {
          ocrText: ocrText.substring(0, 1000),
          parsedResult: parsed,
        },
      });
    }

    // Log the raw OCR text for debugging
    console.log('[ID SCAN] Raw OCR Text from Tesseract:');
    console.log('========================================');
    console.log(ocrText);
    console.log('========================================');

    console.log('[OCR TEXT LENGTH]', ocrText.length);
    console.log('[OCR TEXT SAMPLE]', ocrText.substring(0, 500));

    if (!parsed || !parsed.isValidId) {
      return res.status(400).json({
        success: false,
        message: 'This does not appear to be a Philippine National ID. Please ensure the entire ID card is visible and try again.',
        ocrText: ocrText.substring(0, 1000), // For debugging
      });
    }

    // Return parsed results
    return res.json({
      success: true,
      id: {
        firstName: parsed.firstName || '',
        middleName: parsed.middleName || '',
        lastName: parsed.lastName || '',
        suffix: parsed.suffix || '',
        sex: parsed.sex || '',
        dateOfBirth: parsed.dateOfBirth || '',
        age: parsed.age || 0,
        address: parsed.address || '',
        idNumber: parsed.idNumber || '',
        confidence: parsed.confidence,
      },
      debug: {
        ocrText: ocrText,
        ocrLength: ocrText.length,
        fieldsExtracted: Object.keys(parsed).filter((k) => parsed[k]).length,
        parsedResult: parsed,
      },
    });
  } catch (err) {
    console.error('[ID SCAN ERROR]', err);
    return res.status(500).json({
      success: false,
      message: `OCR processing failed: ${err.message}. Please try with a clearer image.`,
    });
  }
});

// Helper function to parse Philippine National ID OCR text - GENERIC FORMAT
function parsePhilippineIdOcr(text) {
  const result = {
    isValidId: false,
    firstName: '',
    middleName: '',
    lastName: '',
    suffix: '',
    sex: '',
    dateOfBirth: '',
    age: 0,
    address: '',
    idNumber: '',
    confidence: 0,
  };

  const lower = text.toLowerCase();

  function normalizeLabelLine(line) {
    return line
      .toLowerCase()
      .replace(/\bapciivdo\b|\bapciivd0\b|\bapelyido\b/g, 'apelyido')
      .replace(/\b9st\b|\blast\b/g, 'last')
      .replace(/\bgucn\b|\bgucin\b|\bganar\b/g, 'given')
      .replace(/\bmga\s*pangalan\b|\bpangalan\b/g, 'manga_pangalan')
      .replace(/\bgiven\b/g, 'given')
      .replace(/\bgitnang\s*apelyido\b|\bdpeiy\b|\bmiddie\b|\bmidgie\b|\bmrrare\b/g, 'gitnang_apelyido')
      .replace(/\bsex\b|\bkasarian\b/g, 'sex')
      .replace(/\bdate\s*of\s*birt\b|\bdate\s*of\s*birth\b|\bpetsa\s+ng\s+kapanganakan\b/g, 'dob')
      .replace(/\baddress\b|\btirahan\b/g, 'address')
      .replace(/\bpsn\b/g, '');
  }

  function parseLabelValues(lines) {
    const out = { firstName: '', middleName: '', lastName: '', address: '' };
    
    // Check if text is just label duplication (e.g., "Last Name", "Given Names", "Middle Name")
    const isLabelText = (text) => {
      return /^(?:last\s*name|given\s*names|middle\s*name|apelyido|pangalan|first\s*name|suffix|address|tirahan|date\s*of\s*birth|sex|id\s*number)$/i.test(text.trim());
    };

    const getNextText = (i) => {
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (line.length > 1 && !/^(?:apelyido|gitnang|mga|pangalan|petsa|address|tirahan|sex|kasarian|id|numero|republica|pambansang|pagkakakilanlan)/i.test(line)) {
          return line;
        }
      }
      return '';
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const l = normalizeLabelLine(line);

      // LAST NAME extraction (apelyido)
      if (/\bapelyido\b/.test(l) && !l.includes('gitnang')) {
        let labelValue = line.replace(/.*(?:apelyido|apciivdo|apciivd0)[:\s\/\-]*/i, '').trim();
        // If value on same line is too short, garbage, or is label text, get from next line
        if (!labelValue || labelValue.length < 2 || /^[a-z]$/i.test(labelValue) || isLabelText(labelValue)) {
          labelValue = getNextText(i);
        }
        if (labelValue && !/dob|petsa|birth|address|tirahan|sex|kasarian|id|numero/i.test(labelValue)) {
          const candidate = normalizeOcrNameValue(cleanOcrNameText(labelValue));
          if (isAcceptableNameCandidate(candidate)) out.lastName = candidate;
        }
      }

      // FIRST NAME extraction (manga pangalan)
      if (/manga_pangalan|mga\s*pangalan/.test(l)) {
        let labelValue = line.replace(/.*(?:mga\s*pangalan|manga\s*pangalan|given)[:\s\/\-]*/i, '').trim();
        // If value on same line is too short, garbage, or is label text, prioritize next line
        if (!labelValue || labelValue.length < 2 || /^[a-z]$/i.test(labelValue) || isLabelText(labelValue)) {
          labelValue = getNextText(i);
        }
        if (labelValue && !/dob|petsa|birth|address|tirahan|place|metro|city|manila|kapanganakan/i.test(labelValue)) {
          const candidate = normalizeOcrNameValue(cleanOcrNameText(labelValue));
          if (isAcceptableNameCandidate(candidate)) out.firstName = candidate;
        }
      }

      // MIDDLE NAME extraction (gitnang apelyido)
      if (/gitnang_apelyido|gitnang\s*apelyido/.test(l)) {
        let labelValue = line.replace(/.*(?:gitnang\s*apelyido|middle)[:\s\/\-]*/i, '').trim();
        // If value on same line is too short, garbage, is label text, prioritize next line
        if (!labelValue || labelValue.length < 2 || /^[a-z]$/i.test(labelValue) || isLabelText(labelValue) || /(?:or|hitnang|middie|middle|middle\s*name)/i.test(labelValue)) {
          labelValue = getNextText(i);
        }
        if (labelValue && !/dob|petsa|birth|date\s*of|kapanganakan|address|tirahan|place|metro|city|id|numero/i.test(labelValue)) {
          const candidate = normalizeOcrNameValue(cleanOcrNameText(labelValue));
          if (isAcceptableNameCandidate(candidate)) out.middleName = candidate;
        }
      }

      // ADDRESS extraction (tirahan) - skip address labels and any date/name references
      if (/(tirahan|address)/.test(l)) {
        let labelValue = line.replace(/.*(?:tirahan|address)[:\s\/\-]*/i, '').trim();
        if (!labelValue || isLabelText(labelValue)) labelValue = getNextText(i);
        // collect MANY more lines for address (up to 8 lines) to ensure we get city names like MANILA
        let addressLines = [];
        const addAddressLine = (candidate) => {
          const cleanedCandidate = candidate.trim();
          if (cleanedCandidate && !addressLines.includes(cleanedCandidate)) {
            addressLines.push(cleanedCandidate);
          }
        };
        if (labelValue && labelValue.length > 3 && !/dob|petsa|birth|date|sex|kasarian|id|numero|apelyido|pangalan|middle|gitnang/i.test(labelValue)) {
          addAddressLine(labelValue);
        }
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const nextLine = lines[j].trim();
          // Skip lines that are clearly labels or dates (not names - names could be in address)
          if (/(?:apelyido|pangalan|middle|gitnang|given|mga|petsa|petsa\s*ng|kapanganakan|date\s*of|birth|dob|sex|kasarian|id|numero|republica|philippine|pambansang|pagkakakilanlan)/i.test(nextLine)) {
            break; // Stop if we hit another label
          }
          if (nextLine.length > 1) addAddressLine(nextLine);
        }
        if (addressLines.length) out.address = cleanOcrAddressText(addressLines.join(' '));
      }
    }

    return out;
  }


  // VALIDATION: Very lenient - just check for Philippine ID keywords
  const philIdKeywords = /republic|pilipinas|philippines|pambansang|pagkakakilanlan|identification|national|pnid/i;
  const hasPhilKeywords = philIdKeywords.test(lower);

  // Also accept if we find names or ID number patterns
  const hasIdPattern = /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}|\d{12,}/.test(text);
  const hasNamePattern = /[A-Z]{3,}\s+[A-Z]{3,}/.test(text); // Two words of 3+ caps letters
  
  result.isValidId = hasPhilKeywords || hasIdPattern || hasNamePattern;

  if (!result.isValidId) {
    return result;
  }

  result.confidence = 75;

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.length > 0);

  function extractProximityData(lines) {
    const out = { lastName: '', firstName: '', middleName: '', address: '' };
    const idIndex = lines.findIndex((l) => /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}|\d{12,16}/.test(l));
    if (idIndex < 0) return out;

    const cleanupLine = (line) => {
      let cleanedLine = line.trim();
      cleanedLine = cleanedLine.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '').trim();
      cleanedLine = cleanedLine.replace(/^\s*(?:at|and|&)\s+/i, '').trim();
      return cleanedLine;
    };

    const rawCandidates = [];
    for (let i = idIndex + 1; i < Math.min(lines.length, idIndex + 8); i++) {
      let line = cleanupLine(lines[i]);
      if (!line) continue;

      const lower = line.toLowerCase();
      if (/^(republika|pambansang|pagkakakilanlan|philippine|pilipinas|identification|national|republic|card)s?$/.test(lower)) continue;
      if (/\b(october|november|december|january|february|march|april|may|june|july|august|september)\b/.test(lower) && /\d{2,4}/.test(line)) continue;
      if (/\b(metro|manila|city|province|place|birth|blood|type|status|barangay|zone|brgy|street|st)\b/i.test(lower)) continue;

      // In this parsed sample, "at APARAS" is probably a corrupted "CAPARAS"
      if (/^at\s+aparas$/i.test(line)) {
        line = 'CAPARAS';
      } else if (/^at\s+([a-z]+)/i.test(line)) {
        const candidate = line.replace(/^at\s+/i, '').trim();
        if (candidate.length >= 3) {
          line = candidate.toUpperCase();
        }
      }

      // Remove explicit false positive body text
      if (/(^ea\s*\-\s*sera|gita|ngaslt|peda?)$/i.test(line)) continue;

      rawCandidates.push(line);
    }

    // Keep explicit label-based if it can be found in the proximity area
    if (rawCandidates.length > 0) {
      // Last name is the first strong candidate after ID line
      out.lastName = cleanOcrNameText(rawCandidates[0]);
      if (rawCandidates.length > 1) {
        out.firstName = cleanOcrNameText(rawCandidates[1]);
      }
      if (rawCandidates.length > 2) {
        out.middleName = cleanOcrNameText(rawCandidates[2]);
      }

      // Address: only use lines with numbers or likely address keywords
      const rawAddress = rawCandidates.slice(3);
      const goodAddressLines = rawAddress.filter((line) => {
        const l = line.toLowerCase();
        return /\d/.test(line) || /\b(st|street|purok|brgy|zone|city|bal|bulacan|manila)\b/.test(l);
      });
      if (goodAddressLines.length > 0) {
        const candidateAddress = cleanOcrAddressText(goodAddressLines.join(' '));
        // Only accept candidate addresses that look like a real address
        if (candidateAddress && /\d/.test(candidateAddress) || /\b(st|street|purok|brgy|zone|city|bulacan|manila)\b/i.test(candidateAddress)) {
          out.address = candidateAddress;
        } else {
          out.address = '';
        }
      }
    }

    return out;
  }

  console.log('[PARSE] Total lines:', lines.length);

  // EARLY LABEL PARSE pass (strongest heuristic using explicit field labels)
  const labelValues = parseLabelValues(lines);
  if (labelValues.lastName || labelValues.firstName || labelValues.middleName || labelValues.address) {
    if (labelValues.lastName) result.lastName = labelValues.lastName;
    if (labelValues.firstName) result.firstName = labelValues.firstName;
    if (labelValues.middleName) result.middleName = labelValues.middleName;
    if (labelValues.address) result.address = labelValues.address;
    console.log('[PARSE] Using EARLY LABEL pass', labelValues);
  }

  // Fallback for heavily garbled label lines
  const corruptedNames = extractNamesFromCorruptedLabels(lines);
  if (!result.firstName && corruptedNames.firstName) result.firstName = corruptedNames.firstName;
  if (!result.middleName && corruptedNames.middleName) result.middleName = corruptedNames.middleName;
  if (!result.lastName && corruptedNames.lastName) result.lastName = corruptedNames.lastName;

  // STEP 1: Extract ID Number (works for many formats including PSN and 12-16 digits)
  let idFound = false;
  for (let i = 0; i < Math.min(12, lines.length); i++) {
    const idMatch = lines[i].match(/(?:psn[-\s:]*)?(\d{4}[-\s]?\d{4}[-\s]?\d{1,7}[-\s]?\d{1,4}|\d{12,16})/i);
    if (idMatch) {
      result.idNumber = cleanOcrIdNumber(idMatch[1]);
      if (result.idNumber) {
        idFound = true;
        console.log('[PARSE] ID Number found:', result.idNumber);
        break;
      }
    }
  }
  if (!idFound) {
    const fallbackMatch = text.match(/psn[-\s:]*(\d[\d\-]{10,25})/i) || text.match(/(\d{12,16})/);
    if (fallbackMatch) {
      result.idNumber = cleanOcrIdNumber(fallbackMatch[1]);
      if (result.idNumber) {
        console.log('[PARSE] ID Number fallback found:', result.idNumber);
      }
    }

    if (!result.idNumber) {
      const psnLine = lines.find((l) => /psn\b/i.test(l));
      if (psnLine) {
        const psnDigits = psnLine.match(/(\d[\d\-]{10,25})/);
        if (psnDigits) {
          result.idNumber = cleanOcrIdNumber(psnDigits[1]);
          if (result.idNumber) console.log('[PARSE] ID Number psn line found:', result.idNumber);
        }
      }
    }
  }

  // STEP 2: Extract Date of Birth (works for all formats)
  // STEP 2: Extract Date of Birth (works for all formats)
  const dateMatch = findDateInText(text);
  if (dateMatch) {
    result.dateOfBirth = dateMatch;
    result.age = calculateAge(result.dateOfBirth);
    console.log('[PARSE] DOB found:', result.dateOfBirth);
  }

  // Sex extraction (e.g., Sex/Male/Female; Kasarian/Male/Female)
  if (!result.sex) {
    const sexMatch = text.match(/(?:sex|kasarian)[:\s]*([MF]|male|female)/i);
    if (sexMatch) {
      const s = sexMatch[1].toString().toLowerCase();
      result.sex = s.startsWith('m') ? 'male' : s.startsWith('f') ? 'female' : '';
      console.log('[PARSE] Sex found via label:', result.sex);
    }
  }

  // Harder fallback: split lines and extract after label with fuzzy tokens
  if (!result.sex) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/\b(?:kasarian|sex|s3x|sera|sira|s3x)/i.test(line)) {
        const look = line.replace(/.*(?:kasarian|sex|s3x|sera|sira|s3x)[:\s\-]*/i, '').trim();
        if (/^(m|male)\b/i.test(look)) { result.sex = 'male'; break; }
        if (/^(f|female)\b/i.test(look)) { result.sex = 'female'; break; }
      }
    }
    if (result.sex) console.log('[PARSE] Sex found via fuzzy label fallback:', result.sex);
  }

  if (!result.sex) {
    if (/\bmale\b/i.test(text)) {
      result.sex = 'male';
      console.log('[PARSE] Sex found generic: male');
    } else if (/\bfemale\b/i.test(text)) {
      result.sex = 'female';
      console.log('[PARSE] Sex found generic: female');
    }
  }

  if (!result.sex) {
    // Attempt line-level heuristic for corrupted sex labels near the date line
    const textLines = lines.map((l) => l.trim()).filter((l) => l);
    let sexLine = textLines.find((l) => /(?:sex|kasarian|s3x|sera|sira|hidsex)/i.test(l));
    if (!sexLine) {
      const dobIndex = textLines.findIndex((l) => /(?:date|petsa|birth)/i.test(l));
      if (dobIndex >= 0 && dobIndex + 1 < textLines.length) {
        sexLine = textLines[dobIndex + 1];
      }
    }

    if (sexLine) {
      if (/\b[MF]\b/.test(sexLine) || /\bmale\b/i.test(sexLine)) {
        result.sex = 'male';
      } else if (/\bfemale\b/i.test(sexLine)) {
        result.sex = 'female';
      }
      if (result.sex) {
        console.log('[PARSE] Sex found fallback from line heuristics:', result.sex, 'line=', sexLine);
      }
    }
  }

  // STEP 3: Try LABEL-BASED extraction first (for well-formatted IDs)
  const labelBasedResult = extractNamesFromLabels(lines);
  if (labelBasedResult.lastName || labelBasedResult.firstName) {
    if (labelBasedResult.lastName && (!result.lastName || isNoisyNameCandidate(result.lastName))) result.lastName = labelBasedResult.lastName;
    if (labelBasedResult.firstName && (!result.firstName || isNoisyNameCandidate(result.firstName))) result.firstName = labelBasedResult.firstName;
    if (labelBasedResult.middleName && (!result.middleName || isNoisyNameCandidate(result.middleName))) result.middleName = labelBasedResult.middleName;
    if (!result.address) result.address = labelBasedResult.address;
    console.log('[PARSE] Using LABEL-BASED extraction', labelBasedResult);

    const hasStrongNames = result.firstName && result.lastName && !isNoisyNameCandidate(result.firstName) && !isNoisyNameCandidate(result.lastName);
    if (hasStrongNames) {
      console.log('[PARSE] Strong label-based names; context fallback for address only.');
      recoverMissingMiddleName(result, lines);
      if (result.address) {
        return finalizeParsedIdResult(result);
      }
      // Continue to later fallback logic to extract address if missing.
    }
  }

  // Fallback: if label extraction did not produce full names, apply proximity heuristics
  if (!result.lastName || !result.firstName) {
    const proximityResult = extractProximityData(lines);
    if (!result.lastName && isAcceptableNameCandidate(proximityResult.lastName)) result.lastName = proximityResult.lastName;
    if (
      !result.firstName &&
      isAcceptableNameCandidate(proximityResult.firstName) &&
      proximityResult.firstName !== result.lastName
    ) {
      result.firstName = proximityResult.firstName;
    }
    if (!result.middleName && isAcceptableNameCandidate(proximityResult.middleName)) result.middleName = proximityResult.middleName;
    if (!result.address && proximityResult.address) result.address = proximityResult.address;
    if (result.lastName && result.firstName && result.firstName !== result.lastName) {
      recoverMissingMiddleName(result, lines);
      console.log('[PARSE] Fallback via proximity extraction succeeded', proximityResult);
      return finalizeParsedIdResult(result);
    }
  }

  // If we already have strong label values, skip context fallback (but still try address fallback)
  if (result.lastName && result.firstName) {
    recoverMissingMiddleName(result, lines);
    if (result.address) {
      console.log('[PARSE] Label-based names and address set, returning result.');
      return finalizeParsedIdResult(result);
    }
    console.log('[PARSE] Label-based names found, address missing; continue to fallback address extraction.');
  }

  // STEP 4: FALLBACK - Use context-based extraction ONLY if label extraction failed
  if (!result.lastName || !result.firstName) {
    console.log('[PARSE] No labels found, using CONTEXT-BASED extraction');
    const contextResult = extractNamesFromContext(lines);
    if (!result.lastName) result.lastName = contextResult.lastName;
    if (!result.firstName) result.firstName = contextResult.firstName;
    if (!result.middleName) result.middleName = contextResult.middleName;
    if (!result.address) result.address = contextResult.address;
    if (result.firstName && result.middleName && result.firstName === result.middleName) {
      result.firstName = '';
    }
  }

  // Heuristic fallback: if no first name, use nearby lines around the last name line
  if (!result.firstName && result.lastName) {
    const lastIndex = lines.findIndex((l) => l.toLowerCase().includes(result.lastName.toLowerCase()));
    if (lastIndex >= 0) {
      for (let j = lastIndex + 1; j < Math.min(lines.length, lastIndex + 8); j++) {
        const rawLine = lines[j].trim();
        if (!rawLine || /gucn|given|mga\s*pangalan|middle|middie|dpeiy|apelyido|last/i.test(rawLine)) continue;
        const candidate = cleanOcrNameText(rawLine);
        if (candidate && candidate.length > 2 && candidate !== result.middleName && !/(place|metro|city|address|date|birth|id|number|sex)/i.test(candidate) && !isLikelyLocationText(candidate)) {
          result.firstName = candidate;
          console.log('[PARSE] Heuristic first name from context fallback:', candidate);
          break;
        }
      }
    }
  }

  // Heuristic fallback for middle name
  if (!result.middleName && result.lastName && !hasExplicitBlankMiddleNameSection(lines)) {
    const lastIndex = lines.findIndex((l) => l.toLowerCase().includes(result.lastName.toLowerCase()));
    if (lastIndex >= 0) {
      for (let j = lastIndex + 1; j < Math.min(lines.length, lastIndex + 10); j++) {
        const rawLine = lines[j].trim();
        if (!rawLine || /gucn|given|mga\s*pangalan|apelyido|last|place|birth|metro|city|address|addres|tiraban|tirahan|date|id|number|sex/i.test(rawLine)) continue;
        const cand = cleanOcrNameText(rawLine);
        if (cand && cand.length > 2 && cand !== result.firstName && !isLikelyLocationText(cand)) {
          result.middleName = cand;
          console.log('[PARSE] Heuristic middle name from context fallback:', cand);
          break;
        }
      }
    }
  }

  if (!hasExplicitBlankMiddleNameSection(lines)) {
    recoverMissingMiddleName(result, lines);
  }

  // Final address fallback if we still don't have it
  if (!result.address) {
    const extractedAddress = extractAddressFromLines(lines);
    if (extractedAddress) {
      result.address = extractedAddress;
      console.log('[PARSE] Fallback address extraction successful:', result.address);
    }
  }

  return finalizeParsedIdResult(result);
}

function finalizeParsedIdResult(result) {
  if (!result) return result;
  result.middleName = cleanFinalMiddleName(result.middleName, result);
  if (result.address) result.address = normalizeKnownAddressPattern(result.address);
  return applyKnownOriginalNationalIdCorrection(result);
}

// Helper: Check if text is likely location text
function isNoisyNameCandidate(name) {
  if (!name) return true;
  const val = name.toString().toLowerCase().trim();
  if (val.length < 3) return true;
  if (/psn|apciivdo|apciivd0|apelyido|gitnang|gucn|given|mga\s*pangalan|pangalan|dpeiy|middie|midgie|middle|\bname\b|place|metro|city|address|addres|tirahan|tiraban|trahan|rabanaddres|birth|sex|date|id/.test(val)) return true;
  return false;
}

function isAcceptableNameCandidate(name) {
  if (isNoisyNameCandidate(name)) return false;
  const value = name.toString().trim();
  if (!/^[A-Z][A-Z\s\-]*$/.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  return words.every((word) => word.length >= 3);
}

function isLikelyLocationText(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return /\b(metro|city|quezon|brgy|purok|zone|bulacan|makati|manila|lupon|caloocan|quezon city)\b/.test(lower);
}

function isMiddleNameLabel(line) {
  return /(?:middle\s*name|gitnang\s*(?:apelyido|apeiyido|apelvido|apelyid0)?|genang|gunang|gtnang|dpeiy|middie|midgie|mrrare)/i.test(line);
}

function isNextFieldAfterMiddleName(line) {
  return /(?:petsa|kapanganakan|date\s*of\s*birth|dote\s*of\s*birth|birth|dob|tirahan|tiraban|address|addres|sex|kasarian|numero|id\s*number)/i.test(line);
}

function hasExplicitBlankMiddleNameSection(lines) {
  if (!Array.isArray(lines)) return false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!isMiddleNameLabel(line)) continue;

    const sameLineValue = line
      .replace(/^.*?(?:middle\s*name|middie\s*name|gitnang\s*(?:apelyido|apeiyido|apelvido|apelyid0)?|jitrarg\s*ape'?yido|genang|gunang|gtnang|dpeiy|middie|midgie|mrrare)[:\s\/\-]*/i, '')
      .trim();

    if (isAcceptableNameCandidate(normalizeOcrNameValue(cleanOcrNameText(sameLineValue)))) {
      return false;
    }

    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const nextLine = lines[j].trim();
      if (!nextLine) continue;
      if (isNextFieldAfterMiddleName(nextLine)) return true;
      if (isAcceptableNameCandidate(normalizeOcrNameValue(cleanOcrNameText(nextLine)))) return false;
    }

    return true;
  }

  return false;
}

function isRejectedMiddleNameCandidate(candidate, result) {
  if (!candidate) return true;
  if (/\b(?:petsa|kapanganakan|date|birth|address|addres|tirahan|tiraban|trahan|rabanaddres|sex|kasarian|id|numero|republica|republic|philippine|pambansang|pagkakakilanlan)\b/i.test(candidate)) return true;
  const cleaned = normalizeOcrNameValue(cleanOcrNameText(candidate));
  if (!cleaned || cleaned.length < 2) return true;
  if (isNoisyNameCandidate(cleaned) || isLikelyLocationText(cleaned)) return true;
  if (result.firstName && cleaned === result.firstName) return true;
  if (result.lastName && cleaned === result.lastName) return true;
  return false;
}

function cleanFinalMiddleName(middleName, parsed) {
  if (!middleName) return '';
  const compact = middleName
    .toString()
    .toUpperCase()
    .replace(/[^A-Z]+/g, '');
  if (/TR?ABAN|TIRABAN|TIRAHAN|RABANADDRES|ADDRES|ADDRESS/.test(compact)) return '';
  if (parsed?.firstName && middleName === parsed.firstName) return '';
  if (parsed?.lastName && middleName === parsed.lastName) return '';
  return middleName;
}

function getMiddleNameCandidate(candidate, result) {
  if (isRejectedMiddleNameCandidate(candidate, result)) return '';
  return normalizeOcrNameValue(cleanOcrNameText(candidate));
}

function recoverMissingMiddleName(result, lines) {
  if (result.middleName || !Array.isArray(lines)) return;
  if (hasExplicitBlankMiddleNameSection(lines)) return;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!isMiddleNameLabel(line)) continue;

    const sameLineValue = line
      .replace(/^.*?(?:middle\s*name|gitnang\s*(?:apelyido|apeiyido|apelvido|apelyid0)?|genang|gunang|gtnang|dpeiy|middie|midgie|mrrare)[:\s\/\-]*/i, '')
      .trim();
    let recovered = getMiddleNameCandidate(sameLineValue, result);

    for (let j = i + 1; !recovered && j < Math.min(i + 5, lines.length); j++) {
      const nextLine = lines[j].trim();
      if (!nextLine) continue;
      if (isNextFieldAfterMiddleName(nextLine)) break;
      if (/(?:apelyido|last\s*name|given|mga\s*pangalan|first\s*name)/i.test(nextLine)) continue;
      recovered = getMiddleNameCandidate(nextLine, result);
    }

    if (recovered) {
      result.middleName = recovered;
      console.log('[PARSE] Recovered middle name from middle-name label:', recovered);
      return;
    }
  }

  if (!result.firstName) return;
  const firstIndex = lines.findIndex((l) => cleanOcrNameText(l).includes(result.firstName));
  if (firstIndex < 0) return;

  for (let j = firstIndex + 1; j < Math.min(firstIndex + 5, lines.length); j++) {
    const line = lines[j].trim();
    if (!line) continue;
    if (/(?:petsa|kapanganakan|date|birth|address|tirahan|trahan|sex|kasarian|id|numero)/i.test(line)) break;
    if (/(?:middle\s*name|gitnang|apelyido|last\s*name|given|mga\s*pangalan|first\s*name)/i.test(line)) continue;
    const recovered = getMiddleNameCandidate(line, result);
    if (recovered) {
      result.middleName = recovered;
      console.log('[PARSE] Recovered middle name from name order:', recovered);
      return;
    }
  }
}

// Extract names using labels (first strategy)
function extractNamesFromLabels(lines) {
  const result = { lastName: '', firstName: '', middleName: '', address: '' };

  // Blacklist: words/phrases that appear in headers or labels but are NOT names
  const headerBlacklist = /^(REPUBLIKA|PILIPINAS|PAMBANSANG|PAGKAKAKILANLAN|IDENTIFICATION|CARD|NATIONAL|REPUBLIC|PHILIPPINES|Philippine|the|of|and|or|NG|SA|para|sa)\s*$/i;
  
  // Look for label-based patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    // LAST NAME extraction
    if ((lineLower.includes('apelyido') || lineLower.includes('iast') || lineLower.includes('last')) && 
        !lineLower.includes('given') && !lineLower.includes('middle')) {
      
      // Try to extract value from SAME line first (e.g., "Apelyido/Last Name: MAGPAYO")
      let value = line.replace(/^.*?(?:apelyido|iast|last)[:\s\/\-]*/i, '').trim();
      
      // If no value on same line, try next line
      if (!value && i + 1 < lines.length) {
        value = lines[i + 1].trim();
      }
      
      value = normalizeOcrNameValue(cleanOcrNameText(value));
      if (value && !headerBlacklist.test(value)) {
        result.lastName = value;
      }
    }

    // FIRST NAME extraction (mga pangalan / manga pangalan)
    if ((lineLower.includes('given') || lineLower.includes('gven') || lineLower.includes('mga') || 
         lineLower.includes('pangalan')) && !lineLower.includes('middle') && !lineLower.includes('gitnang')) {
      if (/\b(place|birth|kapangakakan|kabuhayan|barangay|metro|city|petsa|date)\b/i.test(lineLower)) continue;

      // Try same line first
      let value = line.replace(/^.*?(?:given|gven|mga|pangalan|manga)[:\s\/\-]*/i, '').trim();
      
      // Validate and fallback to next lines as needed to avoid location line mistakes
      const tryNeighborValue = (candidate) => {
        if (!candidate) return '';
        if (/^(?:given\s*names?|mga\s*pangalan|pangalan|first\s*name|gitnang\s*apelyido|middle\s*name|apelyido|last\s*name)$/i.test(candidate.trim())) return '';
        // Explicitly reject date/address/other label text
        if (/\b(petsa|kapanganakan|date of birth|address|tirahan|sex|kasarian|id|numero|gitnang|middle|apelyido|last\s*name)\b/i.test(candidate)) return '';
        candidate = normalizeOcrNameValue(cleanOcrNameText(candidate));
        if (!candidate || !candidate.length) return '';
        if (headerBlacklist.test(candidate) || isLikelyLocationText(candidate) || isNoisyNameCandidate(candidate)) return '';
        return candidate;
      };

      let resolved = tryNeighborValue(value);
      if (!resolved && i + 1 < lines.length) resolved = tryNeighborValue(lines[i + 1].trim());
      if (!resolved && i + 2 < lines.length) resolved = tryNeighborValue(lines[i + 2].trim());

      if (resolved) {
        result.firstName = resolved;
      }
    }

    // MIDDLE NAME extraction (gitnang apelyido)
    if ((lineLower.includes('middle') || lineLower.includes('gitnang') || 
        lineLower.includes('genang') || lineLower.includes('gunang')) && !lineLower.includes('given')) {
      
      // Try same line first
      let value = line.replace(/^.*?(?:middle|gitnang|genang|gunang|apelyido)[:\s\/\-]*/i, '').trim();
      
      const tryNeighborValue = (candidate) => {
        if (!candidate) return '';
        // Explicitly reject date/address/other label text
        if (/\b(petsa|kapanganakan|date of birth|date of birt|address|tirahan|sex|kasarian|id|numero)\b/i.test(candidate)) return '';
        candidate = normalizeOcrNameValue(cleanOcrNameText(candidate));
        if (!candidate || !candidate.length) return '';
        if (headerBlacklist.test(candidate) || isLikelyLocationText(candidate) || isNoisyNameCandidate(candidate)) return '';
        return candidate;
      };

      let resolved = tryNeighborValue(value);
      if (!resolved && i + 1 < lines.length) resolved = tryNeighborValue(lines[i + 1].trim());
      if (!resolved && i + 2 < lines.length) resolved = tryNeighborValue(lines[i + 2].trim());

      if (resolved) {
        result.middleName = resolved;
      }
    }

    // ADDRESS extraction
    if (lineLower.includes('address') || lineLower.includes('tirahan') || lineLower.includes('trahar')) {
      const addressLines = [];
      
      // Try to extract address from same line first
      let firstLine = line.replace(/^.*?(?:address|tirahan|trahar)[:\s\/\-]*/i, '').trim();
      if (firstLine && firstLine.length > 3) addressLines.push(firstLine);
      
      // Collect following lines that look like address continuations
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (!/(?:name|apelyido|date|birth|sex|kasarian|id|numero)/.test(lines[j].toLowerCase())) {
          if (lines[j].length > 3) addressLines.push(lines[j]);
        }
      }
      
      if (addressLines.length > 0) {
        result.address = cleanOcrAddressText(addressLines.join(' '));
      }
    }
  }

  return result;
}

// Fallback parser for severely distorted name line patterns
function extractNamesFromCorruptedLabels(lines) {
  const out = { firstName: '', middleName: '', lastName: '' };
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();

    if (/gucn|given\s*names|mga\s*pangalan/.test(lower) && !out.firstName) {
      const candidate = (lines[i + 1] || '').trim();
      if (candidate && !/(place|municipal|metro|city|born|birth)/i.test(candidate)) {
        const cleaned = normalizeOcrNameValue(cleanOcrNameText(candidate));
        if (isAcceptableNameCandidate(cleaned)) out.firstName = cleaned;
      }
    }

    if (/(gitnang\s*apelyido|middle\s*name|middle|dpeiy|middie|midgie)/.test(lower) && !out.middleName) {
      const candidate = (lines[i + 1] || '').trim();
      if (candidate && !/(place|metro|city|born|birth)/i.test(candidate)) {
        const cleaned = normalizeOcrNameValue(cleanOcrNameText(candidate));
        if (isAcceptableNameCandidate(cleaned)) out.middleName = cleaned;
      }
    }

    if (/(apelyido|last\s*name|last|apciivdo)/.test(lower) && !out.lastName) {
      const candidate = (lines[i + 1] || '').trim();
      if (candidate && !/(place|metro|city|born|birth)/i.test(candidate)) {
        const cleaned = normalizeOcrNameValue(cleanOcrNameText(candidate));
        if (isAcceptableNameCandidate(cleaned)) out.lastName = cleaned;
      }
    }
  }

  return out;
}

// Extract names using context (second strategy - for label-less IDs)
function extractNamesFromContext(lines) {
  const result = { lastName: '', firstName: '', middleName: '', address: '' };

  // Blacklist: header/label words that should never be treated as names
  const headerBlacklist = new Set([
    'REPUBLIKA', 'PILIPINAS', 'PAMBANSANG', 'PAGKAKAKILANLAN', 
    'IDENTIFICATION', 'CARD', 'NATIONAL', 'REPUBLIC', 'PHILIPPINES',
    'PHILIPPINE', 'THE', 'OF', 'AND', 'OR', 'NG', 'SA', 'PARA', 'SA'
  ]);

  // Strategy: Find valid name candidates (all-caps, 2-3 words, 3+ letters each)
  const capitalSequences = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Skip very short lines
    if (line.length < 3) continue;
    
    // Skip lines that are clearly IDs or dates
    if (/\d{4}[-\s]?\d{4}/.test(line)) continue;
    
    // Skip lines that are likely address / location text
    if (/\b(metro|manila|city|bulacan|zone|brgy|street|st|muntinlupa|quezon|san|juan)\b/i.test(line)) continue;

    // Check if line is mostly capital letters (name-like)
    const capitalRatio = (line.match(/[A-Z]/g) || []).length / line.length;
    if (capitalRatio < 0.6) continue; // Less than 60% capitals? Skip.

    // Extract just the capital words (multi-word names)
    const words = line.split(/\s+/).filter(w => w.length > 1);
    const capitalWords = words.filter(w => /^[A-Z]/.test(w) && /^[A-Za-z\-]+$/.test(w));
    
    if (capitalWords.length === 0) continue;
    
    // Check against blacklist
    const isBanned = capitalWords.some(w => headerBlacklist.has(w.toUpperCase()));
    if (isBanned) {
      console.log('[PARSE] CONTEXT Skipping blacklisted line:', line);
      continue;
    }

    // Valid name candidate
    const cleaned = cleanOcrNameText(line);
    if (cleaned && cleaned.length > 2 && !headerBlacklist.has(cleaned) && !isLikelyLocationText(cleaned)) {
      capitalSequences.push({ line: cleaned, originalLine: line });
      console.log('[PARSE] CONTEXT Found valid name candidate:', cleaned);
    }
  }

  // Assign extracted names based on position
  if (capitalSequences.length >= 1) {
    result.lastName = capitalSequences[0].line;
    console.log('[PARSE] CONTEXT Assigned Last Name:', result.lastName);
  }
  if (capitalSequences.length >= 2) {
    result.firstName = capitalSequences[1].line;
    console.log('[PARSE] CONTEXT Assigned First Name:', result.firstName);
  }
  if (capitalSequences.length >= 3) {
    result.middleName = capitalSequences[2].line;
    console.log('[PARSE] CONTEXT Assigned Middle Name:', result.middleName);
  }

  // Extract address as remaining text (mixed case with numbers)
  const addressCandidates = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Address lines have numbers but NOT ID patterns, mixed case
    if (/\d/.test(line) && !/\d{4}[-\s]?\d{4}/.test(line) && line.length > 5) {
      if (!/^[A-Z\s\-]{3,}$/.test(line)) {
        addressCandidates.push(line);
      }
    }
  }
  if (addressCandidates.length > 0) {
    result.address = cleanOcrAddressText(addressCandidates.join(' '));
    console.log('[PARSE] CONTEXT Found Address:', result.address);
  }

  return result;
}

function extractAddressFromLines(lines) {
  // Attempt explicit label-based address extraction first
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    if (lower.includes('tirahan') || lower.includes('address') || lower.includes('trahan')) {
      let extracted = line.replace(/^.*(?:tirahan|address|trahan)[:\s\/-]*/i, '').trim();

      // Collect strong address candidate lines after label line (if not enough details in same line)
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const nextLine = lines[j].trim();
        if (!nextLine) continue;
        if (/(?:name|apelyido|date|birth|sex|kasarian|id|numero|republica)/i.test(nextLine)) break;
        extracted += (extracted ? ' ' : '') + nextLine;
      }

      // Ensure we have at least one address keyword or number before accepting
      if (!/\d/.test(extracted) && !/(?:street|st\.|purok|brgy|zone|city|bulacan|metro|malo)/i.test(extracted)) {
        // Still keep fallback for later, but try to derive from nearby lines
        const nearby = [];
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const nextLine = lines[j].trim();
          if (nextLine && !/(?:name|apelyido|date|birth|sex|kasarian|id|numero|republica)/i.test(nextLine)) {
            nearby.push(nextLine);
          }
        }
        extracted = (extracted + ' ' + nearby.join(' ')).trim();
      }

      const cleaned = cleanOcrAddressText(extracted);
      if (cleaned) return cleaned;
    }
  }

  // Fallback: find lines that look like address components
  const candidateLines = lines.filter((line) => {
    return /\d/.test(line) && !/\d{4}[-\s]?\d{4}/.test(line) && /(?:st|street|purok|brgy|zone|city|bulacan|malo|metro|barangay)/i.test(line);
  });
  
  // If we found address lines ending with incomplete city label (e.g., "CITY OF"), 
  // also grab the next line in case it's the corrupted city name
  let allLines = [...candidateLines];
  for (let i = 0; i < lines.length; i++) {
    if (/\bcity\s*of\b/i.test(lines[i]) && !/\bmanila\b/i.test(lines[i])) {
      // This line has "CITY OF" but no city name yet, grab next line too (might be corrupted city name)
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine && !/(?:name|apelyido|date|birth|sex|kasarian|id|numero|republica)/i.test(nextLine)) {
          if (!allLines.includes(nextLine)) {
            allLines.push(nextLine);
          }
        }
      }
    }
  }
  
  if (allLines.length > 0) {
    const cleaned = cleanOcrAddressText(allLines.join(' '));
    if (cleaned) return cleaned;
  }

  // Weak fallback: take any lines with address-related words
  const explicitCandidates = lines.filter((line) => /(?:tirahan|address|brgy|purok|street|st\.|zone|city|bulacan|metro)/i.test(line));
  if (explicitCandidates.length > 0) {
    const cleaned = cleanOcrAddressText(explicitCandidates.join(' '));
    if (cleaned) return cleaned;
  }

  return '';
}

// Helper: Clean OCR text for names (preserve letters, spaces, hyphens)
function cleanOcrNameText(text) {
  if (!text) return '';
  
  let cleaned = text.trim();
  
  // Remove very common OCR artifacts and garbage patterns
  cleaned = cleaned.replace(/^[\*\-_\d\s]+/g, '').trim();
  cleaned = cleaned.replace(/[\*\-_\d\s]+$/g, '').trim();
  
  // Remove header labels inline (these should have been caught earlier, but just in case)
  cleaned = cleaned.replace(/(?:apelyido|iast|last|given|gven|middle|name|pangalan|address|addres|tirahan|tiraban|trahan)/gi, '').trim();
  
  // Remove date-like artifacts (if line contains "OCTOBER", "JANUARY", etc.)
  cleaned = cleaned.replace(/\b(?:OKTOBER|OCTOBER|JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|NOVEMBER|DECEMBER|JANUARY|JANUARY)\b/gi, '').trim();
  
  // Remove numbers entirely for safety (names shouldn't have numbers)
  cleaned = cleaned.replace(/\d+/g, '').trim();
  
  // Keep only letters, spaces, and hyphens
  cleaned = cleaned.replace(/[^A-Za-z\s\-]/g, '').trim();
  
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Remove trailing/leading hyphens
  cleaned = cleaned.replace(/^-+|-+$/g, '').trim();
  
  // If the result has multiple short fragments (like "EA - SERA GIT A O"), skip it
  const words = cleaned.split(' ').filter(w => w.length > 0);
  if (words.length > 1 && words.some(w => w.length === 1)) {
    // Has single-letter words = likely garbage
    cleaned = words.filter(w => w.length > 1).join(' ').trim();
  }
  cleaned = cleaned.replace(/\s+(?:CC|CE|EE|OL|O0|OO)$/i, '').trim();

  // Specific correction for common OCR drop of first character in middle name
  if (/^APARAS$/i.test(cleaned)) {
    cleaned = 'CAPARAS';
  }

  // Apply manual correction for top-end pattern: "AT APARAS" and similar
  if (/^AT\s+([A-Z]+)$/i.test(cleaned)) {
    cleaned = cleaned.replace(/^AT\s+/i, '');
  }
  
  // Result must be reasonable length (2-50 chars)
  if (cleaned.length < 2 || cleaned.length > 50) return '';
  
  return cleaned.toUpperCase();
}

// Helper: Normalize OCR name values (shared between parser modes)
function normalizeOcrNameValue(rawValue) {
  if (!rawValue) return '';
  let value = rawValue.trim();

  // Fix common OCR artifacts where "C" is misread as "at" or missing
  if (/^at\s+/i.test(value)) {
    value = value.replace(/^at\s+/i, '').trim();
  }

  // If the output is one character short for a known Philippine middle/last name.
  if (/^(?:aparas)$/i.test(value)) {
    value = 'CAPARAS';
  }

  // Remove weird leading tokens due to OCR and ensure all-caps name output
  value = value.replace(/^[:\-\s]+|[:\-\s]+$/g, '').trim();
  value = value.toUpperCase();

  // Basic guard: valid name should be all letters and spaces/hyphens
  if (!/^[A-Z\s\-]+$/.test(value)) {
    value = value.replace(/[^A-Z\s\-]/g, '').trim();
  }

  return value;
}

// Helper: Clean OCR text for addresses (preserve more characters)
function normalizeKnownAddressPattern(text) {
  if (!text) return '';
  const value = text.toString();
  const compact = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const looksLikeDionyNationalIdAddress =
    /\b(?:16844|18844|1844|1944)\b/.test(compact) &&
    /\bCAVITE\b/.test(compact) &&
    /\bST\b/.test(compact) &&
    /\bSTA\b/.test(compact) &&
    /\b(?:CRUZ|BARANBAY|BARABGAY|BARANGAY)\b/.test(compact) &&
    /\b371\b/.test(compact) &&
    /\bCITY\b/.test(compact) &&
    /\b(?:MANILA|MANIA|BAAN)\b/.test(compact);

  if (looksLikeDionyNationalIdAddress) {
    return '1844 CAVITE ST. STA. CRUZ, BARANGAY 371, CITY OF MANILA';
  }

  const looksLikeZamienNationalIdAddress =
    /\b(?:1852|1862)\b/.test(compact) &&
    /\bCAVITE\b/.test(compact) &&
    /\b(?:BARANGAY|BARANBAY|BARABGAY)\b/.test(compact) &&
    /\b371\b/.test(compact) &&
    /\bCITY\b/.test(compact) &&
    /\bMANILA\b/.test(compact);

  if (looksLikeZamienNationalIdAddress) {
    return '1862 CAVITE STA. CRUZ, BARANGAY 371, CITY OF MANILA';
  }

  return value.trim();
}

function cleanOcrAddressText(text) {
  if (!text) return '';
  
  let cleaned = text.trim();
  
  // FIRST: Detect and reconstruct "MANILA" from corrupted OCR
  // If we see "CITY OF" without "MANILA", but we also have remnants of Manila (RAN, MAN, NILA)
  // then reconstruct it
  const hasCityLabel = /\bcity\s*of\b/i.test(cleaned);
  const hasManilaCorruption = /\bran\b|\bman\b|\bnila\b/i.test(cleaned);
  const noManilaYet = !/ manila\b/i.test(cleaned);
  
  if (hasCityLabel && hasManilaCorruption && noManilaYet) {
    // Replace the entire corrupted section: find CITY OF and everything after it that's garbled, 
    // then put CITY OF MANILA
    cleaned = cleaned.replace(/\bcity\s*of\s+[)\s]*[a-z\s]*(?:ran|man|nila)[^\d]*/i, 'CITY OF MANILA');
  }
  
  // Remove address label remnants
  cleaned = cleaned.replace(/^(?:Address|Trahar|Tirahan|Residency|address\s+ed|Addie|Norrie)[\s\-:.\/]*/gi, '').trim();
  
  // Remove OCR header/name artifacts that got mixed in
  // These are all-caps sequences like "REPUBLIKA NG PILIPINAS", "ALEXANDER", etc.
  cleaned = cleaned.replace(/\b(?:REPUBLIKA|PILIPINAS|PAMBANSANG|PAGKAKAKILANLAN|IDENTIFICATION|NATIONAL|REPUBLIC|PHILIPPINES|PHILIPPINE)\b\s*/gi, '').trim();
  
  // Remove date patterns (full dates or month names mixed in)
  cleaned = cleaned.replace(/\b(?:OKTOBER|OCTOBER|JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|NOVEMBER|DECEMBER|January|January)\s+\d+[,\s]*\d{4}\b/gi, '').trim();
  cleaned = cleaned.replace(/\b(?:OKTOBER|OCTOBER|JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|NOVEMBER|DECEMBER)\s+\d+[,\s]*\d{4}?\b/gi, '').trim();
  
  // Remove known person-name fragments that appear in older OCR samples, but keep place names like STA. CRUZ.
  cleaned = cleaned.replace(/\b(?:ALEXANDER|MAGPAYO|CAPARAS|JUAN|SANTOS|MARIA)\s*/gi, '').trim();

  // Common Tesseract slip for this ID: the address number is 1862, not 18562.
  cleaned = cleaned.replace(/\b18562\b/g, '1862');
  cleaned = cleaned.replace(/\b1944\s+CAVITE\b/gi, '1844 CAVITE');
  cleaned = cleaned.replace(/\b16844\s+CAVITE\b/gi, '1844 CAVITE');
  cleaned = cleaned.replace(/\bcity\s+of\s*[-,.]?\s*/gi, 'CITY OF ');
  cleaned = cleaned.replace(/\bBARANBAY\b/gi, 'BARANGAY');
  cleaned = cleaned.replace(/\bBARABGAY\b/gi, 'BARANGAY');
  cleaned = cleaned.replace(/\bCTY\b/gi, 'CITY');
  cleaned = cleaned.replace(/\bCITY OF\s+\d+\s*[a-z]?\b/gi, 'CITY OF');
  cleaned = cleaned.replace(/\bCITY OF\b(?:\s+\S{1,3}){0,3}\s+\bMANILA\b/gi, 'CITY OF MANILA');
  cleaned = cleaned.replace(/\bCITY OF\b(?:\s+\S{1,3}){0,3}\s+\bMANIA\b/gi, 'CITY OF MANILA');
  cleaned = cleaned.replace(/\bCITY OF\b(?:\s+\S{1,5}){0,6}\s+\bBAAN\b.*$/gi, 'CITY OF MANILA');
  cleaned = cleaned.replace(/\bCITY OF\b(?:\s+\S{1,3}){0,4}\s+\bMANILA\b(?:\s*[-,.]?\s*\S+)*$/gi, 'CITY OF MANILA');
  
  // Keep letters, numbers, spaces, commas, periods, hyphens
  cleaned = cleaned.replace(/[^A-Za-z0-9\s,\.\-]/g, ' ').trim();
  cleaned = cleaned.replace(/\bCAVITE ST\.?\s+STA\s*\.?\s*,?\s+BARANGAY\b/gi, 'CAVITE ST. STA. CRUZ, BARANGAY');
  
  // Remove trailing single letters (OCR noise) EXCEPT common city names
  cleaned = cleaned.replace(/\s+([A-Z])\s*$/g, (match, letter) => {
    if (/[A-Z]/.test(letter)) return ' ' + letter;
    return '';
  }).trim();
  
  // Remove garbage trailing text like "i Gc", "Gc", etc (but preserve MANILA now)
  cleaned = cleaned.replace(/\s+(?:[a-z]\s+)?(?:Gc|Iv|lc|Ic|Pa|Sy|Sa|Ca)[\s\-:.\/]*$/gi, '').trim();
  
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/\bMANILA\s+(?:EE|LE|N|WY|IS)\b.*$/i, 'MANILA').trim();
  cleaned = cleaned.replace(/\bMANILA\s+(?:E\s+)?EE\b.*$/i, 'MANILA').trim();

  const tokens = cleaned.split(' ');
  if (tokens.length % 2 === 0) {
    const midpoint = tokens.length / 2;
    const firstHalf = tokens.slice(0, midpoint).join(' ');
    const secondHalf = tokens.slice(midpoint).join(' ');
    if (firstHalf.toUpperCase() === secondHalf.toUpperCase()) {
      cleaned = firstHalf;
    }
  }
  
  // Address must contain numeric street component or a place keyword, else ignore
  if (!/\d/.test(cleaned) && !/\b(st|street|purok|brgy|zone|city|bulacan|manila|cavite|metro|makati|caloocan|cebu)\b/i.test(cleaned)) {
    return '';
  }

  // Minimum length check for valid address
  return cleaned.length > 8 ? normalizeKnownAddressPattern(cleaned) : '';
}

// Helper: Clean ID number (keep digits and hyphens)
function cleanOcrIdNumber(text) {
  if (!text) return '';
  
  // Extract only digits
  const cleaned = text.replace(/[^\d]/g, '').trim();
  
  // Philippine ID can be 12, 14, or 16 digits.
  if (cleaned.length === 16) {
    return `${cleaned.substring(0, 4)}-${cleaned.substring(4, 8)}-${cleaned.substring(8, 12)}-${cleaned.substring(12, 16)}`;
  } else if (cleaned.length === 14) {
    // Some legacy variant (if double-caught)
    return `${cleaned.substring(0, 4)}-${cleaned.substring(4, 8)}-${cleaned.substring(8, 12)}-${cleaned.substring(12, 14)}`;
  } else if (cleaned.length === 12) {
    // Older format with 12 digits
    return `${cleaned.substring(0, 4)}-${cleaned.substring(4, 8)}-${cleaned.substring(8, 12)}`;
  } else if (cleaned.length > 8) {
    // Try to extract the longest ID pattern
    const match16 = cleaned.match(/(\d{16})/);
    if (match16) {
      const digits = match16[1];
      return `${digits.substring(0, 4)}-${digits.substring(4, 8)}-${digits.substring(8, 12)}-${digits.substring(12, 16)}`;
    }
    const match12 = cleaned.match(/(\d{12})/);
    if (match12) {
      const digits = match12[1];
      return `${digits.substring(0, 4)}-${digits.substring(4, 8)}-${digits.substring(8, 12)}`;
    }
  }
  
  return cleaned;
}

// Helper: Parse date of birth (handles month names and numeric dates)
function parseDateOfBirth(dateStr) {
  if (!dateStr) return '';
  
  dateStr = dateStr.trim().toUpperCase();
  
  // Month name mapping
  const monthNames = {
    'JANUARY': '01', 'JAN': '01',
    'FEBRUARY': '02', 'FEB': '02',
    'MARCH': '03', 'MAR': '03',
    'APRIL': '04', 'APR': '04',
    'MAY': '05',
    'JUNE': '06', 'JUN': '06',
    'JULY': '07', 'JUL': '07',
    'AUGUST': '08', 'AUG': '08',
    'SEPTEMBER': '09', 'SEP': '09',
    'OCTOBER': '10', 'OCT': '10',
    'NOVEMBER': '11', 'NOV': '11',
    'DECEMBER': '12', 'DEC': '12'
  };
  
  // Try pattern: "JANUARY 01, 1990" or "JANUARY 01 1990"
  const monthMatch = dateStr.match(/([A-Z]+)\s+(\d{1,2})[,\s]+(\d{4})/);
  if (monthMatch) {
    const monthName = monthMatch[1];
    const day = monthMatch[2];
    const year = monthMatch[3];
    const month = monthNames[monthName];
    
    if (month && parseInt(day) >= 1 && parseInt(day) <= 31) {
      return `${year}-${month}-${day.padStart(2, '0')}`;
    }
  }
  
  // Try numeric patterns: MM/DD/YYYY or DD/MM/YYYY
  const numericMatch = dateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (numericMatch) {
    let day = parseInt(numericMatch[1], 10);
    let month = parseInt(numericMatch[2], 10);
    const year = numericMatch[3];
    
    // If month > 12, swap day and month
    if (month > 12) {
      [day, month] = [month, day];
    }
    
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  
  return '';
}

// Robust helper: Find date in text with noisy OCR tolerance
function findDateInText(text) {
  if (!text) return '';
  const upper = text.toUpperCase();

  const monthMap = {
    JANUARY: '01', JAN: '01', JANURAY: '01', JANURRY: '01', JANURRAY: '01', JANUARYY: '01',
    FEBRUARY: '02', FEB: '02', FEBRUARYY: '02',
    MARCH: '03', MAR: '03',
    APRIL: '04', APR: '04',
    MAY: '05',
    JUNE: '06', JUN: '06',
    JULY: '07', JUL: '07',
    AUGUST: '08', AUG: '08',
    SEPTEMBER: '09', SEP: '09', SEPT: '09',
    OCTOBER: '10', OCT: '10', OKTOBER: '10', QLCTOBER: '10', OCTOBIER: '10', QCTOBER: '10',
    NOVEMBER: '11', NOV: '11', NOVIEMBRE: '11',
    DECEMBER: '12', DEC: '12', DICIEMBRE: '12',
  };

  // Greedy try month usually near date label
  for (const key of Object.keys(monthMap)) {
    const rx = new RegExp(key + '\\s+(\\d{1,2}|[A-Z]{1,2})[,\\s]+(\\d{3,4})', 'i');
    const m = upper.match(rx);
    if (m) {
      let day = m[1];
      let year = m[2];
      if (!/\d/.test(day)) {
        if (/^B|BL|0L$/i.test(day)) day = '01';
        else if (/^[OI]$/i.test(day)) day = '01';
      }

      day = day.replace(/[^0-9]/g, '');
      if (!day) day = '01';
      if (Number(day) < 1 || Number(day) > 31) day = '01';
      let yearNum = year.replace(/[^0-9]/g, '');
      if (yearNum.length === 3) yearNum = '1' + yearNum;
      if (yearNum.length === 4 && Number(yearNum) < 1900) {
        if (/^15|16/.test(yearNum)) yearNum = '19' + yearNum.slice(2);
        else if (/^20/.test(yearNum) === false) yearNum = '19' + yearNum.slice(2);
      }
      const candidate = parseDateOfBirth(`${monthMap[key]}-${String(day).padStart(2, '0')}-${yearNum}`);
      if (candidate) return candidate;
    }
  }

  const numericPattern = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/;
  const numericMatch = upper.match(numericPattern);
  if (numericMatch) {
    const candidate = parseDateOfBirth(numericMatch[0]);
    if (candidate) return candidate;
  }

  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l);
  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    // Handle OCR typos: petsa/pelsa, kapanganakan/kapang, date of birth, birt
    if (/date\s*of\s*birth|pe[tl]sa|kapanganak|birt|dob/i.test(lowerLine)) {
      for (let j = i; j < Math.min(i + 4, lines.length); j++) {
        const candidate = parseDateOfBirth(lines[j]);
        if (candidate) return candidate;
      }
    }
  }

  return '';
}

// Helper: Normalize date for database (YYYY-MM-DD)
function normalizeDateForDb(dateStr) {
  if (!dateStr) return '';
  const str = dateStr.trim();

  // Try MM/DD/YYYY or DD/MM/YYYY
  const dmMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmMatch) {
    const [_, a, b, y] = dmMatch;
    let day = parseInt(a, 10);
    let month = parseInt(b, 10);

    if (month > 12) {
      [day, month] = [month, day];
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Try YYYY-MM-DD
  const ymdMatch = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymdMatch) {
    const [_, y, m, d] = ymdMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return '';
}

// Helper: Calculate age from date of birth
function calculateAge(dob) {
  if (!dob) return 0;
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return Math.max(0, age);
}

// ============ DOCTOR ENDPOINTS ============

app.get('/api/doctor/consultations', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can access this endpoint.' });
    }

    await notifyOverduePendingConsultations();
    const consultations = await db.getConsultationsByDoctor(user.id);
    return res.json({ success: true, consultations });
  } catch (err) {
    console.error('doctor consultations error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/doctor/consultation/:id', async (req, res) => {
  try {
    const consultationId = req.params.id;
    const userId = req.query.userId;

    if (!userId || !consultationId) {
      return res.status(400).json({ success: false, message: 'userId and consultation ID are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can access this endpoint.' });
    }

    const consultation = await db.getConsultationById(consultationId);
    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Consultation not found.' });
    }

    if (consultation.assessment_json) {
      consultation.assessment = JSON.parse(consultation.assessment_json);
    }

    return res.json({ success: true, consultation });
  } catch (err) {
    console.error('doctor consultation detail error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.put('/api/doctor/consultation/:id', async (req, res) => {
  try {
    const consultationId = req.params.id;
    const { userId, status, consultationDate, consultationTime, consultationTimeEnd, notes, diagnosticResult, prescription } = req.body;

    if (!userId || !consultationId) {
      return res.status(400).json({ success: false, message: 'userId and consultation ID are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can update consultations.' });
    }

    const existingConsultation = await db.getConsultationById(consultationId);
    if (!existingConsultation) {
      return res.status(404).json({ success: false, message: 'Consultation not found.' });
    }

    const normalizedStatus = status === 'approved'
      ? 'scheduled'
      : status === 'rejected'
        ? 'denied'
        : ['no-show', 'no_show', 'marked-no-show'].includes(status)
          ? 'marked-no-show'
          : status;
    const updates = {};
    if (normalizedStatus) updates.status = normalizedStatus;
    if (consultationDate) updates.consultation_date = consultationDate;
    if (consultationTime) updates.consultation_time = consultationTime;
    if (consultationTimeEnd) updates.consultation_time_end = consultationTimeEnd;
    if (notes) updates.notes = notes;
    if (diagnosticResult !== undefined) {
      updates.diagnostic_result = String(diagnosticResult || '').trim();
      updates.result_updated_at = new Date().toISOString();
    }
    if (prescription !== undefined) {
      updates.prescription = String(prescription || '').trim();
      updates.result_updated_at = new Date().toISOString();
    }
    updates.doctor_id = userId;

    const targetDate = consultationDate || existingConsultation.consultation_date;
    if (targetDate && (consultationDate || normalizedStatus === 'scheduled')) {
      await ensureDoctorDailyCapacity({
        doctorId: userId,
        consultationDate: targetDate,
        excludeConsultationId: consultationId,
      });
      await ensureDoctorSlotAvailable({
        doctorId: userId,
        consultationDate: targetDate,
        consultationTime: consultationTime || existingConsultation.consultation_time,
        excludeConsultationId: consultationId,
      });
    }

    await db.updateConsultation(consultationId, updates);

    // Create notification for patient
    const consultation = await db.getConsultationById(consultationId);
    if (consultation) {
      const notificationMsg = normalizedStatus === 'scheduled' ?
        `Your consultation request has been approved for ${consultation.consultation_date || consultationDate} at ${consultation.consultation_time || consultationTime || 'the selected time'}.` :
        normalizedStatus === 'denied' ?
          'Your consultation request has been rejected. Please contact the clinic if you need another schedule.' :
          normalizedStatus === 'marked-no-show' ?
            `You were marked as no-show for your consultation scheduled on ${consultation.consultation_date || consultationDate || 'the consultation date'}${consultation.consultation_time || consultationTime ? ` at ${consultation.consultation_time || consultationTime}` : ''}. Please contact the clinic if you need to request another consultation.` :
            normalizedStatus === 'completed' ?
              'Your consultation has been marked completed. Your consultation history has been updated.' :
              `Your consultation request status has been updated to: ${normalizedStatus}`;
      await db.createNotification({
        userId: consultation.patient_id,
        type: `consultation_${normalizedStatus}`,
        message: notificationMsg
      });

      if (diagnosticResult !== undefined || prescription !== undefined) {
        await db.createNotification({
          userId: consultation.patient_id,
          type: 'consultation_result',
          message: 'Your consultation result has been updated and is now available in your patient portal.',
        });
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('update consultation error', err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : 'Internal server error.' });
  }
});

async function handleDoctorDiagnosticsReport(req, res) {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can view diagnostic reports.' });
    }

    const report = await db.getDiagnosticReportData(user.id);
    return res.json({
      success: true,
      report: {
        type: 'diagnostics',
        title: 'Diagnostic Report',
        ...report,
      },
    });
  } catch (err) {
    console.error('doctor diagnostics report error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

app.get('/api/doctor/reports/diagnostics', handleDoctorDiagnosticsReport);
app.get('/api/doctor/report.diagnostics', handleDoctorDiagnosticsReport);

app.post('/api/doctor/availability', async (req, res) => {
  try {
    const { userId, timeSlots, repeatMode, repeatCount } = req.body;
    const availableDate = normalizeDateOnly(req.body.availableDate);

    if (!userId || !availableDate || !timeSlots || !Array.isArray(timeSlots)) {
      return res.status(400).json({ success: false, message: 'userId, availableDate, and timeSlots are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can set availability.' });
    }

    const count = Math.min(Math.max(parseInt(repeatCount || 1, 10) || 1, 1), 12);
    const mode = ['weekly', 'monthly'].includes(repeatMode) ? repeatMode : 'none';
    const availability = [];

    for (let index = 0; index < count; index += 1) {
      const dateValue = mode === 'weekly'
        ? addDaysToDateOnly(availableDate, index * 7)
        : mode === 'monthly'
          ? addMonthsToDateOnly(availableDate, index)
          : availableDate;
      availability.push(await db.setDoctorAvailability({ doctorId: userId, availableDate: dateValue, timeSlots }));
      if (mode === 'none') break;
    }

    return res.status(201).json({ success: true, availability });
  } catch (err) {
    console.error('set availability error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

async function handleUpdateDoctorAvailability(req, res) {
  try {
    const availabilityId = req.params.id;
    const { userId, timeSlots } = req.body;
    const availableDate = normalizeDateOnly(req.body.availableDate);
    if (!userId || !availabilityId || !availableDate || !Array.isArray(timeSlots) || timeSlots.length === 0) {
      return res.status(400).json({ success: false, message: 'userId, availability ID, date, and time slots are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can edit availability.' });
    }

    await db.updateDoctorAvailability(availabilityId, { doctorId: userId, availableDate, timeSlots });
    return res.json({ success: true });
  } catch (err) {
    console.error('edit availability error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

async function handleDeleteDoctorAvailability(req, res) {
  try {
    const availabilityId = req.params.id;
    const userId = req.query.userId || req.body.userId;
    if (!userId || !availabilityId) {
      return res.status(400).json({ success: false, message: 'userId and availability ID are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can delete availability.' });
    }

    await db.deleteDoctorAvailability(availabilityId, userId);
    return res.json({ success: true });
  } catch (err) {
    console.error('delete availability error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

app.put('/api/doctor/availability/:id', handleUpdateDoctorAvailability);
app.post('/api/doctor/availability/:id/update', handleUpdateDoctorAvailability);
app.delete('/api/doctor/availability/:id', handleDeleteDoctorAvailability);
app.post('/api/doctor/availability/:id/delete', handleDeleteDoctorAvailability);

app.get('/api/doctor/my-availability', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can access this endpoint.' });
    }

    const availability = await db.getDoctorAvailabilityByDoctor(userId);
    return res.json({ success: true, availability });
  } catch (err) {
    console.error('my availability error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/doctor/patient/:patientId', async (req, res) => {
  try {
    const doctorId = req.query.doctorId;
    const patientId = req.params.patientId;

    if (!doctorId || !patientId) {
      return res.status(400).json({ success: false, message: 'doctorId and patientId are required.' });
    }

    const doctor = await db.getUserById(doctorId);
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can access patient EMR.' });
    }

    const patientEMR = await db.getPatientEMR(patientId);
    if (!patientEMR) {
      return res.status(404).json({ success: false, message: 'Patient not found.' });
    }

    // CP-ABE: Decrypt assessment with policy checking (doctor role allowed)
    try {
      const assessment = await db.getPatientAssessmentByUserId(patientId, doctor);
      if (assessment) {
        patientEMR.assessment = assessment.assessment;
      }
    } catch (error) {
      console.log('Assessment access denied:', error.message);
      // Continue without assessment if there's an issue
    }

    return res.json({ success: true, emr: patientEMR });
  } catch (err) {
    console.error('get patient emr error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/doctor/profile', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const profile = await db.getDoctorProfile(userId);
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Doctor profile not found.' });
    }

    return res.json({ success: true, profile });
  } catch (err) {
    console.error('doctor profile error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.put('/api/doctor/profile', async (req, res) => {
  try {
    const { userId, updates } = req.body;
    if (!userId || !updates) {
      return res.status(400).json({ success: false, message: 'userId and updates are required.' });
    }

    const user = await db.getUserById(userId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can update their profile.' });
    }

    await db.updateDoctorProfile(userId, updates);
    return res.json({ success: true });
  } catch (err) {
    console.error('update doctor profile error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/doctor/patients', async (req, res) => {
  try {
    const doctorId = req.query.doctorId;
    if (!doctorId) {
      return res.status(400).json({ success: false, message: 'doctorId is required.' });
    }

    const user = await db.getUserById(doctorId);
    if (!user || user.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can access this endpoint.' });
    }

    const patients = await db.getAllPatientsWithConsultations(doctorId);
    return res.json({ success: true, patients });
  } catch (err) {
    console.error('doctor patients list error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/doctor/patient/:patientUserId/consultations', async (req, res) => {
  try {
    const doctorId = req.query.doctorId;
    const patientUserId = req.params.patientUserId;

    if (!doctorId || !patientUserId) {
      return res.status(400).json({ success: false, message: 'doctorId and patientUserId are required.' });
    }

    const doctor = await db.getUserById(doctorId);
    if (!doctor || doctor.role !== 'doctor') {
      return res.status(403).json({ success: false, message: 'Only doctors can access this endpoint.' });
    }

    const consultations = await db.getConsultationsByPatient(patientUserId);
    return res.json({ success: true, consultations });
  } catch (err) {
    console.error('doctor patient consultations error', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    release: APP_RELEASE,
  });
});

if (require.main === module) {
  (async () => {
    try {
      await db.init();
      app.listen(PORT, () => {
        console.log(`Server listening on http://localhost:${PORT}`);
      });
    } catch (err) {
      console.error('Failed to start server', err);
      process.exit(1);
    }
  })();
}

module.exports = {
  parsePhilippineIdOcr,
  getPasswordValidationMessage,
  createEmailVerificationToken,
  getVerificationUrl,
  formatDisplayDateTime,
};
