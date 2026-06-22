cat > /home/claude/labstock/server.js << 'SERVEREOF'
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  LabStock v2 – Lab Inventory Management Server
//  STOCK MODEL:
//    Each item has: totalQty, availableQty, faultyQty, maintenanceQty, retiredQty
//    Issuing creates an issue-record and decrements availableQty
//    Returning an issue-record increments availableQty
// ─────────────────────────────────────────────────────────────────────────────

const express   = require('express');
const session   = require('express-session');
const bcrypt    = require('bcryptjs');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const compress  = require('compression');
const path      = require('path');
const fs        = require('fs');

const PORT     = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }

function readDB() {
  if (!fs.existsSync(DB_PATH)) return createFreshDB();
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.users)      db.users      = [];
    if (!db.categories) db.categories = [];
    if (!db.items)      db.items      = [];
    if (!db.issues)     db.issues     = [];   // NEW: separate issue records
    if (!db.faults)     db.faults     = [];
    if (!db.logs)       db.logs       = [];
    // Migrate old items: if item has no availableQty, compute it
    db.items.forEach(it => {
      if (it.availableQty === undefined) {
        it.availableQty   = it.status === 'available' ? (it.qty || 1) : 0;
        it.faultyQty      = it.status === 'faulty'      ? (it.qty || 1) : 0;
        it.maintenanceQty = it.status === 'maintenance' ? (it.qty || 1) : 0;
        it.retiredQty     = it.status === 'retired'     ? (it.qty || 1) : 0;
        it.totalQty       = it.qty || 1;
        // issued qty is derived: totalQty - available - faulty - maintenance - retired
      }
    });
    return db;
  } catch (e) {
    console.error('DB read error, recreating:', e.message);
    return createFreshDB();
  }
}

function writeDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }

function addLog(db, action, item, user, details) {
  db.logs.unshift({ id: uid(), time: new Date().toISOString(), action: String(action), item: String(item), user: String(user), details: String(details || '') });
  if (db.logs.length > 1000) db.logs = db.logs.slice(0, 1000);
}

// Compute derived issuedQty for an item
function issuedQty(item) {
  return Math.max(0, item.totalQty - item.availableQty - item.faultyQty - item.maintenanceQty - item.retiredQty);
}

