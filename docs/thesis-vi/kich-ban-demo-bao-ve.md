# Kịch bản Demo Bảo vệ (5 Phút — Offline `0-LLM`) & 10 Câu hỏi Phản biện Hội đồng

---

## Phần 1 — Kịch bản Trình diễn Trực tiếp 5 Phút (Không cần Wi-Fi / Không lo hết API)

### Chuẩn bị trước giờ bảo vệ (30 giây)
Mở terminal tại thư mục gốc dự án `defect-intelligence-platform` và kiểm tra nhanh:
```powershell
.\node_modules\.bin\tsx.cmd scripts\skill-graph-defense-demo.ts
```
*(Lệnh chạy 100% offline, tốn `\$0.00`, hoàn tất trong `< 5` giây và minh họa trực tiếp 4 năng lực lõi của hệ thống.)*

### Diễn tiến thuyết trình 5 phút

1. **Phút 0:00–1:00 — Đặt vấn đề (1 slide + Hình 2 & Hình 3):**
   - *"Kiểm thử E2E truyền thống rất nhanh nhưng gãy ngay khi đổi tên nút; còn AI Web Agent dùng LLM thì chậm gấp 20 lần, tốn phí lặp lại và đặc biệt khi gặp lỗi thật lại có xu hướng xóa assertion để biến test thành xanh — chúng em đo được Black-Box cố làm yếu oracle trên 60% bug thật (`12/20`) và gây False Heal sống biến lỗi mất dữ liệu thành xanh."*
2. **Phút 1:00–2:00 — Kiến trúc Khép kín (Hình 1):**
   - Trình bày ngắn gọn 3 trụ cột: (i) Kỹ năng YAML gắn tĩnh vào mã nguồn (`codeRefs`), (ii) Cổng Telemetry 3 chiều chặn `0-LLM` mọi `PRODUCT_BUG`, chỉ cho phép tự sửa `SKILL_DRIFT` có `git diff` trong tối đa `k ≤ 2` lượt, (iii) Vòng lặp kín với Đồ thị Tri thức Lỗi qua MCP Server.
3. **Phút 2:00–3:30 — Chạy Live Demo Terminal (`scripts/skill-graph-defense-demo.ts`):**
   - **Stage 1:** Chỉ ra Static Grounder tự động ánh xạ route sang file React/Express và Django CBV/Template ở `0-LLM` (tăng precision từ `25% → 81%`).
   - **Stage 2:** Chỉ ra bảng so sánh trực tiếp `Plain File-Overlap` vs `Defect-Aware Unified Graph`: `department.create` được đẩy lên Top-1 nhờ guardrail & bug P1, đồng thời tự động lôi thêm `employee_type.create` (file chưa hề sửa!) qua cạnh `SIBLING_CANDIDATE`.
   - **Stage 3 & 4:** Chỉ ra tiến trình **MCP Server (`stdio`)** thật đang trả lời JSON-RPC 2.0, tự xuất `DRAFT` bug chuẩn schema khi gặp lỗi, và chứng minh trực tiếp **cổng kiểm định từ chối nâng cấp thành `CONFIRMED`** nếu không có con người duyệt RCA.
4. **Phút 3:30–4:30 — Chốt số liệu thuyết phục nhất (Hình 3, Hình 4, Hình 5):**
   - `20.2×` nhanh hơn, giảm `98.5%` chi phí (`N = 100`).
   - `EvoBench-48`: `16/16 (100%)` DRR (`p = 0.0078` vs Black-Box), `0/20` False Heal & Weakening (`p < 0.001`).
   - Đa mô hình 3 họ LLM (`DeepSeek-V3.2`, `Gemini-2.5-Flash`, `GPT-4o-mini`): cả 3 đều `100%` DRR & `0%` FHR (`\$0.0038` với `GPT-4o-mini`).
   - `RealGit-99`: giảm `98.5%` test trên 99 commit thật ở `0.17–0.21 ms`.
5. **Phút 4:30–5:00 — Kết luận & Trung thực giới hạn:**
   - Tóm gọn đóng góp và chủ động nêu 2 giới hạn chính (cần viết adapter cho stack mới, đánh đổi bảo thủ ở oracle) để tạo ấn tượng nghiên cứu chín chắn trước hội đồng.

---

## Phần 2 — 10 Câu hỏi Hóc búa của Hội đồng & Câu trả lời Gọn sắc

