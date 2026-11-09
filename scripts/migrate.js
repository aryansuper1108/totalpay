import 'dotenv/config';
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const url=process.env.DATABASE_URL;
if(!url){console.error('DATABASE_URL is required');process.exit(1);}
const sql=postgres(url,{prepare:false});
try {
  const schema=await readFile(resolve('database/migrations/001_initial_schema.sql'),'utf8');
  for (const statement of schema.split(';').map(s=>s.trim()).filter(Boolean)) {
    await sql.unsafe(statement);
  }
  console.log('Database migration completed.');
} finally { await sql.end(); }
