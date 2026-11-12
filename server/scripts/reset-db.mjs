// Drops and recreates the public schema of the database in DATABASE_URL, so
// the next boot runs every migration on an empty database. Used by the e2e
// suite before it starts the server; handy for a clean local dev database too.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:5432/captain_e2e node scripts/reset-db.mjs

import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
}
if (/supabase|render|amazonaws|prod/i.test(url)) {
    console.error('refusing to reset what looks like a hosted database: ' + url.replace(/\/\/.*@/, '//…@'));
    process.exit(2);
}
const sql = postgres(url, {max: 1, onnotice: () => undefined});
await sql.unsafe('drop schema if exists public cascade; create schema public;');
await sql.end();
console.log('reset ' + url.replace(/\/\/.*@/, '//…@'));
