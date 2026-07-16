/* Dashboard điều hành CCTS — xử lý hoàn toàn client-side, 0 token.
 * Nguồn: export CCTS chuẩn (Ticket Information / Solutions / Spare Parts Record).
 * Logic đã chốt với user:
 *  - SLA vùng: trạm 3h→3h, 4h→4h (có thay linh kiện→7h), còn lại→48h (dùng SLA Status CCTS)
 *  - Ontime vùng = solution đầu tiên (ưu tiên Permanent) − Create Time ≤ hạn
 *  - Người xử lý = Processor của solution; tái phát = cùng Charge Point ID + mã lỗi ≤7/30 ngày sau Permanent
 */
"use strict";

// ---------- cấu hình ----------
const GROUP_SEED = { quypham: "KV1", baokieu: "KV2", liempham: "KV3", phongbui: "KV4" };
const GROUPS = ["KV1", "KV2", "KV3", "KV4", "Chưa phân khu"];
const LS_KEY = "ccts_dash_groups_v1";
// Target vận hành HNO từ 03/07/2026: overdue <3% (cam kết với HQ). Vàng khi chạm 3%, đỏ khi gấp rưỡi target.
const OD_TARGET = 3;
const OD_RED = 5, OD_WARN = 3; // ngưỡng %quá hạn tô màu bảng nhân sự

const COL = { navy:"#1a3a5c", blue:"#2e6da4", green:"#2e8b57", red:"#c0392b", amber:"#e67e22", gray:"#94a3b8" };

// ---------- state ----------
let tickets = new Map();      // id -> ticket object
let solutions = new Map();    // dedupe key -> solution
let loadedFiles = [];
let charts = {};
let groupMap = loadGroups();
let qcRows = new Map();       // Ticket ID -> dòng AI QC (bản ghi mới nhất thắng)
let dataMax = null;           // ngày mới nhất trong dữ liệu (mốc cho "Chọn nhanh")
let hdrBase = "";             // phần đầu dòng thông tin header
let partRecs = new Map();     // dedupe key -> dòng Spare Parts Record (đối soát kho good/broken)
let rejectSet = new Set();    // Ticket ID từng bị Close rejected (quét từ Events Record)
let vomsWin = new Map();      // Ticket ID -> {openT, vomsT}: mốc Open sớm nhất & Pending for VOMS confirm sớm nhất (Events Record)
let errFilter = "";           // lọc theo mã lỗi (bấm cột trong biểu đồ Pareto) — hiện chip ở thanh #af_bar
let tvTimer = null;           // bộ đếm tự xoay tab ở chế độ TV

// giải trình nguyên nhân khách quan cho ticket quá hạn (CSE gõ tay, lưu trên máy) — có giải trình = loại khỏi % sau miễn trừ
const LS_EXPLAIN = "ccts_dash_explain_v1";
// tên người nhập (ghi kèm mỗi giải trình đẩy lên Firebase) — lấy lại từ cấu hình đồng bộ cũ nếu có
let syncUser = "";
try { syncUser = (JSON.parse(localStorage.getItem("ccts_dash_sync_v1") || "{}").user) || ""; } catch (e) {}
// phân loại nguyên nhân khách quan (theo các nhóm miễn trừ đã dùng trong báo cáo SLA3h + disclaim của CCVN)
const EXPLAIN_CATS = ["Trạm đêm đóng cửa (22h–6h)", "Thời tiết / thiên tai", "Hạ tầng điện / mạng", "Không tiếp cận được trạm", "Chờ vật tư", "Lỗi hệ thống VOMS", "Lỗi hệ thống CCTS", "Khách quan khác"];
let explainMap = {};
try { explainMap = JSON.parse(localStorage.getItem(LS_EXPLAIN) || "{}"); } catch (e) { explainMap = {}; }
// bản cũ lưu string (chỉ có text) → đọc kiểu nào cũng ra {c: phân loại, t: chi tiết}
function expOf(tid) {
  const v = explainMap[tid];
  if (!v) return { c: "", t: "" };
  return typeof v === "string" ? { c: "", t: v } : { c: v.c || "", t: v.t || "" };
}
function expText(tid) { const e = expOf(tid); return [e.c, e.t].filter((s) => s && s.trim()).join(" — "); }
function hasExp(tid) { const e = expOf(tid); return !!(e.c || e.t.trim()); }
function saveExplain(tid, cat, text) {
  if ((cat || "").trim() || (text || "").trim()) explainMap[tid] = { c: (cat || "").trim(), t: (text || "").trim() };
  else delete explainMap[tid];
  localStorage.setItem(LS_EXPLAIN, JSON.stringify(explainMap));
  fbPushExplain(tid); // đẩy lên Firebase (bản offline FIREBASE_CONFIG=null thì chỉ lưu máy)
}
// --- đồng bộ giải trình qua Firebase (/dashboard/explain) ---
// Thay kênh Apps Script + Google Sheet cũ (bỏ 16/07/2026): giải trình giờ nằm cùng project
// Firebase với dữ liệu dashboard — realtime cho mọi người đang mở web, không còn cold-start
// hay phải redeploy .gs. Bản offline (FIREBASE_CONFIG=null) chỉ lưu localStorage như xưa.
let fbExpRef = null;     // ref dashboard/explain — gắn trong startLive SAU khi auth xong
let _expPending = null;  // snapshot server chờ áp (hoãn khi user đang gõ dở ô giải trình)
// key Firebase không được chứa . # $ / [ ] — mã hóa (tên ticket có dấu chấm: "B.HNO…")
function expKey(tid) { return String(tid).replace(/[.#$/\[\]]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()); }
// đẩy 1 giải trình lên Firebase (upsert theo ticket; xóa node khi giải trình bị xóa trống)
function fbPushExplain(tid) {
  if (!fbExpRef) return;
  const e = expOf(tid);
  if (e.c || e.t) fbExpRef.child(expKey(tid)).set({ id: tid, c: e.c, t: e.t, user: syncUser || "", up: Date.now() }).catch(() => {});
  else fbExpRef.child(expKey(tid)).remove().catch(() => {});
}
// áp snapshot server vào explainMap (server là nguồn chuẩn). Đang gõ dở ô giải trình thì
// hoãn lại, áp khi rời ô — không mất chữ/focus (bảng ngày vốn không vẽ lại trong renderStats).
function applyExplainRemote(all) {
  const ae = document.activeElement;
  if (ae && ae.classList && (ae.classList.contains("exp-input") || ae.classList.contains("exp-cat"))) { _expPending = all; return; }
  _expPending = null;
  explainMap = {};
  for (const k in all) { const v = all[k] || {}; const id = v.id || k; if (v.c || v.t) explainMap[id] = { c: v.c || "", t: v.t || "" }; }
  localStorage.setItem(LS_EXPLAIN, JSON.stringify(explainMap));
  if (tickets.size) renderStats();
}
document.addEventListener("focusout", () => { if (_expPending) setTimeout(() => { if (_expPending) applyExplainRemote(_expPending); }, 150); });
// ticket quá hạn HOẶC bị VOMS reject, nếu có giải trình khách quan → miễn trừ: SLA tính là ontime ở KPI/%QH toàn dashboard
// (reject thường vẫn ontime theo solution đầu; giải trình để ca reject-mà-quá-hạn được tính lại thành ontime, và ghi lý do)
function isExempt(t) { return hasExp(t.id) && (t.zone === "overdue" || (t.rejected && t.zone !== "pending")); }
function effZone(t) { return isExempt(t) ? "ontime" : t.zone; }

// Google Sheet hệ thống AI QC (đọc công khai qua gviz, không cần đăng nhập) — chỉ lấy sheet "ver 3" theo yêu cầu user
const QC_SHEET_ID = "1W0wq3u3H4yvb-LMPwsb9ccnEJ4DA3dnIhTwTOwoj89U";
// "ver 3" = lịch sử QC solution; "Phase 1" = bản đang chạy (thêm kiểm tra đồng nhất vật tư + trường AI điền).
// Load tuần tự theo thứ tự này — trùng Ticket ID thì bản Phase 1 (load sau) thắng.
const QC_SHEET_NAMES = ["ver 3", "Phase 1"];

function loadGroups() {
  try { return Object.assign({}, GROUP_SEED, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); }
  catch (e) { return Object.assign({}, GROUP_SEED); }
}
function saveGroups() { localStorage.setItem(LS_KEY, JSON.stringify(groupMap)); }
function grpOf(p) { return groupMap[p] || "Chưa phân khu"; }

// ---------- tiện ích ----------
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
function toDate(v) {
  if (v == null || v === "" || v === "----") return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const g = s.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/); // định dạng ngày của gviz
  if (g) return new Date(+g[1], +g[2], +g[3], +(g[4] || 0), +(g[5] || 0), +(g[6] || 0));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
const dayKey = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const monthKey = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1);
function weekKey(d) { // ISO week
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const w1 = new Date(t.getFullYear(), 0, 4);
  const wn = 1 + Math.round(((t - w1) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return t.getFullYear() + "-T" + pad(wn);
}
const bucketKey = { day: dayKey, week: weekKey, month: monthKey };
const fmtPct = (x) => (x == null ? "—" : (Math.round(x * 10) / 10).toLocaleString("vi") + "%");
const fmtD = (d) => pad(d.getDate()) + "/" + pad(d.getMonth() + 1);
const HOURS = 3600e3;

// chuẩn hóa text solution để khớp AI QC với export (ID hai hệ khác nhau, khớp bằng nguyên văn solution)
const norm60 = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 60);
let solTextIndex = new Map(); // norm60(solution) -> {proc, tid}

// mã lỗi: 'A0101 (HighTemperature)' → code 'A0101', tên giữ lần gặp đầu
const errNames = {};
function errCode(raw) {
  const s = String(raw || "").trim();
  if (!s || s === "----") return "Không mã";
  const m = s.match(/^([A-Z]+[\d_]*[A-Z_]*\d*)/i);
  const code = m ? m[1].toUpperCase() : s.slice(0, 20);
  if (!errNames[code]) {
    const nm = s.match(/\(([^)]+)\)/);
    errNames[code] = nm ? nm[1].replace(/\s+/g, " ").trim() : "";
  }
  return code;
}

// tra bảng trạm: thử mã gốc rồi mã bỏ số 0 đệm
const STATION_NORM = {};
for (const k in STATION_MAP) {
  const m = k.match(/^C\.([A-Z]+)0*(\d+)$/);
  if (m) STATION_NORM["C." + m[1] + +m[2]] = STATION_MAP[k];
}
function stationInfo(code) {
  const s = String(code || "").trim().toUpperCase();
  if (STATION_MAP[s]) return STATION_MAP[s];
  const m = s.match(/^C\.([A-Z]+)0*(\d+)$/);
  if (m && STATION_NORM["C." + m[1] + +m[2]]) return STATION_NORM["C." + m[1] + +m[2]];
  return null;
}

// ---------- lưu file đã nạp giữa các lần mở (IndexedDB, chỉ trên máy này) ----------
// Lưu nguyên buffer file xlsx → mở lại trang là tự nạp lại, tận dụng đúng logic khử trùng lặp/parse hiện có.
const IDB_NAME = "ccts_dash", IDB_STORE = "files";
function idbOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(IDB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(IDB_STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbSaveFile(name, buf) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(buf, name); // key = tên file: kỳ export mới cùng tên sẽ ghi đè
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbAllFiles() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const keys = store.getAllKeys(), vals = store.getAll();
    tx.oncomplete = () => res(keys.result.map((k, i) => ({ name: k, buf: vals.result[i] })));
    tx.onerror = () => rej(tx.error);
  });
}
async function idbClear() {
  const db = await idbOpen();
  return new Promise((res) => { const tx = db.transaction(IDB_STORE, "readwrite"); tx.objectStore(IDB_STORE).clear(); tx.oncomplete = () => res(); });
}

// ---------- nạp file ----------
$("dropzone").addEventListener("click", () => $("fileinput").click());
$("fileinput").addEventListener("change", (e) => handleFiles([...e.target.files]));
["dragover", "dragleave", "drop"].forEach((ev) =>
  $("dropzone").addEventListener(ev, (e) => {
    e.preventDefault();
    $("dropzone").classList.toggle("drag", ev === "dragover");
    if (ev === "drop") handleFiles([...e.dataTransfer.files]);
  })
);

async function handleFiles(files) {
  const xls = files.filter((f) => /\.xlsx?$/i.test(f.name));
  if (!xls.length) return;
  // file cũ xử lý trước, file mới nhất (theo tên export có timestamp) ghi đè
  xls.sort((a, b) => a.name.localeCompare(b.name));
  for (const f of xls) {
    const buf = await f.arrayBuffer();
    ingestWorkbook(buf, f.name);
    idbSaveFile(f.name, buf).catch(() => {}); // lưu để lần mở sau tự có sẵn (không chặn nếu lỗi)
  }
  afterLoad();
}

function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  return ws ? XLSX.utils.sheet_to_json(ws, { defval: null }) : [];
}

function ingestWorkbook(buf, fname) {
  // file lớn (báo cáo master nhiều sheet phụ): chỉ parse các sheet dashboard cần để khỏi treo trình duyệt
  const small = buf.byteLength < 10e6;
  const wb = XLSX.read(buf, { type: "array", cellDates: true, ...(small ? {} : { sheets: ["Ticket Information", "Solutions", "Spare Parts Record", "Events Record"] }) });
  const info = sheetRows(wb, "Ticket Information");
  const sols = sheetRows(wb, "Solutions");
  const parts = sheetRows(wb, "Spare Parts Record");
  // Reject = VOMS "add event record" trả ticket về trạng thái Open (thay vì đẩy sang Pending for local team close).
  // Nhận diện trên Events Record: Processor = VOMS, Ticket Status = Open, và có ghi chú (Record Detail khác rỗng)
  // — dòng Open ghi chú rỗng là sự kiện mở ticket ban đầu, KHÔNG tính. Vẫn giữ Close rejected nếu file có.
  for (const r of sheetRows(wb, "Events Record")) {
    const tid = String(r["Ticket ID"] || "").trim();
    const st = String(r["Ticket Status"] || "").trim().toLowerCase();
    const proc = String(r["Processor"] || "").trim().toUpperCase();
    const detail = String(r["Record Detail"] || "").trim();
    const hasDetail = !!detail && detail !== "----";
    if (/close rejected/i.test(st) || (proc === "VOMS" && st === "open" && hasDetail)) rejectSet.add(tid);
    // mốc cửa sổ Open → Pending for VOMS confirm (lấy sự kiện SỚM NHẤT mỗi loại)
    const ct = toDate(r["Create Time"]);
    if (tid && ct && (st === "open" || st === "pending for voms confirm")) {
      const w = vomsWin.get(tid) || {};
      const k = st === "open" ? "openT" : "vomsT";
      if (!w[k] || ct < w[k]) w[k] = ct;
      vomsWin.set(tid, w);
    }
  }
  const partsSet = new Set(parts.map((r) => String(r["Ticket ID"])));
  for (const r of parts) {
    const tid = String(r["Ticket ID"] || "").trim();
    if (!tid) continue;
    const t = toDate(r["Create Time"]);
    const rec = {
      tid, t,
      code: String(r["Material Code"] || "").trim(),
      name: String(r["Material Name (English)"] || "").trim(),
      type: /broken/i.test(String(r["Material type"] || "")) ? "broken" : /good/i.test(String(r["Material type"] || "")) ? "good" : "khác",
      qty: +(r["Usage Quantity"] || 0) || 0,
      proc: String(r["Processor"] || "").trim(),
    };
    partRecs.set(tid + "|" + rec.code + "|" + rec.type + "|" + (t ? t.getTime() : 0) + "|" + rec.qty, rec);
  }

  for (const r of info) {
    const id = String(r["Ticket ID"] || "").trim();
    if (!id) continue;
    const createT = toDate(r["Create Time"]);
    if (!createT) continue;
    tickets.set(id, {
      id,
      extId: String(r["External Ticket ID"] || "").trim(),
      name: String(r["Ticket Name"] || ""),
      station: String(r["Station Code"] || "").trim(),
      cpid: String(r["Charge Point ID"] || "").trim(),
      err: errCode(r["Error Code"]),
      model: String(r["Charge Point Model"] || "").trim(),
      source: String(r["Ticket Source"] || "").trim(),
      status: String(r["Ticket Status"] || ""),
      slaCCTS: String(r["SLA Status"] || ""),
      createT,
      closeT: toDate(r["Close Time"]),
      hasParts: partsSet.has(id),
    });
    // file mới ghi đè hasParts=false của file cũ? gộp: giữ true nếu từng thấy
    const prev = tickets.get(id);
    if (partsSet.has(id)) prev.hasParts = true;
  }
  for (const r of sols) {
    const tid = String(r["Ticket ID"] || "").trim();
    const t = toDate(r["Create Time"]);
    if (!tid || !t) continue;
    const proc = String(r["Processor"] || "").trim();
    const key = tid + "|" + t.getTime() + "|" + proc;
    const att = String(r["Attachments"] || "").trim();
    solutions.set(key, {
      tid, t, proc,
      isPerm: /permanent/i.test(String(r["Solutions Type"] || "")),
      d60: norm60(r["Solution Description"]),
      hasAtt: !!att && att !== "----",
    });
  }
  // file export của sheet AI QC kéo vào cùng ô nạp (nhận diện dòng header có Ticket ID + Kết luận, kể cả header nằm ở dòng 2)
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    if (!ws) continue;
    const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    ingestQCRows(parseQCArrays(arr));
  }
  if (info.length) loadedFiles.push(fname + " (" + info.length + " ticket)");
  else loadedFiles.push(fname);
}

// Thứ tự cột của sheet "ver 3" — gviz của Google luôn nuốt mất dòng header thật của sheet này
// (ở mọi giá trị headers=) nên khi không tìm thấy dòng header phải map theo vị trí cột.
const VER3_COLS = ["Ticket ID", "Thời gian", "Model", "Mã lỗi gốc", "Problem Des", "Solution SE/ASP (nguyên văn)", "Kết luận", "Diễn giải kết luận", "Hành động", "Kết quả", "Chú thích", "Kịch bản lựa chọn", "Số ảnh", "Mô tả ảnh", "Loại xử lý", "Error group"];
// nhóm cột "AI PHÂN TÍCH (Gemini)" trong sheet = Số ảnh + Mô tả ảnh (Gemini đọc ảnh đính kèm để chấm)

// arr = mảng dòng thô (kể cả các dòng tiêu đề nhóm phía trên header thật)
function parseQCArrays(arr) {
  const hi = arr.findIndex((r) => {
    if (!r) return false;
    const cells = r.map((c) => String(c == null ? "" : c).trim());
    return cells.includes("Ticket ID") && cells.includes("Kết luận");
  });
  let hdr, start;
  if (hi >= 0) { hdr = arr[hi].map((c) => String(c == null ? "" : c).trim()); start = hi + 1; }
  else if (arr.some((r) => r && String(r[0] == null ? "" : r[0]).trim() === "THÔNG TIN TICKET")) { hdr = VER3_COLS; start = 0; }
  else return [];
  const list = [];
  for (let i = start; i < arr.length; i++) {
    const row = arr[i];
    if (!row) continue;
    const g = (name) => { const j = hdr.indexOf(name); return j >= 0 && row[j] != null ? String(row[j]) : ""; };
    list.push({
      id: g("Ticket ID").trim(), t: toDate(g("Thời gian")),
      model: g("Model") || g("Loại tủ"), kl: g("Kết luận").trim().toLowerCase(),
      action: g("Hành động"), reason: g("Diễn giải kết luận") || g("Lý do (AI)"),
      checklist: g("Kịch bản lựa chọn") || g("Checklist SOP"),
      errCode: g("Mã lỗi gốc"), photos: g("Số ảnh"), aiDesc: g("Mô tả ảnh"),
      consist: g("Kết quả").trim().toLowerCase(), // KIỂM TRA ĐỒNG NHẤT: vật tư khai vs ảnh/sổ kho (valid/mismatch)
      note: g("Chú thích"),
      sol: norm60(g("Solution SE/ASP (nguyên văn)") || g("Solution Description")),
    });
  }
  return list;
}

function ingestQCRows(list) {
  for (const q of list) {
    if (!q.id || q.id === "TEMPLATE" || /^test/i.test(q.id) || !q.t || !q.kl) continue;
    qcRows.set(q.id, q); // trùng Ticket ID (QC lại) → bản ghi sau (mới hơn) thắng
  }
}

