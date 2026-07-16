# Dashboard điều hành CCTS — bản web (Firebase)

Bản web đọc dữ liệu từ Firebase, không kéo-thả file thủ công. Có **2 nguồn dữ liệu**
kết hợp — vì CCTS không cho lấy đủ mọi thứ theo thời gian thực:

| Nguồn | Node Firebase | Script đẩy | Chu kỳ | Cho panel nào |
|---|---|---|---|---|
| **Toàn cảnh** (full export) | `/dashboard/full` | `push_export.py` | mỗi lần bạn export CCTS | TẤT CẢ panel: %Ontime, Vật tư, FTF, VOMS reject, Hiệu suất, Xu hướng… |
| **Live** (ticket đang mở) | `/dashboard/current` | `dashboard_push.py` | tự động 5–10' | phủ trạng thái/SLA realtime lên ticket đang mở |

**Cách web chọn chế độ:**
- Có `/dashboard/full` → **chế độ Toàn cảnh**: nạp đủ dữ liệu export (mọi panel như bản
  offline), rồi phủ ticket đang mở từ `/dashboard/current` cho tươi. Header: "🟢 Toàn cảnh…".
- Chưa có full (mới bật, chưa chạy `push_export.py`) → **live-lite**: chỉ ticket đang mở,
  các panel cần lịch sử/vật tư/solution tạm ẩn. Header: "🟢 Live…".

> Vì sao phải có `push_export.py`: API live của CCTS (`findCCTSTicket`) chỉ trả **danh
> sách ticket**, KHÔNG có `Solutions / Spare Parts / Events` → không thể có %Ontime, kho
> vật tư, FTF, VOMS reject theo realtime. Ba thứ này chỉ nằm trong file export đầy đủ, nên
> `push_export.py` đọc file đó đẩy lên. "Đủ dữ liệu" sẽ mới đến thời điểm bạn export gần nhất;
> chỉ phần ticket đang mở là realtime.

Muốn quay lại bản OFFLINE kéo-thả file: đặt `FIREBASE_CONFIG = null` trong `config.js`.

## Các bước bật (một lần)

### 1. Quyền node /dashboard trong Firebase  ✅ (đã làm)
**Realtime Database → Rules**, nhánh `dashboard` cho `auth != null` đọc/ghi (cả `/current`
lẫn `/full` nằm trong đây). Thiếu → web báo `permission_denied`.

### 2. .env của sla_monitor
Dùng chung biến với Field Map — nếu Field Map đã chạy thì **không cần thêm gì**:
```
FIREBASE_API_KEY=...        # = apiKey trong config.js
FIREBASE_DB_URL=https://mappingslahno-default-rtdb.asia-southeast1.firebasedatabase.app
```

### 3. Đẩy dữ liệu
```
cd sla_monitor
# (A) Live ticket đang mở — tự chạy mỗi chu kỳ monitor.py (đã móc sẵn). Test tay:
python dashboard_push.py --once

# (B) Toàn bộ dữ liệu — chạy MỖI LẦN bạn export Tickets.xlsx mới từ CCTS:
python push_export.py                       # tự lấy *_Tickets.xlsx mới nhất trong Downloads
python push_export.py "đường/dẫn/file.xlsx" # hoặc chỉ định file
python push_export.py --dry                 # xem thống kê + dung lượng, không đẩy
```
Chạy (B) xong, web tự chuyển sang chế độ Toàn cảnh (đủ panel).
**Nên đặt lịch chạy (B)** sau mỗi lần export (hoặc mỗi sáng) để dữ liệu lịch sử luôn mới.

### 4. Deploy web lên GitHub Pages
Đưa các file sau lên repo (KHÔNG cần các lib nặng — đã lấy từ CDN):
```
index.html   config.js   app.js
libs/station_map.js        ← file RIÊNG bắt buộc phải có
```
`xlsx / chart.js / html2canvas` tải thẳng từ CDN nên khỏi upload. Mở link Pages là chạy.

## Ghi chú
- Firebase SDK + 3 thư viện tải từ CDN (cần internet) — hợp lý vì host online.
- `/dashboard/full` và `/dashboard/current` là node RIÊNG, không đụng `/tickets` của Field Map.
- `push_export.py` cảnh báo nếu payload > 8MB — nên dùng export theo tháng của HNO, đừng
  dùng báo cáo master vài chục nghìn ticket.
- Đồng bộ giải trình (nút ☁) và AI QC vẫn hoạt động bình thường.
