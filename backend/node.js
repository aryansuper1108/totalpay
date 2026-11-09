import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import app from './src/app.js';

const env = {
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET
};
const web = new Hono();
web.route('/', app);
web.use('/*', serveStatic({root:'./client/dist'}));
web.get('*', serveStatic({root:'./client/dist',path:'index.html'}));

const port = Number(process.env.PORT || 4000);
serve({fetch:(request)=>web.fetch(request,env),port}, info => {
  console.log(`TotalPay WorkDesk listening on http://localhost:${info.port}`);
});