function createFreshDB() {
  const adminHash   = bcrypt.hashSync('admin123', 10);
  const studentHash = bcrypt.hashSync('student123', 10);

  function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; }
  function daysAhead(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; }

  const db = {
    users: [
      { id: 'u1', username: 'admin',   passwordHash: adminHash,   name: 'Lab Administrator', role: 'admin'   },
      { id: 'u2', username: 'student', passwordHash: studentHash, name: 'Student',            role: 'student' }
    ],
    categories: [
      { id: 'cat1', name: 'Microcontrollers',      desc: 'Arduino, ESP32, Raspberry Pi, etc.' },
      { id: 'cat2', name: 'Sensors',               desc: 'Temperature, humidity, ultrasonic, IR, etc.' },
      { id: 'cat3', name: 'Communication Modules', desc: 'Bluetooth, WiFi, RF, GSM modules.' },
      { id: 'cat4', name: 'Power Supply',          desc: 'Adapters, batteries, regulators.' },
      { id: 'cat5', name: 'Display Modules',       desc: 'LCD, OLED, 7-segment, LED matrix.' },
      { id: 'cat6', name: 'Actuators',             desc: 'Servo motors, DC motors, stepper motors.' },
      { id: 'cat7', name: 'Passive Components',    desc: 'Resistors, capacitors, breadboards, wires.' },
      { id: 'cat8', name: 'Tools & Equipment',     desc: 'Multimeters, soldering irons, oscilloscopes.' }
    ],
    items: [],
    issues: [],
    faults: [],
    logs: []
  };

  // Helper: make item with new stock model
  // totalQty, availableQty, faultyQty, maintenanceQty, retiredQty
  function mkItem(name, serial, catId, totalQty, availableQty, faultyQty, maintenanceQty, retiredQty, location, notes) {
    return { id: uid(), name, serial, catId, totalQty, availableQty, faultyQty: faultyQty||0, maintenanceQty: maintenanceQty||0, retiredQty: retiredQty||0, location: location||'', notes: notes||'', createdAt: new Date().toISOString() };
  }

  const items = [
    mkItem('Arduino Uno R3',     'ARD-001', 'cat1', 50, 40, 2, 0, 0, 'Shelf A-1', ''),
    mkItem('Arduino Nano',       'ARD-002', 'cat1', 30, 28, 0, 2, 0, 'Shelf A-1', ''),
    mkItem('ESP32 Dev Board',    'ESP-001', 'cat3', 20, 17, 1, 0, 0, 'Shelf A-2', ''),
    mkItem('Raspberry Pi 4B',    'RPI-001', 'cat1', 10,  8, 0, 0, 0, 'Shelf A-1', ''),
    mkItem('DHT22 Sensor',       'SEN-001', 'cat2', 60, 55, 0, 0, 0, 'Shelf B-1', ''),
    mkItem('HC-SR04 Ultrasonic', 'SEN-002', 'cat2', 40, 36, 4, 0, 0, 'Shelf B-1', ''),
    mkItem('HC-05 Bluetooth',    'COM-001', 'cat3', 15,  9, 6, 0, 0, 'Shelf C-1', 'Some units burned out'),
    mkItem('16x2 LCD Display',   'DSP-001', 'cat5', 35, 33, 0, 2, 0, 'Shelf D-1', ''),
    mkItem('SG90 Servo Motor',   'ACT-001', 'cat6', 25, 19, 0, 0, 0, 'Shelf E-1', ''),
    mkItem('PIR Motion Sensor',  'SEN-003', 'cat2', 30, 27, 3, 0, 0, 'Shelf B-2', ''),
    mkItem('NodeMCU ESP8266',    'ESP-002', 'cat3', 18, 13, 0, 5, 0, 'Shelf A-3', 'Firmware update batch'),
    mkItem('L298N Motor Driver', 'ACT-002', 'cat6', 20, 18, 2, 0, 0, 'Shelf E-2', ''),
    mkItem('0.96" OLED Display', 'DSP-002', 'cat5', 22, 18, 0, 0, 0, 'Shelf D-1', ''),
    mkItem('Digital Multimeter', 'TOOL-001','cat8', 12, 10, 1, 1, 0, 'Shelf F-1', ''),
    mkItem('Soldering Iron 40W', 'TOOL-002','cat8',  8,  7, 0, 1, 0, 'Shelf F-2', ''),
    mkItem('IR Sensor Module',   'SEN-004', 'cat2', 45, 42, 3, 0, 0, 'Shelf B-3', ''),
    mkItem('Power Supply 5V/2A', 'PWR-001', 'cat4', 20, 18, 0, 2, 0, 'Shelf G-1', ''),
    mkItem('Breadboard 830pt',   'BRD-001', 'cat7', 60, 44, 0, 0, 0, 'Shelf H-1', ''),
    mkItem('Jumper Wires Set',   'JMP-001', 'cat7',100, 85, 0, 0, 5, 'Shelf H-2', ''),
    mkItem('MQ-2 Gas Sensor',    'SEN-005', 'cat2', 15, 12, 3, 0, 0, 'Shelf B-4', 'Calibration issue on some')
  ];
  db.items = items;

  // Seed some issue records (reducing availableQty already done above)
  const issues = [
    { id: uid(), itemId: items[0].id, itemName: 'Arduino Uno R3',   qty: 5,  issuedTo: 'Rahul Sharma',  studentId: '22CS001', issueDate: daysAgo(5),  returnDate: daysAhead(7),  status: 'issued',   notes: 'Project work',    returnedAt: null },
    { id: uid(), itemId: items[0].id, itemName: 'Arduino Uno R3',   qty: 5,  issuedTo: 'Priya Singh',   studentId: '22CS045', issueDate: daysAgo(10), returnDate: daysAhead(3),  status: 'issued',   notes: 'IoT assignment',  returnedAt: null },
    { id: uid(), itemId: items[3].id, itemName: 'Raspberry Pi 4B',  qty: 2,  issuedTo: 'Amit Kumar',    studentId: '21CS033', issueDate: daysAgo(15), returnDate: daysAhead(2),  status: 'issued',   notes: 'Final year proj', returnedAt: null },
    { id: uid(), itemId: items[8].id, itemName: 'SG90 Servo Motor', qty: 6,  issuedTo: 'Sneha Patel',   studentId: '22CS078', issueDate: daysAgo(3),  returnDate: daysAhead(14), status: 'issued',   notes: 'Robotics lab',    returnedAt: null },
    { id: uid(), itemId: items[17].id,itemName: 'Breadboard 830pt', qty: 10, issuedTo: 'Rohit Verma',   studentId: '21CS099', issueDate: daysAgo(20), returnDate: daysAgo(1),    status: 'overdue',  notes: 'Lab practicals',  returnedAt: null },
    { id: uid(), itemId: items[4].id, itemName: 'DHT22 Sensor',     qty: 5,  issuedTo: 'Ankit Gupta',   studentId: '22CS112', issueDate: daysAgo(8),  returnDate: daysAhead(5),  status: 'issued',   notes: 'Weather station', returnedAt: null },
    { id: uid(), itemId: items[12].id,itemName: '0.96" OLED Display',qty:4,  issuedTo: 'Meera Joshi',   studentId: '23CS015', issueDate: daysAgo(2),  returnDate: daysAhead(10), status: 'issued',   notes: 'Display project', returnedAt: null },
    { id: uid(), itemId: items[2].id, itemName: 'ESP32 Dev Board',  qty: 3,  issuedTo: 'Raj Patel',     studentId: '23CS041', issueDate: daysAgo(12), returnDate: daysAgo(2),    status: 'overdue',  notes: 'WiFi project',    returnedAt: null }
  ];
  db.issues = issues;

  // Add faults
  db.faults = [
    { id: uid(), itemId: items[6].id,  desc: 'Module burned out, pin 3 not responding.',   reportedBy: 'Lab Incharge', date: daysAgo(8), severity: 'high'   },
    { id: uid(), itemId: items[5].id,  desc: 'Intermittent trigger issues on 4 units.',    reportedBy: 'Priya Singh',  date: daysAgo(2), severity: 'medium' },
    { id: uid(), itemId: items[19].id, desc: 'Sensor gives wrong readings, recalibrate.',  reportedBy: 'Rahul Sharma', date: daysAgo(5), severity: 'medium' }
  ];

  addLog(db, 'System Init', 'Database', 'System', 'Fresh database with sample data');
  writeDB(db);
  return db;
}

