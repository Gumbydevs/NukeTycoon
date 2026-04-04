#!/usr/bin/env node
require('dotenv').config();
const { createAdminKey } = require('./auth');

async function main() {
  const name = process.argv[2] || process.env.ADMIN_KEY_NAME || 'cli';
  const createdBy = process.argv[3] || process.env.CREATED_BY || name;
  try {
    const res = await createAdminKey(name, createdBy);
    console.log('Created admin key id:', res.id);
    console.log('Plain admin key (copy this now):');
    console.log(res.key);
    console.log('\nStore this key in a safe place or add it to CLIENT browsers as needed.');
    process.exit(0);
  } catch (err) {
    console.error('Failed to create admin key:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

main();
