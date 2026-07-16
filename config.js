// ===== Cấu hình Dashboard điều hành CCTS (bản LIVE trên web) =====
// FIREBASE_CONFIG != null  -> BẢN LIVE: tự đọc /dashboard/current, cập nhật realtime,
//                             ẩn ô kéo-thả file và các panel phân tích lịch sử.
// FIREBASE_CONFIG == null  -> BẢN OFFLINE cũ: kéo-thả file export như trước.
//
// Dùng chung project Firebase với Field Map HNO (mappingslahno) — data dashboard
// nằm ở node riêng /dashboard/current nên không đụng /tickets của Field Map.
// sla_monitor/dashboard_push.py đẩy dữ liệu lên node này mỗi chu kỳ quét.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAyWWhY2Bh-Irw7mbHh-nz3DZN4O3lupTE",
  authDomain: "mappingslahno.firebaseapp.com",
  databaseURL: "https://mappingslahno-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "mappingslahno",
};
// Đặt FIREBASE_CONFIG = null để quay lại bản OFFLINE kéo-thả file.
