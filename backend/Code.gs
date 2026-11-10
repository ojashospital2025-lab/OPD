/**
 * ओजस क्लिनिक — ऑनलाइन अपॉइंटमेंट बॅकएंड (Google Apps Script + Google Sheet)
 *
 * सुरक्षा:
 *  - रुग्ण फक्त नवीन अपॉइंटमेंट नोंदवू शकतात (किंवा स्वतःचा क्रमांक + मोबाईल देऊन स्थिती पाहू शकतात).
 *  - संपूर्ण यादी फक्त ॲडमिन पासवर्डनंतर मिळणाऱ्या 8 तासांच्या स्वाक्षरीत टोकननेच दिसते.
 *  - पासवर्ड कुठेही साध्या स्वरूपात साठवला जात नाही (SHA-256 + salt).
 *  - चुकीचा पासवर्ड 5 वेळा → 15 मिनिटे लॉगिन बंद.
 *  - एकाच मोबाईलवरून जास्त बुकिंग, स्पॅम बॉट (honeypot) व Sheet फॉर्म्युला-इंजेक्शन रोखले जाते.
 *  - LockService मुळे एकाच वेळी आलेल्या बुकिंगना टोकन क्रमांक दुप्पट होत नाहीत.
 */

const SHEET_NAME = 'Appointments';
const TZ = 'Asia/Kolkata';
const HEADERS = ['ID', 'Token', 'AppointmentDate', 'Session', 'Doctor', 'Service', 'PatientName', 'Age',
  'Gender', 'Phone', 'Village', 'Problem', 'Status', 'BookedAt', 'Notes', 'UpdatedAt'];
const STATUSES = ['प्रतीक्षेत', 'निश्चित', 'तपासणी झाली', 'रद्द', 'आले नाहीत'];
const SESSIONS = ['सकाळ', 'दुपार', 'संध्याकाळ'];
const DOCTORS = ['डॉ. स्वप्निल काळणे', 'डॉ. अनुजा काळणे (बुरुकले)', 'कोणतेही'];
const DAYS_AHEAD = 30;
const MAX_ACTIVE_PER_PHONE = 3;
const TOKEN_HOURS = 8;

/* ============ एकदाच चालवा: 1) setup  2) setAdminPassword ============ */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold')
    .setBackground('#1b2a6b').setFontColor('#ffffff');
  sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@'); // सर्व मजकूर स्वरूपात
  sh.setFrozenRows(1);
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN_SECRET')) props.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('Setup पूर्ण. आता setAdminPassword चालवा.');
}

function setAdminPassword() {
  const NEW_PASSWORD = 'येथे-नवीन-पासवर्ड-लिहा'; // ← बदला, चालवा, मग पुन्हा हा मजकूर पुसून टाका
  if (NEW_PASSWORD.length < 8 || NEW_PASSWORD.indexOf('येथे') === 0) throw new Error('किमान 8 अक्षरी नवीन पासवर्ड लिहा');
  const salt = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('ADMIN_SALT', salt);
  props.setProperty('ADMIN_HASH', sha256(salt + NEW_PASSWORD));
  props.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid()); // जुने लॉगिन रद्द
  Logger.log('पासवर्ड सेट झाला. आता कोडमधील पासवर्ड पुसून Save करा.');
}

/* ============================ Web App ============================ */

