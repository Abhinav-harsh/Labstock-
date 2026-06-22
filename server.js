'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  LabStock – Lab Inventory Management Server
//  Local:  node server.js  →  http://localhost:3000
//  Vercel: deployed automatically via vercel.json
// ─────────────────────────────────────────────────────────────────────────────

const express    = require('express');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt     = require('bcryptjs');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const compression= require('compression');
const path       = require('path');

// ─── DB: MongoDB Atlas via Mongoose ──────────────────────────────────────────
// Set MONGODB_URI in Vercel environment variables (Project → Settings → Env Vars)
// Free cluster at https://cloud.mongodb.com
const mongoose = require('mongoose');

let dbConnected = false;

async function connectDB() {
  if (dbConnected) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is not set.');
  await mongoose.connect(uri);
  dbConnected = true;
}

// ─── Mongoose Schemas ─────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  id: String, username: String, passwordHash: String, name: String, role: String
});
const ItemSchema = new mongoose.Schema({
  id: String, name: String, serial: String, catId: String,
  totalQty: Number, qtyFaulty: { type: Number, default: 0 },
  qtyMaintenance: { type: Number, default: 0 }, qtyRetired: { type: Number, default: 0 },
  location: String, notes: String, createdAt: String
});
const IssueSchema = new mongoose.Schema({
  id: String, itemId: String, qty: Number, issuedTo: String, studentId: String,
  issueDate: String, returnDate: String, notes: String,
  status: { type: String, default: 'active' }, createdAt: String, returnedAt: String,
  issuedBy: String  // Name of the person who issued the item (manual input)
});
const CategorySchema = new mongoose.Schema({
  id: String, name: String, desc: String
});
const FaultSchema = new mongoose.Schema({
  id: String, itemId: String, qty: Number, desc: String, reportedBy: String,
  date: String, severity: String, status: { type: String, default: 'open' }, fixedAt: String
});
const LogSchema = new mongoose.Schema({
  id: String, time: String, action: String, item: String, user: String, details: String
});

const User     = mongoose.models.User     || mongoose.model('User',     UserSchema);
const Item     = mongoose.models.Item     || mongoose.model('Item',     ItemSchema);
const Issue    = mongoose.models.Issue    || mongoose.model('Issue',    IssueSchema);
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema);
const Fault    = mongoose.models.Fault    || mongoose.model('Fault',    FaultSchema);
const Log      = mongoose.models.Log      || mongoose.model('Log',      LogSchema);

// ─── DB HELPERS ──────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function addLog(action, item, user, details) {
  const log = new Log({ id: uid(), time: new Date().toISOString(), action: String(action), item: String(item), user: String(user), details: String(details || '') });
  await log.save();
  await Log.deleteMany({ _id: { $nin: (await Log.find().sort({ time: -1 }).limit(1000).select('_id')).map(l => l._id) } });
}