// tải live từ Google Sheet bằng JSONP (sheet phải ở chế độ "ai có link đều xem được") — load lần lượt từng sheet
function loadQCFromGoogle() {
  loadQCSheet(0);
}
function loadQCSheet(i) {
  if (i >= QC_SHEET_NAMES.length) {
    $("qc_status").textContent = "đã tải " + qcRows.size + " ticket QC (" + QC_SHEET_NAMES.join(" + ") + ") lúc " + new Date().toLocaleTimeString("vi");
    renderQC(currentFilter());
    renderParts(currentFilter()); // panel vật tư dùng kết quả kiểm tra đồng nhất của AI QC
    return;
  }
  $("qc_status").textContent = "đang tải sheet \"" + QC_SHEET_NAMES[i] + "\"…";
  const cb = "__qcResp_" + Date.now() + "_" + i;
  window[cb] = (resp) => {
    delete window[cb];
    try {
      if (resp.status !== "ok") throw new Error(resp.status);
      // ghép hàng label + toàn bộ dòng thành mảng thô rồi tự dò dòng header (header thật có thể nằm dưới dòng tiêu đề nhóm)
      const arr = [resp.table.cols.map((c) => c.label || "")];
      for (const row of resp.table.rows) arr.push((row.c || []).map((c) => (c ? (c.v != null ? c.v : c.f) : null)));
      ingestQCRows(parseQCArrays(arr));
      loadQCSheet(i + 1);
    } catch (e) {
      $("qc_status").textContent = "lỗi đọc sheet \"" + QC_SHEET_NAMES[i] + "\" (" + e.message + ")";
    }
  };
  const s = document.createElement("script");
  s.src = "https://docs.google.com/spreadsheets/d/" + QC_SHEET_ID + "/gviz/tq?tqx=out:json;responseHandler:" + cb + "&headers=1&sheet=" + encodeURIComponent(QC_SHEET_NAMES[i]);
  s.onerror = () => { delete window[cb]; $("qc_status").textContent = "không kết nối được Google Sheet (kiểm tra mạng / quyền chia sẻ)"; };
  document.head.appendChild(s);
}

// --- phân loại thiết bị: BSS (BSS_06/BSS_12) vs EVCS (AC / DC: Kern, Core mini, Core) ---
// nguồn: Ticket Name (VFVN-BSS-/-EVCS-) + cột Charge Point Model của export
function classifyDevice(t) {
  const name = t.name || "", m = t.model || "";
  if (/-BSS-/i.test(name) || /BSS/i.test(m)) {
    t.devType = "BSS";
    t.devModel = /12/.test(m) ? "BSS_12" : /06|_6\b/.test(m) ? "BSS_06" : "BSS khác";
  } else {
    t.devType = "EVCS";
    if (/Kern/i.test(m)) t.devModel = "Kern";
    else if (/core\s*mini|ADC002Mini/i.test(m)) t.devModel = "Core mini";
    else if (/ADC002/i.test(m)) t.devModel = "Core";
    else if (/AC006|SAS|Socket|22KW/i.test(m)) t.devModel = "AC";
    else if (/^CC_/i.test(m)) t.devModel = "DC khác (CC)";
    else t.devModel = m ? "Khác" : "Không rõ model";
  }
}
function devMatch(t, v) {
  if (!v) return true;
  if (v === "BSS" || v === "EVCS") return t.devType === v;
  if (v === "DC") return t.devType === "EVCS" && t.devModel !== "AC";
  return t.devModel === v;
}

// ---------- suy diễn sau khi nạp ----------
function deriveAll() {
  if (LIVE_MODE) return deriveLive(); // bản live: SLA/tái phát monitor tính sẵn, chỉ dựng trường phụ
  // gắn solution vào ticket + index text để khớp AI QC
  solTextIndex = new Map();
  for (const t of tickets.values()) { t.sols = []; }
  for (const s of solutions.values()) {
    const t = tickets.get(s.tid);
    if (t) t.sols.push(s);
    if (s.d60 && !solTextIndex.has(s.d60)) solTextIndex.set(s.d60, s);
  }
  for (const t of tickets.values()) {
    classifyDevice(t);
    t.sols.sort((a, b) => a.t - b.t);
    t.solCount = t.sols.length;
    const perm = t.sols.find((s) => s.isPerm);
    const first = perm || t.sols[0] || null; // "solution đầu tiên, ưu tiên Permanent"
    t.refSol = first;
    t.permSol = perm || null;
    t.proc = first ? first.proc : null;
    t.hasAtt = t.sols.some((s) => s.hasAtt); // có ảnh đính kèm trong solution (yêu cầu kho: thay vật tư phải chụp ảnh)

    // nhóm SLA (rule 02/07/2026: phạm vi = trạm HN + Tự doanh trong STATION_MAP)
    // V1=3h; V2=4h (thay linh kiện 7h); V3=7h (thay linh kiện 12h); ngoài phạm vi=48h
    // rule 07/07/2026: SLA nhanh CHỈ áp cho ticket Ticket Source = API creation; nguồn khác → 48h dù trạm vùng nhanh
    const si = stationInfo(t.station);
    const zone = si && /api/i.test(t.source) ? si[0] : null;
    t.province = si ? si[1] : "";
    if (zone === "V1") { t.slaClass = "3h"; t.limitH = 3; }
    else if (zone === "V2") { t.limitH = t.hasParts ? 7 : 4; t.slaClass = t.limitH + "h"; }
    else if (zone === "V3") { t.limitH = t.hasParts ? 12 : 7; t.slaClass = t.limitH + "h"; }
    else { t.slaClass = "48h"; t.limitH = 48; }

    // ontime/overdue: 3h/4h theo rule 07/07/2026 (cửa sổ Open → Pending for VOMS confirm ≈ solution đầu tiên);
    // 7h/12h theo solution đầu (rule 02/07, cùng công thức); 48h giữ cờ SLA Status của CCTS như trước.
    if (t.slaClass === "48h") {
      t.zone = /overdue/i.test(t.slaCCTS) ? "overdue" : (/ontime/i.test(t.slaCCTS) ? "ontime" : "pending");
    } else if (first) {
      t.zone = (first.t - t.createT) <= t.limitH * HOURS ? "ontime" : "overdue";
    } else {
      // chưa có solution: đã quá hạn tính đến giờ → overdue, chưa thì pending
      t.zone = (Date.now() - t.createT) > t.limitH * HOURS ? "overdue" : "pending";
    }
    // thời gian Open → Pending for VOMS confirm (giờ) lấy trực tiếp từ Events Record
    const w = vomsWin.get(t.id);
    t.openToVomsH = (w && w.openT && w.vomsT && w.vomsT >= w.openT) ? (w.vomsT - w.openT) / HOURS : null;

    t.repeat7 = false; t.repeat30 = false; t.repeatOf = null;
    t.caused30 = false; // ticket này sửa xong nhưng lỗi lặp lại trong 30 ngày (dùng cho FTF)
  }

  // tái phát: cùng trụ + cùng mã lỗi, ticket mới tạo ≤7/30 ngày sau Permanent solution của ticket trước
  const byKey = {};
  for (const t of tickets.values()) {
    if (t.err === "Không mã" || !t.cpid) continue;
    (byKey[t.cpid + "|" + t.err] = byKey[t.cpid + "|" + t.err] || []).push(t);
  }
  for (const key in byKey) {
    const arr = byKey[key].sort((a, b) => a.createT - b.createT);
    for (let i = 1; i < arr.length; i++) {
      // ticket trước gần nhất đã có Permanent solution trước khi ticket này tạo
      for (let j = i - 1; j >= 0; j--) {
        const prev = arr[j];
        if (prev.permSol && prev.permSol.t <= arr[i].createT) {
          const dd = (arr[i].createT - prev.permSol.t) / 864e5;
          if (dd <= 30) { arr[i].repeat30 = true; arr[i].repeatOf = prev; prev.caused30 = true; if (dd <= 7) arr[i].repeat7 = true; }
          break;
        }
      }
    }
  }

  // Reject + First Time Fix (Reject cập nhật 09/07/2026):
  // Reject = VOMS add event record trả ticket về Open (rejectSet, quét ở Events Record) hoặc Close rejected
  // FTF = chốt bằng đúng 1 solution (Permanent) + không reject + không gây tái phát ≤30 ngày
  for (const t of tickets.values()) {
    t.rejected = rejectSet.has(t.id) || t.status === "Close rejected";
    t.ftf = t.solCount === 1 && t.sols[0].isPerm && !t.rejected && !t.caused30;
  }

  buildRiskModel();
}

// --- SLA Risk Scoring (heuristic, 0 token): chấm nguy cơ vỡ SLA từ tỉ lệ quá hạn LỊCH SỬ của chính data đã nạp ---
// KHÔNG phải model ML như đề xuất gốc — đây là công cụ hỗ trợ theo tần suất lịch sử, chạy trên snapshot đã nạp.
// Dùng zone THÔ (t.zone==='overdue'), không dùng effZone: miễn trừ/giải trình là phán xét sau, không phải yếu tố dự báo.
let riskModel = null;
const isNight = (t) => { const h = t.createT.getHours(); return h >= 22 || h < 6; };
const holderOf = (t) => RESOURCE_MAP[t.status] || "Khác";
function buildRiskModel() {
  const done = [...tickets.values()].filter((t) => t.zone !== "pending");
  const base = done.length ? done.filter((t) => t.zone === "overdue").length / done.length : 0;
  const feat = { sla: {}, err: {}, model: {}, holder: {}, night: {}, repeat: {} };
  const add = (map, key, od) => { const m = (map[key] = map[key] || [0, 0]); if (od) m[0]++; m[1]++; };
  for (const t of done) {
    const od = t.zone === "overdue";
    add(feat.sla, t.slaClass, od); add(feat.err, t.err, od); add(feat.model, t.devModel, od);
    add(feat.holder, holderOf(t), od); add(feat.night, isNight(t) ? "đêm" : "ngày", od);
    add(feat.repeat, t.repeat30 ? "tái phát" : "thường", od);
  }
  riskModel = { base, K: 8, feat }; // K = làm mượt Laplace: giá trị ít mẫu kéo về tỉ lệ chung
}
// tỉ lệ quá hạn lịch sử của 1 giá trị đặc trưng, làm mượt về base khi mẫu nhỏ
function featRate(map, key) {
  if (!riskModel) return null;
  const m = map[key], { base, K } = riskModel;
  if (!m) return base;
  return (m[0] + base * K) / (m[1] + K);
}
// điểm nguy cơ 0..1 = bình quân có trọng số tỉ lệ quá hạn lịch sử theo các đặc trưng của ticket
function riskScore(t) {
  if (!riskModel) return null;
  const f = riskModel.feat;
  const parts = [
    [featRate(f.sla, t.slaClass), 1.3], [featRate(f.err, t.err), 1.2], [featRate(f.model, t.devModel), 0.8],
    [featRate(f.holder, holderOf(t)), 1.3], [featRate(f.night, isNight(t) ? "đêm" : "ngày"), 0.6],
    [featRate(f.repeat, t.repeat30 ? "tái phát" : "thường"), 1.0],
  ];
  let ws = 0, w = 0;
  for (const [r, wt] of parts) if (r != null) { ws += r * wt; w += wt; }
  return w ? ws / w : riskModel.base;
}
// tooltip minh bạch: liệt kê tỉ lệ quá hạn lịch sử theo từng đặc trưng (không phải hộp đen)
function riskTip(t) {
  if (!riskModel) return "";
  const p = (v) => (v == null ? "—" : Math.round(v * 100) + "%");
  return "%QH lịch sử theo: nhóm " + t.slaClass + " " + p(featRate(riskModel.feat.sla, t.slaClass)) +
    " · mã " + t.err + " " + p(featRate(riskModel.feat.err, t.err)) +
    " · " + holderOf(t) + " " + p(featRate(riskModel.feat.holder, holderOf(t))) +
    (t.repeat30 ? " · trụ tái phát " + p(featRate(riskModel.feat.repeat, "tái phát")) : "") +
    (isNight(t) ? " · tạo đêm " + p(featRate(riskModel.feat.night, "đêm")) : "");
}

// ---------- filter ----------
function currentFilter() {
  const from = $("f_from").value ? new Date($("f_from").value + "T00:00:00") : null;
  const to = $("f_to").value ? new Date($("f_to").value + "T23:59:59") : null;
  const grp = $("f_group").value, person = $("f_person").value;
  return { from, to, grp, person, dev: $("f_dev").value, err: errFilter };
}
function tickInFilter(t, f, ignorePerson) {
  if (f.from && t.createT < f.from) return false;
  if (f.to && t.createT > f.to) return false;
  if (f.dev && !devMatch(t, f.dev)) return false;
  if (f.err && t.err !== f.err) return false;
  if (!ignorePerson) {
    if (f.person && t.proc !== f.person) return false;
    if (f.grp && (!t.proc || grpOf(t.proc) !== f.grp)) return false;
  }
  return true;
}
function solInFilter(s, f) {
  if (f.from && s.t < f.from) return false;
  if (f.to && s.t > f.to) return false;
  if (f.person && s.proc !== f.person) return false;
  if (f.grp && grpOf(s.proc) !== f.grp) return false;
  if (f.dev || f.err) { const t = tickets.get(s.tid); if (!t) return false; if (f.dev && !devMatch(t, f.dev)) return false; if (f.err && t.err !== f.err) return false; }
  return true;
}

// ---------- render ----------
function afterLoad() {
  deriveAll();
  if (!tickets.size) return;
  $("dash").style.display = "block";
  $("dropzone").style.padding = "12px";
  $("filebar").textContent = "Đã nạp: " + loadedFiles.join("  ·  ") + "  —  tổng " + tickets.size + " ticket (đã khử trùng lặp), " + solutions.size + " solution.";

  // khởi tạo khoảng ngày theo dữ liệu
  const ds = [...tickets.values()].map((t) => t.createT).concat([...solutions.values()].map((s) => s.t));
  const min = new Date(Math.min(...ds)), max = new Date(Math.max(...ds));
  dataMax = max;
  if (!$("f_from").value) $("f_from").value = dayKey(min);
  $("f_to").value = dayKey(max);
  hdrBase = "Dữ liệu " + fmtD(min) + " → " + fmtD(max) + "/" + max.getFullYear();
  $("hdrinfo").textContent = hdrBase;

  // dropdown người
  const procs = LIVE_MODE
    ? [...new Set([...tickets.values()].map((t) => t.proc))].filter(Boolean).sort()   // live: người = owner ticket mở
    : [...new Set([...solutions.values()].map((s) => s.proc))].filter(Boolean).sort();
  $("f_person").innerHTML = '<option value="">Tất cả</option>' + procs.map((p) => `<option>${p}</option>`).join("");
  $("f_group").innerHTML = '<option value="">Toàn team</option>' + GROUPS.map((g) => `<option>${g}</option>`).join("");
  if (!afterLoad._hashApplied) { afterLoad._hashApplied = true; applyHash(); } // khôi phục bộ lọc từ URL (nếu mở bằng link đã lưu)
  renderAll();
  // giải trình online: listener Firebase (gắn trong startLive) tự áp về explainMap — không cần pull tay
  // tự thử kéo AI QC live 1 lần khi có dữ liệu (im lặng nếu offline)
  if (!qcRows.size && !afterLoad._qcTried) { afterLoad._qcTried = true; loadQCFromGoogle(); }
}

function renderAll() {
  const f = currentFilter();
  renderActiveFilters();
  saveHash(f);
  const T = [...tickets.values()].filter((t) => tickInFilter(t, f));
  if (LIVE_MODE) return renderLive(f, T); // bản live: chỉ các panel dùng được ticket đang mở
  const S = [...solutions.values()].filter((s) => solInFilter(s, f) && tickets.has(s.tid));
  renderKPIs(f, T, S);
  // màn hình 1: 6 biểu đồ điều hành
  renderSLAon(T);
  renderODday(f, T);
  renderWorkload(f);
  renderStuckChart(T);
  renderErrors(T);
  renderParts(f);
  renderForecast(f);
  renderTrend(f);
  renderPriority(f);
  renderDaily(f);
  // các bảng chi tiết thu gọn
  renderSLA(T);
  renderPerf(f);
  renderStuck(T);
  renderRepeats(T);
  renderQC(f);
}

// --- chip lọc đang bật (mã lỗi bấm từ biểu đồ Pareto) hiện ở thanh #af_bar, bấm ✕ để bỏ ---
function renderActiveFilters() {
  const bar = $("af_bar");
  if (!bar) return;
  const chips = [];
  if (errFilter) chips.push(`<span class="chip">Mã lỗi <b>${errFilter}</b>${errNames[errFilter] ? " (" + errNames[errFilter] + ")" : ""}<span class="x" data-clr="err" title="bỏ lọc mã lỗi">✕</span></span>`);
  bar.innerHTML = chips.join(" ");
  bar.style.display = chips.length ? "flex" : "none";
  bar.querySelectorAll(".x[data-clr]").forEach((x) => x.addEventListener("click", () => {
    if (x.dataset.clr === "err") errFilter = "";
    renderAll();
  }));
}

// --- xu hướng dài hạn theo tháng (toàn bộ dữ liệu, chỉ theo dev/person/khu, KHÔNG theo khoảng ngày) ---
function renderTrend(f) {
  const ff = { ...f, from: null, to: null }; // bỏ lọc ngày để thấy toàn bộ lịch sử
  const buckets = {};
  for (const t of tickets.values()) {
    if (!tickInFilter(t, ff)) continue;
    const k = monthKey(t.createT);
    const b = (buckets[k] = buckets[k] || { n: 0, done: 0, od: 0 });
    b.n++;
    if (t.zone !== "pending") { b.done++; if (effZone(t) === "overdue") b.od++; }
  }
  const keys = Object.keys(buckets).sort();
  mkChart("c_trend", {
    data: {
      labels: keys,
      datasets: [
        { type: "bar", label: "Ticket tạo trong tháng", data: keys.map((k) => buckets[k].n), backgroundColor: COL.blue + "88", yAxisID: "y" },
        { type: "line", label: "%Quá hạn (sau miễn trừ)", data: keys.map((k) => (buckets[k].done ? Math.round(1000 * buckets[k].od / buckets[k].done) / 10 : null)),
          borderColor: COL.red, backgroundColor: COL.red, yAxisID: "y2", tension: .25, pointRadius: 3, spanGaps: true },
        { type: "line", label: "Target " + OD_TARGET + "%", data: keys.map(() => OD_TARGET), borderColor: COL.gray, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, yAxisID: "y2" },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { footer: (it) => { const b = buckets[it[0].label]; return b ? `quá hạn ${b.od}/${b.done} đã có KQ` : ""; } } } },
      scales: { y: { beginAtZero: true, title: { display: true, text: "Ticket" } },
        y2: { position: "right", beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: "%Quá hạn" } },
        x: { ticks: { maxTicksLimit: 14 } } } },
  });
}

// --- lưu/khôi phục bộ lọc qua URL #hash (copy link gửi đồng nghiệp / F5 không mất lọc) ---
function saveHash(f) {
  const p = new URLSearchParams();
  const set = (k, v) => { if (v) p.set(k, v); };
  set("from", $("f_from").value); set("to", $("f_to").value);
  set("dev", f.dev); set("person", f.person); set("grp", f.grp); set("err", f.err);
  set("gran", $("f_gran").value !== "day" ? $("f_gran").value : ""); set("level", $("f_level").value !== "person" ? $("f_level").value : "");
  const s = p.toString();
  const target = s ? "#" + s : "";
  if (location.hash !== target) history.replaceState(null, "", location.pathname + location.search + target);
}
function applyHash() {
  if (!location.hash || location.hash.length < 2) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  const setVal = (id, k) => { if (p.has(k)) $(id).value = p.get(k); };
  setVal("f_from", "from"); setVal("f_to", "to"); setVal("f_dev", "dev");
  setVal("f_person", "person"); setVal("f_group", "grp"); setVal("f_gran", "gran"); setVal("f_level", "level");
  if (p.has("err")) errFilter = p.get("err");
  // dev có thể là model ngoài danh sách cứng (vd "DC khác (CC)") → thêm option nếu thiếu
  if (p.get("dev")) { const sel = $("f_dev"); if (![...sel.options].some((o) => o.value === p.get("dev"))) sel.add(new Option("  " + p.get("dev"), p.get("dev"))); sel.value = p.get("dev"); }
  return true;
}

