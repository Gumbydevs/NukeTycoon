const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const db = require('./db');

const resend = new Resend(process.env.RESEND_API_KEY);

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
        { id: player.id, email: player.email, username: player.username },
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

    const { error } = await resend.emails.send({
        from: process.env.EMAIL_FROM || 'Nuclear Tycoon <onboarding@resend.dev>',
        to: email,
        subject: `${code} — your Nuclear Tycoon login code`,
        html: `
            <div style="background:#0d0d0d;color:#fff;padding:32px;font-family:monospace;max-width:480px;">
                <div style="font-size:20px;font-weight:bold;color:#ffb84d;margin-bottom:16px;">☢️ Nuclear Tycoon</div>
                <p style="color:#ccc;margin-bottom:8px;">Your login code:</p>
                <div style="font-size:40px;font-weight:bold;color:#ffb84d;letter-spacing:10px;margin:20px 0;padding:16px;background:#111;text-align:center;border-radius:4px;">${code}</div>
                <p style="color:#888;font-size:12px;">Expires in 10 minutes. Do not share this code.</p>
            </div>
        `,
    });

    if (error) {
        console.error('Resend error:', error);
        return { ok: false, error: 'Failed to send email. Try again.' };
    }

    return { ok: true };
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
    let playerResult = await db.query('SELECT * FROM players WHERE email = $1', [email]);

    if (playerResult.rows.length === 0) {
        // New player — auto-generate a username from the email local part
        const base = email.split('@')[0]
            .replace(/[^a-zA-Z0-9]/g, '')
            .slice(0, 10)
            .toUpperCase() || 'PLAYER';
        const suffix = Math.floor(Math.random() * 9000) + 1000;
        const username = `${base}_${suffix}`;
        playerResult = await db.query(
            'INSERT INTO players (email, username, token_balance) VALUES ($1, $2, 50000) RETURNING *',
            [email, username]
        );
    }

    const player = playerResult.rows[0];
    const token = generateJWT(player);
    return { ok: true, player, token };
}

module.exports = { sendOTP, verifyOTP, verifyJWT, generateJWT };
