# Thư mục import của Dashboard

Đây là **nguồn file export chuẩn** cho dashboard CCTS (thay cho việc quét lung tung trong `Downloads`).

## Cách dùng
- Đặt file export `*_Tickets.xlsx` vào **thẳng thư mục này** rồi chạy:
  ```
  python ../../sla_monitor/push_export.py
  ```
  Script tự lấy file `*Tickets*.xlsx` **mới nhất** ở đây (nếu trống mới lùi về Downloads).
- `auto_export.py` (chạy tự động) cũng lưu file tải về vào đây.

## An toàn dữ liệu (chống "mất hết thông tin")
Trước khi đẩy lên Firebase, `push_export.py` kiểm tra:
- File **0 ticket** sau khi lọc → **không đẩy** (tránh xóa trắng dashboard).
- Số ticket **< 60%** lần đẩy trước (file thiếu/tải dở) → **không đẩy**, phải chạy lại `--force` nếu chắc chắn.

Số liệu lần đẩy gần nhất lưu ở `_last_push.json`.

## Lịch sử
Mỗi lần đẩy thành công, file được sao lưu vào `archive/` (giữ 30 bản gần nhất) để đối chiếu khi cần.