// --- tra cứu nhanh 1 ticket / trạm / trụ ---
function renderSearch(q) {
  q = (q || "").trim().toLowerCase();
  const body = $("search_body");
  if (q.length < 2) { $("search_n").textContent = "(gõ ít nhất 2 ký tự)"; body.innerHTML = ""; return; }
  const hit = [...tickets.values()].filter((t) =>
    (t.id && t.id.toLowerCase().includes(q)) || (t.name && t.name.toLowerCase().includes(q)) ||
    (t.station && t.station.toLowerCase().includes(q)) || (t.cpid && t.cpid.toLowerCase().includes(q)) ||
    (t.err && t.err.toLowerCase().includes(q))
  ).sort((a, b) => b.createT - a.createT);
  $("search_n").textContent = `— khớp ${hit.length} ticket` + (hit.length > 40 ? " (hiện 40 mới nhất)" : "");
  if (!hit.length) { body.innerHTML = '<div style="color:var(--muted);padding:8px">Không tìm thấy ticket nào khớp.</div>'; return; }
  const zoneTxt = (t) => t.zone === "pending" ? '<span style="color:var(--muted)">chưa có solution</span>' : isExempt(t) ? '<span style="color:var(--amber)">miễn trừ (có giải trình)</span>' : t.zone === "overdue" ? '<span style="color:var(--red);font-weight:700">QUÁ HẠN</span>' : '<span style="color:var(--green)">đạt</span>';
  body.innerHTML = hit.slice(0, 40).map((t) => {
    const sols = t.sols.map((s) => `${dayKey(s.t).slice(5)} ${pad(s.t.getHours())}:${pad(s.t.getMinutes())} · ${s.proc || "—"}${s.isPerm ? " (Permanent)" : ""}`).join("<br>") || '<span style="color:var(--red)">chưa có solution</span>';
    const exp = expText(t.id);
    const rep = t.repeat30 ? ` · <b style="color:var(--amber)">tái phát ${t.repeat7 ? "≤7" : "≤30"} ngày</b>${t.repeatOf ? " (sau " + (t.repeatOf.proc || "?") + ")" : ""}` : "";
    return `<div class="srow"><div class="sh"><span>${t.name || t.id}</span><span><span class="pill ${t.limitH <= 3 ? "p3" : t.limitH <= 4 ? "p4" : t.limitH <= 12 ? "p7" : "p48"}">${t.slaClass}</span> ${zoneTxt(t)}</span></div>` +
      `<div class="sl">Trạm <b>${t.station || "—"}</b> · S/N trụ <b>${t.cpid || "—"}</b> · ${t.devType}/${t.devModel} · mã lỗi <b>${t.err}</b>${errNames[t.err] ? " (" + errNames[t.err] + ")" : ""}<br>` +
      `Tạo ${dayKey(t.createT)} ${pad(t.createT.getHours())}:${pad(t.createT.getMinutes())} · trạng thái <b>${t.status || "—"}</b> · người ${t.proc || "—"}${t.proc ? " (" + grpOf(t.proc) + ")" : ""}${rep}</div>` +
      `<div class="stl"><b>${t.solCount} solution:</b><br>${sols}</div>` +
      (exp ? `<div class="stl" style="color:var(--amber)"><b>Giải trình:</b> ${exp}</div>` : "") + `</div>`;
  }).join("");
}

// --- giải trình tự động (gợi ý) dựa trên dữ liệu ticket, không cần CSE gõ tay ---
function autoExplain(t) {
  const reasons = [];
  if (!t.refSol) {
    const grp = RESOURCE_MAP[t.status];
    reasons.push("Chưa xử lý" + (grp ? ` — đang treo ${grp}` : t.status ? ` — trạng thái "${t.status}"` : ""));
  } else {
    const grp = RESOURCE_MAP[t.status];
    if (grp && grp !== "Khác") reasons.push(`Đang treo: ${grp}`);
  }
  if (t.hasParts) reasons.push("Có thay linh kiện (hạn được nới)");
  const h = t.createT.getHours();
  if (h >= 22 || h < 6) reasons.push("Tạo ban đêm 22h–6h");
  if (t.repeat30) reasons.push(`Tái phát ${t.repeat7 ? "≤7" : "≤30"} ngày`);
  if (t.refSol) {
    const dur = (t.refSol.t - t.createT) / HOURS;
    const over = Math.round((dur - t.limitH) * 10) / 10;
    if (over > 0) reasons.push(`Vượt hạn ${over.toLocaleString("vi")}h`);
  }
  return reasons.join(" · ") || "—";
}