async function ensureDefaultData() {
  const userCount = await User.countDocuments();
  if (userCount === 0) {
    const adminHash   = await bcrypt.hash('admin123', 10);
    const studentHash = await bcrypt.hash('student123', 10);
    await User.insertMany([
      { id: 'u1', username: 'admin',   passwordHash: adminHash,   name: 'Lab Administrator', role: 'admin' },
      { id: 'u2', username: 'student', passwordHash: studentHash, name: 'Student',            role: 'student' }
    ]);

    const cats = [
      { id:'cat1', name:'Microcontrollers',      desc:'Arduino, ESP32, Raspberry Pi, etc.' },
      { id:'cat2', name:'Sensors',               desc:'Temperature, humidity, ultrasonic, IR, etc.' },
      { id:'cat3', name:'Communication Modules', desc:'Bluetooth, WiFi, RF, GSM modules.' },
      { id:'cat4', name:'Power Supply',          desc:'Adapters, batteries, regulators.' },
      { id:'cat5', name:'Display Modules',       desc:'LCD, OLED, 7-segment, LED matrix.' },
      { id:'cat6', name:'Actuators',             desc:'Servo motors, DC motors, stepper motors.' },
      { id:'cat7', name:'Passive Components',    desc:'Resistors, capacitors, breadboards, wires.' },
      { id:'cat8', name:'Tools & Equipment',     desc:'Multimeters, soldering irons, oscilloscopes.' }
    ];
    await Category.insertMany(cats);

    function daysAgo(n)  { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().split('T')[0]; }
    function daysAhead(n){ const d=new Date(); d.setDate(d.getDate()+n); return d.toISOString().split('T')[0]; }

    const items = [
      { id:'i1',  name:'Arduino Uno R3',     serial:'ARD-001', catId:'cat1', totalQty:50, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf A-1', notes:'' },
      { id:'i2',  name:'Arduino Nano',       serial:'ARD-002', catId:'cat1', totalQty:30, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf A-1', notes:'' },
      { id:'i3',  name:'ESP32 Dev Board',    serial:'ESP-001', catId:'cat3', totalQty:20, qtyFaulty:2, qtyMaintenance:0, qtyRetired:0, location:'Shelf A-2', notes:'' },
      { id:'i4',  name:'Raspberry Pi 4B',    serial:'RPI-001', catId:'cat1', totalQty:10, qtyFaulty:0, qtyMaintenance:1, qtyRetired:0, location:'Shelf A-1', notes:'Project use' },
      { id:'i5',  name:'DHT22 Sensor',       serial:'SEN-001', catId:'cat2', totalQty:40, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf B-1', notes:'' },
      { id:'i6',  name:'HC-SR04 Ultrasonic', serial:'SEN-002', catId:'cat2', totalQty:35, qtyFaulty:5, qtyMaintenance:0, qtyRetired:0, location:'Shelf B-1', notes:'' },
      { id:'i7',  name:'HC-05 Bluetooth',    serial:'COM-001', catId:'cat3', totalQty:15, qtyFaulty:3, qtyMaintenance:0, qtyRetired:0, location:'Shelf C-1', notes:'3 modules damaged' },
      { id:'i8',  name:'16x2 LCD Display',   serial:'DSP-001', catId:'cat5', totalQty:25, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf D-1', notes:'' },
      { id:'i9',  name:'SG90 Servo Motor',   serial:'ACT-001', catId:'cat6', totalQty:40, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf E-1', notes:'' },
      { id:'i10', name:'PIR Motion Sensor',  serial:'SEN-003', catId:'cat2', totalQty:20, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf B-2', notes:'' },
      { id:'i11', name:'NodeMCU ESP8266',    serial:'ESP-002', catId:'cat3', totalQty:18, qtyFaulty:0, qtyMaintenance:3, qtyRetired:0, location:'Shelf A-3', notes:'3 units firmware update needed' },
      { id:'i12', name:'L298N Motor Driver', serial:'ACT-002', catId:'cat6', totalQty:12, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf E-2', notes:'' },
      { id:'i13', name:'0.96" OLED Display', serial:'DSP-002', catId:'cat5', totalQty:22, qtyFaulty:1, qtyMaintenance:0, qtyRetired:0, location:'Shelf D-1', notes:'' },
      { id:'i14', name:'Digital Multimeter', serial:'TOOL-001',catId:'cat8', totalQty:8,  qtyFaulty:0, qtyMaintenance:1, qtyRetired:0, location:'Shelf F-1', notes:'' },
      { id:'i15', name:'Soldering Iron 40W', serial:'TOOL-002',catId:'cat8', totalQty:6,  qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf F-2', notes:'' },
      { id:'i16', name:'IR Sensor Module',   serial:'SEN-004', catId:'cat2', totalQty:50, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf B-3', notes:'' },
      { id:'i17', name:'Power Supply 5V/2A', serial:'PWR-001', catId:'cat4', totalQty:15, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf G-1', notes:'' },
      { id:'i18', name:'Breadboard 830pt',   serial:'BRD-001', catId:'cat7', totalQty:60, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf H-1', notes:'' },
      { id:'i19', name:'Jumper Wires Set',   serial:'JMP-001', catId:'cat7', totalQty:80, qtyFaulty:0, qtyMaintenance:0, qtyRetired:0, location:'Shelf H-2', notes:'' },
      { id:'i20', name:'MQ-2 Gas Sensor',    serial:'SEN-005', catId:'cat2', totalQty:10, qtyFaulty:4, qtyMaintenance:0, qtyRetired:0, location:'Shelf B-4', notes:'Calibration issue' }
    ];
    await Item.insertMany(items);

    const issues = [
      { id:uid(), itemId:'i1',  qty:10, issuedTo:'Rahul Sharma',  studentId:'22CS001', issueDate:daysAgo(5),  returnDate:daysAhead(7),  notes:'',            status:'active', createdAt:new Date().toISOString(), issuedBy:'Dr. Sharma' },
      { id:uid(), itemId:'i1',  qty:5,  issuedTo:'Priya Singh',   studentId:'22CS045', issueDate:daysAgo(10), returnDate:daysAhead(3),  notes:'Project use',  status:'active', createdAt:new Date().toISOString(), issuedBy:'Prof. Verma' },
      { id:uid(), itemId:'i9',  qty:8,  issuedTo:'Amit Kumar',    studentId:'21CS033', issueDate:daysAgo(15), returnDate:daysAhead(2),  notes:'',            status:'active', createdAt:new Date().toISOString(), issuedBy:'Lab Assistant Ravi' },
      { id:uid(), itemId:'i13', qty:3,  issuedTo:'Sneha Patel',   studentId:'22CS078', issueDate:daysAgo(3),  returnDate:daysAhead(14), notes:'',            status:'active', createdAt:new Date().toISOString(), issuedBy:'Dr. Sharma' },
      { id:uid(), itemId:'i18', qty:15, issuedTo:'Rohit Verma',   studentId:'21CS099', issueDate:daysAgo(20), returnDate:daysAhead(1),  notes:'',            status:'active', createdAt:new Date().toISOString(), issuedBy:'Prof. Gupta' },
      { id:uid(), itemId:'i2',  qty:6,  issuedTo:'Kavya Reddy',   studentId:'23CS012', issueDate:daysAgo(2),  returnDate:daysAhead(5),  notes:'Lab project', status:'active', createdAt:new Date().toISOString(), issuedBy:'Lab Assistant Ravi' },
    ];
    await Issue.insertMany(issues);

    const faults = [
      { id:uid(), itemId:'i7',  qty:3, desc:'Modules burned out, pin 3 not responding.', reportedBy:'Lab Incharge', date:daysAgo(8), severity:'high',   status:'open' },
      { id:uid(), itemId:'i20', qty:4, desc:'Sensor gives wrong readings, needs replacement.', reportedBy:'Priya Singh', date:daysAgo(2), severity:'medium', status:'open' },
      { id:uid(), itemId:'i6',  qty:5, desc:'IR emitter LEDs blown, need replacement.', reportedBy:'Lab Incharge', date:daysAgo(5), severity:'medium', status:'open' },
      { id:uid(), itemId:'i3',  qty:2, desc:'WiFi antenna broken, boards non-functional.', reportedBy:'Amit Kumar', date:daysAgo(3), severity:'low',    status:'open' },
    ];
    await Fault.insertMany(faults);

    await addLog('System Init', 'Database', 'System', 'Fresh database created with sample data');
  }

  // Ensure student account always exists
  const student = await User.findOne({ role: 'student' });
  if (!student) {
    const studentHash = await bcrypt.hash('student123', 10);
    await new User({ id: 'u2', username: 'student', passwordHash: studentHash, name: 'Student', role: 'student' }).save();
  }
}

function computeQtys(item, issues) {
  const activeIssues = issues.filter(iss => String(iss.itemId) === String(item.id) && iss.status === 'active');
  const qtyIssued = activeIssues.reduce((s, iss) => s + (iss.qty || 1), 0);
  const qtyFaulty = item.qtyFaulty || 0;
  const qtyMaintenance = item.qtyMaintenance || 0;
  const qtyRetired = item.qtyRetired || 0;
  const qtyAvailable = Math.max(0, item.totalQty - qtyIssued - qtyFaulty - qtyMaintenance - qtyRetired);
  return { qtyAvailable, qtyIssued, qtyFaulty, qtyMaintenance, qtyRetired, totalQty: item.totalQty };
}

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────
const app = express();

app.use(compression());
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

// ─── SESSION — stored in MongoDB so it persists across Vercel serverless instances ──
app.use(session({
  secret: process.env.SESSION_SECRET || 'labstock_s3cr3t_key_2024_xK9mP!',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: 8 * 60 * 60,
    autoRemove: 'native'
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// ─── RATE LIMIT ──────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true,
  message: { error: 'Too many failed login attempts. Please wait 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
});

// ─── DB MIDDLEWARE — connect before every request ─────────────────────────────
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (e) {
    res.status(503).json({ error: 'Database not configured. Set MONGODB_URI in environment variables.' });
  }
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

// ─── STATIC / PAGES ──────────────────────────────────────────────────────────
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/public/*', (req, res) => res.redirect('/'));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    await ensureDefaultData();
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const user = await User.findOne({ username: { $regex: new RegExp(`^${String(username).trim()}$`, 'i') } });
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
    const match = await bcrypt.compare(String(password), user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid username or password.' });
    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.name     = user.name;
    req.session.role     = user.role;
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session error, please try again.' });
      addLog('Login', '—', user.name, 'Logged in successfully').catch(() => {});
      res.json({ success: true, name: user.name, role: user.role });
    });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
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
    if (String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    const user = await User.findOne({ id: req.session.userId });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const match = await bcrypt.compare(String(currentPassword), user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });
    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    await user.save();
    await addLog('Password Changed', '—', req.session.name, '');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── ITEMS API ────────────────────────────────────────────────────────────────
app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const items  = await Item.find().lean();
    const issues = await Issue.find({ status: 'active' }).lean();
    const enriched = items.map(item => ({ ...item, ...computeQtys(item, issues) }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/items', requireAdmin, async (req, res) => {
  try {
    const { name, serial, catId, totalQty, location, notes } = req.body;
    if (!name || !String(name).trim())   return res.status(400).json({ error: 'Item name is required.' });
    if (!serial|| !String(serial).trim()) return res.status(400).json({ error: 'Serial number is required.' });
    if (!catId) return res.status(400).json({ error: 'Category is required.' });
    const exists = await Item.findOne({ serial: { $regex: new RegExp(`^${String(serial).trim()}$`, 'i') } });
    if (exists) return res.status(409).json({ error: 'Serial number already exists.' });
    const item = new Item({
      id: uid(), name: String(name).trim(), serial: String(serial).trim().toUpperCase(),
      catId: String(catId), totalQty: Math.max(1, parseInt(totalQty) || 1),
      qtyFaulty: 0, qtyMaintenance: 0, qtyRetired: 0,
      location: String(location || '').trim(), notes: String(notes || '').trim(),
      createdAt: new Date().toISOString()
    });
    await item.save();
    await addLog('Added', item.name, req.session.name, `Serial: ${item.serial}, Qty: ${item.totalQty}`);
    res.status(201).json({ ...item.toObject(), qtyAvailable: item.totalQty, qtyIssued: 0 });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.put('/api/items/:id', requireAdmin, async (req, res) => {
  try {
    const item = await Item.findOne({ id: req.params.id });
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const { name, serial, catId, totalQty, qtyFaulty, qtyMaintenance, qtyRetired, location, notes } = req.body;
    if (!name || !String(name).trim())    return res.status(400).json({ error: 'Item name is required.' });
    if (!serial|| !String(serial).trim()) return res.status(400).json({ error: 'Serial number is required.' });
    if (!catId) return res.status(400).json({ error: 'Category is required.' });
    const dup = await Item.findOne({ serial: { $regex: new RegExp(`^${String(serial).trim()}$`, 'i') }, id: { $ne: req.params.id } });
    if (dup) return res.status(409).json({ error: 'Serial number already in use.' });
    item.name           = String(name).trim();
    item.serial         = String(serial).trim().toUpperCase();
    item.catId          = String(catId);
    item.totalQty       = Math.max(1, parseInt(totalQty) || item.totalQty);
    item.qtyFaulty      = Math.max(0, parseInt(qtyFaulty) ?? item.qtyFaulty);
    item.qtyMaintenance = Math.max(0, parseInt(qtyMaintenance) ?? item.qtyMaintenance);
    item.qtyRetired     = Math.max(0, parseInt(qtyRetired) ?? item.qtyRetired);
    item.location       = String(location || '').trim();
    item.notes          = String(notes || '').trim();
    await item.save();
    await addLog('Edited', item.name, req.session.name, `Total qty: ${item.totalQty}`);
    const issues = await Issue.find({ itemId: item.id, status: 'active' }).lean();
    res.json({ ...item.toObject(), ...computeQtys(item.toObject(), issues) });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.delete('/api/items/:id', requireAdmin, async (req, res) => {
  try {
    const item = await Item.findOne({ id: req.params.id });
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    await Item.deleteOne({ id: req.params.id });
    await Issue.deleteMany({ itemId: req.params.id });
    await Fault.deleteMany({ itemId: req.params.id });
    await addLog('Deleted', item.name, req.session.name, `Serial: ${item.serial}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── ISSUE API ────────────────────────────────────────────────────────────────
app.post('/api/items/:id/issue', requireAdmin, async (req, res) => {
  try {
    const item = await Item.findOne({ id: req.params.id });
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const { issuedTo, studentId, issueDate, returnDate, notes, qty, issuedBy } = req.body;
    if (!issuedTo || !studentId || !issueDate)
      return res.status(400).json({ error: 'Student name, ID and issue date are required.' });
    if (!issuedBy || !String(issuedBy).trim())
      return res.status(400).json({ error: 'Issued by (your name) is required.' });
    const allIssues = await Issue.find({ itemId: req.params.id, status: 'active' }).lean();
    const issueQty  = Math.max(1, parseInt(qty) || 1);
    const computed  = computeQtys(item.toObject(), allIssues);
    if (issueQty > computed.qtyAvailable)
      return res.status(400).json({ error: `Only ${computed.qtyAvailable} unit(s) available.` });
    const issue = new Issue({
      id: uid(), itemId: req.params.id, qty: issueQty,
      issuedTo: String(issuedTo).trim(), studentId: String(studentId).trim(),
      issueDate, returnDate: returnDate || '', notes: notes ? String(notes).trim() : '',
      status: 'active', createdAt: new Date().toISOString(),
      issuedBy: String(issuedBy).trim()  // Manual input: name of person issuing the item
    });
    await issue.save();
    await addLog('Issued', item.name, req.session.name, `Qty: ${issueQty} → ${issuedTo} (${studentId}) by ${issuedBy}`);
    const updatedIssues = await Issue.find({ itemId: req.params.id, status: 'active' }).lean();
    const q = computeQtys(item.toObject(), updatedIssues);
    res.json({ issue: issue.toObject(), item: { ...item.toObject(), ...q } });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.post('/api/issues/:id/return', requireAdmin, async (req, res) => {
  try {
    const issue = await Issue.findOne({ id: req.params.id });
    if (!issue) return res.status(404).json({ error: 'Issue record not found.' });
    if (issue.status === 'returned') return res.status(400).json({ error: 'Already returned.' });
    issue.status     = 'returned';
    issue.returnedAt = new Date().toISOString();
    await issue.save();
    const item = await Item.findOne({ id: issue.itemId });
    if (item) await addLog('Returned', item.name, req.session.name, `Qty: ${issue.qty} from ${issue.issuedTo}`);
    const updatedIssues = item ? await Issue.find({ itemId: item.id, status: 'active' }).lean() : [];
    const q = item ? computeQtys(item.toObject(), updatedIssues) : {};
    res.json({ issue: issue.toObject(), item: item ? { ...item.toObject(), ...q } : null });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.get('/api/issues', requireAuth, async (req, res) => {
  try {
    const issues = await Issue.find().sort({ createdAt: -1 }).lean();
    const items  = await Item.find().lean();
    const enriched = issues.map(iss => {
      const item = items.find(i => i.id === iss.itemId);
      return { ...iss, itemName: item ? item.name : 'Unknown', itemSerial: item ? item.serial : '', catId: item ? item.catId : '' };
    });
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── COMPONENTS (aggregated view) ────────────────────────────────────────────
app.get('/api/components', requireAuth, async (req, res) => {
  try {
    const items  = await Item.find().lean();
    const issues = await Issue.find({ status: 'active' }).lean();
    const groups = {};
    items.forEach(item => {
      const key = item.name.trim().toLowerCase();
      const q   = computeQtys(item, issues);
      if (!groups[key]) {
        groups[key] = { name: item.name, catId: item.catId, totalQty: 0, qtyAvailable: 0, qtyIssued: 0, qtyFaulty: 0, qtyMaintenance: 0, qtyRetired: 0, shelves: new Set(), items: [] };
      }
      const g = groups[key];
      g.totalQty       += q.totalQty;
      g.qtyAvailable   += q.qtyAvailable;
      g.qtyIssued      += q.qtyIssued;
      g.qtyFaulty      += q.qtyFaulty;
      g.qtyMaintenance += q.qtyMaintenance;
      g.qtyRetired     += q.qtyRetired;
      if (item.location) g.shelves.add(item.location);
      g.items.push({ id: item.id, serial: item.serial, totalQty: q.totalQty, qtyAvailable: q.qtyAvailable, qtyIssued: q.qtyIssued, qtyFaulty: q.qtyFaulty, qtyMaintenance: q.qtyMaintenance, location: item.location });
    });
    const result = Object.values(groups).map(g => ({ ...g, shelves: Array.from(g.shelves) })).sort((a, b) => a.name.localeCompare(b.name));
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── CATEGORIES API ───────────────────────────────────────────────────────────
app.get('/api/categories', requireAuth, async (req, res) => {
  try { res.json(await Category.find().lean()); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/categories', requireAdmin, async (req, res) => {
  try {
    const { name, desc } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required.' });
    const exists = await Category.findOne({ name: { $regex: new RegExp(`^${String(name).trim()}$`, 'i') } });
    if (exists) return res.status(409).json({ error: 'Category already exists.' });
    const cat = new Category({ id: uid(), name: String(name).trim(), desc: String(desc || '').trim() });
    await cat.save();
    await addLog('Category Added', cat.name, req.session.name, '');
    res.status(201).json(cat.toObject());
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.put('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const cat = await Category.findOne({ id: req.params.id });
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    const { name, desc } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required.' });
    const dup = await Category.findOne({ name: { $regex: new RegExp(`^${String(name).trim()}$`, 'i') }, id: { $ne: req.params.id } });
    if (dup) return res.status(409).json({ error: 'Category name already in use.' });
    cat.name = String(name).trim();
    cat.desc = String(desc || '').trim();
    await cat.save();
    await addLog('Category Edited', cat.name, req.session.name, '');
    res.json(cat.toObject());
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.delete('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const cat = await Category.findOne({ id: req.params.id });
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    const hasItems = await Item.findOne({ catId: req.params.id });
    if (hasItems) return res.status(400).json({ error: 'Cannot delete: items exist in this category.' });
    await Category.deleteOne({ id: req.params.id });
    await addLog('Category Deleted', cat.name, req.session.name, '');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── FAULTS API ───────────────────────────────────────────────────────────────
app.get('/api/faults', requireAuth, async (req, res) => {
  try { res.json(await Fault.find().lean()); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/faults', requireAdmin, async (req, res) => {
  try {
    const { itemId, desc, reportedBy, date, severity, qty } = req.body;
    if (!itemId || !desc) return res.status(400).json({ error: 'Item and description are required.' });
    const item = await Item.findOne({ id: itemId });
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const faultQty = Math.max(1, parseInt(qty) || 1);
    const allIssues = await Issue.find({ itemId: itemId, status: 'active' }).lean();
    const computed  = computeQtys(item.toObject(), allIssues);
    if (faultQty > computed.qtyAvailable)
      return res.status(400).json({ error: `Only ${computed.qtyAvailable} unit(s) available to mark as faulty.` });
    item.qtyFaulty = (item.qtyFaulty || 0) + faultQty;
    await item.save();
    const fault = new Fault({ id: uid(), itemId, qty: faultQty, desc: String(desc).trim(), reportedBy: String(reportedBy || req.session.name).trim(), date: date || new Date().toISOString().split('T')[0], severity: severity || 'medium', status: 'open' });
    await fault.save();
    await addLog('Fault Reported', item.name, req.session.name, `Qty: ${faultQty}, Severity: ${fault.severity}`);
    const updatedIssues = await Issue.find({ itemId: itemId, status: 'active' }).lean();
    const q = computeQtys(item.toObject(), updatedIssues);
    res.json({ fault: fault.toObject(), item: { ...item.toObject(), ...q } });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.post('/api/faults/:faultId/fix', requireAdmin, async (req, res) => {
  try {
    const fault = await Fault.findOne({ id: req.params.faultId });
    if (!fault) return res.status(404).json({ error: 'Fault not found.' });
    if (fault.status === 'fixed') return res.status(400).json({ error: 'Already fixed.' });
    const item = await Item.findOne({ id: fault.itemId });
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    item.qtyFaulty = Math.max(0, (item.qtyFaulty || 0) - fault.qty);
    await item.save();
    fault.status  = 'fixed';
    fault.fixedAt = new Date().toISOString();
    await fault.save();
    await addLog('Fixed', item.name, req.session.name, `Qty: ${fault.qty} returned to available`);
    const issues = await Issue.find({ itemId: item.id, status: 'active' }).lean();
    const q = computeQtys(item.toObject(), issues);
    res.json({ fault: fault.toObject(), item: { ...item.toObject(), ...q } });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.post('/api/faults/:faultId/maintenance', requireAdmin, async (req, res) => {
  try {
    const fault = await Fault.findOne({ id: req.params.faultId });
    if (!fault) return res.status(404).json({ error: 'Fault not found.' });
    const item = await Item.findOne({ id: fault.itemId });
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    item.qtyFaulty      = Math.max(0, (item.qtyFaulty || 0) - fault.qty);
    item.qtyMaintenance = (item.qtyMaintenance || 0) + fault.qty;
    await item.save();
    fault.status = 'maintenance';
    await fault.save();
    await addLog('Maintenance', item.name, req.session.name, `Qty: ${fault.qty} sent for repair`);
    const issues = await Issue.find({ itemId: item.id, status: 'active' }).lean();
    const q = computeQtys(item.toObject(), issues);
    res.json({ fault: fault.toObject(), item: { ...item.toObject(), ...q } });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.post('/api/items/:id/fix-maintenance', requireAdmin, async (req, res) => {
  try {
    const { qty } = req.body;
    const item = await Item.findOne({ id: req.params.id });
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    const fixQty = Math.min(Math.max(1, parseInt(qty) || 1), item.qtyMaintenance || 0);
    item.qtyMaintenance = Math.max(0, (item.qtyMaintenance || 0) - fixQty);
    await item.save();
    await addLog('Fixed (Maintenance)', item.name, req.session.name, `Qty: ${fixQty} returned to available`);
    const issues = await Issue.find({ itemId: item.id, status: 'active' }).lean();
    const q = computeQtys(item.toObject(), issues);
    res.json({ ...item.toObject(), ...q });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── LOGS API ─────────────────────────────────────────────────────────────────
app.get('/api/logs', requireAdmin, async (req, res) => {
  try { res.json(await Log.find().sort({ time: -1 }).lean()); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/logs', requireAdmin, async (req, res) => {
  try { await Log.deleteMany({}); res.json({ success: true }); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route not found.' });
  res.redirect('/');
});

// ─── START (local dev only) ───────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log(`║  LabStock  →  http://localhost:${PORT}        ║`);
    console.log('║  Username : admin  │  Password : admin123 ║');
    console.log('╚══════════════════════════════════════════╝\n');
  });
}

// Required for Vercel serverless
module.exports = app;
