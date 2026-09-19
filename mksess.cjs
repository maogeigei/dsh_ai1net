const crypto = require('crypto');
const Database = require('better-sqlite3');
const db = new Database('/var/lib/dsh-ai1net/dsh_ai1net.db');
const admin = db.prepare('SELECT id FROM users WHERE role=? LIMIT 1').get('admin');
const token = crypto.randomBytes(32).toString('hex');
const hash = crypto.createHash('sha256').update(token).digest('hex');
db.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at,ip,user_agent) VALUES (?,?,?,?,?,?)').run(hash, admin.id, Date.now(), Date.now() + 600 * 1000, '127.0.0.1', 'poc-curl2');
console.log(token);
db.close();
