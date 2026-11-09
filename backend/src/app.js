import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';

const app = new Hono();
const encoder = new TextEncoder();

// Keep unexpected API failures machine-readable. Without this handler Hono's
// default plain-text 500 response causes the login UI's JSON parser to fail.
app.onError((error, c) => {
  console.error('Unhandled API error:', {
    name:error?.name,
    message:error?.message,
    code:error?.code,
    stack:error?.stack
  });
  return c.json({error:'The service could not complete the request. Please try again later.'},500);
});

function database(env) {
  const connectionString = env?.HYPERDRIVE?.connectionString || env?.DATABASE_URL || '';
  if (!connectionString) throw new Error('Database is not configured. Set Cloudflare Hyperdrive or DATABASE_URL.');
  // Hyperdrive provides the cross-request connection pool. Keep the
  // Postgres.js client request-scoped so a frozen Worker isolate cannot reuse
  // a socket the runtime has already closed.
  return postgres(connectionString, {
    max: 5,
    fetch_types: false,
    idle_timeout: 20,
    connect_timeout: 10
  });
}
const q = (db, statement, params=[]) => db.unsafe(statement, params);
const secret = env => env?.JWT_SECRET || 'local-only-change-this-secret-before-deploying-123456';
const publicUser = u => ({id:u.id,name:u.name,email:u.email,role:u.role,department:u.department,teamId:u.team_id});

async function makeToken(id, env) {
  return new SignJWT({sub:String(id)}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('12h').sign(encoder.encode(secret(env)));
}
async function auth(c,next) {
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'');
  if(!token) return c.json({error:'Authentication required'},401);
  let payload;
  try {
    ({payload}=await jwtVerify(token,encoder.encode(secret(c.env))));
  } catch {
    return c.json({error:'Authentication required'},401);
  }
  if(!payload.sub) return c.json({error:'Authentication required'},401);
  // Let database and route failures reach app.onError instead of disguising
  // them as invalid credentials.
  const rows=await q(database(c.env),'SELECT * FROM users WHERE id=$1 AND active=TRUE',[payload.sub]);
  if(!rows.length) return c.json({error:'Your account is inactive or no longer exists'},401);
  c.set('user',rows[0]);
  await next();
}
const adminOnly = async(c,next) => c.get('user')?.role==='ADMIN' ? next() : c.json({error:'Administrator access required'},403);
const taskDto = async(db,t) => {
  const [owners,teams,collabs]=await Promise.all([
    q(db,'SELECT id,name FROM users WHERE id=$1',[t.owner_id]),
    t.team_id ? q(db,'SELECT id,name,department FROM teams WHERE id=$1',[t.team_id]) : Promise.resolve([]),
    q(db,'SELECT u.id,u.name FROM task_collaborators c JOIN users u ON u.id=c.user_id WHERE c.task_id=$1',[t.id])
  ]);
  return {...t,owner:owners[0]||null,team:teams[0]||null,collaborators:collabs};
};
const taskDtos = async(db,rows) => Promise.all(rows.map(t=>taskDto(db,t)));

app.get('/api/health',c=>c.json({ok:true,service:'TotalPay WorkDesk API',runtime:'portable'}));

app.post('/api/auth/bootstrap',async c=>{
  const db=database(c.env);
  const count=await q(db,'SELECT COUNT(*)::int AS count FROM users');
  if(Number(count[0].count)>0) return c.json({error:'Workspace is already initialized'},409);
  const {name,email,password}=await c.req.json();
  if(!name||!email||!password||String(password).length<12) return c.json({error:'Name, email and a password of at least 12 characters are required'},400);
  const hash=await bcrypt.hash(password,12);
  const rows=await q(db,`INSERT INTO users(name,email,password_hash,role,department,active)
    VALUES($1,LOWER($2),$3,'ADMIN','Management',TRUE)
    RETURNING id,name,email,role,department,team_id`,[name.trim(),email.trim(),hash]);
  const token=await makeToken(rows[0].id,c.env);
  return c.json({token,user:publicUser(rows[0])},201);
});

app.post('/api/auth/login',async c=>{
  const db=database(c.env);
  const {email,password}=await c.req.json();
  const rows=await q(db,'SELECT * FROM users WHERE LOWER(email)=LOWER($1) AND active=TRUE',[email||'']);
  if(!rows.length||!(await bcrypt.compare(password||'',rows[0].password_hash))) return c.json({error:'Invalid email or password'},401);
  return c.json({token:await makeToken(rows[0].id,c.env),user:publicUser(rows[0])});
});

app.use('/api/*',async(c,next)=>{ if(c.req.path==='/api/health'||c.req.path.startsWith('/api/auth/')) return next(); return auth(c,next); });

app.get('/api/me',c=>c.json(publicUser(c.get('user'))));

