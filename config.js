/* ============================================================
   ओजस क्लिनिक — वेबसाइट सेटिंग्ज (फक्त ही फाइल बदला)
   ============================================================ */
window.OJAS_CONFIG = {
  // Google Apps Script Web App URL (README मधील पायरी 2 नंतर येथे पेस्ट करा).
  // रिकामे ठेवल्यास वेबसाइट "डेमो मोड" मध्ये चालते (डेटा फक्त त्याच ब्राउझरमध्ये).
  API_URL: "https://script.google.com/macros/s/AKfycbxjNEp5XeNhFc8JRAga2J7asjME6Fd5GV0gYD7-oXjmhhWD4-7zSusyJcRgmLDfnaLi_A/exec",

  PHONE: "8799809360",
  WHATSAPP: "918799809360",
  EMAIL: "ojashospital2025@gmail.com",
  INSTAGRAM_URL: "https://www.instagram.com/ojas_hospital25/",
  // YouTube चॅनेलची लिंक येथे टाका (उदा. https://www.youtube.com/@ojashospital)
  YOUTUBE_URL: "https://www.youtube.com/@swapnilkalne",
  MAP_URL: "https://www.google.com/maps/search/?api=1&query=Shegaon+Naka+Shegaon+Road+Telhara+Maharashtra",
  ADDRESS: "शेगाव रोड, शेगाव नाका जवळ, तेल्हारा.",
  BOOKING_DAYS_AHEAD: 30
};

/* ---------- API (Apps Script किंवा डेमो) ---------- */
(function () {
  const C = window.OJAS_CONFIG;
  const DEMO_KEY = "ojas_demo_appointments_v1";

  function ist(d) {
    const t = new Date((d || new Date()).getTime() + 330 * 60000);
    return t.toISOString().slice(0, 10);
  }
  // डेमोसाठी उदाहरण नोंदी (फक्त डेमो मोडमध्ये; खऱ्या सर्व्हरवर येत नाहीत)
  function samples() {
    const t = ist(), tm = ist(new Date(Date.now() + 86400000));
    const mk = (i, date, session, doctor, service, name, age, gender, village, status) => ({ id: "OJDEMO" + i, token: 0, date, session, doctor,
      service, name: name + " (उदाहरण)", age, gender, phone: "90000000" + String(i).padStart(2, "0"), village, problem: "", status, bookedAt: "", notes: "" });
    const rows = [
      mk(1, t, "सकाळ", "डॉ. स्वप्निल काळणे", "लहान मुलांचे आजार", "आरुष पाटील", "3", "मुलगा / पुरुष", "तेल्हारा", "तपासणी झाली"),
      mk(2, t, "सकाळ", "डॉ. अनुजा काळणे (बुरुकले)", "गर्भवती माता तपासणी", "स्नेहा देशमुख", "26", "मुलगी / स्त्री", "अडगाव", "प्रतीक्षेत"),
      mk(3, t, "संध्याकाळ", "डॉ. स्वप्निल काळणे", "सर्वसाधारण आजार (BP, मधुमेह, ताप इ.)", "रमेश वानखडे", "58", "मुलगा / पुरुष", "हिवरखेड", "प्रतीक्षेत"),
      mk(4, tm, "सकाळ", "डॉ. अनुजा काळणे (बुरुकले)", "PCOD / वंध्यत्व", "पूजा इंगळे", "29", "मुलगी / स्त्री", "तेल्हारा", "निश्चित")
    ];
    const n = {}; rows.forEach(r => r.token = (n[r.date] = (n[r.date] || 0) + 1));
    return rows;
  }
  function demoLoad() {
    try { const s = localStorage.getItem(DEMO_KEY); return s ? JSON.parse(s) : samples(); } catch (e) { return samples(); }
  }
  function demoSave(a) { try { localStorage.setItem(DEMO_KEY, JSON.stringify(a)); } catch (e) {} }
  function rid() { return "OJ" + Math.random().toString(36).slice(2, 8).toUpperCase(); }

  async function demo(body) {
    const all = demoLoad();
    if (body.action === "book") {
      const same = all.find(r => r.phone === body.phone && r.date === body.date && r.status !== "रद्द");
      if (same) return { ok: true, duplicate: true, id: same.id, token: same.token, date: same.date, session: same.session };
      const token = all.filter(r => r.date === body.date).length + 1;
      const row = { id: rid(), token, date: body.date, session: body.session, doctor: body.doctor, service: body.service,
        name: body.name, age: body.age, gender: body.gender, phone: body.phone, village: body.village,
        problem: body.problem, status: "प्रतीक्षेत", bookedAt: new Date().toISOString(), notes: "" };
      all.push(row); demoSave(all);
      return { ok: true, id: row.id, token, date: row.date, session: row.session };
    }
    if (body.action === "lookup") {
      const r = all.find(x => x.id === String(body.id).toUpperCase() && x.phone === body.phone);
      return r ? { ok: true, appt: { id: r.id, token: r.token, date: r.date, session: r.session, doctor: r.doctor, status: r.status } }
               : { ok: false, error: "अपॉइंटमेंट सापडली नाही. क्रमांक व मोबाईल तपासा." };
    }
    if (body.action === "login") return body.password ? { ok: true, token: "demo" } : { ok: false, error: "पासवर्ड टाका" };
    if (body.action === "list") {
      const rows = all.filter(r => (!body.from || r.date >= body.from) && (!body.to || r.date <= body.to));
      return { ok: true, rows };
    }
    if (body.action === "update") {
      const r = all.find(x => x.id === body.id);
      if (!r) return { ok: false, error: "नोंद सापडली नाही" };
      if (body.status) r.status = body.status;
      if (typeof body.notes === "string") r.notes = body.notes;
      demoSave(all); return { ok: true };
    }
    return { ok: false, error: "अवैध विनंती" };
  }

  async function api(body) {
    if (!C.API_URL) return demo(body);
    const res = await fetch(C.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // preflight टाळण्यासाठी
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error("सर्व्हर त्रुटी " + res.status);
    return res.json();
  }

  window.OJAS = { api, isDemo: !C.API_URL, todayIST: () => ist(), istDate: ist };
})();
