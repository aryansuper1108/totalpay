import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';

const app = new Hono();
const encoder = new TextEncoder();

// Share one Postgres.js client across middleware and route handlers for this
// invocation. Hyperdrive cleans up the edge client when the Worker request ends.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  const db = database(c.env);
  c.set('db', db);
  await next();
});

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
    max: 1,
    fetch_types: false,
    idle_timeout: 20,
    connect_timeout: 10
  });
}
// Postgres.js unsafe() defaults prepare to false even when the client uses
// prepared statements. Hyperdrive transaction pooling needs prepared queries.
const q = (db, statement, params=[]) => db.unsafe(statement, params, {prepare:true});
const secret = env => env?.JWT_SECRET || 'local-only-change-this-secret-before-deploying-123456';
const publicUser = u => ({id:u.id,name:u.name,email:u.email,role:u.role,department:u.department,teamId:u.team_id,active:u.active!==false});
const writeAudit = (db,user,action,entityType,entityId,details={}) =>
  q(db,'INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5::jsonb)',[user?.id||null,action,entityType,entityId||null,JSON.stringify(details)]);
const notifyUser = (db,recipientId,actorId,type,title,body='',taskId=null,requestId=null) =>
  q(db,'INSERT INTO notifications(recipient_id,actor_id,notification_type,title,body,task_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[recipientId,actorId||null,type,title,body,taskId,requestId]);

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
  const rows=await q(c.get('db'),'SELECT * FROM users WHERE id=$1 AND active=TRUE',[payload.sub]);
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

app.get('/api/health',c=>c.json({ok:true,service:'Totalpay Workdesk API',runtime:'portable'}));

app.post('/api/auth/login',async c=>{
  const db=c.get('db');
  const {email,password}=await c.req.json();
  const rows=await q(db,'SELECT * FROM users WHERE LOWER(email)=LOWER($1) AND active=TRUE',[email||'']);
  if(!rows.length||!(await bcrypt.compare(password||'',rows[0].password_hash))) return c.json({error:'Invalid email or password'},401);
  return c.json({token:await makeToken(rows[0].id,c.env),user:publicUser(rows[0])});
});

app.use('/api/*',async(c,next)=>{ if(c.req.path==='/api/health'||c.req.path.startsWith('/api/auth/')) return next(); return auth(c,next); });

app.get('/api/me',c=>c.json(publicUser(c.get('user'))));

app.get('/api/org',async c=>{
  const db=c.get('db'),u=c.get('user');
  let teams,members;
  if(u.role==='ADMIN'){
    teams=await q(db,'SELECT t.*,u.name AS manager_name FROM teams t LEFT JOIN users u ON u.id=t.manager_id ORDER BY t.name');
    members=await q(db,'SELECT id,name,email,role,department,team_id,active FROM users ORDER BY active DESC,name');
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
  const db=c.get('db'),{name,email,password,role,department,teamId}=await c.req.json();
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
    await writeAudit(db,c.get('user'),'created','user',rows[0].id,{name:rows[0].name,email:rows[0].email,role});
    return c.json(publicUser(rows[0]),201);
  } catch(e) { return c.json({error:e.code==='23505'?'Email already exists':'Unable to create user'},409); }
});

app.patch('/api/users/:id',adminOnly,async c=>{
  const db=c.get('db'),id=c.req.param('id'),body=await c.req.json();
  const current=await q(db,'SELECT * FROM users WHERE id=$1',[id]);
  if(!current.length) return c.json({error:'User not found'},404);
  const u=current[0],name=String(body.name??u.name).trim(),email=String(body.email??u.email).trim().toLowerCase();
  const role=body.role??u.role,department=String(body.department??u.department).trim(),active=body.active??u.active;
  if(!name||!email||!department||!['ADMIN','MANAGER','EMPLOYEE'].includes(role)) return c.json({error:'Name, email, department and a valid role are required'},400);
  if(String(u.id)===String(c.get('user').id)&&(!active||role!=='ADMIN')) return c.json({error:'You cannot deactivate or remove administrator access from your own account'},400);
  if(body.password&&String(body.password).length<12) return c.json({error:'Use a password of at least 12 characters'},400);
  if(u.team_id){const t=await q(db,'SELECT department FROM teams WHERE id=$1',[u.team_id]);if(t.length&&t[0].department!==department)return c.json({error:'Move this user to a matching department/team before changing department'},400)}
  if(u.role==='MANAGER'&&(role!=='MANAGER'||!active)) await q(db,'UPDATE teams SET manager_id=NULL WHERE manager_id=$1',[id]);
  try {
    const rows=await q(db,`UPDATE users SET name=$1,email=$2,role=$3,department=$4,active=$5,password_hash=COALESCE($6,password_hash),updated_at=NOW() WHERE id=$7 RETURNING *`,[name,email,role,department,active,body.password?await bcrypt.hash(body.password,12):null,id]);
    await writeAudit(db,c.get('user'),'updated','user',id,{name,email,role,department,active,passwordChanged:Boolean(body.password)});
    return c.json(publicUser(rows[0]));
  } catch(e) { return c.json({error:e.code==='23505'?'Email already exists':'Unable to update user'},409); }
});

app.post('/api/teams',adminOnly,async c=>{
  const db=c.get('db'),{name,department,managerId}=await c.req.json();
  if(!name||!department) return c.json({error:'Team name and department required'},400);
  if(managerId) {
    const mgr=await q(db,"SELECT id,role,department FROM users WHERE id=$1 AND active=TRUE",[managerId]);
    if(!mgr.length||mgr[0].role!=='MANAGER'||mgr[0].department!==department) return c.json({error:'Select an active manager from the same department'},400);
  }
  const rows=await q(db,'INSERT INTO teams(name,department,manager_id) VALUES($1,$2,$3) RETURNING *',[name.trim(),department,managerId||null]);
  if(managerId) await q(db,'UPDATE users SET team_id=$1 WHERE id=$2',[rows[0].id,managerId]);
  await writeAudit(db,c.get('user'),'created','team',rows[0].id,{name:rows[0].name,department:rows[0].department});
  return c.json(rows[0],201);
});

app.patch('/api/teams/:id',adminOnly,async c=>{
  const db=c.get('db'),id=c.req.param('id'),{name,department,managerId}=await c.req.json();
  const existing=await q(db,'SELECT * FROM teams WHERE id=$1',[id]);
  if(!existing.length) return c.json({error:'Team not found'},404);
  if(!name?.trim()||!department?.trim()) return c.json({error:'Team name and department are required'},400);
  const assigned=await q(db,'SELECT COUNT(*)::int AS count FROM users WHERE team_id=$1 AND department<>$2',[id,department]);
  if(Number(assigned[0].count)>0) return c.json({error:'Reassign members to the new department before changing this team department'},400);
  if(managerId){const mgr=await q(db,'SELECT id,role,department FROM users WHERE id=$1 AND active=TRUE',[managerId]);if(!mgr.length||mgr[0].role!=='MANAGER'||mgr[0].department!==department)return c.json({error:'Select an active manager from the same department'},400)}
  const rows=await q(db,'UPDATE teams SET name=$1,department=$2,manager_id=$3 WHERE id=$4 RETURNING *',[name.trim(),department,managerId||null,id]);
  if(managerId) await q(db,'UPDATE users SET team_id=$1 WHERE id=$2',[id,managerId]);
  await writeAudit(db,c.get('user'),'updated','team',id,{name:rows[0].name,department:rows[0].department,managerId:rows[0].manager_id});
  return c.json(rows[0]);
});

app.patch('/api/users/:id/team',adminOnly,async c=>{
  const db=c.get('db'),{teamId}=await c.req.json();
  if(teamId) {
    const rows=await q(db,'SELECT department FROM teams WHERE id=$1',[teamId]);
    const user=await q(db,'SELECT department FROM users WHERE id=$1',[c.req.param('id')]);
    if(!rows.length||!user.length||rows[0].department!==user[0].department) return c.json({error:'Team and user departments must match'},400);
  }
  await q(db,'UPDATE users SET team_id=$1 WHERE id=$2',[teamId||null,c.req.param('id')]);
  await writeAudit(db,c.get('user'),'changed_team','user',c.req.param('id'),{teamId:teamId||null});
  return c.json({ok:true});
});

app.get('/api/tasks',async c=>{
  const db=c.get('db'),u=c.get('user');
  let rows;
  if(u.role==='ADMIN') rows=await q(db,'SELECT * FROM tasks ORDER BY due_date NULLS LAST,id DESC');
  else if(u.role==='MANAGER') rows=await q(db,'SELECT * FROM tasks WHERE team_id=$1 ORDER BY due_date NULLS LAST,id DESC',[u.team_id||-1]);
  else rows=await q(db,'SELECT * FROM tasks WHERE owner_id=$1 OR id IN (SELECT task_id FROM task_collaborators WHERE user_id=$1) ORDER BY due_date NULLS LAST,id DESC',[u.id]);
  return c.json(await taskDtos(db,rows));
});

app.get('/api/planner/:userId',async c=>{
  const db=c.get('db'),u=c.get('user'),targetRows=await q(db,'SELECT * FROM users WHERE id=$1 AND active=TRUE',[c.req.param('userId')]);
  if(!targetRows.length) return c.json({error:'User not found'},404);
  const target=targetRows[0];
  const allowed=u.role==='ADMIN'||u.id===target.id||(u.role==='MANAGER'&&target.team_id===u.team_id);
  if(!allowed) return c.json({error:'You cannot view this planner'},403);
  const rows=await q(db,'SELECT * FROM tasks WHERE owner_id=$1 ORDER BY due_date NULLS LAST,id DESC',[target.id]);
  return c.json({user:publicUser(target),tasks:await taskDtos(db,rows)});
});

app.post('/api/tasks',async c=>{
  const db=c.get('db'),u=c.get('user'),{title,description='',ownerId,priority='MEDIUM',status='TODO',dueDate,collaboratorIds=[]}=await c.req.json();
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
  const validCollaborators=[];
  for(const cid of [...new Set(collaboratorIds.map(Number))]) {
    if(cid===owner.id) continue;
    const collab=await q(db,'SELECT id,team_id FROM users WHERE id=$1 AND active=TRUE',[cid]);
    if(collab.length&&collab[0].team_id===owner.team_id){await q(db,'INSERT INTO task_collaborators(task_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[inserted[0].id,cid]);validCollaborators.push(cid)}
  }
  const recipientIds=[owner.id,...validCollaborators].filter((id,index,array)=>String(id)!==String(u.id)&&array.findIndex(x=>String(x)===String(id))===index);
  for(const recipientId of recipientIds) await notifyUser(db,recipientId,u.id,'TASK_ASSIGNED','A task was assigned to you',title.trim(),inserted[0].id);
  await writeAudit(db,u,'created','task',inserted[0].id,{title:title.trim(),ownerId:owner.id,teamId:owner.team_id});
  return c.json(await taskDto(db,inserted[0]),201);
});

app.patch('/api/tasks/:id',async c=>{
  const db=c.get('db'),u=c.get('user'),id=Number(c.req.param('id')),body=await c.req.json();
  const rows=await q(db,'SELECT * FROM tasks WHERE id=$1',[id]);
  if(!rows.length) return c.json({error:'Task not found'},404);
  const t=rows[0];
  const allowed=u.role==='ADMIN'||(u.role==='MANAGER'&&t.team_id===u.team_id)||t.owner_id===u.id;
  if(!allowed) return c.json({error:'You cannot update this task'},403);
  const status=body.status??t.status,priority=body.priority??t.priority;
  if(!['TODO','IN_PROGRESS','ON_HOLD','BLOCKED','DONE'].includes(status)||!['LOW','MEDIUM','HIGH'].includes(priority)) return c.json({error:'Invalid task status or priority'},400);
  const updated=await q(db,`UPDATE tasks SET title=$1,description=$2,status=$3,priority=$4,due_date=$5,updated_at=NOW() WHERE id=$6 RETURNING *`,
    [body.title??t.title,body.description??t.description,status,priority,body.dueDate??t.due_date,id]);
  if(status!==t.status){
    const recipients=[t.owner_id,t.created_by].filter((rid,index,array)=>String(rid)!==String(u.id)&&array.findIndex(x=>String(x)===String(rid))===index);
    for(const rid of recipients) await notifyUser(db,rid,u.id,'TASK_STATUS','Task status changed',`${updated[0].title}: ${status}`,t.id);
    await writeAudit(db,u,'status_changed','task',id,{from:t.status,to:status});
  }
  return c.json(await taskDto(db,updated[0]));
});

app.delete('/api/tasks/:id',async c=>{
  const db=c.get('db'),u=c.get('user'),rows=await q(db,'SELECT * FROM tasks WHERE id=$1',[Number(c.req.param('id'))]);
  if(!rows.length) return c.json({error:'Task not found'},404);
  const t=rows[0],allowed=u.role==='ADMIN'||(u.role==='MANAGER'&&t.team_id===u.team_id)||t.owner_id===u.id;
  if(!allowed) return c.json({error:'You cannot delete this task'},403);
  await q(db,'DELETE FROM tasks WHERE id=$1',[t.id]);
  await writeAudit(db,u,'deleted','task',t.id,{title:t.title});
  return c.json({ok:true});
});

app.get('/api/requests',async c=>{
  const db=c.get('db'),u=c.get('user');
  let rows;
  if(u.role==='ADMIN'||u.department==='Technical') rows=await q(db,`SELECT r.*,rq.name AS requester_name,ap.name AS approver_name,byu.name AS approved_by_name
    FROM requests r LEFT JOIN users rq ON rq.id=r.requester_id LEFT JOIN users ap ON ap.id=r.approver_id LEFT JOIN users byu ON byu.id=r.approved_by ORDER BY r.created_at DESC,r.id DESC`);
  else rows=await q(db,`SELECT r.*,rq.name AS requester_name,ap.name AS approver_name,byu.name AS approved_by_name
    FROM requests r LEFT JOIN users rq ON rq.id=r.requester_id LEFT JOIN users ap ON ap.id=r.approver_id LEFT JOIN users byu ON byu.id=r.approved_by
    WHERE r.requester_id=$1 OR r.approver_id=$1 ORDER BY r.created_at DESC,r.id DESC`,[u.id]);
  return c.json(rows);
});
app.post('/api/requests',async c=>{
  const db=c.get('db'),u=c.get('user'),body=await c.req.json();
  if(u.role!=='ADMIN'&&u.department!=='Technical') return c.json({error:'Technical department access required'},403);
  const requesterId=body.requesterId||u.id,approverId=body.approverId;
  if(String(requesterId)!==String(u.id)&&u.role!=='ADMIN') return c.json({error:'Only administrators can submit a request for another user'},403);
  if(!body.mid||!body.merchant_name||!body.description||!approverId) return c.json({error:'MID, merchant name, description and an approver are required'},400);
  const people=await q(db,'SELECT id,name,email FROM users WHERE id=ANY($1::bigint[]) AND active=TRUE',[[requesterId,approverId]]);
  const requester=people.find(p=>String(p.id)===String(requesterId)),approver=people.find(p=>String(p.id)===String(approverId));
  if(!requester||!approver) return c.json({error:'Select active users for requester and approver'},400);
  const status=body.status||'NOT_STARTED';
  if(!['NOT_STARTED','IN_PROGRESS','COMPLETED'].includes(status)) return c.json({error:'Invalid request status'},400);
  const rows=await q(db,`INSERT INTO requests(mid,merchant_name,request_date,description,platform,requester,requester_id,developer,approver,approver_id,status,test_status,environment,checker,release_date,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [body.mid,body.merchant_name,body.request_date||null,body.description,body.platform||'',requester.name,requester.id,body.developer||'',approver.name,approver.id,status,body.test_status||'',body.environment||'',body.checker||'',body.release_date||null,u.id]);
  await notifyUser(db,approver.id,u.id,'REQUEST_APPROVAL','Approval requested',`${requester.name} needs your approval for ${body.merchant_name}`,null,rows[0].id);
  await writeAudit(db,u,'created','request',rows[0].id,{merchant:body.merchant_name,approverId:approver.id});
  return c.json(rows[0],201);
});
app.patch('/api/requests/:id/decision',async c=>{
  const db=c.get('db'),u=c.get('user'),id=c.req.param('id'),{decision,note=''}=await c.req.json();
  if(!['APPROVED','REJECTED'].includes(decision)) return c.json({error:'Choose approve or reject'},400);
  const requests=await q(db,'SELECT * FROM requests WHERE id=$1',[id]);
  if(!requests.length) return c.json({error:'Request not found'},404);
  const r=requests[0];
  if(String(r.approver_id)!==String(u.id)&&u.role!=='ADMIN') return c.json({error:'Only the assigned approver can decide this request'},403);
  if(r.approval_status!=='PENDING') return c.json({error:'This request has already been decided'},409);
  const updated=await q(db,`UPDATE requests SET approval_status=$1,approved_by=$2,approved_at=NOW(),approval_note=$3 WHERE id=$4 RETURNING *`,[decision,u.id,String(note).slice(0,1000),id]);
  if(r.requester_id&&String(r.requester_id)!==String(u.id)) await notifyUser(db,r.requester_id,u.id,'REQUEST_DECISION',`Request ${decision.toLowerCase()}`,`${r.merchant_name} was ${decision.toLowerCase()} by ${u.name}`,null,r.id);
  await writeAudit(db,u,'approval_'+decision.toLowerCase(),'request',id,{merchant:r.merchant_name,note:String(note).slice(0,1000)});
  return c.json(updated[0]);
});
app.patch('/api/requests/:id',async c=>{
  const db=c.get('db'),u=c.get('user'),id=c.req.param('id'),body=await c.req.json();
  if(u.role!=='ADMIN'&&u.department!=='Technical') return c.json({error:'Technical department access required'},403);
  if(body.status&&!['NOT_STARTED','IN_PROGRESS','COMPLETED'].includes(body.status)) return c.json({error:'Invalid request status'},400);
  const rows=await q(db,`UPDATE requests SET status=COALESCE($1,status),test_status=COALESCE($2,test_status),developer=COALESCE($3,developer),environment=COALESCE($4,environment),release_date=COALESCE($5,release_date) WHERE id=$6 RETURNING *`,[body.status??null,body.test_status??null,body.developer??null,body.environment??null,body.release_date??null,id]);
  if(!rows.length) return c.json({error:'Request not found'},404);
  await writeAudit(db,u,'updated','request',id,{status:rows[0].status});
  return c.json(rows[0]);
});

app.get('/api/notifications',async c=>{
  const db=c.get('db'),u=c.get('user');
  const [items,count]=await Promise.all([
    q(db,'SELECT id,notification_type,title,body,task_id,request_id,read_at,created_at FROM notifications WHERE recipient_id=$1 ORDER BY created_at DESC LIMIT 30',[u.id]),
    q(db,'SELECT COUNT(*)::int AS count FROM notifications WHERE recipient_id=$1 AND read_at IS NULL',[u.id])
  ]);
  return c.json({items,unreadCount:Number(count[0].count)});
});
app.patch('/api/notifications/:id/read',async c=>{
  const db=c.get('db'),u=c.get('user'),id=c.req.param('id');
  const rows=await q(db,'UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND recipient_id=$2 RETURNING id,read_at',[id,u.id]);
  if(!rows.length) return c.json({error:'Notification not found'},404);
  return c.json(rows[0]);
});
app.get('/api/audit',adminOnly,async c=>{
  const rows=await q(c.get('db'),`SELECT a.id,a.action,a.entity_type,a.entity_id,a.details,a.created_at,u.name AS actor_name
    FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.id DESC LIMIT 100`);
  return c.json(rows);
});

export default app;