// --- card giải trình tích hợp mọi nhóm SLA (gộp báo cáo overdue ngày + danh sách SLA3h cũ, 10/07) ---
let expSel = ""; // chip lọc nhóm: "" = tất cả | "fast" = 3h/4h/7h/12h | "48" = 48h
const inExpSel = (t) => (expSel === "fast" ? t.limitH < 48 : expSel === "48" ? t.slaClass === "48h" : true);
// ca cần giải trình: quá hạn (kể cả đã miễn trừ) / bị VOMS reject / Open→VOMS confirm VƯỢT GIỜ SLA của ticket (chỉ nhóm 3h/4h)
// ngưỡng = t.limitH (nhóm 3h → >3h, nhóm 4h → >4h) — KHÔNG so cứng 3h như trước
const isOverVoms = (t) => (t.slaClass === "3h" || t.slaClass === "4h") && t.openToVomsH != null && t.openToVomsH > t.limitH;
const needExplain = (t) => t.zone === "overdue" || t.rejected || isOverVoms(t);
// phân loại TÌNH HUỐNG của ca giải trình — 1 nhãn chính, ưu tiên (nặng→nhẹ):
// lỗi hệ thống (treo bên thứ 3) > resolve muộn > VOMS reject.
// LƯU Ý vòng đời: Open → KTV xử lý → nhấn Resolve (= bước Open→VOMS). Nhấn resolve trễ
// TỨC LÀ resolve muộn → "giờ xử lý muộn"/Open→VOMS vượt SLA và "resolve muộn" là MỘT.
const EXP_SCN = { "Lỗi hệ thống": "#8e44ad", "Resolve muộn": COL.red, "VOMS reject": "#16a085" };
const EXT_HOLDERS = new Set(["Tại ASP", "Tại VOMS", "Kẹt vật tư", "Kẹt firmware"]); // holderOf → đang treo bên ngoài team
function explainScenario(t) {
  if (!t.refSol && EXT_HOLDERS.has(holderOf(t))) return "Lỗi hệ thống";  // chưa có solution & treo bên thứ 3 (ASP/kho/firmware)
  if (t.zone === "overdue" || isOverVoms(t)) return "Resolve muộn";      // resolve trễ (gồm Open→VOMS vượt giờ SLA)
  if (t.rejected) return "VOMS reject";                                 // bị VOMS trả về Open / Close rejected
  return "Resolve muộn";                                                // dự phòng (needExplain đảm bảo đã dính ≥1)
}
function dailyRows(f) {
  const day = $("d_day").value;
  if (!day) return { day: "", day2: "", rows: [], created: 0, byDay: {} };
  const day2 = $("d_day2").value && $("d_day2").value >= day ? $("d_day2").value : day;
  const d0 = new Date(day + "T00:00:00"), d1 = new Date(day2 + "T23:59:59");
  const all = [...tickets.values()].filter((t) => t.createT >= d0 && t.createT <= d1 && tickInFilter(t, { ...f, from: null, to: null }) && inExpSel(t));
  const byDay = {}; // dd/mm -> [quá hạn, tạo] để dòng tổng bóc theo từng ngày khi xem khoảng
  for (const t of all) {
    const k = dayKey(t.createT);
    byDay[k] = byDay[k] || [0, 0];
    byDay[k][1]++;
    if (t.zone === "overdue") byDay[k][0]++;
  }
  return { day, day2, created: all.length, rows: all.filter(needExplain), byDay, all };
}
function renderDaily(f) {
  if (!$("d_day").value && tickets.size) { // mặc định = ngày có ticket mới nhất (không lấy ngày solution)
    $("d_day").value = dayKey(new Date(Math.max(...[...tickets.values()].map((t) => +t.createT))));
  }
  const { day, day2, rows, created, byDay, all } = dailyRows(f);
  const multi = day2 && day2 !== day; // xem khoảng nhiều ngày: nhóm theo ngày trước, hiện thêm ngày ở cột Tạo lúc
  dailySummary(rows, created, byDay, multi);
  const order = { "3h": 0, "4h": 1, "7h": 2, "12h": 3, "48h": 4 };
  rows.sort((a, b) => (multi ? dayKey(a.createT).localeCompare(dayKey(b.createT)) : 0) || (order[a.slaClass] ?? 9) - (order[b.slaClass] ?? 9) || b.createT - a.createT);
  $("daily").innerHTML = "<thead><tr><th>Ticket</th><th>Ticket ID</th><th>External ticket id</th><th>Trạm</th><th>Mã lỗi</th><th>Nhóm</th><th>Tạo lúc</th><th>Solution đầu</th><th>Giờ xử lý / hạn</th><th title=\"Thời gian từ trạng thái Open đến Pending for VOMS confirm, lấy trong Events Record — chỉ áp nhóm 3h/4h\">Open→VOMS</th><th>Kết quả</th><th>Người</th><th>Khu</th><th>Trạng thái</th><th title=\"Phân loại tình huống: Resolve muộn / Pending for other (treo bên thứ 3) / VOMS reject\">Tình huống</th><th style=\"min-width:160px\">Cần giải trình vì</th><th style=\"min-width:200px\">Giải trình khách quan (CSE gõ)</th></tr></thead><tbody>" +
    rows.map((t) => {
      const dur = t.refSol ? Math.round((t.refSol.t - t.createT) / 360000) / 10 : null;
      const wait = t.refSol ? null : Math.round((Date.now() - t.createT) / 360000) / 10; // chưa xử lý: đã treo bao lâu tính đến giờ
      const h = t.createT.getHours();
      const night = h >= 22 || h < 6 ? ' <span title="Tạo ban đêm 22h–6h — thường thuộc diện miễn trừ (trạm đóng cửa)">🌙</span>' : "";
      const tip = `${t.devType}/${t.devModel} (${t.model || "không rõ model"}) · S/N trụ: ${t.cpid || "—"} · ${t.province || "ngoài phạm vi HN"} · ${t.solCount} solution · ${autoExplain(t)}`;
      const overVoms = isOverVoms(t);
      const z = effZone(t);
      const kq = t.zone === "overdue" && z !== "ontime" ? '<td class="bad">Quá hạn</td>' : isExempt(t) ? '<td class="warn" title="' + expText(t.id).replace(/"/g, "'") + '">Miễn trừ</td>' : t.zone === "pending" ? "<td>Chưa có sol</td>" : '<td style="color:var(--green)">Đạt</td>';
      const why = [t.zone === "overdue" ? "Quá hạn" : "", t.rejected ? "VOMS reject" : "", overVoms ? `Open→VOMS ${(Math.round(t.openToVomsH * 10) / 10).toLocaleString("vi")}h>${t.limitH}h` : ""].filter(Boolean).join(" · ");
      const scn = explainScenario(t), scnC = EXP_SCN[scn];
      const scnCell = `<td><span class="pill" style="background:${scnC}22;color:${scnC};border:1px solid ${scnC}66;white-space:nowrap" title="Đang treo: ${holderOf(t)}">${scn}</span></td>`;
      return `<tr${t.limitH <= 4 ? ' style="background:rgba(220,53,69,.05)"' : ""}><td title="${tip}">${t.name || t.id}</td><td>${t.id}</td><td>${t.extId || "—"}</td><td>${t.station}</td><td>${t.err}</td><td><span class="pill ${t.limitH <= 3 ? "p3" : t.limitH <= 4 ? "p4" : t.limitH <= 12 ? "p7" : "p48"}">${t.slaClass}</span></td>` +
        `<td>${(multi ? dayKey(t.createT).slice(5) + " " : "") + pad(h)}:${pad(t.createT.getMinutes())}${night}</td>` +
        `<td>${t.refSol ? dayKey(t.refSol.t).slice(5) + " " + pad(t.refSol.t.getHours()) + ":" + pad(t.refSol.t.getMinutes()) : '<b style="color:var(--red)">CHƯA XỬ LÝ</b>'}</td>` +
        `<td class="${t.zone === "overdue" ? "bad" : ""}">${dur != null ? dur.toLocaleString("vi") + "h / " + t.limitH + "h" : '<span title="Đã treo tính đến bây giờ">đang ' + wait.toLocaleString("vi") + "h</span> / " + t.limitH + "h"}</td>` +
        `<td class="${overVoms ? "warn" : ""}">${t.openToVomsH != null && t.limitH <= 4 ? (Math.round(t.openToVomsH * 10) / 10).toLocaleString("vi") + "h" : "—"}</td>` + kq +
        `<td>${t.proc || "—"}</td><td>${t.proc ? grpOf(t.proc) : ""}</td><td>${t.status}</td>` + scnCell +
        `<td style="text-align:left;font-size:12px;color:var(--red)">${why}${t.repeat30 ? ' · <b>TP' + (t.repeat7 ? "≤7ng" : "≤30ng") + "</b>" : ""}</td>` +
        `<td style="text-align:left"><div style="display:flex;flex-direction:column;gap:3px;min-width:210px">` +
        `<select class="exp-cat" data-tid="${t.id}" style="padding:3px 4px;border:1px solid var(--border);border-radius:5px;font-size:12px;color:${expOf(t.id).c ? "var(--text)" : "var(--muted)"}"><option value="">— phân loại khách quan —</option>` +
        EXPLAIN_CATS.map((c) => `<option ${expOf(t.id).c === c ? "selected" : ""}>${c}</option>`).join("") + `</select>` +
        `<input class="exp-input" data-tid="${t.id}" value="${expOf(t.id).t.replace(/"/g, "&quot;")}" placeholder="chi tiết (vd: mưa bão, VOMS bắt lỗi ảnh…)" style="width:100%;padding:3px 6px;border:1px solid var(--border);border-radius:5px;font-size:12px"></div></td></tr>`;
    }).join("") + "</tbody>";
  // chọn/gõ xong thì tự lưu (đọc cả cặp select+input cùng ticket) + cập nhật dòng tổng, không vẽ lại bảng để không mất focus
  const saveRow = (tid) => {
    const cat = $("daily").querySelector(`.exp-cat[data-tid="${tid}"]`);
    const inp = $("daily").querySelector(`.exp-input[data-tid="${tid}"]`);
    saveExplain(tid, cat ? cat.value : "", inp ? inp.value : "");
    if (cat) cat.style.color = cat.value ? "var(--text)" : "var(--muted)";
    const d = dailyRows(currentFilter());
    dailySummary(d.rows, d.created, d.byDay, d.day2 && d.day2 !== d.day);
    renderExplainDash(d.rows, d.all);
    renderStats();
    flashSaved(1);
  };
  $("daily").querySelectorAll(".exp-input, .exp-cat").forEach((el) =>
    el.addEventListener("change", () => saveRow(el.dataset.tid))
  );
  renderExplainDash(rows, all);
}

// --- Dashboard giải trình: 3 biểu đồ tròn (doughnut) xem THÀNH PHẦN các ca cần giải trình ---
// (1) tỉ lệ Quá hạn/Đạt/Chưa có KQ trên TOÀN BỘ ticket tạo trong kỳ
// (2) theo TÌNH HUỐNG (Resolve muộn / Lỗi hệ thống / VOMS reject) — đã/chưa giải trình để trong tooltip
// (3) theo NGUYÊN NHÂN khách quan CSE đã phân loại (EXPLAIN_CATS)
const PIE = ["#2e6da4", "#2e8b57", "#e67e22", "#c0392b", "#8e44ad", "#16a085", "#f39c12", "#2c3e50", "#d35400", "#27ae60"];
function renderExplainDash(rows, all) {
  if (!$("c_exp_scn") || !$("c_exp_cat")) return; // chưa có canvas (vd bản live) → bỏ qua
  const scns = ["Resolve muộn", "Lỗi hệ thống", "VOMS reject"];
  const scnN = {}, done = {}, undone = {};
  for (const s of scns) { scnN[s] = 0; done[s] = 0; undone[s] = 0; }
  const catCount = {}; for (const c of EXPLAIN_CATS) catCount[c] = 0; catCount["(chưa phân loại)"] = 0;
  for (const t of rows) {
    const s = explainScenario(t);
    scnN[s]++;
    if (hasExp(t.id)) done[s]++; else undone[s]++;
    const c = expOf(t.id).c || "(chưa phân loại)";
    catCount[c] = (catCount[c] || 0) + 1;
  }
  const N = rows.length || 1;
  const pct = (v) => Math.round(1000 * v / N) / 10;
  // (1) tình huống
  const sL = scns.filter((s) => scnN[s] > 0);
  mkChart("c_exp_scn", {
    type: "doughnut",
    data: { labels: sL, datasets: [{ data: sL.map((s) => scnN[s]), backgroundColor: sL.map((s) => EXP_SCN[s]), borderColor: "#fff", borderWidth: 1.5 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } },
        title: { display: true, text: "Thành phần theo tình huống (" + rows.length + " ca)" },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${scnN[ctx.label]} (${pct(scnN[ctx.label])}%) — đã GT ${done[ctx.label]}, chưa ${undone[ctx.label]}` } } } },
  });
  // (2) nguyên nhân khách quan
  const cats = Object.keys(catCount).filter((c) => catCount[c] > 0).sort((a, b) => catCount[b] - catCount[a]);
  mkChart("c_exp_cat", {
    type: "doughnut",
    data: { labels: cats, datasets: [{ data: cats.map((c) => catCount[c]),
      backgroundColor: cats.map((c, i) => (c === "(chưa phân loại)" ? COL.gray + "aa" : PIE[i % PIE.length])), borderColor: "#fff", borderWidth: 1.5 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 10 } } },
        title: { display: true, text: "Thành phần nguyên nhân khách quan" },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${catCount[ctx.label]} (${pct(catCount[ctx.label])}%)` } } } },
  });
  // (1) tỉ lệ quá hạn / tổng ticket tạo trong kỳ (sau miễn trừ, khớp %QH toàn dashboard)
  if ($("c_exp_od")) {
    const A = all || [];
    let od = 0, on = 0, pend = 0;
    for (const t of A) { if (t.zone === "pending") pend++; else if (effZone(t) === "overdue") od++; else on++; }
    const tot = A.length || 1;
    const oL = ["Quá hạn", "Đạt", "Chưa có KQ"], oV = [od, on, pend], oC = [COL.red, COL.green, COL.gray + "aa"];
    const k = oV.map((v) => v > 0);
    mkChart("c_exp_od", {
      type: "doughnut",
      data: { labels: oL.filter((_, i) => k[i]), datasets: [{ data: oV.filter((_, i) => k[i]),
        backgroundColor: oC.filter((_, i) => k[i]), borderColor: "#fff", borderWidth: 1.5 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } },
          title: { display: true, text: "Quá hạn sau miễn trừ / tổng ticket (" + A.length + ")" },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed} (${Math.round(1000 * ctx.parsed / tot) / 10}%)` } } } },
    });
  }
}
function flashSaved(n) {
  $("d_saved").textContent = `✓ đã lưu ${n} giải trình lúc ${new Date().toLocaleTimeString("vi")} — đã trừ khỏi %QH`;
  $("d_saved").style.color = "var(--green)";
}
// sau khi lưu giải trình: tính lại KPI/bảng/biểu đồ phụ thuộc %QH, không vẽ lại bảng ngày để giữ focus
function renderStats() {
  const f = currentFilter();
  const T = [...tickets.values()].filter((t) => tickInFilter(t, f));
  if (LIVE_MODE) return renderLive(f, T); // bản live: dùng đúng bộ panel live (giải trình cập nhật cũng vẽ lại đây)
  const S = [...solutions.values()].filter((s) => solInFilter(s, f) && tickets.has(s.tid));
  renderPriority(f);
  renderKPIs(f, T, S);
  renderSLAon(T);
  renderODday(f, T);
  renderStuckChart(T);
  renderTrend(f);
  renderPerf(f);
  renderSLA(T);
  renderStuck(T);
}
function dailySummary(rows, created, byDay, multi) {
  const od = rows.filter((t) => t.zone === "overdue");
  const rej = rows.filter((t) => t.rejected);
  const ov3 = rows.filter(isOverVoms);
  const noSol = rows.filter((t) => !t.refSol);
  const exempt = od.filter((t) => hasExp(t.id));
  const pct = created ? Math.round(1000 * od.length / created) / 10 : 0;
  const left = od.length - exempt.length;
  const pct2 = created ? Math.round(1000 * left / created) / 10 : 0;
  const byGrp = {};
  for (const t of rows) { const g = t.proc ? grpOf(t.proc) : "chưa có người"; byGrp[g] = (byGrp[g] || 0) + 1; }
  const grpTxt = Object.entries(byGrp).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(", ");
  const selTxt = expSel === "fast" ? " (nhóm nhanh 3h/4h/7h)" : expSel === "48" ? " (nhóm 48h)" : "";
  $("d_sum").innerHTML = `Tạo <b>${created}</b> ticket${selTxt} · cần giải trình <b>${rows.length}</b> = ` +
    `quá hạn <b style="color:${pct < OD_TARGET ? "var(--green)" : "var(--red)"}">${od.length} (${pct.toLocaleString("vi")}%)</b>` +
    (rej.length ? ` + VOMS reject <b style="color:var(--red)">${rej.length}</b>` : "") +
    (ov3.length ? ` + Open→VOMS vượt giờ SLA <b style="color:var(--amber)">${ov3.length}</b>` : "") +
    ` (trùng tính 1 lần) so target QH &lt;${OD_TARGET}%` +
    (noSol.length ? ` · <b style="color:var(--red)">${noSol.length} CHƯA có solution</b>` : "") +
    (grpTxt ? ` · theo khu: <b>${grpTxt}</b>` : "") +
    (exempt.length ? ` · quá hạn đã giải trình <b>${exempt.length}</b> → sau miễn trừ còn <b style="color:${pct2 < OD_TARGET ? "var(--green)" : "var(--red)"}">${left} (${pct2.toLocaleString("vi")}%)</b>` : "") +
    (multi && byDay ? `<br>Theo ngày (quá hạn/tạo): ` + Object.keys(byDay).sort().map((k) => {
      const [o, n] = byDay[k];
      return `${k.slice(8)}/${k.slice(5, 7)}: <b style="color:${o ? "var(--red)" : "var(--green)"}">${o}</b>/${n}`;
    }).join(" · ") : "");
}

// --- SLA 3h/4h tổng hợp toàn team (dùng cho sheet Excel SLA3h_TongHop; danh sách/giải trình đã GỘP vào card giải trình tích hợp) ---
function sla3hStats(f) {
  const v = { n3: 0, on3: 0, n4: 0, on4: 0, solved: 0, ftf: 0, rej: 0, list: [] };
  for (const t of tickets.values()) {
    if (!tickInFilter(t, f)) continue;
    if (t.slaClass !== "3h" && t.slaClass !== "4h") continue;
    const z = effZone(t);
    if (t.slaClass === "3h") { v.n3++; if (z === "ontime") v.on3++; }
    else { v.n4++; if (z === "ontime") v.on4++; }
    if (t.solCount) { v.solved++; if (t.ftf) v.ftf++; }
    if (t.rejected) v.rej++;
    v.list.push(t);
  }
  return v;
}
const pct1 = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);

// xuất Excel TOÀN BỘ ticket mọi nhóm SLA (3h/4h/7h/12h/48h):
// sheet tổng theo ngày (tách từng nhóm) + sheet chi tiết từng ticket (kèm giải trình cho ca quá hạn & reject)
const EXPORT_CLS = ["3h", "4h", "7h", "12h", "48h"];
function export3h(f) {
  const list = [...tickets.values()].filter((t) => tickInFilter(t, f))
    .sort((a, b) => a.createT - b.createT || (a.slaClass < b.slaClass ? -1 : 1));
  if (!list.length) { alert("Không có ticket trong kỳ lọc để xuất."); return; }
  const outcome = (t) => t.zone === "pending" ? "Chưa có solution" : isExempt(t) ? "Miễn trừ (giải trình)" : t.zone === "overdue" ? "Quá hạn" : "Đạt";
  const tally = (arr) => {
    const d = { total: 0, ontime: 0, exempt: 0, overdue: 0, pending: 0, reject: 0 };
    EXPORT_CLS.forEach((c) => (d[c] = 0));
    for (const t of arr) {
      d.total++;
      if (d[t.slaClass] != null) d[t.slaClass]++;
      if (t.rejected) d.reject++;
      if (t.zone === "pending") d.pending++;
      else if (isExempt(t)) d.exempt++;
      else if (t.zone === "overdue") d.overdue++;
      else d.ontime++;
    }
    return d;
  };
  const dayRow = (label, d) => {
    const done = d.ontime + d.exempt + d.overdue;
    const row = { "Ngày": label, "Tổng": d.total };
    EXPORT_CLS.forEach((c) => (row["Nhóm " + c] = d[c]));
    return Object.assign(row, {
      "Đạt đúng hạn": d.ontime, "Miễn trừ": d.exempt, "Quá hạn": d.overdue, "Chưa có solution": d.pending,
      "Bị VOMS reject": d.reject,
      "%Đạt (sau miễn trừ)": done ? Math.round(1000 * (d.ontime + d.exempt) / done) / 10 : "",
      "%Quá hạn": done ? Math.round(1000 * d.overdue / done) / 10 : "",
    });
  };
  // sheet 1: kết quả theo từng ngày (tách từng nhóm SLA) + dòng TỔNG
  const byDay = {};
  for (const t of list) (byDay[dayKey(t.createT)] = byDay[dayKey(t.createT)] || []).push(t);
  const daily = Object.keys(byDay).sort().map((k) => dayRow(k, tally(byDay[k])));
  daily.push(dayRow("TỔNG", tally(list)));
  // sheet 2: chi tiết từng ticket, có cột Nhóm SLA + FTF/Reject; giải trình cho ca quá hạn HOẶC reject
  const detail = list.map((t) => {
    const needExp = needExplain(t); // ca cần giải trình: quá hạn (gồm đã miễn trừ), bị reject, hoặc Open→VOMS confirm vượt giờ SLA (nhóm 3h/4h)
    return {
      "Ngày": dayKey(t.createT), "Ticket": t.name || t.id, "Ticket ID": t.id, "External ticket id": t.extId || "", "Nhóm SLA": t.slaClass, "Trạm": t.station, "Mã lỗi": t.err,
      "Tạo lúc": dayKey(t.createT) + " " + pad(t.createT.getHours()) + ":" + pad(t.createT.getMinutes()),
      "Solution đầu": t.refSol ? dayKey(t.refSol.t) + " " + pad(t.refSol.t.getHours()) + ":" + pad(t.refSol.t.getMinutes()) : "CHƯA XỬ LÝ",
      "Giờ xử lý": t.refSol ? Math.round((t.refSol.t - t.createT) / 360000) / 10 : "",
      "Open→VOMS confirm (h)": t.openToVomsH != null ? Math.round(t.openToVomsH * 10) / 10 : "",
      "Hạn (h)": t.limitH, "Người": t.proc || "", "Khu": t.proc ? grpOf(t.proc) : "",
      "Trạng thái": t.status, "Kết quả": outcome(t),
      "FTF": t.ftf ? "x" : "", "Bị VOMS reject": t.rejected ? "x" : "",
      "Giải trình dữ liệu (tự động)": needExp ? autoExplain(t) : "",
      "Phân loại khách quan": needExp ? expOf(t.id).c : "",
      "Giải trình chi tiết (CSE)": needExp ? expOf(t.id).t : "",
    };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(daily), "TheoNgay");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), "ChiTiet");
  const ds = list.map((t) => dayKey(t.createT)).sort();
  const suffix = ds[0] === ds[ds.length - 1] ? ds[0] : ds[0] + "_den_" + ds[ds.length - 1];
  XLSX.writeFile(wb, "baocao_ticket_" + suffix + ".xlsx");
}

// --- Báo cáo QC-04 (tuần/tháng): 1 workbook gộp AI QC + SLA + overdue + vật tư để gửi quản lý/VG ---
function exportQC04(f) {
  const T = [...tickets.values()].filter((t) => tickInFilter(t, f));
  if (!T.length) { alert("Không có ticket trong kỳ lọc để xuất báo cáo QC."); return; }
  const wb = XLSX.utils.book_new();
  const period = (f.from ? dayKey(f.from) : dayKey(new Date(Math.min(...T.map((t) => +t.createT))))) + " → " + (f.to ? dayKey(f.to) : dayKey(dataMax || new Date()));
  const CLS = ["3h", "4h", "7h", "12h", "48h"];
  const slaRows = CLS.map((c) => {
    const g = T.filter((t) => t.slaClass === c);
    const done = g.filter((t) => t.zone !== "pending");
    const on = done.filter((t) => effZone(t) === "ontime").length, od = done.filter((t) => effZone(t) === "overdue").length;
    return { "Nhóm SLA": c, "Tổng": g.length, "Đã có KQ": done.length, "Đạt": on, "Quá hạn": od, "Chưa sol": g.length - done.length, "%Đạt": done.length ? Math.round(1000 * on / done.length) / 10 : "", "%QH": done.length ? Math.round(1000 * od / done.length) / 10 : "" };
  }).filter((r) => r["Tổng"]);
  const totDone = T.filter((t) => t.zone !== "pending");
  const totOn = totDone.filter((t) => effZone(t) === "ontime").length, totOd = totDone.filter((t) => effZone(t) === "overdue").length;
  const Q = qcRows.size ? [...qcRows.values()].filter((q) => qcInFilter(q, f)) : [];
  const nValid = Q.filter((q) => q.kl === "valid").length, nWarn = Q.filter((q) => q.kl === "warning").length, nInv = Q.filter((q) => q.kl === "invalid").length;
  const aiFail = partsAudit(f).filter((l) => l.aiState === "fail");
  const needExp = T.filter(needExplain);
  const exemptN = T.filter((t) => t.zone === "overdue" && hasExp(t.id)).length;
  const pctT = (a, b) => b ? Math.round(1000 * a / b) / 10 : 0;
  // 1) Tổng quan
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { "Chỉ số": "Kỳ báo cáo", "Giá trị": period },
    { "Chỉ số": "Tổng ticket", "Giá trị": T.length },
    { "Chỉ số": "Đã có kết quả SLA", "Giá trị": totDone.length },
    { "Chỉ số": "Đạt SLA (sau miễn trừ)", "Giá trị": totOn + " (" + pctT(totOn, totDone.length) + "%)" },
    { "Chỉ số": "Quá hạn (sau miễn trừ)", "Giá trị": totOd + " (" + pctT(totOd, totDone.length) + "%)" },
    { "Chỉ số": "Cần giải trình (overdue/reject/Open→VOMS vượt giờ SLA)", "Giá trị": needExp.length },
    { "Chỉ số": "Trong đó đã giải trình miễn trừ", "Giá trị": exemptN },
    { "Chỉ số": "Tái phát ≤30 ngày", "Giá trị": T.filter((t) => t.repeat30).length },
    { "Chỉ số": "——— AI QC ———", "Giá trị": "" },
    { "Chỉ số": "Ticket đã QC (trong kỳ)", "Giá trị": Q.length },
    { "Chỉ số": "PASS / Valid", "Giá trị": nValid + (Q.length ? " (" + Math.round(100 * nValid / Q.length) + "%)" : "") },
    { "Chỉ số": "Warning", "Giá trị": nWarn },
    { "Chỉ số": "Invalid / Reopen", "Giá trị": nInv },
    { "Chỉ số": "Vật tư AI đối chiếu KHÔNG khớp", "Giá trị": aiFail.length },
  ]), "TongQuan");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(slaRows), "SLA_TheoNhom");
  // 2) AI QC theo người + kịch bản
  if (Q.length) {
    const per = {};
    for (const q of Q) { const p = qcProc(q) || "(không khớp export)"; const v = per[p] = per[p] || { n: 0, valid: 0, warning: 0, invalid: 0 }; v.n++; if (v[q.kl] !== undefined) v[q.kl]++; }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(per).sort((a, b) => b[1].n - a[1].n).map(([p, v]) => ({ "Người": p, "Đã QC": v.n, "Valid": v.valid, "Warning": v.warning, "Invalid": v.invalid, "%Đạt": v.n ? Math.round(100 * v.valid / v.n) : "" }))), "AI_QC_Nguoi");
    const kb = {};
    for (const q of Q) { const k = (q.checklist || "(không ghi)").replace(/\s+/g, " ").trim().slice(0, 60) || "(không ghi)"; const v = kb[k] = kb[k] || { n: 0, bad: 0 }; v.n++; if (q.kl !== "valid") v.bad++; }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(kb).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => ({ "Kịch bản (AI chọn)": k, "Số ticket": v.n, "Bị bắt lỗi": v.bad, "%Bị bắt": v.n ? Math.round(100 * v.bad / v.n) : "" }))), "AI_QC_KichBan");
  }
  // 3) Overdue/reject case-by-case kèm giải trình
  if (needExp.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(needExp.sort((a, b) => a.createT - b.createT).map((t) => ({
      "Ticket": t.name || t.id, "Trạm": t.station, "Nhóm SLA": t.slaClass, "Mã lỗi": t.err,
      "Tạo lúc": dayKey(t.createT) + " " + pad(t.createT.getHours()) + ":" + pad(t.createT.getMinutes()),
      "Giờ xử lý": t.refSol ? Math.round((t.refSol.t - t.createT) / 360000) / 10 : "CHƯA XỬ LÝ", "Hạn (h)": t.limitH,
      "Người": t.proc || "", "Khu": t.proc ? grpOf(t.proc) : "", "Trạng thái": t.status,
      "Cần giải trình vì": [t.zone === "overdue" ? "Quá hạn" : "", t.rejected ? "VOMS reject" : "", isOverVoms(t) ? "Open→VOMS>" + t.limitH + "h" : ""].filter(Boolean).join(" · "),
      "Kết quả": isExempt(t) ? "Miễn trừ" : t.zone === "overdue" ? "Quá hạn" : t.zone === "pending" ? "Chưa có sol" : "Đạt",
      "Phân loại": expOf(t.id).c, "Giải trình": expOf(t.id).t,
    }))), "Overdue_GiaiTrinh");
  }
  // 4) Vật tư không khớp
  if (aiFail.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(aiFail.map((l) => ({ "Ticket": l.tname, "Trạm": l.station, "Vật tư": l.matList, "Broken": l.broken, "Good": l.good, "Người": l.proc, "Ghi chú AI": l.aiNote || "vật tư không khớp ảnh" }))), "VatTu_KhongKhop");
  }
  XLSX.writeFile(wb, "baocao_QC_" + (f.from ? dayKey(f.from) : "all") + (f.to ? "_den_" + dayKey(f.to) : "") + ".xlsx");
}

// --- Dự báo vật tư (ngoại suy tần suất tiêu hao) + danh sách trụ cần bảo trì phòng ngừa ---
function renderForecast(f) {
  const recs = partRecsInFilter(f).filter((r) => r.type === "good"); // vật tư xuất dùng (good)
  const from = f.from || (tickets.size ? new Date(Math.min(...[...tickets.values()].map((t) => +t.createT))) : new Date());
  const to = f.to || dataMax || new Date();
  const weeks = Math.max(1, (to - from) / (7 * 864e5));
  const byMat = {};
  for (const r of recs) { const k = (r.name || r.code || "(không rõ)").slice(0, 40); const v = byMat[k] = byMat[k] || { qty: 0, code: r.code }; v.qty += r.qty; }
  const rows = Object.entries(byMat).map(([k, v]) => ({ mat: k, code: v.code, used: v.qty, rate: v.qty / weeks })).sort((a, b) => b.used - a.used).slice(0, 20);
  $("parts_forecast").innerHTML = rows.length
    ? "<thead><tr><th style=\"text-align:left\">Vật tư</th><th>Đã dùng (kỳ)</th><th>Tốc độ/tuần</th><th>Dự báo 4 tuần tới</th></tr></thead><tbody>" +
      rows.map((r) => `<tr><td style="text-align:left" title="${r.code}">${r.mat}</td><td>${r.used.toLocaleString("vi")}</td><td>${(Math.round(r.rate * 10) / 10).toLocaleString("vi")}</td><td><b>${Math.ceil(r.rate * 4).toLocaleString("vi")}</b></td></tr>`).join("") + "</tbody>"
    : '<tbody><tr><td style="color:var(--muted)">Không có vật tư xuất dùng (good) trong kỳ lọc</td></tr></tbody>';
  // trụ cần bảo trì phòng ngừa: cùng trụ (S/N) + mã lỗi tái phát ≤30 ngày, nhiều lần nhất
  const T = [...tickets.values()].filter((t) => tickInFilter(t, f) && t.repeat30);
  const byU = {};
  for (const t of T) { const k = t.station + "|" + t.cpid + "|" + t.err; const v = byU[k] = byU[k] || { station: t.station, cpid: t.cpid, err: t.err, n7: 0, n30: 0, last: t.createT }; v.n30++; if (t.repeat7) v.n7++; if (t.createT > v.last) v.last = t.createT; }
  const prev = Object.values(byU).sort((a, b) => b.n30 - a.n30 || b.last - a.last).slice(0, 15);
  $("preventive").innerHTML = prev.length
    ? "<thead><tr><th>Trạm</th><th>S/N trụ</th><th>Mã lỗi</th><th>Tái phát ≤30ng</th><th>≤7ng</th><th>Lần cuối</th></tr></thead><tbody>" +
      prev.map((r) => `<tr><td>${r.station || "—"}</td><td style="font-size:11.5px">${r.cpid || "—"}</td><td title="${(errNames[r.err] || "").replace(/"/g, "'")}">${r.err}</td><td class="${r.n30 >= 3 ? "warn" : ""}"><b>${r.n30}</b></td><td>${r.n7 || ""}</td><td>${dayKey(r.last).slice(5)}</td></tr>`).join("") + "</tbody>"
    : '<tbody><tr><td style="color:var(--green)">Không có trụ tái phát trong kỳ lọc ✓</td></tr></tbody>';
}

