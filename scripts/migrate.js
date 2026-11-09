import 'dotenv/config';
import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const url=process.env.DATABASE_URL;
if(!url){console.error('DATABASE_URL is required');process.exit(1);}
const sql=postgres(url,{prepare:false});
try {
  const directory=resolve('database/migrations');
  const files=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();
  for (const file of files) {
    const schema=await readFile(resolve(directory,file),'utf8');
    for (const statement of schema.split(';').map(s=>s.trim()).filter(Boolean)) {
      await sql.unsafe(statement);
    }
    console.log('Applied '+file);
  }
  console.log('Database migrations completed.');
} finally { await sql.end(); }
