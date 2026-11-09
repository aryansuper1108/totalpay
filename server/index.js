import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
dotenv.config();
const app=express(); app.use(cors()); app.use(express.json({limit:"5mb"}));
const db=new Database(process.env.DB_FILE||"workdesk.sqlite"); db.pragma("journal_mode = WAL");
const SECRET=process.env.JWT_SECRET||"change-this-secret-before-production";
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('ADMIN','MANAGER','EMPLOYEE')),department TEXT NOT NULL,team_id INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS teams(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,department TEXT NOT NULL,manager_id INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT DEFAULT '',owner_id INTEGER NOT NULL REFERENCES users(id),team_id INTEGER REFERENCES teams(id),created_by INTEGER NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'TODO',priority TEXT NOT NULL DEFAULT 'MEDIUM',due_date TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS task_collaborators(task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id),PRIMARY KEY(task_id,user_id));
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT,mid TEXT,merchant_name TEXT,request_date TEXT,description TEXT,platform TEXT,requester TEXT,developer TEXT,approver TEXT,status TEXT,test_status TEXT,environment TEXT,checker TEXT,release_date TEXT,created_by INTEGER REFERENCES users(id));
`);
const userCount=db.prepare("SELECT COUNT(*) n FROM users").get().n;
if(!userCount){
 const add=db.prepare("INSERT INTO users(name,email,password_hash,role,department,team_id) VALUES(?,?,?,?,?,?)");
 const admin=add.run("CEO Admin","admin@totalpay.local",bcrypt.hashSync("Demo@123",10),"ADMIN","Management").lastInsertRowid;
 const taj=add.run("Taj","taj@totalpay.local",bcrypt.hashSync("Demo@123",10),"MANAGER","Technical").lastInsertRowid;
 const aryan=add.run("Aryan Rana","aryan@totalpay.local",bcrypt.hashSync("Demo@123",10),"EMPLOYEE","Technical").lastInsertRowid;
 const neha=add.run("Neha Patel","neha@totalpay.local",bcrypt.hashSync("Demo@123",10),"EMPLOYEE","Technical").lastInsertRowid;
 const team=db.prepare("INSERT INTO teams(name,department,manager_id) VALUES(?,?,?)").run("Taj Team","Technical",taj).lastInsertRowid;
 db.prepare("UPDATE users SET team_id=? WHERE id IN (?,?,?)").run(team,taj,aryan,neha);
 const task=db.prepare("INSERT INTO tasks(title,description,owner_id,team_id,created_by,status,priority,due_date) VALUES(?,?,?,?,?,?,?,?)");
 task.run("API callback issue on payments","Review callback response and validate payment flow.",aryan,team,aryan,"IN_PROGRESS","HIGH",new Date().toISOString().slice(0,10));
 task.run("Update merchant documentation","Refresh the integration guide.",neha,team,neha,"TODO","MEDIUM",new Date(Date.now()+86400000).toISOString().slice(0,10));
 task.run("Prepare release notes v1.4.0","Prepare release notes for QA handoff.",aryan,team,aryan,"BLOCKED","MEDIUM",new Date(Date.now()+2*86400000).toISOString().slice(0,10));
}
const publicUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,department:u.department,teamId:u.team_id});
function auth(req,res,next){try{const token=(req.headers.authorization||"").replace(/^Bearer /,"");if(!token)throw 0;const p=jwt.verify(token,SECRET);const u=db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(p.id);if(!u)throw 0;req.user=u;next()}catch{res.status(401).json({error:"Authentication required"})}}
const admin=(req,res,next)=>req.user.role==="ADMIN"?next():res.status(403).json({error:"Administrator access required"});
const teamOf=(u)=>u.role==="ADMIN"?null:(u.team_id||null);
function canViewUser(viewer,target){if(viewer.role==="ADMIN")return true;if(viewer.id===target.id)return true;if(viewer.role==="MANAGER"&&target.team_id===viewer.team_id)return true;return false}
function visibleTasks(u){
 if(u.role==="ADMIN")return db.prepare("SELECT * FROM tasks ORDER BY due_date IS NULL,due_date,id DESC").all();
 if(u.role==="MANAGER")return db.prepare("SELECT * FROM tasks WHERE team_id=? ORDER BY due_date IS NULL,due_date,id DESC").all(u.team_id||-1);
 return db.prepare("SELECT * FROM tasks WHERE owner_id=? OR id IN (SELECT task_id FROM task_collaborators WHERE user_id=?) ORDER BY due_date IS NULL,due_date,id DESC").all(u.id,u.id);
}
function taskDto(t){const owner=db.prepare("SELECT id,name FROM users WHERE id=?").get(t.owner_id);const team=db.prepare("SELECT id,name,department FROM teams WHERE id=?").get(t.team_id);const collaborators=db.prepare("SELECT u.id,u.name FROM task_collaborators c JOIN users u ON u.id=c.user_id WHERE c.task_id=?").all(t.id);return {...t,owner:owner||null,team:team||null,collaborators}}
app.post("/api/auth/login",(req,res)=>{const {email,password}=req.body||{};const u=db.prepare("SELECT * FROM users WHERE lower(email)=lower(?) AND active=1").get(email||"");if(!u||!bcrypt.compareSync(password||"",u.password_hash))return res.status(401).json({error:"Invalid email or password"});const token=jwt.sign({id:u.id},SECRET,{expiresIn:"12h"});res.json({token,user:publicUser(u)})});
app.get("/api/me",auth,(req,res)=>res.json(publicUser(req.user)));
app.get("/api/org",auth,(req,res)=>{
 const teams=req.user.role==="ADMIN"?db.prepare("SELECT t.*,u.name manager_name FROM teams t LEFT JOIN users u ON u.id=t.manager_id ORDER BY t.name").all():db.prepare("SELECT t.*,u.name manager_name FROM teams t LEFT JOIN users u ON u.id=t.manager_id WHERE t.id=?").all(req.user.team_id||-1);
 const members=req.user.role==="ADMIN"?db.prepare("SELECT id,name,email,role,department,team_id FROM users WHERE active=1 ORDER BY name").all():req.user.role==="MANAGER"?db.prepare("SELECT id,name,email,role,department,team_id FROM users WHERE active=1 AND team_id=? ORDER BY name").all(req.user.team_id||-1):[db.prepare("SELECT id,name,email,role,department,team_id FROM users WHERE id=?").get(req.user.id)];
 res.json({teams,members:members.map(u=>({id:u.id,name:u.name,email:u.email,role:u.role,department:u.department,teamId:u.team_id}))})
});
app.post("/api/users",auth,admin,(req,res)=>{const {name,email,password,role,department,teamId}=req.body||{};if(!name||!email||!password||!role||!department)return res.status(400).json({error:"Name, email, password, role and department are required"});if(!["ADMIN","MANAGER","EMPLOYEE"].includes(role))return res.status(400).json({error:"Invalid role"});try{if(teamId){const team=db.prepare("SELECT * FROM teams WHERE id=?").get(teamId);if(!team||team.department!==department)return res.status(400).json({error:"Selected team does not match the department"});}const info=db.prepare("INSERT INTO users(name,email,password_hash,role,department,team_id) VALUES(?,?,?,?,?,?)").run(name,email,bcrypt.hashSync(password,10),role,department,teamId||null);if(role==="MANAGER"&&teamId)db.prepare("UPDATE teams SET manager_id=? WHERE id=?").run(info.lastInsertRowid,teamId);res.status(201).json({id:info.lastInsertRowid,name,email,role,department,teamId:teamId||null})}catch(e){res.status(409).json({error:"Email already exists"})}});
app.post("/api/teams",auth,admin,(req,res)=>{const {name,department,managerId}=req.body||{};if(!name||!department)return res.status(400).json({error:"Team name and department required"});const info=db.prepare("INSERT INTO teams(name,department,manager_id) VALUES(?,?,?)").run(name,department,managerId||null);if(managerId)db.prepare("UPDATE users SET team_id=? WHERE id=?").run(info.lastInsertRowid,managerId);res.status(201).json({id:info.lastInsertRowid,name,department,managerId})});
app.patch("/api/users/:id/team",auth,admin,(req,res)=>{const {teamId}=req.body||{};db.prepare("UPDATE users SET team_id=? WHERE id=?").run(teamId||null,req.params.id);res.json({ok:true})});
app.get("/api/tasks",auth,(req,res)=>res.json(visibleTasks(req.user).map(taskDto)));
app.get("/api/planner/:userId",auth,(req,res)=>{const target=db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(req.params.userId);if(!target)return res.status(404).json({error:"User not found"});if(!canViewUser(req.user,target))return res.status(403).json({error:"You cannot view this planner"});const tasks=req.user.role==="ADMIN"||req.user.role==="MANAGER"?db.prepare("SELECT * FROM tasks WHERE owner_id=? ORDER BY due_date,id DESC").all(target.id):db.prepare("SELECT * FROM tasks WHERE owner_id=? ORDER BY due_date,id DESC").all(req.user.id);res.json({user:publicUser(target),tasks:tasks.map(taskDto)})});
app.post("/api/tasks",auth,(req,res)=>{const {title,description="",ownerId,priority="MEDIUM",status="TODO",dueDate,collaboratorIds=[]}=req.body||{};const owner=db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(ownerId||req.user.id);if(!owner)return res.status(400).json({error:"Task owner not found"});if(req.user.role==="EMPLOYEE"&&owner.id!==req.user.id)return res.status(403).json({error:"Employees can only create tasks for themselves"});if(req.user.role==="MANAGER"&&owner.team_id!==req.user.team_id)return res.status(403).json({error:"You can only assign tasks within your team"});if(!title)return res.status(400).json({error:"Task title required"});const teamId=owner.team_id;const info=db.prepare("INSERT INTO tasks(title,description,owner_id,team_id,created_by,status,priority,due_date) VALUES(?,?,?,?,?,?,?,?)").run(title,description,owner.id,teamId,req.user.id,status,priority,dueDate||null);const add=db.prepare("INSERT OR IGNORE INTO task_collaborators(task_id,user_id) VALUES(?,?)");for(const cid of collaboratorIds){const c=db.prepare("SELECT * FROM users WHERE id=?").get(cid);if(c&&c.team_id===owner.team_id&&c.id!==owner.id)add.run(info.lastInsertRowid,c.id)}res.status(201).json(taskDto(db.prepare("SELECT * FROM tasks WHERE id=?").get(info.lastInsertRowid)))});
app.patch("/api/tasks/:id",auth,(req,res)=>{const t=db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);if(!t)return res.status(404).json({error:"Task not found"});const owner=db.prepare("SELECT * FROM users WHERE id=?").get(t.owner_id);const allowed=req.user.role==="ADMIN"||(req.user.role==="MANAGER"&&owner.team_id===req.user.team_id)||t.owner_id===req.user.id;if(!allowed)return res.status(403).json({error:"You cannot update this task"});const title=req.body.title??t.title,description=req.body.description??t.description,status=req.body.status??t.status,priority=req.body.priority??t.priority,dueDate=req.body.dueDate??t.due_date;db.prepare("UPDATE tasks SET title=?,description=?,status=?,priority=?,due_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(title,description,status,priority,dueDate,t.id);res.json(taskDto(db.prepare("SELECT * FROM tasks WHERE id=?").get(t.id)))});
app.delete("/api/tasks/:id",auth,(req,res)=>{const t=db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);if(!t)return res.status(404).json({error:"Task not found"});const owner=db.prepare("SELECT * FROM users WHERE id=?").get(t.owner_id);if(!(req.user.role==="ADMIN"||(req.user.role==="MANAGER"&&owner.team_id===req.user.team_id)||t.owner_id===req.user.id))return res.status(403).json({error:"You cannot delete this task"});db.prepare("DELETE FROM tasks WHERE id=?").run(t.id);res.json({ok:true})});
app.get("/api/requests",auth,(req,res)=>{if(req.user.role!=="ADMIN"&&req.user.department!=="Technical")return res.status(403).json({error:"Technical department access required"});res.json(db.prepare("SELECT * FROM requests ORDER BY id DESC").all())});
app.post("/api/requests",auth,(req,res)=>{if(req.user.role!=="ADMIN"&&req.user.department!=="Technical")return res.status(403).json({error:"Technical department access required"});const fields=["mid","merchant_name","request_date","description","platform","requester","developer","approver","status","test_status","environment","checker","release_date"];const vals=fields.map(k=>req.body[k]??"");const info=db.prepare(`INSERT INTO requests(${fields.join(",")},created_by) VALUES(${fields.map(()=>"?").join(",")},?)`).run(...vals,req.user.id);res.status(201).json({id:info.lastInsertRowid})});
app.get("/api/health",(req,res)=>res.json({ok:true,service:"TotalPay WorkDesk API"}));
const __dirname=path.dirname(fileURLToPath(import.meta.url));
if(process.env.NODE_ENV==="production"){app.use(express.static(path.resolve(__dirname,"../client/dist")));app.get("*",(req,res)=>res.sendFile(path.resolve(__dirname,"../client/dist/index.html")))}
const port=process.env.PORT||4000;app.listen(port,()=>console.log(`WorkDesk API listening on ${port}`));