app.get('/api/org',async c=>{
  const db=database(c.env),u=c.get('user');
  let teams,members;
  if(u.role==='ADMIN'){
    teams=await q(db,'SELECT t.*,u.name AS manager_name FROM teams t LEFT JOIN users u ON u.id=t.manager_id ORDER BY t.name');
    members=await q(db,'SELECT id,name,email,role,department,team_id FROM users WHERE active=TRUE ORDER BY name');
  } else if(u.role==='MANAGER') {
    teams=await q(db,'SELECT t.*,u.name AS manager_name FROM teams t LEFT JOIN users u ON u.id=t.manager_id WHERE t.id=$1',[u.team_id||-1]);
    members=await q(db,'SELECT id,name,email,role,department,team_id FROM users WHERE active=TRUE AND team_id=$1 ORDER BY name',[u.team_id||-1]);
  } else {
    teams=u.team_id ? await q(db,'SELECT t.*,u.name AS manager_name FROM teams t LEFT JOIN users u ON u.id=t.manager_id WHERE t.id=$1',[u.team_id]) : [];
    members=[{id:u.id,name:u.name,email:u.email,role:u.role,department:u.department,team_id:u.team_id}];
  }
  return c.json({teams,members:members.map(publicUser)});
});

app.post('/api/users',adminOnly,async c=>{
  const db=database(c.env),{name,email,password,role,department,teamId}=await c.req.json();
  if(!name||!email||!password||!role||!department) return c.json({error:'Name, email, password, role and department are required'},400);
  if(!['ADMIN','MANAGER','EMPLOYEE'].includes(role)) return c.json({error:'Invalid role'},400);
  if(String(password).length<12) return c.json({error:'Use a temporary password of at least 12 characters'},400);
  if(teamId) {
    const team=await q(db,'SELECT * FROM teams WHERE id=$1',[teamId]);
    if(!team.length||team[0].department!==department) return c.json({error:'Selected team does not match the department'},400);
  }
  try {
    const rows=await q(db,`INSERT INTO users(name,email,password_hash,role,department,team_id,active)
      VALUES($1,LOWER($2),$3,$4,$5,$6,TRUE)
      RETURNING id,name,email,role,department,team_id`,[name.trim(),email.trim(),await bcrypt.hash(password,12),role,department,teamId||null]);
    if(role==='MANAGER'&&teamId) await q(db,'UPDATE teams SET manager_id=$1 WHERE id=$2',[rows[0].id,teamId]);
    return c.json(publicUser(rows[0]),201);
  } catch(e) { return c.json({error:e.code==='23505'?'Email already exists':'Unable to create user'},409); }
});

app.post('/api/teams',adminOnly,async c=>{
  const db=database(c.env),{name,department,managerId}=await c.req.json();
  if(!name||!department) return c.json({error:'Team name and department required'},400);
  if(managerId) {
    const mgr=await q(db,"SELECT id,role,department FROM users WHERE id=$1 AND active=TRUE",[managerId]);
    if(!mgr.length||mgr[0].role!=='MANAGER'||mgr[0].department!==department) return c.json({error:'Select an active manager from the same department'},400);
  }
  const rows=await q(db,'INSERT INTO teams(name,department,manager_id) VALUES($1,$2,$3) RETURNING *',[name.trim(),department,managerId||null]);
  if(managerId) await q(db,'UPDATE users SET team_id=$1 WHERE id=$2',[rows[0].id,managerId]);
  return c.json(rows[0],201);
});

app.patch('/api/users/:id/team',adminOnly,async c=>{
  const db=database(c.env),{teamId}=await c.req.json();
  if(teamId) {
    const rows=await q(db,'SELECT department FROM teams WHERE id=$1',[teamId]);
    const user=await q(db,'SELECT department FROM users WHERE id=$1',[c.req.param('id')]);
    if(!rows.length||!user.length||rows[0].department!==user[0].department) return c.json({error:'Team and user departments must match'},400);
  }
  await q(db,'UPDATE users SET team_id=$1 WHERE id=$2',[teamId||null,c.req.param('id')]);
  return c.json({ok:true});
});

app.get('/api/tasks',async c=>{
  const db=database(c.env),u=c.get('user');
  let rows;
  if(u.role==='ADMIN') rows=await q(db,'SELECT * FROM tasks ORDER BY due_date NULLS LAST,id DESC');
  else if(u.role==='MANAGER') rows=await q(db,'SELECT * FROM tasks WHERE team_id=$1 ORDER BY due_date NULLS LAST,id DESC',[u.team_id||-1]);
  else rows=await q(db,'SELECT * FROM tasks WHERE owner_id=$1 OR id IN (SELECT task_id FROM task_collaborators WHERE user_id=$1) ORDER BY due_date NULLS LAST,id DESC',[u.id]);
  return c.json(await taskDtos(db,rows));
});