// --- đối soát vật tư kho: lệch good/broken chấp nhận được (2 dòng nhập khác nhau) — vi phạm = AI QC không khớp ảnh ---
function partRecsInFilter(f) {
  return [...partRecs.values()].filter((r) => {
    const t = tickets.get(r.tid);
    const when = r.t || (t && t.createT);
    if (f.from && when && when < f.from) return false;
    if (f.to && when && when > f.to) return false;
    return true;
  });
}
function partsAudit(f) {
  const recs = partRecsInFilter(f);
  // đối soát theo TỔNG SL mỗi ticket (thay vật tư hỏng bằng mã khác vẫn hợp lệ → "khác mã" chỉ là ghi chú, không phải vi phạm)
  const byTicket = {};
  for (const r of recs) {
    const v = (byTicket[r.tid] = byTicket[r.tid] || { tid: r.tid, broken: 0, good: 0, cb: new Set(), cg: new Set(), mats: new Set(), proc: r.proc });
    if (r.type === "broken") { v.broken += r.qty; v.cb.add(r.code); }
    else { v.good += r.qty; v.cg.add(r.code); }
    v.mats.add((r.code + " " + r.name).slice(0, 34));
    if (r.proc) v.proc = r.proc;
  }
  const qcMap = qcConsistByTicket();
  return Object.values(byTicket).map((v) => {
    const t = tickets.get(v.tid);
    const qc = qcMap.get(v.tid) || null;
    // AI QC đồng nhất vật tư: valid/ok = khớp; giá trị khác (mismatch…) = AI phát hiện vật tư khai không khớp ảnh/sổ kho
    const aiState = qc ? (/^(valid|ok|pass)/.test(qc.consist) ? "ok" : "fail") : null;
    return {
      ...v, tname: t ? (t.name || v.tid) : v.tid, station: t ? t.station : "",
      mismatch: v.broken !== v.good,
      aiState, aiNote: qc ? (qc.note || qc.reason || "").replace(/\s+/g, " ").trim() : "",
      diffCodes: [...v.cb].sort().join() !== [...v.cg].sort().join(),
      matList: [...v.mats].slice(0, 3).join("; ") + (v.mats.size > 3 ? "…" : ""),
    };
  });
}
function renderParts(f) {
  const lines = partsAudit(f);
  renderPartsChart(f);
  if (!lines.length) { $("parts_sum").textContent = "Không có ticket thay vật tư trong kỳ lọc."; $("parts").innerHTML = ""; $("parts_person").innerHTML = ""; return; }
  const mmN = lines.filter((l) => l.mismatch).length;
  const aiFail = lines.filter((l) => l.aiState === "fail");
  const aiOk = lines.filter((l) => l.aiState === "ok").length;
  const diffC = lines.filter((l) => l.diffCodes && !l.mismatch).length;
  $("parts_sum").innerHTML = `<b>${lines.length}</b> ticket thay vật tư · AI QC đối chiếu vật tư: <b style="color:var(--green)">${aiOk} khớp</b> / <b style="color:${aiFail.length ? "var(--red)" : "var(--green)"}">${aiFail.length} không khớp</b> / ${lines.length - aiOk - aiFail.length} chưa QC · ${mmN} lệch tổng good/broken + ${diffC} thay khác mã (chấp nhận được, chỉ ghi nhận)`;
  // rollup người
  const per = {};
  for (const l of lines) {
    const p = l.proc || "(không rõ)";
    per[p] = per[p] || { n: 0, mm: 0, ai: 0 };
    per[p].n++;
    if (l.mismatch) per[p].mm++;
    if (l.aiState === "fail") per[p].ai++;
  }
  $("parts_person").innerHTML = "<thead><tr><th>Người</th><th>Ticket thay VT</th><th>Lệch tổng (ghi nhận)</th><th>AI: vật tư không khớp</th></tr></thead><tbody>" +
    Object.entries(per).sort((a, b) => b[1].ai - a[1].ai || b[1].n - a[1].n).map(([p, v]) =>
      `<tr><td>${p}</td><td>${v.n}</td><td style="color:var(--muted)">${v.mm || ""}</td><td class="${v.ai ? "bad" : ""}">${v.ai || ""}</td></tr>`).join("") + "</tbody>";
  // chi tiết vi phạm: CHỈ ticket AI phát hiện vật tư khai không khớp ảnh
  const viol = aiFail.slice(0, 60);
  $("parts").innerHTML = "<thead><tr><th>Ticket</th><th>Trạm</th><th>Vật tư</th><th>Broken</th><th>Good</th><th>Người</th><th>Ghi chú AI</th></tr></thead><tbody>" +
    (viol.length ? viol.map((l) => `<tr><td>${l.tname}</td><td>${l.station}</td><td style="text-align:left">${l.matList}</td><td>${l.broken}</td><td>${l.good}</td><td>${l.proc}</td>` +
      `<td class="bad" style="text-align:left" title="${(l.aiNote || "").replace(/"/g, "'").slice(0, 300)}">${(l.aiNote || "vật tư không khớp ảnh").slice(0, 80)}</td></tr>`).join("")
      : `<tr><td colspan="7" style="text-align:center;color:var(--green)">Không có vi phạm AI QC trong kỳ lọc ✓</td></tr>`) + "</tbody>";
}
// biểu đồ vật tư tiêu hao: SL xuất (good) và thu về (broken) theo mã vật tư, top theo SL xuất
function renderPartsChart(f) {
  const byMat = {};
  for (const r of partRecsInFilter(f)) {
    const k = (r.name || r.code || "(không rõ)").slice(0, 38);
    byMat[k] = byMat[k] || { good: 0, broken: 0 };
    if (r.type === "broken") byMat[k].broken += r.qty;
    else byMat[k].good += r.qty;
  }
  const top = Object.entries(byMat).sort((a, b) => b[1].good - a[1].good || b[1].broken - a[1].broken).slice(0, 12);
  mkChart("c_parts", {
    type: "bar",
    data: { labels: top.map(([k]) => k),
      datasets: [
        { label: "Xuất dùng (good)", data: top.map(([, v]) => v.good), backgroundColor: COL.blue + "cc" },
        { label: "Thu về (broken)", data: top.map(([, v]) => v.broken), backgroundColor: COL.amber + "cc" },
      ] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, title: { display: true, text: "SL trong kỳ lọc" } }, y: { ticks: { font: { size: 10.5 }, autoSkip: false } } } },
  });
}

// --- workload nhân sự: ticket quy đổi theo nhóm SLA so định mức trên NGÀY LÀM VIỆC (T2–T6) ---
// ticket 3h/4h phải bỏ việc chạy ngay + áp lực SLA → nặng hơn 48h; hệ số chỉnh được, 48h chuẩn = 1
function workDays(from, to) {
  let n = 0;
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= to; d.setDate(d.getDate() + 1)) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) n++;
  }
  return Math.max(1, n);
}
function wlWeights() {
  const w3 = +$("wl_w3").value || 2, w4 = +$("wl_w4").value || 1.5, w7 = +$("wl_w7").value || 1.2;
  return { "3h": w3, "4h": w4, "7h": w7, "12h": w7, "48h": 1 };
}
function renderWorkload(f) {
  const norm = +$("wl_norm").value || 5;
  const W = wlWeights();
  localStorage.setItem("ccts_dash_wl", JSON.stringify({ norm, w3: W["3h"], w4: W["4h"], w7: W["7h"] }));
  const from = f.from || (tickets.size ? new Date(Math.min(...[...tickets.values()].map((t) => +t.createT))) : new Date());
  const to = f.to || dataMax || new Date();
  const days = workDays(from, to);
  const target = Math.round(norm * days * 10) / 10;
  const CLS = ["3h", "4h", "7h", "12h", "48h"];
  const per = {}; // người -> đếm theo nhóm SLA
  for (const t of tickets.values()) {
    if (!tickInFilter(t, f) || !t.proc || t.zone === "pending") continue;
    if (grpOf(t.proc) === "Chưa phân khu") continue; // đồng bộ với bảng hiệu suất
    const v = (per[t.proc] = per[t.proc] || { "3h": 0, "4h": 0, "7h": 0, "12h": 0, "48h": 0 });
    v[t.slaClass] = (v[t.slaClass] || 0) + 1;
  }
  const load = (v) => CLS.reduce((s, c) => s + (v[c] || 0) * W[c], 0);
  const raw = (v) => CLS.reduce((s, c) => s + (v[c] || 0), 0);
  const rows = Object.entries(per).sort((a, b) => load(b[1]) - load(a[1]));
  $("wl_note").textContent = `kỳ lọc ${days} ngày làm việc (T2–T6) → định mức ${norm} × ${days} = ${target} quy đổi/người · quá tải khi vượt đường định mức · chỉ người đã phân khu`;
  const CCOL = { "3h": COL.red, "4h": COL.amber, "7h": COL.blue, "12h": COL.blue, "48h": COL.gray };
  mkChart("c_wl", {
    data: {
      labels: rows.map(([p]) => p),
      datasets: CLS.filter((c) => rows.some(([, v]) => v[c])).map((c) => ({
        type: "bar", label: `${c} ×${W[c]}`, stack: "w",
        data: rows.map(([, v]) => Math.round((v[c] || 0) * W[c] * 10) / 10),
        backgroundColor: CCOL[c] + (c === "48h" ? "99" : "cc"),
      })).concat([{ type: "line", label: `Định mức ${target}`, data: rows.map(() => target), borderColor: COL.navy, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 }]),
    },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      onClick: (e, els) => { // bấm cột 1 người → lọc toàn dashboard theo người đó (bấm lại để bỏ)
        if (!els.length || !rows[els[0].index]) return;
        const p = rows[els[0].index][0], sel = $("f_person");
        sel.value = sel.value === p ? "" : p;
        renderAll();
      },
      plugins: { tooltip: { callbacks: { footer: (items) => {
        const v = rows[items[0].dataIndex][1];
        const L = Math.round(load(v) * 10) / 10;
        return `Tổng: ${raw(v)} ticket = ${L} quy đổi · tải ${Math.round(100 * L / target)}% định mức (${Math.round(10 * L / days) / 10} quy đổi/ngày LV) · (bấm để lọc theo người này)`;
      } } } },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: "Ticket quy đổi trong kỳ" } } } },
  });
}

// --- quá hạn kẹt ở đâu (mapping trạng thái → nhóm giữ ticket, theo quy ước báo cáo tuần CCVN) ---
const RESOURCE_MAP = {
  "Appointment": "Tại ASP", "Open": "Tại ASP", "Pending for ASP close": "Tại ASP", "Close rejected": "Tại ASP",
  "Pending for local team close": "Tại CCVN (team mình)", "Pending for rework SOP": "Tại CCVN (team mình)", "Pending for RCA report": "Tại CCVN (team mình)",
  "Pending for spare parts": "Kẹt vật tư",
  "Pending for firmware": "Kẹt firmware",
  "Pending closure": "Tại VOMS", "Pending for others": "Tại VOMS", "Pending for VOMS confirm": "Tại VOMS", "Pending for client verification": "Tại VOMS",
};
function stuckStats(T) {
  const st = {};
  for (const t of T) {
    const s = t.status || "(không rõ)";
    st[s] = st[s] || { grp: RESOURCE_MAP[s] || "Khác", n: 0, on: 0, od: 0 };
    st[s].n++;
    if (effZone(t) === "overdue") st[s].od++;
    else if (effZone(t) === "ontime") st[s].on++;
  }
  return st;
}
function renderStuck(T) {
  const st = stuckStats(T);
  const grps = {};
  for (const [s, v] of Object.entries(st)) {
    grps[v.grp] = grps[v.grp] || { n: 0, on: 0, od: 0, rows: [] };
    grps[v.grp].n += v.n; grps[v.grp].on += v.on; grps[v.grp].od += v.od;
    grps[v.grp].rows.push([s, v]);
  }
  const totOD = Math.max(1, T.filter((t) => t.zone === "overdue").length);
  const pct = (od, n) => (n ? Math.round(1000 * od / n) / 10 : null);
  const cls = (v) => (v == null ? "" : v >= 30 ? "bad" : v >= 15 ? "warn" : "");
  let html = "<thead><tr><th>Nhóm giữ ticket / trạng thái</th><th>Tổng</th><th>Ontime</th><th>Overdue</th><th>%QH trong nhóm</th><th>%đóng góp vào tổng QH</th></tr></thead><tbody>";
  for (const [g, v] of Object.entries(grps).sort((a, b) => b[1].od - a[1].od)) {
    html += `<tr class="rollup"><td>${g}</td><td>${v.n}</td><td>${v.on}</td><td>${v.od}</td><td class="${cls(pct(v.od, v.n))}">${fmtPct(pct(v.od, v.n))}</td><td>${fmtPct(pct(v.od, totOD))}</td></tr>`;
    for (const [s, r] of v.rows.sort((a, b) => b[1].od - a[1].od)) {
      html += `<tr><td style="padding-left:22px;color:var(--muted)">${s}</td><td>${r.n}</td><td>${r.on}</td><td>${r.od || ""}</td><td class="${cls(pct(r.od, r.n))}">${fmtPct(pct(r.od, r.n))}</td><td>${r.od ? fmtPct(pct(r.od, totOD)) : ""}</td></tr>`;
    }
  }
  $("stuck").innerHTML = html + "</tbody>";
}

// --- panel AI QC ---
// ID của hệ AI QC (API CCTS) khác Ticket ID export → khớp theo ID trước, không được thì khớp nguyên văn solution
function qcProc(q) {
  const tk = tickets.get(q.id);
  if (tk && tk.proc) return tk.proc;
  const s = q.sol && solTextIndex.get(q.sol);
  return s ? s.proc : null;
}
// tìm Ticket ID của export tương ứng dòng QC (ID 2 hệ khác nhau → thử ID rồi khớp nguyên văn solution)
function qcTicketId(q) {
  if (tickets.has(q.id)) return q.id;
  const s = q.sol && solTextIndex.get(q.sol);
  return s ? s.tid : null;
}
// map Ticket ID export -> dòng QC có kết quả kiểm tra đồng nhất vật tư (cột "Kết quả" sheet Phase 1/ver 3)
function qcConsistByTicket() {
  const m = new Map();
  for (const q of qcRows.values()) {
    if (!q.consist) continue;
    const tid = qcTicketId(q);
    if (tid) m.set(tid, q);
  }
  return m;
}
function qcInFilter(q, f) {
  if (f.from && q.t < f.from) return false;
  if (f.to && q.t > f.to) return false;
  const proc = qcProc(q);
  if (f.person && proc !== f.person) return false;
  if (f.grp && (!proc || grpOf(proc) !== f.grp)) return false;
  return true;
}
function renderQC(f) {
  if (!qcRows.size) return;
  $("qc_body").style.display = "block";
  $("qc_empty").style.display = "none";
  const Q = [...qcRows.values()].filter((q) => qcInFilter(q, f));
  const n = Q.length;
  const nValid = Q.filter((q) => q.kl === "valid").length;
  const nWarn = Q.filter((q) => q.kl === "warning").length;
  const nInv = Q.filter((q) => q.kl === "invalid").length;
  const joined = Q.filter((q) => qcProc(q)).length;
  $("qc_kpis").innerHTML = [
    ["Ticket đã QC", n], ["Valid", nValid + (n ? " (" + Math.round(100 * nValid / n) + "%)" : "")],
    ["Cảnh báo", nWarn + (n ? " (" + Math.round(100 * nWarn / n) + "%)" : "")],
    ["Invalid", nInv], ["Khớp được người", joined + "/" + n],
  ].map(([t, v]) => `<div class="kpi"><div class="t">${t}</div><div class="v">${v}</div></div>`).join("");

  // theo người (join Ticket ID -> người xử lý từ export)
  const per = {};
  for (const q of Q) {
    const p = qcProc(q) || "(không khớp export)";
    per[p] = per[p] || { n: 0, valid: 0, warning: 0, invalid: 0 };
    per[p].n++;
    if (per[p][q.kl] !== undefined) per[p][q.kl]++;
  }
  $("qc_person").innerHTML = "<thead><tr><th>Người</th><th>Đã QC</th><th>Valid</th><th>Cảnh báo</th><th>Invalid</th><th>%đạt</th></tr></thead><tbody>" +
    Object.entries(per).sort((a, b) => b[1].n - a[1].n).map(([p, v]) =>
      `<tr><td>${p}</td><td>${v.n}</td><td>${v.valid}</td><td>${v.warning}</td><td class="${v.invalid ? "bad" : ""}">${v.invalid || ""}</td><td>${v.n ? Math.round(100 * v.valid / v.n) + "%" : "—"}</td></tr>`).join("") + "</tbody>";

  // kịch bản xử lý AI chọn, kèm tỉ lệ bị AI bắt lỗi
  const kb = {};
  for (const q of Q) {
    const k = (q.checklist || "(không ghi)").replace(/\s+/g, " ").trim().slice(0, 60) || "(không ghi)";
    kb[k] = kb[k] || { n: 0, bad: 0 };
    kb[k].n++;
    if (q.kl !== "valid") kb[k].bad++;
  }
  $("qc_items").innerHTML = "<thead><tr><th>Kịch bản xử lý (AI chọn)</th><th>Số ticket</th><th>Bị bắt lỗi</th><th>%bị bắt</th></tr></thead><tbody>" +
    Object.entries(kb).sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) =>
      `<tr><td style="text-align:left">${k}</td><td>${v.n}</td><td>${v.bad || ""}</td><td class="${v.n && v.bad / v.n >= .5 ? "bad" : v.bad / v.n >= .25 ? "warn" : ""}">${Math.round(100 * v.bad / v.n)}%</td></tr>`).join("") + "</tbody>";

  // danh sách cần xử lý
  const bad = Q.filter((q) => q.kl !== "valid").sort((a, b) => b.t - a.t).slice(0, 30);
  $("qc_list").innerHTML = "<thead><tr><th>Thời gian</th><th>Ticket ID</th><th>Model</th><th>Mã lỗi</th><th>Người</th><th>Kết luận</th><th>Diễn giải / lý do AI</th><th>AI phân tích (ảnh)</th></tr></thead><tbody>" +
    bad.map((q) => `<tr title="${(q.reason || "").replace(/"/g, "'").slice(0, 300)}"><td>${q.t ? dayKey(q.t) + " " + pad(q.t.getHours()) + ":" + pad(q.t.getMinutes()) : ""}</td><td>${q.id}</td><td>${q.model}</td><td>${q.errCode || "—"}</td><td>${qcProc(q) || "—"}</td><td class="${q.kl === "invalid" ? "bad" : "warn"}">${q.kl}</td><td style="text-align:left">${(q.reason || q.action).replace(/\s+/g, " ").slice(0, 70)}</td><td style="text-align:left" title="${(q.aiDesc || "").replace(/"/g, "'").slice(0, 400)}">${(q.photos ? q.photos + " ảnh — " : "") + (q.aiDesc || "").replace(/\s+/g, " ").slice(0, 60)}</td></tr>`).join("") + "</tbody>";
}

// --- Ticket cần ưu tiên hôm nay: chưa có giải pháp hoặc quá hạn (loại ca đã miễn trừ) ---
const NEXT_ACTION = {
  "Tại ASP": "Đốc ASP nhận & xử lý",
  "Tại CCVN (team mình)": "SE hoàn tất & đóng ticket",
  "Kẹt vật tư": "Cấp/theo dõi vật tư",
  "Kẹt firmware": "Xử lý firmware",
  "Tại VOMS": "Đốc VOMS confirm/đóng",
};
function nextAction(t) {
  const grp = RESOURCE_MAP[t.status];
  if (!t.refSol) { // chưa có giải pháp
    if (grp === "Kẹt vật tư") return "Cấp vật tư gấp";
    if (grp === "Kẹt firmware") return "Xử lý firmware gấp";
    if (grp === "Tại ASP") return "Đốc ASP xử lý ngay";
    if (grp === "Tại VOMS") return "Đẩy lại team xử lý";
    return "SE xử lý ngay (chưa có giải pháp)";
  }
  return NEXT_ACTION[grp] || "Rà soát & đóng ticket";
}
const ageH = (t) => (Date.now() - t.createT) / HOURS;
const remH = (t) => t.limitH - ageH(t); // giờ còn lại đến hạn SLA (âm = đã quá hạn)
const fmtAge = (h) => (h < 48 ? (Math.round(h * 10) / 10).toLocaleString("vi") + "h" : Math.round(h / 24) + " ngày");
// ticket cần ưu tiên = đang mở thực sự, chưa xử lý xong (user chốt 10/07): Open / chờ vật tư / hẹn lịch.
// KHÔNG lấy Pending for local team close / Pending closure / VOMS confirm — các trạng thái này ĐÃ CÓ solution, chỉ chờ đóng.
const PRIORITY_STATUSES = ["Open", "Pending for spare parts", "Appointment"];
function renderPriority(f) {
  const list = [...tickets.values()].filter((t) => tickInFilter(t, f) && PRIORITY_STATUSES.includes(t.status));
  list.sort((a, b) => remH(a) - remH(b)); // gần hết hạn / đã quá hạn nhiều nhất xếp trước (theo deadline thực)
  const cnt = (s) => list.filter((t) => t.status === s).length;
  const nrej = list.filter((t) => t.rejected).length;
  $("pri_sum").innerHTML = list.length
    ? `Cần ưu tiên: <b>${list.length}</b> ticket · <b style="color:var(--red)">Open ${cnt("Open")}</b> · Chờ vật tư ${cnt("Pending for spare parts")} · Appointment ${cnt("Appointment")}` +
      (nrej ? ` · <b style="color:var(--red)">↩ bị reject ${nrej}</b> <span class="note">(tuổi cao do mở lại)</span>` : "")
    : '<span class="note">Không có ticket đang mở (Open / chờ vật tư / hẹn lịch) trong kỳ lọc ✓</span>';
  const cap = 200;
  $("priority").innerHTML = "<thead><tr><th>Ticket ID</th><th>Tuổi ticket</th><th title=\"Thời gian còn lại đến hạn SLA (âm = đã quá hạn) — dùng để quyết định gọi ai trước\">Còn lại / hết hạn</th><th title=\"Nguy cơ vỡ SLA = tỉ lệ quá hạn LỊCH SỬ (0 token) của các ticket cùng nhóm SLA / mã lỗi / nơi giữ / trụ tái phát. Công cụ hỗ trợ, không phải chắc chắn. Rê chuột xem chi tiết.\">Nguy cơ vỡ SLA</th><th>SLA</th><th>Trạng thái hiện tại</th><th>Station Code</th><th>Model</th><th>Mã lỗi</th><th>Người xử lý gần nhất</th><th style=\"text-align:left\">Next action đề xuất</th></tr></thead><tbody>" +
    list.slice(0, cap).map((t) => {
      const h = ageH(t), rem = remH(t);
      const pill = t.limitH <= 3 ? "p3" : t.limitH <= 4 ? "p4" : t.limitH <= 12 ? "p7" : "p48";
      const remCell = rem < 0 ? `<td class="bad">quá ${fmtAge(-rem)}</td>` : `<td class="${rem < 1 ? "bad" : rem < 3 ? "warn" : ""}">còn ${fmtAge(rem)}</td>`;
      // badge reject: giải thích tại sao tuổi ticket cao (ticket bị mở lại) — note/phân loại làm ở card giải trình bên dưới
      const rejBadge = t.rejected ? ' <span class="pill" style="background:#fde2e0;color:var(--red)" title="Bị VOMS reject → ticket được mở lại; tuổi tính từ lúc tạo gốc nên cao. Giải trình/phân loại ở card giải trình bên dưới.">↩ reject</span>' : "";
      const risk = riskScore(t);
      const riskCell = risk == null ? "<td>—</td>" : `<td class="${risk >= 0.4 ? "bad" : risk >= 0.2 ? "warn" : ""}" title="${riskTip(t).replace(/"/g, "'")}">${Math.round(risk * 100)}%</td>`;
      return `<tr>` +
        `<td title="${t.devType}/${t.devModel} · S/N: ${t.cpid || "—"}">${t.name || t.id}${rejBadge}</td>` +
        `<td class="${h > t.limitH ? "bad" : ""}"${t.rejected ? ' title="Tuổi cao do ticket bị reject mở lại — xem badge ↩ reject"' : ""}>${fmtAge(h)}</td>` +
        remCell +
        riskCell +
        `<td><span class="pill ${pill}">${t.slaClass}</span></td>` +
        `<td>${t.status || "—"}</td><td>${t.station || "—"}</td><td>${t.devModel || t.devType || "—"}</td>` +
        `<td title="${(errNames[t.err] || "").replace(/"/g, "'")}">${t.err}</td>` +
        `<td>${t.proc || '<span style="color:var(--red)">chưa có người</span>'}</td>` +
        `<td style="text-align:left">${t.refSol ? "" : '<b style="color:var(--red)">'}${nextAction(t)}${t.refSol ? "" : "</b>"}</td></tr>`;
    }).join("") +
    (list.length > cap ? `<tr><td colspan="11" style="text-align:left;color:var(--muted)">… còn ${list.length - cap} ticket nữa — thu hẹp khoảng lọc để xem hết</td></tr>` : "") +
    "</tbody>";
}