// ─── EXPRESS SETUP ────────────────────────────────────────────────────────────
const app = express();
app.use(compress());
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'labstock_v2_s3cr3t_xK9mP_2024!',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true,
  message: { error: 'Too many failed login attempts. Please wait 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === 'admin') return next();
  if (req.session && req.session.userId) return res.status(403).json({ error: 'Admin access required.' });
  return res.status(401).json({ error: 'Not authenticated' });
}

// ─── PAGE ROUTES ──────────────────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/public/*', (req, res) => res.redirect('/'));

// ─── AUTH API ─────────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const db   = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
    req.session.userId = user.id; req.session.username = user.username;
    req.session.name = user.name; req.session.role = user.role;
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session error.' });
      addLog(db, 'Login', '—', user.name, 'Logged in'); writeDB(db);
      res.json({ success: true, name: user.name, role: user.role });
    });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ success: true }); });
});

app.get('/api/session', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, name: req.session.name, role: req.session.role, username: req.session.username });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields are required.' });
    if (String(newPassword).length < 6) return res.status(400).json({ error: 'Min 6 characters.' });
    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!await bcrypt.compare(String(currentPassword), user.passwordHash))
      return res.status(401).json({ error: 'Current password is incorrect.' });
    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    addLog(db, 'Password Changed', '—', req.session.name, ''); writeDB(db);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── ITEMS API ────────────────────────────────────────────────────────────────
