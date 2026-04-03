const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const db = require('./db');
const nodemailer = require('nodemailer');

const DEFAULT_AVATAR = '☢️';
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Optional SMTP transporter (useful if you don't want to verify a domain with Resend)
let smtpTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
        smtpTransporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
        // verify connection config now (non-blocking)
        smtpTransporter.verify().catch(err => console.warn('SMTP verify failed:', err && err.message));
    } catch (e) {
        console.warn('Failed to create SMTP transporter:', e && e.message);
        smtpTransporter = null;
    }
}

// Simple in-memory rate limit: max 3 OTP requests per email per 10 minutes
const otpRateLimit = new Map();
function checkRateLimit(email) {
    const now = Date.now();
    const key = email.toLowerCase();
    const entry = otpRateLimit.get(key) || { count: 0, windowStart: now };
    if (now - entry.windowStart > 10 * 60 * 1000) {
        // Reset window
        otpRateLimit.set(key, { count: 1, windowStart: now });
        return true;
    }
    if (entry.count >= 3) return false;
    entry.count++;
    otpRateLimit.set(key, entry);
    return true;
}

function hashCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

function generateJWT(player) {
    return jwt.sign(
        { id: player.id, email: player.email, username: player.username, avatar: player.avatar || DEFAULT_AVATAR },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );
}

function verifyJWT(token) {
    try {
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return null;
    }
}