// --- KPI + delta so kỳ liền trước cùng độ dài ---
function kpiCalc(T, S) {
  const c = { n: T.length, sol: S.length, rep30: T.filter((t) => t.repeat30).length, pend: T.filter((t) => t.zone === "pending").length };
  for (const cls of ["3h", "4h", "7h", "12h", "48h"]) {
    const g = T.filter((t) => t.slaClass === cls && t.zone !== "pending");
    c[cls] = g.length ? 100 * g.filter((t) => effZone(t) === "ontime").length / g.length : null;
    c[cls + "_n"] = g.length;
  }
  return c;
}
function renderKPIs(f, T, S) {
  let prev = null;
  if (f.from && f.to) {
    const len = f.to - f.from;
    const pf = { ...f, from: new Date(f.from - len - 1), to: new Date(f.from - 1) };
    const pT = [...tickets.values()].filter((t) => tickInFilter(t, pf));
    const pS = [...solutions.values()].filter((s) => solInFilter(s, pf) && tickets.has(s.tid));
    prev = kpiCalc(pT, pS);
  }
  const c = kpiCalc(T, S);
  const delta = (cur, pre, unit, goodWhenUp) => {
    if (prev == null || prev.n === 0 || pre == null || cur == null) return "";
    const d = cur - pre;
    if (Math.abs(d) < 0.05) return '<span class="flat">— không đổi</span>';
    const good = goodWhenUp ? d > 0 : d < 0;
    return `<span class="${good ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(Math.round(d * 10) / 10).toLocaleString("vi")}${unit} so kỳ trước</span>`;
  };
  // ngưỡng màu theo target HNO: quá hạn <3% (ontime ≥97) đạt cam kết, 3–6% cần để mắt, >6% phải can thiệp
  const slaCls = (v, nn) => (v == null || !nn ? "" : v >= 100 - OD_TARGET ? "k-good" : v >= 100 - 2 * OD_TARGET ? "k-warn" : "k-bad");
  const slaCell = (cls) => (c[cls + "_n"] === 0 ? null : // nhóm không có ticket trong kỳ thì ẩn ô
    ["%Ontime " + cls, fmtPct(c[cls]) + ` <span style="font-size:11px;color:var(--muted)">(${c[cls + "_n"]})</span>`, delta(c[cls], prev && prev[cls], " điểm", true), slaCls(c[cls], c[cls + "_n"])]);
  const cells = [
    ["Ticket tạo", c.n.toLocaleString("vi"), delta(c.n, prev && prev.n, "", false), ""],
    slaCell("3h"), slaCell("4h"), slaCell("7h"), slaCell("12h"), slaCell("48h"),
    ["Solution", c.sol.toLocaleString("vi"), delta(c.sol, prev && prev.sol, "", true), ""],
    ["Tái phát ≤30ng", c.rep30.toLocaleString("vi"), delta(c.rep30, prev && prev.rep30, "", false), ""],
    ["Chưa có solution", c.pend.toLocaleString("vi"), "", ""],
  ].filter(Boolean);
  $("kpis").innerHTML = cells.map(([t, v, d, cls]) => `<div class="kpi ${cls}"><div class="t">${t}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
}

// --- bảng hiệu suất người/khu ---
function periodStats(rows, ref) {
  // rows: {sols:[Date], ticks:[ticket]} — trả về số liệu ngày/7ng/tháng(MTD)/lũy kế + %OD
  const day0 = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const d7 = new Date(day0 - 6 * 864e5);
  const m0 = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const inD = (d) => d >= day0, in7 = (d) => d >= d7, inM = (d) => d >= m0;
  const od = (list) => {
    const done = list.filter((t) => t.zone !== "pending");
    return done.length ? 100 * done.filter((t) => effZone(t) === "overdue").length / done.length : null;
  };
  return {
    sD: rows.sols.filter(inD).length, s7: rows.sols.filter(in7).length,
    sM: rows.sols.filter(inM).length, sAll: rows.sols.length,
    nT: rows.ticks.length,
    oD: od(rows.ticks.filter((t) => inD(t.createT))),
    o7: od(rows.ticks.filter((t) => in7(t.createT))),
    oM: od(rows.ticks.filter((t) => inM(t.createT))),
    r7: rows.ticks.filter((t) => t.repeatOf && (t.repeatOf.proc) && t.repeat7).length,
    r30: rows.ticks.filter((t) => t.repeatOf && (t.repeatOf.proc) && t.repeat30).length,
  };
}
let perfSort = { col: "sAll", dir: -1 };
function renderPerf(f) {
  const level = $("f_level").value;
  const ref = $("f_to").value ? new Date($("f_to").value + "T23:59:59") : new Date();
  $("perf_note").textContent = "Sol = solution đã gửi · %QH = tỉ lệ quá hạn ticket người đó xử lý (đã trừ ticket có giải trình khách quan) · ngày tham chiếu " + fmtD(ref) + " · TP = bị tái phát (quy cho người xử lý trước) · người chưa phân khu ẨN khỏi bảng (phân khu ở nút ⚙, xem lại bằng lọc Khu = Chưa phân khu)";
  // gom theo người: solutions theo ngày gửi; ticket quy theo người xử lý; tái phát quy cho người trước
  const per = {};
  const mk = (k) => (per[k] = per[k] || { sols: [], ticks: [], reps7: 0, reps30: 0 });
  for (const s of solutions.values()) {
    if (!tickets.has(s.tid)) continue;
    if (f.from && s.t < f.from) continue;
    if (f.to && s.t > f.to) continue;
    if (f.dev && !devMatch(tickets.get(s.tid), f.dev)) continue;
    mk(s.proc).sols.push(s.t);
  }
  for (const t of tickets.values()) {
    if (!tickInFilter(t, { ...f, person: "", grp: "" })) continue;
    if (t.proc) mk(t.proc).ticks.push(t);
    if (t.repeatOf && t.repeatOf.proc) {
      const r = mk(t.repeatOf.proc);
      if (t.repeat30) r.reps30++;
      if (t.repeat7) r.reps7++;
    }
  }
  let rows = Object.entries(per).map(([p, v]) => {
    const st = periodStats(v, ref);
    st.name = p; st.grp = grpOf(p); st.r7 = v.reps7; st.r30 = v.reps30;
    return st;
  });
  if (f.person) rows = rows.filter((r) => r.name === f.person);
  if (f.grp) rows = rows.filter((r) => r.grp === f.grp);
  // chỉ hiện người đã phân khu (map thêm ở nút ⚙) — trừ khi chủ động lọc Khu = "Chưa phân khu" để soi
  if (f.grp !== "Chưa phân khu") rows = rows.filter((r) => r.grp !== "Chưa phân khu");

  if (level === "group") {
    const g = {};
    for (const r of rows) {
      const k = r.grp;
      g[k] = g[k] || { name: k, grp: "", sD: 0, s7: 0, sM: 0, sAll: 0, nT: 0, _odM: [0, 0], _od7: [0, 0], _odD: [0, 0], r7: 0, r30: 0 };
      for (const c of ["sD", "s7", "sM", "sAll", "nT", "r7", "r30"]) g[k][c] += r[c];
    }
    // %OD của khu tính lại từ ticket
    for (const t of tickets.values()) {
      if (!tickInFilter(t, { ...f, person: "", grp: "" }) || !t.proc || t.zone === "pending") continue;
      const k = grpOf(t.proc); if (!g[k]) continue;
      const ref0 = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
      const pairs = [["_odD", ref0], ["_od7", new Date(ref0 - 6 * 864e5)], ["_odM", new Date(ref.getFullYear(), ref.getMonth(), 1)]];
      for (const [kk, d0] of pairs) if (t.createT >= d0) { g[k][kk][1]++; if (effZone(t) === "overdue") g[k][kk][0]++; }
    }
    rows = Object.values(g).map((r) => ({ ...r, oD: r._odD[1] ? 100 * r._odD[0] / r._odD[1] : null, o7: r._od7[1] ? 100 * r._od7[0] / r._od7[1] : null, oM: r._odM[1] ? 100 * r._odM[0] / r._odM[1] : null }));
  }

  rows.sort((a, b) => ((a[perfSort.col] ?? -1) - (b[perfSort.col] ?? -1)) * perfSort.dir || a.name.localeCompare(b.name));

  const cols = [["name", level === "group" ? "Khu" : "Người"], ["grp", "Khu"], ["sD", "Sol hôm nay"], ["s7", "Sol 7 ngày"], ["sM", "Sol tháng"], ["sAll", "Sol lũy kế*"], ["nT", "Ticket xử lý"], ["oD", "%QH ngày"], ["o7", "%QH 7ng"], ["oM", "%QH tháng"], ["r7", "TP ≤7ng"], ["r30", "TP ≤30ng"]];
  const usedCols = level === "group" ? cols.filter((c) => c[0] !== "grp") : cols;
  const odClass = (v) => (v == null ? "" : v >= OD_RED ? "bad" : v >= OD_WARN ? "warn" : "");
  const maxSol = Math.max(1, ...rows.map((r) => r.sAll || 0));
  let html = "<thead><tr>" + usedCols.map(([k, t]) => `<th data-k="${k}">${t}${perfSort.col === k ? (perfSort.dir < 0 ? " ▼" : " ▲") : ""}</th>`).join("") + "</tr></thead><tbody>";
  const tot = { sD: 0, s7: 0, sM: 0, sAll: 0, nT: 0, r7: 0, r30: 0 };
  for (const r of rows) {
    for (const k in tot) tot[k] += r[k] || 0;
    html += "<tr>" + usedCols.map(([k]) => {
      if (k === "name") return `<td>${r.name}</td>`;
      if (k === "grp") return `<td>${r.grp}</td>`;
      if (k === "sAll") { // data bar: liếc là thấy ai gánh nhiều/ít việc
        const w = Math.round(100 * (r.sAll || 0) / maxSol);
        return `<td style="background:linear-gradient(90deg,rgba(46,109,164,.22) ${w}%,transparent ${w}%)">${(r.sAll || 0).toLocaleString("vi")}</td>`;
      }
      if (k === "oM") { // data bar đỏ, thang 0–30% quá hạn
        const w = r.oM == null ? 0 : Math.min(100, Math.round(r.oM * 100 / 30));
        return `<td class="${odClass(r.oM)}" style="background:linear-gradient(90deg,rgba(192,57,43,.25) ${w}%,transparent ${w}%)">${fmtPct(r.oM)}</td>`;
      }
      if (k[0] === "o") return `<td class="${odClass(r[k])}">${fmtPct(r[k])}</td>`;
      return `<td>${(r[k] || 0).toLocaleString("vi")}</td>`;
    }).join("") + "</tr>";
  }
  html += `<tr class="total"><td>TỔNG${level === "group" ? "" : "</td><td>"}</td><td>${tot.sD}</td><td>${tot.s7}</td><td>${tot.sM}</td><td>${tot.sAll}</td><td>${tot.nT}</td><td></td><td></td><td></td><td>${tot.r7}</td><td>${tot.r30}</td></tr>`;
  html += "</tbody>";
  $("perf").innerHTML = html;
  $("perf").querySelectorAll("th").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      perfSort = { col: k, dir: perfSort.col === k ? -perfSort.dir : -1 };
      renderPerf(currentFilter());
    })
  );
}

// --- charts ---
function mkChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), cfg);
}
// Ticket tạo mới + %QH theo ngày. Ticket 48h chỉ CHỐT quá hạn sau 48h kể từ lúc tạo →
// bucket còn ticket "pending" (chưa hết hạn, chưa có KQ) vẽ NÉT ĐỨT + điểm rỗng = "%QH tạm tính, chưa chốt".
function renderODday(f, T) {
  const gran = $("f_gran").value, bk = bucketKey[gran];
  const buckets = {};
  const ensure = (k) => (buckets[k] = buckets[k] || { n: 0, od: 0, done: 0, pend: 0 });
  for (const t of T) {
    const b = ensure(bk(t.createT));
    b.n++;
    if (t.zone !== "pending") { b.done++; if (effZone(t) === "overdue") b.od++; }
    else b.pend++;
  }
  const keys = Object.keys(buckets).sort();
  const prov = (k) => buckets[k].pend > 0; // còn ticket trong hạn → số chưa chốt
  mkChart("c_odday", {
    data: {
      labels: keys,
      datasets: [
        { type: "bar", label: "Ticket tạo mới", data: keys.map((k) => buckets[k].n), backgroundColor: COL.blue + "88", yAxisID: "y" },
        { type: "line", label: "%Quá hạn", data: keys.map((k) => (buckets[k].done ? Math.round(1000 * buckets[k].od / buckets[k].done) / 10 : null)),
          borderColor: COL.red, backgroundColor: COL.red, yAxisID: "y2", tension: .25,
          pointRadius: keys.map((k) => (prov(k) ? 4 : 2)),
          pointStyle: keys.map((k) => (prov(k) ? "rectRot" : "circle")),
          pointBackgroundColor: keys.map((k) => (prov(k) ? "#fff" : COL.red)),
          segment: { borderDash: (c) => (prov(keys[c.p1DataIndex]) ? [5, 4] : undefined) } },
        { type: "line", label: "Target " + OD_TARGET + "%", data: keys.map(() => OD_TARGET), borderColor: COL.gray, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, yAxisID: "y2" },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { footer: (items) => {
          const b = buckets[items[0].label];
          return b && b.pend ? `⏳ chưa chốt: ${b.pend} ticket còn trong hạn (48h sau khi tạo mới biết QH)` : "";
        } } } },
      scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } },
        y2: { position: "right", beginAtZero: true, max: 100, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } } } },
  });
}
// %Ontime theo nhóm SLA (cột user chốt 10/07: 3h · 4h/7h gộp làm 1 · 48h) + số ticket tạo trục phải
const SLAON_GROUPS = [["3h", ["3h"]], ["4h/7h", ["4h", "7h", "12h"]], ["48h", ["48h"]]];
function renderSLAon(T) {
  const rows = SLAON_GROUPS.map(([lbl, cls]) => {
    const g = T.filter((t) => cls.includes(t.slaClass));
    const done = g.filter((t) => t.zone !== "pending");
    const on = done.filter((t) => effZone(t) === "ontime").length;
    return { lbl, n: g.length, done: done.length, on, pct: done.length ? Math.round(1000 * on / done.length) / 10 : null };
  });
  const colOf = (r) => (r.pct == null ? COL.gray : r.pct >= 100 - OD_TARGET ? COL.green : r.pct >= 100 - 2 * OD_TARGET ? COL.amber : COL.red);
  mkChart("c_slaon", {
    data: {
      labels: rows.map((r) => `${r.lbl} (${r.n.toLocaleString("vi")})`),
      datasets: [
        { type: "bar", label: "%Ontime (sau miễn trừ)", data: rows.map((r) => r.pct), backgroundColor: rows.map(colOf), yAxisID: "y" },
        { type: "bar", label: "Ticket tạo", data: rows.map((r) => r.n), backgroundColor: COL.navy + "44", yAxisID: "y2" },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { footer: (it) => { const r = rows[it[0].dataIndex]; return `ontime ${r.on}/${r.done} đã có KQ · quá hạn ${r.done - r.on}`; } } } },
      scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: "%Ontime" }, ticks: { font: { size: 10 } } },
        y2: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: "Ticket" }, ticks: { font: { size: 10 } } },
        x: { ticks: { font: { size: 11 } } } } },
  });
}
// quá hạn đang kẹt ở đâu — bar ngang theo nhóm giữ ticket (bảng chi tiết theo trạng thái vẫn ở card thu gọn)
function renderStuckChart(T) {
  const st = stuckStats(T);
  const grps = {};
  for (const v of Object.values(st)) { const g = (grps[v.grp] = grps[v.grp] || { n: 0, od: 0 }); g.n += v.n; g.od += v.od; }
  const rows = Object.entries(grps).filter(([, v]) => v.od).sort((a, b) => b[1].od - a[1].od);
  mkChart("c_stuck", {
    type: "bar",
    data: { labels: rows.map(([g]) => g), datasets: [{ label: "Ticket quá hạn đang giữ", data: rows.map(([, v]) => v.od), backgroundColor: COL.red + "cc" }] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { footer: (it) => { const v = rows[it[0].dataIndex][1]; return `%QH trong nhóm: ${v.n ? Math.round(1000 * v.od / v.n) / 10 : 0}% (tổng ${v.n} ticket)`; } } } },
      scales: { x: { beginAtZero: true, ticks: { font: { size: 10 } } }, y: { ticks: { font: { size: 11 } } } } },
  });
}
// SLA Matrix: 1 bảng gộp %Đạt/%QH theo nhóm dịch vụ + FTF/Reject (thay 2 biểu đồ rời rạc cũ)
const SLA_PILL = { "3h": "p3", "4h": "p4", "7h": "p7", "12h": "p7", "48h": "p48" };
function renderSLA(T) {
  const rows = ["3h", "4h", "7h", "12h", "48h"].map((c) => {
    const g = T.filter((t) => t.slaClass === c);
    const done = g.filter((t) => t.zone !== "pending");
    return {
      c, n: g.length, doneN: done.length,
      on: done.filter((t) => effZone(t) === "ontime").length, // ontime đã gồm miễn trừ (isExempt → effZone ontime)
      od: done.filter((t) => effZone(t) === "overdue").length,
      pend: g.length - done.length,
      solved: g.filter((t) => t.solCount).length,
      ftf: g.filter((t) => t.ftf).length,
      rej: g.filter((t) => t.rejected).length,
    };
  }).filter((r) => r.n);
  const clsOd = (p) => (p == null ? "" : p >= OD_RED ? "bad" : p >= OD_WARN ? "warn" : "");
  const line = (r, total) => {
    const okPct = r.doneN ? Math.round(1000 * r.on / r.doneN) / 10 : null;
    const odPct = r.doneN ? Math.round(1000 * r.od / r.doneN) / 10 : null;
    const ftfPct = r.solved ? Math.round(1000 * r.ftf / r.solved) / 10 : null;
    return `<tr${total ? ' class="total"' : ""}>` +
      `<td>${total ? "TỔNG" : `<span class="pill ${SLA_PILL[r.c]}">${r.c}</span>`}</td>` +
      `<td>${r.n.toLocaleString("vi")}</td><td>${r.doneN}</td>` +
      `<td${total ? "" : ' style="color:var(--green)"'}>${r.on}</td>` +
      `<td class="${total ? "" : clsOd(odPct)}">${r.od || ""}</td><td>${r.pend || ""}</td>` +
      `<td><b>${fmtPct(okPct)}</b></td><td class="${total ? "" : clsOd(odPct)}">${fmtPct(odPct)}</td>` +
      `<td>${r.solved ? r.ftf + "/" + r.solved + " (" + fmtPct(ftfPct) + ")" : "—"}</td>` +
      `<td class="${total ? "" : (r.rej ? "bad" : "")}">${r.rej || ""}</td></tr>`;
  };
  const tot = { c: "", n: 0, doneN: 0, on: 0, od: 0, pend: 0, solved: 0, ftf: 0, rej: 0 };
  rows.forEach((r) => ["n", "doneN", "on", "od", "pend", "solved", "ftf", "rej"].forEach((k) => (tot[k] += r[k])));
  $("slamatrix").innerHTML =
    "<thead><tr><th style=\"text-align:left\">Nhóm SLA</th><th>Tổng</th><th>Đã có KQ</th><th>Đạt</th><th>Quá hạn</th><th>Chưa sol</th><th>%Đạt</th><th>%QH</th><th title=\"First Time Fix trên số ticket đã có solution\">FTF</th><th title=\"Bị VOMS trả lại (mở lại Open)\">Reject</th></tr></thead><tbody>" +
    (rows.length ? rows.map((r) => line(r, false)).join("") + line(tot, true)
      : '<tr><td colspan="10" style="color:var(--muted)">Không có ticket trong kỳ lọc</td></tr>') + "</tbody>";
}
function renderErrors(T) {
  const cnt = {};
  for (const t of T) cnt[t.err] = (cnt[t.err] || 0) + 1;
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const total = T.length || 1;
  let cum = 0;
  const cumPct = top.map(([, n]) => (cum += n, Math.round(1000 * cum / total) / 10));
  mkChart("c_err", {
    data: { labels: top.map(([c]) => c),
      datasets: [
        { type: "bar", label: "Số ticket", data: top.map(([, n]) => n), backgroundColor: COL.navy + "cc", yAxisID: "y" },
        { type: "line", label: "% lũy kế", data: cumPct, borderColor: COL.amber, backgroundColor: COL.amber, yAxisID: "y2", tension: .2, pointRadius: 2 },
      ] },
    options: { responsive: true, maintainAspectRatio: false,
      onClick: (e, els) => { // bấm cột 1 mã lỗi → lọc toàn dashboard theo mã đó (bấm lại / ✕ chip để bỏ)
        if (!els.length || !top[els[0].index]) return;
        const c = top[els[0].index][0];
        errFilter = errFilter === c ? "" : c;
        renderAll();
      },
      plugins: { tooltip: { callbacks: { afterTitle: (items) => (errNames[items[0].label] || "") + "  (bấm để lọc theo mã này)" } } },
      scales: { y: { beginAtZero: true }, y2: { position: "right", min: 0, max: 100, grid: { drawOnChartArea: false } } } },
  });
  // heat table mã lỗi × khu
  const grps = GROUPS.slice();
  const heat = {};
  for (const t of T) {
    if (!t.proc) continue;
    const g = grpOf(t.proc);
    heat[t.err] = heat[t.err] || {};
    heat[t.err][g] = (heat[t.err][g] || 0) + 1;
  }
  const rows = Object.entries(heat).map(([e, m]) => [e, grps.map((g) => m[g] || 0)]).sort((a, b) => b[1].reduce((x, y) => x + y) - a[1].reduce((x, y) => x + y)).slice(0, 15);
  const mx = Math.max(1, ...rows.flatMap((r) => r[1]));
  const lv = (v) => (v === 0 ? "" : v > mx * .66 ? "h4" : v > mx * .4 ? "h3" : v > mx * .15 ? "h2" : "h1");
  $("heat").innerHTML = "<thead><tr><th>Mã lỗi</th>" + grps.map((g) => `<th>${g}</th>`).join("") + "<th>Tổng</th></tr></thead><tbody>" +
    rows.map(([e, vals]) => `<tr><td title="${errNames[e] || ""}">${e}</td>` + vals.map((v) => `<td class="${lv(v)}">${v || ""}</td>`).join("") + `<td><b>${vals.reduce((x, y) => x + y)}</b></td></tr>`).join("") + "</tbody>";
}
function renderRepeats(T) {
  const reps = T.filter((t) => t.repeat30);
  const byP = {}, byU = {};
  for (const t of reps) {
    const p = t.repeatOf && t.repeatOf.proc ? t.repeatOf.proc : "(không rõ)";
    byP[p] = byP[p] || [0, 0]; byP[p][1]++; if (t.repeat7) byP[p][0]++;
    // gom theo trụ cụ thể (trạm + S/N) × mã lỗi
    const k = t.station + "|" + t.cpid + "|" + t.err;
    byU[k] = byU[k] || { station: t.station, cpid: t.cpid, err: t.err, n7: 0, n30: 0, last: t.createT };
    byU[k].n30++; if (t.repeat7) byU[k].n7++;
    if (t.createT > byU[k].last) byU[k].last = t.createT;
  }
  const rowsP = Object.entries(byP).sort((a, b) => b[1][1] - a[1][1]).slice(0, 10);
  $("rep_person").innerHTML = `<thead><tr><th>Người xử lý trước</th><th>≤7 ngày</th><th>≤30 ngày</th></tr></thead><tbody>` +
    rowsP.map(([k, [a, b]]) => `<tr><td>${k}</td><td>${a || ""}</td><td><b>${b}</b></td></tr>`).join("") + "</tbody>";
  const rowsU = Object.values(byU).sort((a, b) => b.n30 - a.n30 || b.last - a.last).slice(0, 12);
  $("rep_err").innerHTML = `<thead><tr><th>Trạm</th><th>S/N trụ</th><th>Mã lỗi</th><th>≤7 ngày</th><th>≤30 ngày</th><th>Lần cuối</th></tr></thead><tbody>` +
    rowsU.map((r) => `<tr><td>${r.station || "—"}</td><td style="font-size:11.5px">${r.cpid || "—"}</td>` +
      `<td title="${(errNames[r.err] || "").replace(/"/g, "'")}">${r.err}</td><td>${r.n7 || ""}</td><td><b>${r.n30}</b></td><td>${dayKey(r.last).slice(5)}</td></tr>`).join("") + "</tbody>";
}