function doGet() {
  return json({ ok: true, service: 'Ojas Clinic API' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (body.action) {
      case 'book': return json(book(body));
      case 'lookup': return json(lookup(body));
      case 'login': return json(login(body));
      case 'list': requireAdmin(body.token); return json(list(body));
      case 'update': requireAdmin(body.token); return json(update(body));
      default: return json({ ok: false, error: 'अवैध विनंती' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/* ============================ रुग्ण ============================ */

function book(b) {
  if (b.website) return { ok: true, id: 'OK', token: 0 }; // honeypot: बॉटला शांतपणे टाळा
  const name = clean(b.name, 60), phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
  const date = String(b.date || ''), session = String(b.session || '');
  if (name.length < 2) throw new Error('रुग्णाचे नाव लिहा');
  if (!/^[6-9]\d{9}$/.test(phone)) throw new Error('10 अंकी योग्य मोबाईल नंबर लिहा');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('तारीख निवडा');
  const today = istDate(0), last = istDate(DAYS_AHEAD);
  if (date < today || date > last) throw new Error('तारीख आजपासून ' + DAYS_AHEAD + ' दिवसांच्या आत निवडा');
  if (SESSIONS.indexOf(session) < 0) throw new Error('वेळ निवडा');
  const doctor = DOCTORS.indexOf(b.doctor) >= 0 ? b.doctor : 'कोणतेही';
  const age = String(b.age || '').replace(/[^\d.]/g, '').slice(0, 4);

  // एकाच मोबाईलवरून तासाला 6 पेक्षा जास्त प्रयत्न नाहीत
  const cache = CacheService.getScriptCache(), ck = 'rl_' + phone;
  const hits = Number(cache.get(ck) || 0);
  if (hits >= 6) throw new Error('खूप प्रयत्न झाले. थोड्या वेळाने पुन्हा करा किंवा फोन करा.');
  cache.put(ck, String(hits + 1), 3600);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet(), rows = data(sh);
    const dup = rows.find(r => r.Phone === phone && r.AppointmentDate === date && r.Status !== 'रद्द');
    if (dup) return { ok: true, duplicate: true, id: dup.ID, token: Number(dup.Token), date: date, session: dup.Session };
    const active = rows.filter(r => r.Phone === phone && r.AppointmentDate >= today &&
      ['रद्द', 'तपासणी झाली', 'आले नाहीत'].indexOf(r.Status) < 0).length;
    if (active >= MAX_ACTIVE_PER_PHONE) throw new Error('या नंबरवर आधीच ' + active + ' अपॉइंटमेंट आहेत. कृपया फोन करा.');
    const token = rows.filter(r => r.AppointmentDate === date).length + 1;
    const id = 'OJ' + Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
    const now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
    sh.appendRow([id, String(token), date, session, doctor, clean(b.service, 60), name, age,
      clean(b.gender, 10), phone, clean(b.village, 60), clean(b.problem, 300), 'प्रतीक्षेत', now, '', now]);
    return { ok: true, id: id, token: token, date: date, session: session };
  } finally { lock.releaseLock(); }
}

function lookup(b) {
  const id = String(b.id || '').trim().toUpperCase(), phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
  const r = data(sheet()).find(x => x.ID === id && x.Phone === phone);
  if (!r) return { ok: false, error: 'अपॉइंटमेंट सापडली नाही. क्रमांक व मोबाईल तपासा.' };
  return { ok: true, appt: { id: r.ID, token: Number(r.Token), date: r.AppointmentDate, session: r.Session, doctor: r.Doctor, status: r.Status } };
}

/* ============================ ॲडमिन ============================ */

function login(b) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('login_fails') || 0);
  if (fails >= 5) throw new Error('जास्त चुकीचे प्रयत्न. 15 मिनिटांनी पुन्हा प्रयत्न करा.');
  const p = PropertiesService.getScriptProperties();
  const hash = p.getProperty('ADMIN_HASH'), salt = p.getProperty('ADMIN_SALT');
  if (!hash) throw new Error('ॲडमिन पासवर्ड सेट नाही (setAdminPassword चालवा)');
  if (!safeEq(sha256(salt + String(b.password || '')), hash)) {
    cache.put('login_fails', String(fails + 1), 900);
    Utilities.sleep(800);
    throw new Error('चुकीचा पासवर्ड');
  }
  cache.remove('login_fails');
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  return { ok: true, token: exp + '.' + sign(String(exp)), expires: exp };
}

function requireAdmin(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !safeEq(sign(parts[0]), parts[1]) || Number(parts[0]) < Date.now())
    throw new Error('LOGIN_REQUIRED');
}

function list(b) {
  const from = String(b.from || ''), to = String(b.to || '');
  const rows = data(sheet()).filter(r => (!from || r.AppointmentDate >= from) && (!to || r.AppointmentDate <= to))
    .map(r => ({ id: r.ID, token: Number(r.Token), date: r.AppointmentDate, session: r.Session, doctor: r.Doctor,
      service: r.Service, name: r.PatientName, age: r.Age, gender: r.Gender, phone: r.Phone, village: r.Village,
      problem: r.Problem, status: r.Status, bookedAt: r.BookedAt, notes: r.Notes }));
  return { ok: true, rows: rows };
}

function update(b) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet(), vals = sh.getDataRange().getDisplayValues();
    for (let i = 1; i < vals.length; i++) {
      if (vals[i][0] === b.id) {
        if (b.status) {
          if (STATUSES.indexOf(b.status) < 0) throw new Error('अवैध स्थिती');
          sh.getRange(i + 1, 13).setValue(b.status);
        }
        if (typeof b.notes === 'string') sh.getRange(i + 1, 15).setValue(clean(b.notes, 300));
        sh.getRange(i + 1, 16).setValue(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'));
        return { ok: true };
      }
    }
    throw new Error('नोंद सापडली नाही');
  } finally { lock.releaseLock(); }
}

/* ============================ मदतनीस ============================ */

function sheet() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('setup() आधी चालवा');
  return sh;
}
function data(sh) {
  const v = sh.getDataRange().getDisplayValues();
  return v.slice(1).filter(r => r[0]).map(r => { const o = {}; HEADERS.forEach((h, i) => o[h] = r[i]); return o; });
}
function clean(s, max) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s; // Sheet फॉर्म्युला-इंजेक्शन रोखा
}
function istDate(addDays) {
  return Utilities.formatDate(new Date(Date.now() + addDays * 86400000), TZ, 'yyyy-MM-dd');
}
function sha256(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}
function sign(s) {
  const key = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, key));
}
function safeEq(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