async function sendOTP(email) {
    // If an SMTP transporter is configured, use it first (supports Gmail app passwords, SendGrid SMTP, etc.)
    if (smtpTransporter) {
        try {
            const code = String(Math.floor(100000 + Math.random() * 900000));
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

            // Invalidate existing unused codes for this email
            await db.query(
                'UPDATE auth_codes SET used = TRUE WHERE email = $1 AND used = FALSE',
                [email]
            );

            await db.query(
                'INSERT INTO auth_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)',
                [email, hashCode(code), expiresAt]
            );

            const mailOptions = {
                from: process.env.EMAIL_FROM || process.env.SMTP_USER,
                to: email,
                subject: `${code} — your NUKEWAR login code`,
                html: `
                    <div style="background:#0d0d0d;color:#fff;padding:32px;font-family:monospace;max-width:480px;">
                        <div style="font-size:20px;font-weight:bold;color:#ffb84d;margin-bottom:16px;">☢️ NUKEWAR</div>
                        <p style="color:#ccc;margin-bottom:8px;">Your login code:</p>
                        <div style="font-size:40px;font-weight:bold;color:#ffb84d;letter-spacing:10px;margin:20px 0;padding:16px;background:#111;text-align:center;border-radius:4px;">${code}</div>
                        <p style="color:#888;font-size:12px;">Expires in 10 minutes. Do not share this code.</p>
                    </div>
                `,
            };

            await smtpTransporter.sendMail(mailOptions);
            return { ok: true };
        } catch (err) {
            console.error('SMTP send error:', err && (err.stack || err.message || err));
            // Fall through to try Resend if available
        }
    }

    if (!resend) {
        console.error('RESEND_API_KEY is missing. Email login is disabled.');
        return { ok: false, error: 'Email login is not configured yet.' };
    }

    if (!checkRateLimit(email)) {
        return { ok: false, error: 'Too many code requests. Wait a few minutes.' };
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Invalidate existing unused codes for this email
    await db.query(
        'UPDATE auth_codes SET used = TRUE WHERE email = $1 AND used = FALSE',
        [email]
    );

    await db.query(
        'INSERT INTO auth_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)',
        [email, hashCode(code), expiresAt]
    );

    let sendResult;
    try {
        sendResult = await resend.emails.send({
        from: process.env.EMAIL_FROM || 'NUKEWAR <onboarding@resend.dev>',
        to: email,
        subject: `${code} — your NUKEWAR login code`,
        html: `
            <div style="background:#0d0d0d;color:#fff;padding:32px;font-family:monospace;max-width:480px;">
                <div style="font-size:20px;font-weight:bold;color:#ffb84d;margin-bottom:16px;">☢️ NUKEWAR</div>
                <p style="color:#ccc;margin-bottom:8px;">Your login code:</p>
                <div style="font-size:40px;font-weight:bold;color:#ffb84d;letter-spacing:10px;margin:20px 0;padding:16px;background:#111;text-align:center;border-radius:4px;">${code}</div>
                <p style="color:#888;font-size:12px;">Expires in 10 minutes. Do not share this code.</p>
            </div>
        `,
    });
    } catch (err) {
        // If Resend throws, surface the error for logging below
        sendResult = { error: err };
    }

    if (sendResult && sendResult.error) {
        console.error('Resend error:', sendResult.error);
        // Development fallback: when DEV_EMAIL_FALLBACK=true, log the code to the server console
        // so local testing can proceed without a verified sending domain.
        if (process.env.DEV_EMAIL_FALLBACK === 'true' || (sendResult.error && sendResult.error.statusCode === 403 && sendResult.error.name === 'validation_error')) {
            console.warn('Resend blocked sending email; falling back to dev OTP output.');
            console.info(`DEV OTP for ${email}: ${code}`);
            return { ok: true, code };
        }
        return { ok: false, error: 'Failed to send email. Try again.' };
    }

    return { ok: true };
}

// Password hashing helpers using PBKDF2
function hashPasswordSync(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    return { salt, hash };
}

function verifyPasswordSync(password, salt, hash) {
    if (!salt || !hash) return false;
    const derived = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}

async function signupWithPassword(email, password, username) {
    if (!email || !password) return { ok: false, error: 'Email and password are required.' };
    const lower = email.toLowerCase().trim();
    // Check existing
    const exists = await db.query('SELECT id FROM players WHERE email = $1', [lower]);
    if (exists.rows.length > 0) return { ok: false, error: 'Account already exists for that email.' };

    const uname = username && username.trim().length >= 3 ? username.trim() : (lower.split('@')[0].replace(/[^a-zA-Z0-9]/g,'').slice(0,10).toUpperCase() || 'PLAYER') + '_' + (Math.floor(Math.random()*9000)+1000);

    const { salt, hash } = hashPasswordSync(password);
    const result = await db.query(
        'INSERT INTO players (email, username, avatar, token_balance, password_salt, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [lower, uname, DEFAULT_AVATAR, 50000, salt, hash]
    );
    const player = result.rows[0];
    const token = generateJWT(player);
    return { ok: true, player, token, isNewPlayer: true };
}

async function loginWithPassword(email, password) {
    if (!email || !password) return { ok: false, error: 'Email and password are required.' };
    const lower = email.toLowerCase().trim();
    const result = await db.query('SELECT * FROM players WHERE email = $1', [lower]);
    if (result.rows.length === 0) return { ok: false, error: 'No account for that email.' };
    const player = result.rows[0];
    if (!player.password_salt || !player.password_hash) return { ok: false, error: 'This account does not use password login.' };
    const ok = verifyPasswordSync(password, player.password_salt, player.password_hash);
    if (!ok) return { ok: false, error: 'Invalid password.' };
    const token = generateJWT(player);
    return { ok: true, player, token, isNewPlayer: false };
}

async function verifyOTP(email, code) {
    const result = await db.query(
        `SELECT * FROM auth_codes
         WHERE email = $1 AND code_hash = $2 AND used = FALSE AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [email, hashCode(code.trim())]
    );

    if (result.rows.length === 0) {
        return { ok: false, error: 'Invalid or expired code.' };
    }

    // Mark used
    await db.query('UPDATE auth_codes SET used = TRUE WHERE id = $1', [result.rows[0].id]);

    // Get or create player
    let isNewPlayer = false;
    let playerResult = await db.query('SELECT * FROM players WHERE email = $1', [email]);

    if (playerResult.rows.length === 0) {
        isNewPlayer = true;
        // New player — auto-generate a username from the email local part
        const base = email.split('@')[0]
            .replace(/[^a-zA-Z0-9]/g, '')
            .slice(0, 10)
            .toUpperCase() || 'PLAYER';
        const suffix = Math.floor(Math.random() * 9000) + 1000;
        const username = `${base}_${suffix}`;
        playerResult = await db.query(
            'INSERT INTO players (email, username, avatar, token_balance) VALUES ($1, $2, $3, 50000) RETURNING *',
            [email, username, DEFAULT_AVATAR]
        );
    }

    const player = playerResult.rows[0];
    if (!player.avatar) player.avatar = DEFAULT_AVATAR;
    const token = generateJWT(player);
    return { ok: true, player, token, isNewPlayer };
}

module.exports = { sendOTP, verifyOTP, verifyJWT, generateJWT, signupWithPassword, loginWithPassword };