// ---------- phân khu nhân sự ----------
$("btn_groups").addEventListener("click", () => {
  const procs = [...new Set([...solutions.values()].map((s) => s.proc))].filter(Boolean).sort();
  $("grp_table").innerHTML = "<thead><tr><th>Người</th><th>Khu</th><th>Solution lũy kế</th></tr></thead><tbody>" +
    procs.map((p) => {
      const n = [...solutions.values()].filter((s) => s.proc === p).length;
      return `<tr><td>${p}${GROUP_SEED[p] ? " ⭐" : ""}</td><td><select data-p="${p}">` +
        GROUPS.map((g) => `<option ${grpOf(p) === g ? "selected" : ""}>${g}</option>`).join("") +
        `</select></td><td>${n}</td></tr>`;
    }).join("") + "</tbody>";
  $("grp_table").querySelectorAll("select").forEach((sel) =>
    sel.addEventListener("change", () => { groupMap[sel.dataset.p] = sel.value; saveGroups(); })
  );
  $("modal").style.display = "flex";
});
$("grp_close").addEventListener("click", () => { $("modal").style.display = "none"; renderAll(); });

// (đồng bộ giải trình giờ chạy tự động qua Firebase — xem fbPushExplain/applyExplainRemote đầu file)
$("grp_export").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(groupMap, null, 2)], { type: "application/json" }));
  a.download = "phan_khu_nhan_su.json"; a.click();
});
$("grp_import").addEventListener("click", () => $("grp_file").click());
$("grp_file").addEventListener("change", async (e) => {
  try {
    groupMap = Object.assign({}, GROUP_SEED, JSON.parse(await e.target.files[0].text()));
    saveGroups(); $("btn_groups").click();
  } catch (err) { alert("File JSON không hợp lệ"); }
});

// ---------- xuất ----------
$("btn_png").addEventListener("click", async () => {
  const node = $("cap");
  const canvas = await html2canvas(node, { backgroundColor: "#f4f6fa", scale: 2 });
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = "dashboard_ccts_" + dayKey(new Date()) + ".png";
  a.click();
});
$("btn_xlsx").addEventListener("click", () => {
  const f = currentFilter();
  const T = [...tickets.values()].filter((t) => tickInFilter(t, f));
  const wb = XLSX.utils.book_new();
  // sheet người
  const ref = f.to || new Date();
  const per = {};
  for (const s of solutions.values()) { if (!tickets.has(s.tid)) continue; if (f.from && s.t < f.from) continue; if (f.to && s.t > f.to) continue; (per[s.proc] = per[s.proc] || { sols: [], ticks: [] }).sols.push(s.t); }
  for (const t of T) if (t.proc) (per[t.proc] = per[t.proc] || { sols: [], ticks: [] }).ticks.push(t);
  const rows = Object.entries(per).map(([p, v]) => {
    const st = periodStats(v, ref);
    return { "Người": p, "Khu": grpOf(p), "Sol hôm nay": st.sD, "Sol 7 ngày": st.s7, "Sol tháng": st.sM, "Sol lũy kế": st.sAll, "Ticket xử lý": st.nT, "%QH ngày": st.oD, "%QH 7 ngày": st.o7, "%QH tháng": st.oM };
  }).sort((a, b) => b["Sol lũy kế"] - a["Sol lũy kế"]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "HieuSuat_Nguoi");
  // sheet mã lỗi
  const cnt = {};
  for (const t of T) cnt[t.err] = (cnt[t.err] || 0) + 1;
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ "Mã lỗi": c, "Tên": errNames[c] || "", "Số ticket": n }))), "MaLoi");
  // sheet đối soát vật tư
  // sheet SLA 3h/4h tổng hợp (kèm FTF + Reject)
  const g3 = sla3hStats(f);
  if (g3.n3 + g3.n4 > 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { "Chỉ số": "Đạt 3h", "Đạt/Tổng": g3.on3 + "/" + g3.n3, "%": pct1(g3.on3, g3.n3) },
      { "Chỉ số": "Đạt 4h", "Đạt/Tổng": g3.on4 + "/" + g3.n4, "%": pct1(g3.on4, g3.n4) },
      { "Chỉ số": "First Time Fix", "Đạt/Tổng": g3.ftf + "/" + g3.solved, "%": pct1(g3.ftf, g3.solved) },
      { "Chỉ số": "Reject", "Đạt/Tổng": g3.rej + "/" + (g3.n3 + g3.n4), "%": pct1(g3.rej, g3.n3 + g3.n4) },
    ]), "SLA3h_TongHop");
  }
  const audit = partsAudit(f);
  if (audit.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(audit.map((l) => (
      { "Ticket": l.tname, "Trạm": l.station, "Vật tư": l.matList, "SL Broken": l.broken, "SL Good": l.good, "Lệch tổng cặp": l.mismatch ? "x" : "", "Thay khác mã": l.diffCodes ? "x" : "", "AI QC vật tư": l.aiState === "fail" ? "KHÔNG KHỚP" : l.aiState === "ok" ? "khớp" : "chưa QC", "Ghi chú AI": l.aiNote || "", "Người": l.proc }
    ))), "DoiSoat_VatTu");
  }
  // sheet quá hạn kẹt ở đâu
  const stx = stuckStats(T);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(stx).sort((a, b) => b[1].od - a[1].od).map(([s, v]) => (
    { "Nhóm giữ ticket": v.grp, "Trạng thái": s, "Tổng": v.n, "Ontime": v.on, "Overdue": v.od, "%QH trong trạng thái": v.n ? Math.round(1000 * v.od / v.n) / 10 : "" }
  ))), "QuaHan_KetODau");
  // sheet tái phát
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(T.filter((t) => t.repeat30).map((t) => ({ "Ticket": t.name || t.id, "Trạm": t.station, "S/N trụ": t.cpid, "Mã lỗi": t.err, "Ngày tạo": dayKey(t.createT), "Tái phát ≤7ng": t.repeat7 ? "x" : "", "Người xử lý trước": t.repeatOf && t.repeatOf.proc || "" }))), "TaiPhat");
  // sheet chi tiết
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(T.map((t) => ({ "Ticket": t.name || t.id, "Trạm": t.station, "Thiết bị": t.devType, "Model": t.devModel, "Model gốc": t.model, "Mã lỗi": t.err, "Nhóm SLA": t.slaClass, "Ngày tạo": dayKey(t.createT), "Kết quả": t.zone + (isExempt(t) ? " (miễn trừ - có giải trình)" : ""), "Người xử lý": t.proc || "", "Khu": t.proc ? grpOf(t.proc) : "", "Số solution": t.solCount, "Trạng thái": t.status }))), "ChiTiet");
  // sheet AI QC (nếu đã tải)
  if (qcRows.size) {
    const Q = [...qcRows.values()].filter((q) => qcInFilter(q, f));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Q.map((q) => (
      { "Ticket ID": q.id, "Thời gian": q.t ? dayKey(q.t) : "", "Model": q.model, "Người xử lý": qcProc(q) || "", "Kết luận": q.kl, "Hành động": q.action, "Checklist": q.checklist, "Lý do AI": q.reason.slice(0, 500) }
    ))), "AI_QC");
  }
  XLSX.writeFile(wb, "baocao_ccts_" + dayKey(new Date()) + ".xlsx");
});
$("btn_qc").addEventListener("click", loadQCFromGoogle);
$("btn_qc04").addEventListener("click", () => exportQC04(currentFilter()));

// ---------- filter events ----------
["f_gran", "f_group", "f_person", "f_level", "f_dev"].forEach((id) => $(id).addEventListener("change", renderAll));
try {
  const wl = JSON.parse(localStorage.getItem("ccts_dash_wl") || "{}");
  if (wl.norm) $("wl_norm").value = wl.norm;
  if (wl.w3) $("wl_w3").value = wl.w3;
  if (wl.w4) $("wl_w4").value = wl.w4;
  if (wl.w7) $("wl_w7").value = wl.w7;
} catch (e) { /* giữ mặc định */ }
["wl_norm", "wl_w3", "wl_w4", "wl_w7"].forEach((id) => $(id).addEventListener("change", () => renderWorkload(currentFilter())));
["d_day", "d_day2"].forEach((id) => $(id).addEventListener("change", () => {
  $("d_quick").value = ""; // chỉnh tay thì thoát chế độ chọn nhanh
  renderDaily(currentFilter());
}));
$("d_quick").addEventListener("change", () => {
  const v = $("d_quick").value;
  if (!v) return;
  const latest = tickets.size ? new Date(Math.max(...[...tickets.values()].map((t) => +t.createT))) : new Date();
  const day0 = new Date(latest.getFullYear(), latest.getMonth(), latest.getDate());
  const monday = new Date(day0 - ((day0.getDay() + 6) % 7) * 864e5);
  let from = day0, to = day0;
  if (v === "yesterday") { from = to = new Date(day0 - 864e5); }
  else if (v === "thisweek") { from = monday; }
  else if (v === "lastweek") { from = new Date(monday - 7 * 864e5); to = new Date(+monday - 864e5); }
  else if (v === "last7") { from = new Date(day0 - 6 * 864e5); }
  $("d_day").value = dayKey(from);
  $("d_day2").value = +to === +from ? "" : dayKey(to);
  renderDaily(currentFilter());
});
$("btn_explain_save").addEventListener("click", () => {
  let n = 0;
  $("daily").querySelectorAll(".exp-input").forEach((inp) => {
    const cat = $("daily").querySelector(`.exp-cat[data-tid="${inp.dataset.tid}"]`);
    saveExplain(inp.dataset.tid, cat ? cat.value : "", inp.value);
    if ((cat && cat.value) || inp.value.trim()) n++;
  });
  const d = dailyRows(currentFilter());
  dailySummary(d.rows, d.created, d.byDay, d.day2 && d.day2 !== d.day);
  renderStats();
  flashSaved(n);
});
$("btn_copy_report").addEventListener("click", () => {
  const { day, day2, rows, created, byDay } = dailyRows(currentFilter());
  if (!day) return;
  const multi = day2 && day2 !== day;
  const vnD = (s) => s.split("-").reverse().join("/");
  const od = rows.filter((t) => t.zone === "overdue");
  const pct = created ? Math.round(1000 * od.length / created) / 10 : 0;
  const exempt = od.filter((t) => hasExp(t.id));
  const left = od.length - exempt.length;
  const pct2 = created ? Math.round(1000 * left / created) / 10 : 0;
  const selTxt = expSel === "fast" ? " (NHÓM NHANH 3h/4h/7h)" : expSel === "48" ? " (NHÓM 48h)" : "";
  const lines = [(multi ? `BÁO CÁO GIẢI TRÌNH TỪ ${vnD(day)} ĐẾN ${vnD(day2)}` : `BÁO CÁO GIẢI TRÌNH NGÀY ${vnD(day)}`) + selTxt,
    `Tạo ${created} ticket · cần giải trình ${rows.length} · quá hạn ${od.length} (${pct.toLocaleString("vi")}%) so target <${OD_TARGET}%` +
    (exempt.length ? ` · đã giải trình ${exempt.length} → sau miễn trừ còn ${left} (${pct2.toLocaleString("vi")}%)` : "")];
  if (multi) lines.push("Theo ngày (quá hạn/tạo): " + Object.keys(byDay).sort().map((k) => `${k.slice(8)}/${k.slice(5, 7)}: ${byDay[k][0]}/${byDay[k][1]}`).join(" · "));
  rows.forEach((t, i) => {
    const dur = t.refSol ? Math.round((t.refSol.t - t.createT) / 360000) / 10 : null;
    const why = [t.zone === "overdue" ? "quá hạn" : "", t.rejected ? "VOMS reject" : "", isOverVoms(t) ? `Open→VOMS ${(Math.round(t.openToVomsH * 10) / 10).toLocaleString("vi")}h>${t.limitH}h` : ""].filter(Boolean).join(", ");
    lines.push(`${i + 1}. ${t.name || t.id} [${why}]`);
    lines.push(`   ${t.station} · ${t.err} · nhóm ${t.slaClass} · tạo ${(multi ? dayKey(t.createT).slice(5) + " " : "") + pad(t.createT.getHours())}:${pad(t.createT.getMinutes())} · ` +
      (t.refSol ? `solution ${pad(t.refSol.t.getHours())}:${pad(t.refSol.t.getMinutes())} (${dur.toLocaleString("vi")}h/${t.limitH}h)` : `CHƯA XỬ LÝ (hạn ${t.limitH}h)`) +
      ` · ${t.proc ? t.proc + " (" + grpOf(t.proc) + ")" : "chưa có người"} · ${t.status}`);
    const exp = [autoExplain(t), expText(t.id)].filter((s) => s && s !== "—").join(" | CSE: ");
    if (exp) lines.push(`   → ${exp}`);
  });
  if (!rows.length) lines.push("Không có ticket cần giải trình ✓");
  navigator.clipboard.writeText(lines.join("\n")).then(() => {
    $("d_saved").textContent = "✓ đã copy báo cáo, dán vào chat gửi quản lý";
    $("d_saved").style.color = "var(--green)";
  });
});
$("btn_daily").addEventListener("click", () => {
  const { day, day2, rows, created } = dailyRows(currentFilter());
  if (!day) return;
  const multi = day2 && day2 !== day;
  const wb = XLSX.utils.book_new();
  const data = rows.map((t) => ({
    "Ticket": t.name || t.id, "Ticket ID": t.id, "External ticket id": t.extId || "", "Trạm": t.station, "Thiết bị": t.devType + "/" + t.devModel, "Mã lỗi": t.err, "Nhóm SLA": t.slaClass,
    "Tạo lúc": dayKey(t.createT) + " " + pad(t.createT.getHours()) + ":" + pad(t.createT.getMinutes()),
    "Solution đầu": t.refSol ? dayKey(t.refSol.t) + " " + pad(t.refSol.t.getHours()) + ":" + pad(t.refSol.t.getMinutes()) : "CHƯA XỬ LÝ",
    "Giờ xử lý": t.refSol ? Math.round((t.refSol.t - t.createT) / 360000) / 10 : "",
    "Open→VOMS confirm (h)": t.limitH <= 4 && t.openToVomsH != null ? Math.round(t.openToVomsH * 10) / 10 : "",
    "Hạn (h)": t.limitH, "Người": t.proc || "", "Khu": t.proc ? grpOf(t.proc) : "",
    "Trạng thái": t.status, "Tái phát": t.repeat30 ? (t.repeat7 ? "≤7 ngày" : "≤30 ngày") : "",
    "Cần giải trình vì": [t.zone === "overdue" ? "Quá hạn" : "", t.rejected ? "VOMS reject" : "", isOverVoms(t) ? "Open→VOMS>" + t.limitH + "h" : ""].filter(Boolean).join(" · "),
    "Kết quả": t.zone === "pending" ? "Chưa có solution" : isExempt(t) ? "Miễn trừ (giải trình)" : t.zone === "overdue" ? "Quá hạn" : "Đạt",
    "Giải trình dữ liệu (tự động)": autoExplain(t),
    "Phân loại khách quan": expOf(t.id).c,
    "Giải trình chi tiết": expOf(t.id).t,
  }));
  const od = rows.filter((t) => t.zone === "overdue");
  const exempt = od.filter((t) => hasExp(t.id)).length;
  const left = od.length - exempt;
  data.unshift({
    "Ticket": "TỔNG: tạo " + created + (expSel === "fast" ? " (nhóm nhanh)" : expSel === "48" ? " (nhóm 48h)" : "") + " · cần giải trình " + rows.length + " · quá hạn " + od.length + " (" + (created ? Math.round(1000 * od.length / created) / 10 : 0) + "%) · target <" + OD_TARGET + "%" +
      (exempt ? " · đã giải trình " + exempt + " → sau miễn trừ còn " + left + " (" + (created ? Math.round(1000 * left / created) / 10 : 0) + "%)" : ""),
  });
  const suffix = day.replace(/-/g, "") + (multi ? "_" + day2.replace(/-/g, "") : "");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "GiaiTrinh_" + suffix);
  XLSX.writeFile(wb, "baocao_giaitrinh_" + (expSel === "fast" ? "nhanh_" : expSel === "48" ? "48h_" : "") + day + (multi ? "_den_" + day2 : "") + ".xlsx");
});
$("btn_3h_report").addEventListener("click", () => export3h(currentFilter()));