app.get('/api/planner/:userId',async c=>{
  const db=database(c.env),u=c.get('user'),targetRows=await q(db,'SELECT * FROM users WHERE id=$1 AND active=TRUE',[c.req.param('userId')]);
  if(!targetRows.length) return c.json({error:'User not found'},404);
  const target=targetRows[0];
  const allowed=u.role==='ADMIN'||u.id===target.id||(u.role==='MANAGER'&&target.team_id===u.team_id);
  if(!allowed) return c.json({error:'You cannot view this planner'},403);
  const rows=await q(db,'SELECT * FROM tasks WHERE owner_id=$1 ORDER BY due_date NULLS LAST,id DESC',[target.id]);
  return c.json({user:publicUser(target),tasks:await taskDtos(db,rows)});
});

app.post('/api/tasks',async c=>{
  const db=database(c.env),u=c.get('user'),{title,description='',ownerId,priority='MEDIUM',status='TODO',dueDate,collaboratorIds=[]}=await c.req.json();
  if(!title?.trim()) return c.json({error:'Task title required'},400);
  if(!['TODO','IN_PROGRESS','ON_HOLD','BLOCKED','DONE'].includes(status)||!['LOW','MEDIUM','HIGH'].includes(priority)) return c.json({error:'Invalid task status or priority'},400);
  const owners=await q(db,'SELECT * FROM users WHERE id=$1 AND active=TRUE',[ownerId||u.id]);
  if(!owners.length) return c.json({error:'Task owner not found'},400);
  const owner=owners[0];
  if(u.role==='EMPLOYEE'&&owner.id!==u.id) return c.json({error:'Employees can only create tasks for themselves'},403);
  if(u.role==='MANAGER'&&owner.team_id!==u.team_id) return c.json({error:'You can only assign tasks within your team'},403);
  const inserted=await q(db,`INSERT INTO tasks(title,description,owner_id,team_id,created_by,status,priority,due_date)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [title.trim(),description,owner.id,owner.team_id,u.id,status,priority,dueDate||null]);
  for(const cid of [...new Set(collaboratorIds.map(Number))]) {
    if(cid===owner.id) continue;
    const collab=await q(db,'SELECT id,team_id FROM users WHERE id=$1 AND active=TRUE',[cid]);
    if(collab.length&&collab[0].team_id===owner.team_id) await q(db,'INSERT INTO task_collaborators(task_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[inserted[0].id,cid]);
  }
  return c.json(await taskDto(db,inserted[0]),201);
});

app.patch('/api/tasks/:id',async c=>{
  const db=database(c.env),u=c.get('user'),id=Number(c.req.param('id')),body=await c.req.json();
  const rows=await q(db,'SELECT * FROM tasks WHERE id=$1',[id]);
  if(!rows.length) return c.json({error:'Task not found'},404);
  const t=rows[0];
  const allowed=u.role==='ADMIN'||(u.role==='MANAGER'&&t.team_id===u.team_id)||t.owner_id===u.id;
  if(!allowed) return c.json({error:'You cannot update this task'},403);
  const status=body.status??t.status,priority=body.priority??t.priority;
  if(!['TODO','IN_PROGRESS','ON_HOLD','BLOCKED','DONE'].includes(status)||!['LOW','MEDIUM','HIGH'].includes(priority)) return c.json({error:'Invalid task status or priority'},400);
  const updated=await q(db,`UPDATE tasks SET title=$1,description=$2,status=$3,priority=$4,due_date=$5,updated_at=NOW() WHERE id=$6 RETURNING *`,
    [body.title??t.title,body.description??t.description,status,priority,body.dueDate??t.due_date,id]);
  return c.json(await taskDto(db,updated[0]));
});

app.delete('/api/tasks/:id',async c=>{
  const db=database(c.env),u=c.get('user'),rows=await q(db,'SELECT * FROM tasks WHERE id=$1',[Number(c.req.param('id'))]);
  if(!rows.length) return c.json({error:'Task not found'},404);
  const t=rows[0],allowed=u.role==='ADMIN'||(u.role==='MANAGER'&&t.team_id===u.team_id)||t.owner_id===u.id;
  if(!allowed) return c.json({error:'You cannot delete this task'},403);
  await q(db,'DELETE FROM tasks WHERE id=$1',[t.id]);
  return c.json({ok:true});
});

app.get('/api/requests',async c=>{
  const db=database(c.env),u=c.get('user');
  if(u.role!=='ADMIN'&&u.department!=='Technical') return c.json({error:'Technical department access required'},403);
  return c.json(await q(db,'SELECT * FROM requests ORDER BY id DESC'));
});
app.post('/api/requests',async c=>{
  const db=database(c.env),u=c.get('user');
  if(u.role!=='ADMIN'&&u.department!=='Technical') return c.json({error:'Technical department access required'},403);
  const fields=['mid','merchant_name','request_date','description','platform','requester','developer','approver','status','test_status','environment','checker','release_date'];
  const body=await c.req.json(),values=fields.map(k=>body[k]??'');
  const placeholders=fields.map((_,i)=>`$${i+1}`).join(',');
  const rows=await q(db,`INSERT INTO requests(${fields.join(',')},created_by) VALUES(${placeholders},$${fields.length+1}) RETURNING id`,[...values,u.id]);
  return c.json({id:rows[0].id},201);
});

export default app;