app.get('/api/items', requireAuth, (req, res) => {
  try { res.json(readDB().items); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/items', requireAdmin, (req, res) => {
  try {
    const { name, serial, catId, totalQty, availableQty, faultyQty, maintenanceQty, retiredQty, location, notes } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Item name is required.' });
    if (!serial || !String(serial).trim()) return res.status(400).json({ error: 'Serial/code is required.' });
    if (!catId) return res.status(400).json({ error: 'Category is required.' });
    const db = readDB();
    if (db.items.find(i => i.serial.toLowerCase() === String(serial).toLowerCase().trim()))
      return res.status(409).json({ error: 'Serial/code already exists.' });
    const total = Math.max(1, parseInt(totalQty) || 1);
    const avail = Math.max(0, Math.min(total, parseInt(availableQty) !== undefined ? parseInt(availableQty) : total));
    const faulty = Math.max(0, parseInt(faultyQty) || 0);
    const maint  = Math.max(0, parseInt(maintenanceQty) || 0);
    const retired= Math.max(0, parseInt(retiredQty) || 0);
    if (avail + faulty + maint + retired > total)
      return res.status(400).json({ error: 'Sum of qty breakdown cannot exceed total quantity.' });
    const item = { id: uid(), name: String(name).trim(), serial: String(serial).trim().toUpperCase(), catId: String(catId), totalQty: total, availableQty: avail, faultyQty: faulty, maintenanceQty: maint, retiredQty: retired, location: String(location||'').trim(), notes: String(notes||'').trim(), createdAt: new Date().toISOString() };
    db.items.push(item);
    addLog(db, 'Added', item.name, req.session.name, `Serial: ${item.serial}, Total: ${total}`);
    writeDB(db); res.status(201).json(item);
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.put('/api/items/:id', requireAdmin, (req, res) => {
  try {
    const db  = readDB();
    const idx = db.items.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Item not found.' });
    const { name, serial, catId, totalQty, availableQty, faultyQty, maintenanceQty, retiredQty, location, notes } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Item name is required.' });
    if (!serial || !String(serial).trim()) return res.status(400).json({ error: 'Serial is required.' });
    if (!catId) return res.status(400).json({ error: 'Category is required.' });
    const dup = db.items.find(i => i.serial.toLowerCase() === String(serial).toLowerCase().trim() && i.id !== req.params.id);
    if (dup) return res.status(409).json({ error: 'Serial already in use.' });
    const total  = Math.max(1, parseInt(totalQty) || 1);
    const avail  = Math.max(0, parseInt(availableQty) || 0);
    const faulty = Math.max(0, parseInt(faultyQty) || 0);
    const maint  = Math.max(0, parseInt(maintenanceQty) || 0);
    const ret    = Math.max(0, parseInt(retiredQty) || 0);
    const curIssued = issuedQty(db.items[idx]);
    if (avail + faulty + maint + ret + curIssued > total)
      return res.status(400).json({ error: `Qty breakdown (${avail+faulty+maint+ret} + ${curIssued} currently issued) exceeds total ${total}.` });
    db.items[idx] = { ...db.items[idx], name: String(name).trim(), serial: String(serial).trim().toUpperCase(), catId: String(catId), totalQty: total, availableQty: avail, faultyQty: faulty, maintenanceQty: maint, retiredQty: ret, location: String(location||'').trim(), notes: String(notes||'').trim() };
    addLog(db, 'Edited', db.items[idx].name, req.session.name, `Total: ${total}, Avail: ${avail}`);
    writeDB(db); res.json(db.items[idx]);
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.delete('/api/items/:id', requireAdmin, (req, res) => {
  try {
    const db  = readDB();
    const itm = db.items.find(i => i.id === req.params.id);
    if (!itm) return res.status(404).json({ error: 'Item not found.' });
    const openIssues = db.issues.filter(is => is.itemId === req.params.id && is.status !== 'returned');
    if (openIssues.length) return res.status(400).json({ error: `Cannot delete: ${openIssues.length} unit(s) currently issued. Return them first.` });
    db.items  = db.items.filter(i => i.id !== req.params.id);
    db.issues = db.issues.filter(is => is.itemId !== req.params.id);
    db.faults = db.faults.filter(f => f.itemId !== req.params.id);
    addLog(db, 'Deleted', itm.name, req.session.name, `Serial: ${itm.serial}`);
    writeDB(db); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// Update stock quantities only (faulty/maintenance/retired adjustments)
app.post('/api/items/:id/stock', requireAdmin, (req, res) => {
  try {
    const db  = readDB();
    const idx = db.items.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Item not found.' });
    const { field, delta } = req.body; // field: 'faultyQty'|'maintenanceQty'|'retiredQty', delta: +/-n
    const item = db.items[idx];
    const d = parseInt(delta);
    if (!['faultyQty','maintenanceQty','retiredQty'].includes(field)) return res.status(400).json({ error: 'Invalid field.' });
    const newVal = (item[field] || 0) + d;
    if (newVal < 0) return res.status(400).json({ error: 'Cannot go below 0.' });
    // Moving from/to available
    const newAvail = item.availableQty - d;
    if (newAvail < 0) return res.status(400).json({ error: 'Not enough available units.' });
    item[field] = newVal;
    item.availableQty = newAvail;
    const actionMap = { faultyQty: 'Mark Faulty', maintenanceQty: 'Send Maintenance', retiredQty: 'Retire' };
    addLog(db, actionMap[field], item.name, req.session.name, `${d > 0 ? '+' : ''}${d} units`);
    writeDB(db); res.json(item);
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── ISSUES API ───────────────────────────────────────────────────────────────
app.get('/api/issues', requireAuth, (req, res) => {
  try { res.json(readDB().issues); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/items/:id/issue', requireAdmin, (req, res) => {
  try {
    const db  = readDB();
    const idx = db.items.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Item not found.' });
    const { issuedTo, studentId, qty, issueDate, returnDate, notes } = req.body;
    if (!issuedTo || !studentId || !issueDate) return res.status(400).json({ error: 'Student name, ID and issue date are required.' });
    const qtyNum = Math.max(1, parseInt(qty) || 1);
    if (db.items[idx].availableQty < qtyNum)
      return res.status(400).json({ error: `Only ${db.items[idx].availableQty} unit(s) available. Cannot issue ${qtyNum}.` });
    db.items[idx].availableQty -= qtyNum;
    const issue = { id: uid(), itemId: req.params.id, itemName: db.items[idx].name, qty: qtyNum, issuedTo: String(issuedTo).trim(), studentId: String(studentId).trim(), issueDate, returnDate: returnDate||'', notes: String(notes||'').trim(), status: 'issued', issuedBy: req.session.name, createdAt: new Date().toISOString(), returnedAt: null };
    db.issues.push(issue);
    addLog(db, 'Issued', db.items[idx].name, req.session.name, `${qtyNum} unit(s) to ${issuedTo} (${studentId})`);
    writeDB(db); res.json({ item: db.items[idx], issue });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.post('/api/issues/:issueId/return', requireAdmin, (req, res) => {
  try {
    const db  = readDB();
    const issIdx = db.issues.findIndex(is => is.id === req.params.issueId);
    if (issIdx === -1) return res.status(404).json({ error: 'Issue record not found.' });
    const issue = db.issues[issIdx];
    if (issue.status === 'returned') return res.status(400).json({ error: 'Already returned.' });
    const itemIdx = db.items.findIndex(i => i.id === issue.itemId);
    if (itemIdx !== -1) db.items[itemIdx].availableQty += issue.qty;
    db.issues[issIdx] = { ...issue, status: 'returned', returnedAt: new Date().toISOString() };
    addLog(db, 'Returned', issue.itemName, req.session.name, `${issue.qty} unit(s) from ${issue.issuedTo}`);
    writeDB(db);
    res.json({ item: itemIdx !== -1 ? db.items[itemIdx] : null, issue: db.issues[issIdx] });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── CATEGORIES API ───────────────────────────────────────────────────────────
app.get('/api/categories', requireAuth, (req, res) => {
  try { res.json(readDB().categories); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/categories', requireAdmin, (req, res) => {
  try {
    const { name, desc } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required.' });
    const db = readDB();
    if (db.categories.find(c => c.name.toLowerCase() === String(name).toLowerCase().trim()))
      return res.status(409).json({ error: 'Category already exists.' });
    const cat = { id: uid(), name: String(name).trim(), desc: String(desc||'').trim() };
    db.categories.push(cat); addLog(db, 'Category Added', cat.name, req.session.name, '');
    writeDB(db); res.status(201).json(cat);
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.put('/api/categories/:id', requireAdmin, (req, res) => {
  try {
    const db = readDB(); const idx = db.categories.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Category not found.' });
    const { name, desc } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required.' });
    const dup = db.categories.find(c => c.name.toLowerCase() === String(name).toLowerCase().trim() && c.id !== req.params.id);
    if (dup) return res.status(409).json({ error: 'Name already in use.' });
    db.categories[idx] = { ...db.categories[idx], name: String(name).trim(), desc: String(desc||'').trim() };
    addLog(db, 'Category Edited', db.categories[idx].name, req.session.name, '');
    writeDB(db); res.json(db.categories[idx]);
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.delete('/api/categories/:id', requireAdmin, (req, res) => {
  try {
    const db = readDB(); const cat = db.categories.find(c => c.id === req.params.id);
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    if (db.items.some(i => i.catId === req.params.id))
      return res.status(400).json({ error: 'Cannot delete: items exist. Reassign first.' });
    db.categories = db.categories.filter(c => c.id !== req.params.id);
    addLog(db, 'Category Deleted', cat.name, req.session.name, ''); writeDB(db);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── FAULTS API ───────────────────────────────────────────────────────────────
app.get('/api/faults', requireAuth, (req, res) => {
  try { res.json(readDB().faults); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/faults', requireAdmin, (req, res) => {
  try {
    const { itemId, qty, desc, reportedBy, date, severity } = req.body;
    if (!itemId || !desc) return res.status(400).json({ error: 'Item and description are required.' });
    const db = readDB(); const idx = db.items.findIndex(i => i.id === itemId);
    if (idx === -1) return res.status(404).json({ error: 'Item not found.' });
    const qtyNum = Math.max(1, parseInt(qty) || 1);
    if (db.items[idx].availableQty < qtyNum)
      return res.status(400).json({ error: `Only ${db.items[idx].availableQty} available units to mark faulty.` });
    db.items[idx].availableQty -= qtyNum;
    db.items[idx].faultyQty    += qtyNum;
    const fault = { id: uid(), itemId, qty: qtyNum, desc: String(desc).trim(), reportedBy: String(reportedBy||req.session.name).trim(), date: date||new Date().toISOString().split('T')[0], severity: severity||'medium' };
    db.faults.push(fault);
    addLog(db, 'Fault Reported', db.items[idx].name, req.session.name, `${qtyNum} unit(s), severity: ${fault.severity}`);
    writeDB(db); res.json({ fault, item: db.items[idx] });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.post('/api/faults/:faultId/fix', requireAdmin, (req, res) => {
  try {
    const db = readDB(); const fi = db.faults.findIndex(f => f.id === req.params.faultId);
    if (fi === -1) return res.status(404).json({ error: 'Fault record not found.' });
    const fault = db.faults[fi];
    const idx   = db.items.findIndex(i => i.id === fault.itemId);
    if (idx !== -1) {
      const fixQty = Math.min(fault.qty, db.items[idx].faultyQty);
      db.items[idx].faultyQty    -= fixQty;
      db.items[idx].availableQty += fixQty;
      addLog(db, 'Fixed', db.items[idx].name, req.session.name, `${fixQty} unit(s) back to available`);
    }
    db.faults.splice(fi, 1); writeDB(db);
    res.json({ item: idx !== -1 ? db.items[idx] : null });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.post('/api/faults/:faultId/maintenance', requireAdmin, (req, res) => {
  try {
    const db = readDB(); const fi = db.faults.findIndex(f => f.id === req.params.faultId);
    if (fi === -1) return res.status(404).json({ error: 'Fault record not found.' });
    const fault = db.faults[fi]; const idx = db.items.findIndex(i => i.id === fault.itemId);
    if (idx !== -1) {
      const mQty = Math.min(fault.qty, db.items[idx].faultyQty);
      db.items[idx].faultyQty      -= mQty;
      db.items[idx].maintenanceQty += mQty;
      addLog(db, 'Maintenance', db.items[idx].name, req.session.name, `${mQty} unit(s) sent for repair`);
    }
    db.faults.splice(fi, 1); writeDB(db);
    res.json({ item: idx !== -1 ? db.items[idx] : null });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.post('/api/faults/:faultId/retire', requireAdmin, (req, res) => {
  try {
    const db = readDB(); const fi = db.faults.findIndex(f => f.id === req.params.faultId);
    if (fi === -1) return res.status(404).json({ error: 'Fault not found.' });
    const fault = db.faults[fi]; const idx = db.items.findIndex(i => i.id === fault.itemId);
    if (idx !== -1) {
      const rQty = Math.min(fault.qty, db.items[idx].faultyQty);
      db.items[idx].faultyQty  -= rQty;
      db.items[idx].retiredQty += rQty;
      addLog(db, 'Retired', db.items[idx].name, req.session.name, `${rQty} unit(s) retired`);
    }
    db.faults.splice(fi, 1); writeDB(db);
    res.json({ item: idx !== -1 ? db.items[idx] : null });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// Maintenance back to available
app.post('/api/items/:id/maintenance-done', requireAdmin, (req, res) => {
  try {
    const db = readDB(); const idx = db.items.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Item not found.' });
    const { qty } = req.body; const qtyNum = Math.max(1, parseInt(qty)||1);
    if (db.items[idx].maintenanceQty < qtyNum) return res.status(400).json({ error: 'Not that many in maintenance.' });
    db.items[idx].maintenanceQty -= qtyNum;
    db.items[idx].availableQty   += qtyNum;
    addLog(db, 'Maintenance Done', db.items[idx].name, req.session.name, `${qtyNum} unit(s) back to available`);
    writeDB(db); res.json(db.items[idx]);
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── LOGS API ─────────────────────────────────────────────────────────────────
app.get('/api/logs', requireAdmin, (req, res) => {
  try { res.json(readDB().logs); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});
app.delete('/api/logs', requireAdmin, (req, res) => {
  try { const db = readDB(); db.logs = []; writeDB(db); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route not found.' });
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  LabStock v2  →  http://localhost:${PORT}    ║`);
  console.log('║  Username : admin   Password : admin123  ║');
  console.log('╚══════════════════════════════════════════╝\n');
});
SERVEREOF
echo "server.js written: $(wc -l < /home/claude/labstock/server.js) lines"