// ---------- tra cứu nhanh ----------
let searchTimer = null;
$("q_search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("q_search").value;
  if (!q.trim()) { $("searchmodal").style.display = "none"; return; }
  searchTimer = setTimeout(() => { renderSearch(q); $("searchmodal").style.display = "flex"; }, 200);
});
$("search_close").addEventListener("click", () => { $("searchmodal").style.display = "none"; });
$("searchmodal").addEventListener("click", (e) => { if (e.target === $("searchmodal")) $("searchmodal").style.display = "none"; });

// ---------- chế độ TV (màn hình treo phòng trực): ẩn công cụ + tự xoay tab mỗi 30s ----------
$("btn_tv").addEventListener("click", () => {
  const on = document.body.classList.toggle("tv");
  if (on) {
    const tabs = [...document.querySelectorAll("#tabs .tab")];
    let i = tabs.findIndex((t) => t.classList.contains("active"));
    tvTimer = setInterval(() => { i = (i + 1) % tabs.length; tabs[i].click(); }, 30000);
  } else { clearInterval(tvTimer); tvTimer = null; }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  ["searchmodal", "modal"].forEach((id) => { if ($(id)) $(id).style.display = "none"; });
  if (document.body.classList.contains("tv")) { document.body.classList.remove("tv"); clearInterval(tvTimer); tvTimer = null; }
});

// ---------- xóa dữ liệu đã lưu trên máy này ----------
$("btn_clear").addEventListener("click", async () => {
  if (!confirm("Xóa toàn bộ file đã lưu trên máy này (dashboard sẽ trống khi mở lại)? Giải trình & phân khu KHÔNG bị xóa.")) return;
  await idbClear().catch(() => {});
  location.reload();
});

// ---------- điều hướng tab ----------
document.querySelectorAll("#tabs .tab").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.toggle("active", b === btn));
  const name = btn.dataset.tab;
  document.querySelectorAll(".panel").forEach((p) => (p.style.display = p.dataset.panel === name ? "" : "none"));
  // chart vẽ khi tab còn ẩn bị Chart.js ghim kích thước 0 → vẽ lại khi tab đã hiện để lấy đúng size (chỉ khi đã có dữ liệu)
  if (tickets.size) renderAll();
}));

// ---------- chip lọc nhóm SLA của card giải trình tích hợp (Tất cả / Nhanh 3h·4h·7h / 48h) ----------
document.querySelectorAll("#exp_chips button").forEach((b) => b.addEventListener("click", () => {
  expSel = b.dataset.k || "";
  document.querySelectorAll("#exp_chips button").forEach((x) => x.classList.toggle("active", x === b));
  renderDaily(currentFilter());
}));

// ---------- thu gọn các bảng chi tiết (click mới hiện) ----------
function toggleWrap(wrapId, btnId, showTxt, hideTxt) {
  const w = $(wrapId), open = w.style.display !== "none";
  w.style.display = open ? "none" : "block";
  $(btnId).textContent = open ? showTxt : hideTxt;
}
$("btn_heat_toggle").addEventListener("click", () => toggleWrap("heat_wrap", "btn_heat_toggle", "Hiện heatmap ▾", "Ẩn heatmap ▴"));
$("btn_slam_toggle").addEventListener("click", () => toggleWrap("slam_wrap", "btn_slam_toggle", "Xem bảng ▾", "Ẩn bảng ▴"));
$("btn_perf_toggle").addEventListener("click", () => toggleWrap("perf_wrap", "btn_perf_toggle", "Xem bảng ▾", "Ẩn bảng ▴"));
$("btn_stuck_toggle").addEventListener("click", () => toggleWrap("stuck_wrap", "btn_stuck_toggle", "Xem bảng ▾", "Ẩn bảng ▴"));
["f_from", "f_to"].forEach((id) => $(id).addEventListener("change", () => {
  $("f_quick").value = ""; // chỉnh tay thì thoát chế độ chọn nhanh
  $("hdrinfo").textContent = hdrBase;
  renderAll();
}));

// "Chọn nhanh": đặt khoảng lọc theo tuần ISO (W-number như báo cáo tuần CCVN) / tháng / 30 ngày
function isoWeekNum(d) { return +weekKey(d).split("-T")[1]; }
function setRange(from, to, label) {
  $("f_from").value = dayKey(from);
  $("f_to").value = dayKey(to);
  $("hdrinfo").textContent = hdrBase + (label ? "  ·  " + label : "");
  renderAll();
}
$("f_quick").addEventListener("change", () => {
  const ref = dataMax || new Date();
  const day0 = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const monday = new Date(day0 - ((day0.getDay() + 6) % 7) * 864e5);
  const v = $("f_quick").value;
  if (v === "thisweek" || v === "lastweek") {
    const m = v === "lastweek" ? new Date(monday - 7 * 864e5) : monday;
    const s = new Date(+m + 6 * 864e5);
    const wn = isoWeekNum(m);
    setRange(m, s, `Tuần W${wn} (${fmtD(m)}–${fmtD(s)}) — KPI so với W${wn - 1}`);
  } else if (v === "thismonth") {
    setRange(new Date(ref.getFullYear(), ref.getMonth(), 1), day0, "Tháng " + (ref.getMonth() + 1) + " (lũy kế đến " + fmtD(day0) + ")");
  } else if (v === "last30") {
    setRange(new Date(day0 - 29 * 864e5), day0, "30 ngày gần nhất");
  } else if (v === "all") {
    const ds = [...tickets.values()].map((t) => t.createT);
    setRange(new Date(Math.min(...ds)), day0, "");
  }
});

// ============================================================================
// BẢN LIVE — đọc /dashboard/current realtime từ Firebase (sla_monitor đẩy lên).
// Chỉ ticket đang mở → suy diễn SLA/tái phát dùng số monitor tính sẵn; các panel
// cần lịch sử/vật tư/solution được ẩn (class .hist-only trong index.html).
// ============================================================================
let LIVE_MODE = false;
let liveDB = null;

function setLiveStat(on, txt) {
  const ls = $("livestat"); if (!ls) return;
  ls.style.display = "flex";
  ls.classList.toggle("on", on); ls.classList.toggle("off", !on);
  $("livetxt").textContent = txt;
}

let fullData = null;   // node /dashboard/full  = toàn bộ export (push_export.py)
let liveData = null;   // node /dashboard/current = ticket đang mở (dashboard_push.py, 5–10')

function startLive() {
  document.body.classList.add("web");   // ẩn ô nạp file thủ công (dữ liệu tự về từ Firebase)
  setLiveStat(false, "Đang kết nối Firebase…");
  if (typeof firebase === "undefined") { setLiveStat(false, "Không tải được Firebase (kiểm tra mạng)"); return; }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    liveDB = firebase.database();
    firebase.auth().signInAnonymously().catch((e) => setLiveStat(false, "Lỗi đăng nhập Firebase: " + e.message));
    // listener gắn SAU khi auth xong (rules yêu cầu auth != null)
    firebase.auth().onAuthStateChanged((u) => {
      if (!u) return;
      liveDB.ref("dashboard/full").on("value",
        (snap) => { fullData = snap.val(); refreshWeb(); },
        (err) => setLiveStat(false, "Lỗi đọc full: " + err.message));
      liveDB.ref("dashboard/current").on("value",
        (snap) => { liveData = snap.val(); refreshWeb(); },
        (err) => setLiveStat(false, "Lỗi đọc live: " + err.message));
      // giải trình dùng chung cả nhóm — realtime, thay kênh Apps Script/Google Sheet cũ
      fbExpRef = liveDB.ref("dashboard/explain");
      fbExpRef.on("value", (snap) => applyExplainRemote(snap.val() || {}), () => {});
    });
  } catch (e) { setLiveStat(false, "Firebase lỗi: " + e.message); }
}

// điều phối: có full export -> chế độ TOÀN CẢNH (đủ panel) + phủ ticket mở; chỉ có live -> live-lite
function refreshWeb() {
  const hasFull = fullData && fullData.ti && fullData.ti.length;
  const hasLive = liveData && liveData.rows && liveData.rows.length;
  if (hasFull) {
    LIVE_MODE = false;
    document.body.classList.remove("live");   // hiện lại mọi panel lịch sử/vật tư
    ingestFull(fullData);
    const k = hasLive ? applyLive(liveData) : 0;
    const at = new Date(fullData.meta && fullData.meta.at || Date.now());
    setLiveStat(true, "🟢 Toàn cảnh: " + (fullData.meta && fullData.meta.file || "export") +
      " · " + tickets.size + " ticket" + (k ? " · live " + k + " đang mở" : "") +
      " · cập nhật " + at.toLocaleDateString("vi") + " " + at.toLocaleTimeString("vi"));
    afterLoad();
  } else if (hasLive) {
    LIVE_MODE = true;
    document.body.classList.add("live");
    ingestLive(liveData);
    const at = new Date(liveData.meta && liveData.meta.at || Date.now());
    setLiveStat(true, "🟢 Live · " + tickets.size + " ticket tồn · cập nhật " + at.toLocaleTimeString("vi") +
      "  (chưa có full export — chạy push_export.py để đủ panel)");
    afterLoad();
  } else {
    setLiveStat(false, "Chưa có dữ liệu trên server (chờ chu kỳ quét / chạy push_export.py)");
  }
}

// live-lite: nạp {meta, rows} ticket đang mở vào tickets Map (KHÔNG afterLoad — refreshWeb lo)
function ingestLive(payload) {
  tickets = new Map(); solutions = new Map(); partRecs = new Map();
  rejectSet = new Set(); vomsWin = new Map();
  for (const r of (payload.rows || [])) {
    if (!r || r.id == null) continue;
    tickets.set(String(r.id), {
      id: String(r.id), extId: r.extId || "", name: r.name || "",
      station: (r.station || "").trim(), cpid: (r.cpid || "").trim(),
      err: r.err || "Không mã", model: r.model || "", source: r.source || "",
      status: r.status || "", slaCCTS: "",
      createT: new Date(r.createT), closeT: null, hasParts: false,
      owner: (r.owner || "").trim(), collab: (r.collab || "").trim(),
      _deadline: r.deadline ? new Date(r.deadline) : null,
      _limitH: r.limitH || 48, _zone: r.zone || "pending",
      _rep7: !!r.rep7, _rep30: !!r.rep30,
    });
  }
  loadedFiles = ["CCTS live"];
}

// TOÀN CẢNH: dựng lại tickets/solutions/partRecs/rejectSet/vomsWin từ full export.
// Mirror ĐÚNG luồng ingestWorkbook (JS là nguồn chuẩn hóa duy nhất) nhưng đọc từ
// mảng JSON push_export.py đẩy lên (ngày = epoch ms) thay vì đọc sheet xlsx.
function ingestFull(payload) {
  tickets = new Map(); solutions = new Map(); partRecs = new Map();
  rejectSet = new Set(); vomsWin = new Map();
  const D = (ms) => (ms ? new Date(ms) : null);

  for (const r of (payload.events || [])) {
    const tid = String(r.tid || "").trim();
    const st = String(r.status || "").trim().toLowerCase();
    const proc = String(r.proc || "").trim().toUpperCase();
    const detail = String(r.detail || "").trim();
    const hasDetail = !!detail && detail !== "----";
    if (/close rejected/i.test(st) || (proc === "VOMS" && st === "open" && hasDetail)) rejectSet.add(tid);
    const ct = D(r.createMs);
    if (tid && ct && (st === "open" || st === "pending for voms confirm")) {
      const w = vomsWin.get(tid) || {};
      const k = st === "open" ? "openT" : "vomsT";
      if (!w[k] || ct < w[k]) w[k] = ct;
      vomsWin.set(tid, w);
    }
  }
  const partsSet = new Set((payload.parts || []).map((r) => String(r.tid)));
  for (const r of (payload.parts || [])) {
    const tid = String(r.tid || "").trim(); if (!tid) continue;
    const t = D(r.createMs);
    const rec = {
      tid, t, code: String(r.mcode || "").trim(), name: String(r.mname || "").trim(),
      type: /broken/i.test(String(r.mtype || "")) ? "broken" : /good/i.test(String(r.mtype || "")) ? "good" : "khác",
      qty: +(r.qty || 0) || 0, proc: String(r.proc || "").trim(),
    };
    partRecs.set(tid + "|" + rec.code + "|" + rec.type + "|" + (t ? t.getTime() : 0) + "|" + rec.qty, rec);
  }
  for (const r of (payload.ti || [])) {
    const id = String(r.id || "").trim(); if (!id) continue;
    const createT = D(r.createMs); if (!createT) continue;
    tickets.set(id, {
      id, extId: String(r.extId || "").trim(), name: String(r.name || ""),
      station: String(r.station || "").trim(), cpid: String(r.cpid || "").trim(),
      err: errCode(r.err), model: String(r.model || "").trim(), source: String(r.source || "").trim(),
      status: String(r.status || ""), slaCCTS: String(r.sla || ""), createT,
      closeT: D(r.closeMs), hasParts: partsSet.has(id),
    });
  }
  for (const r of (payload.sol || [])) {
    const tid = String(r.tid || "").trim();
    const t = D(r.createMs);
    if (!tid || !t) continue;
    const proc = String(r.proc || "").trim();
    const key = tid + "|" + t.getTime() + "|" + proc;
    const att = String(r.att || "").trim();
    solutions.set(key, {
      tid, t, proc, isPerm: /permanent/i.test(String(r.stype || "")),
      d60: norm60(r.desc), hasAtt: !!att && att !== "----",
    });
  }
  loadedFiles = [(payload.meta && payload.meta.file) || "CCTS export"];
}

// phủ trạng thái realtime của ticket ĐANG MỞ (từ /dashboard/current) lên dữ liệu export.
// ticket đã có trong export -> cập nhật trạng thái; ticket mở sau kỳ export -> thêm mới.
// Trả về số ticket mở đã áp.
function applyLive(payload) {
  let n = 0;
  for (const r of (payload.rows || [])) {
    if (!r || r.id == null) continue;
    const id = String(r.id);
    const ex = tickets.get(id);
    if (ex) {
      ex.status = r.status || ex.status;   // trạng thái hiện tại thắng bản export
    } else {
      tickets.set(id, {
        id, extId: r.extId || "", name: r.name || "", station: (r.station || "").trim(),
        cpid: (r.cpid || "").trim(), err: r.err || "Không mã", model: r.model || "",
        source: r.source || "", status: r.status || "", slaCCTS: "",
        createT: new Date(r.createT), closeT: null, hasParts: false,
      });
    }
    n++;
  }
  return n;
}

// suy diễn cho bản live: dựng trường phụ mà các panel còn lại cần, KHÔNG tính lại SLA
function deriveLive() {
  for (const t of tickets.values()) {
    t.sols = []; t.solCount = 0; t.refSol = null; t.permSol = null;
    t.proc = t.owner || null; t.hasAtt = false;   // người xử lý (live) = owner ticket mở
    classifyDevice(t);
    const si = stationInfo(t.station);
    t.province = si ? si[1] : "";
    t.limitH = t._limitH;
    t.slaClass = t.limitH + "h";
    // ticket mở: quá hạn khi đã qua hạn theo đồng hồ hiện tại (chính xác hơn giá trị đẩy lúc quét)
    t.zone = (t._deadline && Date.now() > +t._deadline) ? "overdue" : (t._zone || "pending");
    t.repeat7 = t._rep7; t.repeat30 = t._rep30; t.repeatOf = null; t.caused30 = false;
    t.openToVomsH = null; t.rejected = false; t.ftf = false;
  }
  buildRiskModel();
}

// render bản live: KPI vận hành + các panel dùng được ticket đang mở
function renderLive(f, T) {
  renderKPIsLive(f, T);
  renderStuckChart(T);   // quá hạn kẹt ở đâu (theo trạng thái)
  renderErrors(T);       // top mã lỗi Pareto
  renderWorkload(f);     // tải theo người (= owner)
  renderPriority(f);     // ticket ưu tiên hôm nay
  renderSLA(T);          // SLA matrix theo nhóm dịch vụ
  renderStuck(T);        // bảng quá hạn kẹt ở đâu
  renderRepeats(T);      // tái phát 7/30 ngày
  renderQC(f);           // AI QC (kéo live Google Sheet, độc lập)
}

// KPI vận hành cho bản live (thay renderKPIs vốn thiên về %ontime hồi cứu)
function renderKPIsLive(f, T) {
  const overdue = T.filter((t) => t.zone === "overdue");
  const soon = T.filter((t) => t.zone !== "overdue" && t._deadline && (+t._deadline - Date.now()) <= 3600e3);
  const rep30 = T.filter((t) => t.repeat30);
  const byTier = {};
  for (const t of T) byTier[t.slaClass] = (byTier[t.slaClass] || 0) + 1;
  const tierStr = ["3h", "4h", "7h", "12h", "48h"].filter((c) => byTier[c]).map((c) => `${c}: ${byTier[c]}`).join(" · ");
  const odPct = T.length ? Math.round(1000 * overdue.length / T.length) / 10 : 0;
  const odCls = !overdue.length ? "k-good" : odPct >= OD_RED ? "k-bad" : odPct >= OD_WARN ? "k-warn" : "k-good";
  const cells = [
    ["Ticket tồn", T.length.toLocaleString("vi"), tierStr, ""],
    ["Quá hạn", overdue.length.toLocaleString("vi"), odPct + "% tổng tồn", odCls],
    ["Sắp hết hạn ≤1h", soon.length.toLocaleString("vi"), "còn hạn nhưng dưới 1 giờ", soon.length ? "k-warn" : ""],
    ["Còn hạn", (T.length - overdue.length).toLocaleString("vi"), "", ""],
    ["Tái phát ≤30ng", rep30.length.toLocaleString("vi"), "cùng trụ + mã lỗi", rep30.length ? "k-warn" : ""],
  ];
  $("kpis").innerHTML = cells.map(([t, v, d, cls]) => `<div class="kpi ${cls}"><div class="t">${t}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
}

// ---------- test hook (chỉ chạy khi mở qua http với ?load=...) ----------
(function () {
  const q = new URLSearchParams(location.search).get("load");
  if (!q) return;
  Promise.all(q.split(",").map((u) => fetch(u).then((r) => r.arrayBuffer()).then((b) => ({ name: decodeURIComponent(u.split("/").pop()), buf: b }))))
    .then((fs) => { for (const f of fs) ingestWorkbook(f.buf, f.name); afterLoad(); })
    .catch((e) => console.error("test-load failed", e));
})();

// ---------- tự nạp lại file đã lưu lần trước (IndexedDB) khi mở trang ----------
(async function restore() {
  // Bản LIVE: có FIREBASE_CONFIG → đọc realtime từ Firebase, KHÔNG nạp file cục bộ
  if (typeof FIREBASE_CONFIG !== "undefined" && FIREBASE_CONFIG) { startLive(); return; }
  if (new URLSearchParams(location.search).get("load")) return; // đang mở bằng ?load test → bỏ qua
  try {
    const files = await idbAllFiles();
    if (!files.length) return;
    files.sort((a, b) => a.name.localeCompare(b.name)); // file cũ trước, mới ghi đè — như handleFiles
    $("filebar").textContent = "Đang nạp lại " + files.length + " file đã lưu lần trước…";
    for (const f of files) ingestWorkbook(f.buf, f.name);
    afterLoad();
  } catch (e) { /* không có/không đọc được kho lưu → chờ user kéo file */ }
})();