### Câu 1: *Tại sao không dùng luôn AI Agent (như WebArena / Browser-Use) chạy kiểm thử hàng ngày cho đỡ phải duy trì Skill Graph?*
> **Trả lời:** Thực nghiệm `RQ1` của em đo trực tiếp trên cùng mô hình `DeepSeek-V3.2` và cùng trình thực thi cho thấy Pure-LLM Agent chậm hơn **20.2 lần** (`102.3 s` vs `5.1 s`), kém ổn định hơn (**73.3%** vs **100%**, Fisher `p = 0.015`) và tốn chi phí tăng tuyến tính mỗi lần chạy. Skill Graph chỉ dùng LLM một lần lúc tạo hoặc lúc giao diện đổi, còn 100% lượt kiểm chứng định kỳ chạy bằng Playwright ở `0-LLM`, giúp tiết kiệm **88.2%** ngay sau 5 lượt và **98.5%** sau 100 lượt.

### Câu 2: *Làm sao đảm bảo hệ thống tự phục hồi (Self-Healing) không tự ý "chữa mù" che giấu lỗi sản phẩm?*
> **Trả lời:** Em áp dụng **3 lớp phòng vệ độc lập (defense-in-depth)**: (1) **Cổng Telemetry tất định trước khi gọi LLM** — hễ có HTTP 5xx, JS `pageerror`, hay thất bại postcondition thì xếp vào `PRODUCT_BUG` và từ chối ngay ở `0` LLM call; (2) **Bất biến postcondition** — ngay cả khi được gọi cho `SKILL_DRIFT`, trình xác thực từ chối mọi bản vá xóa hoặc làm yếu postcondition; (3) **Kiểm chứng lại trên DB sạch bằng Playwright (`0-LLM`)**. Trên `EvoBench-48` và cả 3 họ LLM, tỷ lệ False Healing của hệ thống là **0%** (`0/20` và `0/12`), trong khi Black-Box cố làm yếu oracle ở **60% (`12/20`, `p < 0.001`)** và gây False Heal sống ở cả DeepSeek lẫn Gemini.

### Câu 3: *Nhưng trên `EvoBench-48`, White-Box (`16/16`) hơn Telemetry-Gated No-Diff (`13/16`) có `p = 0.250` chưa dưới `0.05` — vậy có cần `git diff` không?*
> **Trả lời:** Đây là điểm em chủ động phân tích trung thực trong *Threats to Validity*. Về mặt định tính, 3 ca mà No-Diff thất bại (`HOR-D2`, `HOR-D3`, `HOR-D4` sửa nhãn trong Django template và Python `base/forms.py`) đều là những ca thay đổi từ vựng không hiển nhiên trên DOM nếu không nhìn thấy dòng cũ → dòng mới trong `git diff`, và White-Box thắng tuyệt đối `3–0` (không thua ca nào). Lý do `p = 0.250` là do cỡ mẫu `16` drift có tối đa 3 cặp bất đồng (`2 × 0.5^3 = 0.250`). Ngoài ra, `git diff` còn phục vụ lọc tác động giúp giảm **80.74%** lượt chạy trên `EvoBench-48` và **98.5%** trên `RealGit-99`.

### Câu 4: *Nếu lập trình viên cố ý đổi thông báo thành công từ `"Saved"` sang `"Updated"` (và chuỗi này nằm trong postcondition), hệ thống xử lý thế nào?*
> **Trả lời:** Hệ thống sẽ chủ động phân loại bảo thủ là `PRODUCT_BUG` và từ chối tự sửa. Đây là **đánh đổi có chủ đích**: vì một postcondition kiểm chứng hành vi nghiệp vụ cốt lõi, tự động sửa postcondition sẽ mở cửa cho False Healing. Khi hợp đồng nghiệp vụ thực sự thay đổi, kỹ sư cập nhật lại postcondition trong file YAML kỹ năng được quản lý bằng Git (giống như cập nhật unit test khi đổi spec).

### Câu 5: *Tỷ lệ giảm `98.5%` trên `RealGit-99` có bị "thổi phồng" vì số skill ít không?*
> **Trả lời:** Có, em ghi rõ trong luận văn rằng `98.5%` là **cận trên thực nghiệm theo tập skill hiện có** (`8` skill trên RWA và `4` skill lõi trên Horilla). Tuy nhiên, ngay cả khi mở rộng đủ skill cho toàn bộ ứng dụng, toàn bộ nhóm commit chỉ sửa CI/CD, tài liệu, gói phụ thuộc và unit test (`35/49 = 71.4%` trên RWA) vẫn luôn bị loại sạch ở `0.2 ms` mà không cần khởi động trình duyệt.

### Câu 6: *Nếu áp dụng cho dự án công ty dùng Angular + Java Spring Boot (khác React/Django) thì có phải viết lại toàn bộ hệ thống không?*
> **Trả lời:** Không. Toàn bộ lõi thực thi, lập kế hoạch DAG, cổng telemetry, self-healer, đồ thị tri thức và MCP server hoàn toàn độc lập với framework (`0` dòng code đặc thù ứng dụng trong lõi). Phần duy nhất cần bổ sung là một plugin adapter cho `StaticGrounder` (~150–250 dòng mã đọc route Angular / `@RequestMapping` của Spring Boot) và khai báo quy ước `codeUnitId` nếu cần.

### Câu 7: *Vì sao phải cô lập `DRAFT` bug do hệ thống tự sinh khỏi `CONFIRMED` bug trong Đồ thị Tri thức Lỗi?*
> **Trả lời:** Vì đầu ra tự động dù xuất phát từ telemetry tất định vẫn có thể bị nhiễu (ví dụ đổi spec UI hoặc lỗi môi trường tạm thời). Nếu cho phép AI/công cụ tự ghi thẳng vào tri thức `CONFIRMED`, sai lệch sẽ lan truyền vào các guardrail và ưu tiên kiểm thử về sau. Trong hệ thống của em, `knowledge-validator` cưỡng chế ở mức JSON Schema và luật kiểm định: `DRAFT` tự sinh không bao giờ được tự nâng cấp lên `CONFIRMED` nếu thiếu phần phân tích nguyên nhân gốc (RCA) và xác nhận của con người.

### Câu 8: *Tại sao kết quả tác giả hóa của `Gemini-2.5-Flash` chỉ đạt `1/2` trong khi `DeepSeek-V3.2` và `GPT-4o-mini` đạt `2/2`?*
> **Trả lời:** Tác vụ tác giả hóa từ đầu đòi hỏi suy luận đa bước mở (tự tìm đường đi trên giao diện chưa biết), nên nhạy với năng lực lập kế hoạch của từng họ mô hình — `Gemini-2.5-Flash` gặp lỗi ở `user.settings_update` trên RWA nhưng lại giải `work_type.create` trên Horilla nhanh nhất (chỉ `5` calls). Điều quan trọng là ngay cả khi dùng mô hình rẻ như `GPT-4o-mini`, giai đoạn bảo trì tự lành White-Box vẫn đạt **100% (`8/8`)** chỉ với `\$0.0038`.

### Câu 9: *Hệ thống có phát hiện được lỗi vỡ giao diện CSS hoặc lỗi hiệu năng chậm nhẹ không?*
> **Trả lời:** Hiện tại hệ thống tập trung vào **lỗi chức năng, lỗi mạng HTTP 5xx, lỗi runtime JS và tính toàn vẹn dữ liệu DOM/API** — chưa phát hiện lỗi thuần thẩm mỹ/bố cục CSS nếu không ảnh hưởng tương tác hoặc postcondition. Đây là hướng mở rộng tự nhiên bằng cách gắn thêm postcondition ngưỡng độ trễ hoặc so sánh ảnh chụp vùng trọng yếu.

### Câu 10: *Vai trò thực sự của MCP Server trong hệ thống này là gì? Có phải chỉ là làm thêm cho hợp xu hướng?*
> **Trả lời:** MCP Server giải quyết đúng bài toán **"ai sẽ kích hoạt kiểm thử ngay lúc lập trình?"**. Thay vì đợi đẩy code lên CI mới phát hiện lỗi anh em (`sibling bug`), các AI coding agent trong IDE (như Cursor, Claude Code, Antigravity) có thể gọi trực tiếp 6 tool qua `stdio` ở **`0-LLM` (`\$0.00`)**: tra cứu tiền sử lỗi trên file đang sửa (`query_defect_knowledge`), lập danh sách kỹ năng rủi ro cao nhất cần chạy (`plan_impacted_skills`), chạy kiểm chứng ngay tại máy (`run_skill_verification`) và phát hành `DRAFT` bug nếu gây hồi quy.
