# Chương 4: Thực nghiệm và Đánh giá Hệ thống

> *Ghi chú sử dụng:* Bản thảo chương này sử dụng 100% số liệu đã kiểm chứng trực tiếp từ các tệp CSV/JSON trong `docs/thesis-evaluation/` và hình vẽ 300-DPI trong `docs/ieee-paper/figures/`. Bạn có thể sao chép trực tiếp vào mẫu Word hoặc LaTeX của trường.

---

## 4.1. Thiết lập Thực nghiệm và Kiểm soát Tính công bằng

Để đánh giá tính tổng quát vượt khỏi một công nghệ đơn lẻ, hệ thống được kiểm chứng trực tiếp trên **hai ứng dụng nguồn mở đầy đủ (full-stack) có kiến trúc đối lập hoàn toàn**, không sử dụng container giả lập hay chỉnh sửa mã nguồn gốc trước khi kiểm thử:

1. **`cypress-io/cypress-realworld-app` (Ngăn xếp SPA hiện đại):** TypeScript, React 18, Material UI (MUI), XState, Express REST API, GraphQL và cơ sở dữ liệu `lowdb`; được mô hình hóa bằng **8 kỹ năng nguyên tử** (`skills/cypress-rwa/`), bao gồm cả luồng giao dịch 2 người dùng (người gửi yêu cầu thanh toán và người phê duyệt).
2. **`horilla-opensource/horilla` (Ngăn xếp MPA doanh nghiệp):** Python 3.12, Django 5.2, HTMX động, Class-Based Views (CBV) và SQLite; được mô hình hóa bằng **4 kỹ năng nguyên tử cốt lõi** (`skills/horilla/`) cùng các hộp thoại xác nhận nhiều bước (`modal` bảo vệ xóa bản ghi với 3 checkbox bắt buộc).

### Kiểm soát tính công bằng thực nghiệm (Fairness Controls)
- **Độc lập môi trường:** Cơ sở dữ liệu ứng dụng được khôi phục về trạng thái sạch trước mọi lượt chạy đo thời gian; mã nguồn kho thử nghiệm được khôi phục nguyên trạng về `HEAD` sau mọi đột biến mã.
- **Cùng công cụ quan sát và thực thi:** Tất cả các mô hình đối sánh — bao gồm *Tác tử Pure-LLM* (RQ1), *Black-Box Self-Healer* và *Telemetry-Gated No-Diff* (RQ2) — đều chia sẻ chung trình chụp DOM ngữ nghĩa (hỗ trợ đầy đủ thuộc tính `<label for>` và `title`), bộ thực thi hành động Playwright, bộ kiểm chứng điều kiện hậu kiểm (postcondition) và cùng thiết lập mô hình (`temperature = 0`, chế độ đầu ra JSON).
- **Kiểm định thống kê chính xác:** Mọi tỷ lệ thành công đều đi kèm **khoảng tin cậy Wilson 95%**; so sánh ghép cặp trên cùng commit sử dụng **kiểm định chính xác McNemar hai phía**; so sánh độc lập (tỷ lệ pass, tỷ lệ làm yếu assertion) sử dụng **kiểm định chính xác Fisher hai phía**; phân phối độ trễ phi tham số sử dụng **Mann-Whitney $U$** kết hợp kích thước hiệu ứng **Cliff's $\delta$**.

---

## 4.2. Đánh giá Hiệu quả Chi phí và Độ trễ (`RQ1`)

Trên **5 luồng nghiệp vụ đa bước** (3 luồng trên `cypress-rwa` gồm cả chuỗi 5 kỹ năng / 2 người dùng `auth → create_request → logout → login → accept_request`; 2 luồng trên `horilla` gồm chuỗi 3 kỹ năng `login → department.create → department.search`), Đồ thị Kỹ năng Khả tổ hợp (`0-LLM` khi chạy lại) được đối sánh với Tác tử Pure-LLM dùng cùng mô hình `DeepSeek-V3.2`.

**Bảng 4.1 — Hoàn vốn chi phí và độ trễ theo số chu kỳ kiểm thử $N$ (`DeepSeek-V3.2`)**

| Chu kỳ $N$ | Loại dữ liệu | Pure-LLM Calls | Pure-LLM Chi phí | Pure-LLM Thời gian | Skill Graph Calls | Skill Graph Chi phí | Skill Graph Thời gian | Tiết kiệm chi phí |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Đo trực tiếp | 14.4 | `\$0.00544` | 102.3 s | 7 | `\$0.00322` | 5.1 s | 40.81% |
| 5 | Đo trực tiếp | 72.0 | `\$0.02722` | 511.7 s | 7 | `\$0.00322` | 25.4 s | **88.17%** |
| 10 | Ngoại suy (4% drift) | 144.0 | `\$0.05443` | 1,023.4 s | 7 | `\$0.00322` | 50.7 s | 94.08% |
| 25 | Ngoại suy (4% drift) | 360.0 | `\$0.13608` | 2,558.6 s | 8 | `\$0.00443` | 126.9 s | 96.74% |
| 50 | Ngoại suy (4% drift) | 720.0 | `\$0.27215` | 5,117.2 s | 9 | `\$0.00564` | 253.7 s | 97.93% |
| 100 | Ngoại suy (4% drift) | 1,440.0 | `\$0.54430` | 10,234.3 s | 11 | `\$0.00807` | 507.4 s | **98.52%** |

*(Chèn Hình 4.1: `docs/ieee-paper/figures/fig2-rq1-amortization.png`)*

**Nhận xét chính:**
- **Độ tin cậy:** Skill Graph đạt **25/25 (100.0%, Wilson CI `[86.7, 100.0]`)** `VERIFIED_PASS` ở **`0` lần gọi LLM**, vượt trội rõ rệt so với Pure-LLM **11/15 (73.3%, CI `[48.0, 89.1]`)** với ý nghĩa thống kê **Fisher's Exact `p = 0.015`**. Đáng chú ý, Pure-LLM vẫn vượt qua `6/6` lần trên Horilla và `3/3` lần trên luồng 2 người dùng phức tạp nhất — khẳng định baseline không bị làm yếu, nhưng vẫn gặp vòng lặp bước ngẫu nhiên trên `rwa_tx_payment` (`0/3`) và `rwa_bank_create` (`2/3`).
- **Tốc độ:** Trung vị thời gian chạy của Skill Graph là **4.47 giây** (trung bình `5.07 s`) so với **113.25 giây** (trung bình `102.34 s`) của Pure-LLM — **nhanh gấp 20.2 lần** (**Mann-Whitney `U = 0`, `p < 0.001`**, kích thước hiệu ứng lớn tối đa **Cliff's `δ = -1.0`**).
- **Hoàn vốn chi phí:** Tính cả chi phí tác giả hóa ban đầu (`7` calls = `\$0.00322`) và giả định tỷ lệ thay đổi UI định kỳ 4% (1 lần tự phục hồi hộp trắng mỗi 25 lượt chạy), tổng chi phí giảm **88.17%** ngay ở 5 lượt chạy đo thực tế và **98.52%** ở 100 lượt chạy.

---

## 4.3. Phân loại Lỗi, Tự phục hồi và An toàn trên `EvoBench-48` (`RQ2`)

Bộ kiểm chuẩn **`EvoBench-48`** gồm **48 commit đột biến tất định** trên cả hai ứng dụng: **16 `SKILL_DRIFT`** (đổi nhãn, placeholder, nút bấm, trường form bắt buộc trên TSX, Django template và Python `forms.py`), **20 `PRODUCT_BUG`** (lỗi HTTP 500, crash GraphQL mutation, sự kiện click bị nuốt, lỗi im lặng HTTP 200 không lưu DB, hỏng bộ lọc/đăng nhập), và **12 `NO_IMPACT`** (sửa tài liệu, component không liên quan).

**Bảng 4.2 — So sánh 4 cấu hình trên `EvoBench-48` ($N = 48$) kèm Wilson 95% CI và kiểm định thống kê**

| Hệ thống | DRR (Wilson 95% CI) | Attempted Weakening (95% CI) | False Heal Rate (95% CI) | Phát hiện Bug | Số LLM Call | Chi phí ước tính |
|---|---:|---:|---:|---:|---:|---:|
| Static Playwright (`0-LLM`) | 0.0% `[0.0, 19.4]` | 0.0% | 0.0% | 100.0% (20/20) | 0 | `\$0.0000` |
| Black-Box Healer (Không Diff/Gate) | 50.0% `[28.0, 72.0]` | 60.0% `[38.7, 78.1]` | 5.0% `[0.9, 23.6]` | 95.0% (19/20) | 36 | `\$0.0432` |
| Telemetry-Gated (Không Diff) | 81.3% `[57.0, 93.4]` | 0.0% `[0.0, 16.1]` | 0.0% `[0.0, 16.1]` | 100.0% (20/20) | 17 | `\$0.0198` |
| **White-Box Skill Graph (`k ≤ 2`)** | **100.0% `[80.6, 100.0]`** | **0.0% `[0.0, 16.1]`** | **0.0% `[0.0, 16.1]`** | **100.0% (20/20)** | **16** | **`\$0.0191`** |

*(Chèn Hình 4.2: `docs/ieee-paper/figures/fig3-evobench48-ablation.png`)*

**Kết quả nổi bật:**
- **Độ chính xác phân loại và chọn lọc tác động:** Đạt **48/48 (100.0%)** cho cả phân loại 3 trạng thái lẫn chọn chính xác tập kỹ năng bị ảnh hưởng, cắt giảm **80.74%** tổng số lượt thực thi (`57/296`).
- **Tăng trưởng đơn điệu khả năng tự phục hồi (DRR):** Static `0.0%` → Black-Box `50.0%` (`8/16`) → Telemetry-Gated No-Diff `81.3%` (`13/16`) → **White-Box `100.0%` (`16/16`)**. Kiểm định ghép cặp **Exact McNemar** khẳng định sự cải thiện có ý nghĩa thống kê rất cao so với Static (**`p < 0.001`**) và Black-Box (**`p = 0.0078`**). Trên 3 drift phía server/template Django khó (`HOR-D2`, `HOR-D3`, `HOR-D4` sửa trực tiếp `base/forms.py`), chỉ mình White-Box có `git diff` phục hồi thành công trong 1 lần gọi.
- **Đảm bảo an toàn tuyệt đối trước Bug sản phẩm:** Black-Box tiêu tốn gấp **2.25 lần** số lần gọi LLM (`36` vs `16`), cố gắng làm yếu hoặc xóa bỏ postcondition trên **12/20 (60.0%)** lỗi thật (**Fisher's Exact `p < 0.001`** so với `0/20` của White-Box) và gây ra **False Heal sống** trên **`RWA-B8`** (biến lỗi mất dữ liệu giao dịch thành `VERIFIED_PASS`). Ngược lại, White-Box từ chối toàn bộ 20 lỗi thật ở **`0` lần gọi LLM**, đạt **0% False Healing** và **100% phát hiện lỗi**.

---

## 4.4. Khả năng Tổng quát hóa Đa mô hình trên 3 họ LLM (`RQ3`)

Để chứng minh hiệu quả và độ an toàn là **bất biến kiến trúc** chứ không phải đặc thù của một mô hình duy nhất, chúng tôi đánh giá trực tiếp 3 họ LLM đại diện trên cùng tập chuẩn hóa (**8 drift dùng chung**, **4 bug đại diện** trên cả 2 stack, và **2 tác vụ tác giả hóa đa stack**).

**Bảng 4.3 — Đánh giá chéo 3 họ mô hình LLM (`temperature = 0`)**

| Họ mô hình LLM | WB DRR | BB DRR | WB Bug Calls / FHR | BB Weakening / FHR | Tác giả hóa | WB Calls (Chi phí) | BB Calls (Chi phí) |
|---|---:|---:|---:|---:|---:|---:|---:|
| **DeepSeek-V3.2** | **8/8 (100.0%)** | 4/8 (50.0%) | **0 / 0/4 (0%)** | 0/4 / 0/4 | 2/2 | 8 (`\$0.0099`) | 12 (`\$0.0146`) |
| **Gemini-2.5-Flash** | **8/8 (100.0%)** | 7/8 (87.5%) | **0 / 0/4 (0%)** | 1/4 / **1/4** | 1/2 | 9 (`\$0.0212`) | 12 (`\$0.0285`) |
| **GPT-4o-mini** | **8/8 (100.0%)** | 6/8 (75.0%) | **0 / 0/4 (0%)** | 1/4 / 0/4 | 2/2 | 8 (`\$0.0038`) | 12 (`\$0.0050`) |

*(Chèn Hình 4.3: `docs/ieee-paper/figures/fig4-multimodel-panel.png`)*

**Phân tích:**
- Trên **cả 3 họ mô hình**, White-Box đạt tuyệt đối **24/24 (100.0%)** phục hồi drift — đáng chú ý, `Gemini-2.5-Flash` đã cứu thành công `RWA-D5` ở **lần thử thứ 2** nhờ cơ chế phản hồi verifier giới hạn `k ≤ 2` — và giữ vững **0/12 (0%)** False Healing với **`0` lần gọi LLM** trên bug sản phẩm.
- Trái lại, Black-Box không những lãng phí 12 lời gọi LLM trên mỗi mô hình mà còn để `Gemini-2.5-Flash` gây **False Heal sống** trên bug HTTP 500 `RWA-B6` (che giấu hoàn toàn lỗi backend thành xanh) và `GPT-4o-mini` làm yếu oracle trên `HOR-B2`.
- Chi phí vận hành White-Box cực thấp: `GPT-4o-mini` chỉ tốn **`\$0.0038`** (chưa tới nửa xu Mỹ) để tự lành toàn bộ 8 UI drift trên hai ứng dụng.

---

## 4.5. Đánh giá Thực tế trên Lịch sử Git Thật (`RealGit-99`, `RQ4`)

Nhằm kiểm chứng tính ứng dụng thực tế ngoài các đột biến kiểm soát, hệ thống chạy đọc-chỉ (`0-LLM`, không sửa `HEAD`) trên **99 commit liên tiếp trong lịch sử Git gốc** của cả hai kho mã.

**Bảng 4.4 — Lọc tác động `0-LLM` trên 99 commit Git thực tế (`RealGit-99`)**

| Kho mã nguồn mở | Số commit thật | Bỏ qua `NO_IMPACT` | Tỷ lệ giảm lượt test | Độ trễ trung vị | Độ trễ P95 |
|---|---:|---:|---:|---:|---:|
| `cypress-rwa` | 49 | 48/49 (98.0%) | **99.7%** | 0.21 ms | 0.39 ms |
| `horilla` | 50 | 44/50 (88.0%) | **96.0%** | 0.17 ms | 0.33 ms |
| **Tổng hợp** | **99** | **92/99 (92.9%)** | **98.5%** | — | — |

*(Chèn Hình 4.4a: `docs/ieee-paper/figures/fig5-realgit-and-grounding.png`)*

Trên thực tế, hệ thống lọc bỏ chính xác các commit chỉ sửa tài liệu, cấu hình CI/CD, nâng cấp gói phụ thuộc hay phân hệ khác ở tốc độ dưới 1 mili-giây (`0.17–0.21 ms`), đồng thời kích hoạt đúng kỹ năng khi commit chạm mã nguồn liên quan (ví dụ commit `3aab985` sửa `Query.ts` trên RWA, commit `6a9053e` sửa `login.html` và commit `80bea6f` sửa `generic/form.html` trên Horilla).

---

## 4.6. Đánh giá Nâng cấp Grounding Tĩnh, Tác giả hóa và Vòng lặp Kín MCP (`RQ5`)

**Bảng 4.5 — Hiệu quả các nâng cấp Phase A (Static Grounding & Modal Authoring) và Phase B (Unified Graph & MCP)**

| Chỉ số đánh giá | Trước nâng cấp (Baseline) | Sau nâng cấp (Phase A + B) |
|---|---:|---:|
| Độ chính xác `codeRefs` tĩnh (`0-LLM`) | 25.0% (6/24) | **81.0% (17/21)** |
| Tỷ lệ tác giả hóa đa stack (4 luồng) | 75.0% (3/4) | **100.0% (4/4)** |
| Tỷ lệ vượt qua khi tắt Cổng Tổng quát hóa | 0.0% (0/4) | — *(xác nhận vai trò bắt buộc của gate)* |
| Độ chính xác xếp hạng rủi ro Top-1 (`0-LLM`) | 50.0% (2/4) | **100.0% (4/4)** |
| Độ phủ phát hiện lỗi anh em (`Sibling Recall`) | 0.0% (0/2) | **100.0% (2/2)** |
| Vòng lặp kín MCP Stdio sống (`0-LLM`) | Chưa có | **2/2 PASS (`\$0.00`, cô lập 100% `DRAFT`)** |

*(Chèn Hình 4.4b: `docs/ieee-paper/figures/fig5-realgit-and-grounding.png`)*

1. **Grounding tĩnh thay thế tìm kiếm từ khóa:** Chuyển sang `TsWebRouteGrounder` và `DjangoRouteGrounder` loại bỏ hàng loạt tệp nhiễu chéo phân hệ, đưa độ chính xác vi mô của `codeRefs` từ **25% → 81%** (`user.settings_update`: `16.7% → 100%`; `department.delete`: `0% → 83.3%`).
2. **Tác giả hóa nhận biết Modal & Cổng Tổng quát hóa:** Cơ chế ưu tiên phần tử `[MODAL]` và tự đóng overlay hướng dẫn giúp tác giả hóa thành công **4/4 (100%)** — bao gồm luồng xóa bản ghi bảo vệ 3 checkbox `department.delete` vốn thất bại ở baseline. Khi tắt cổng tham số hóa và chạy lại không LLM trên dữ liệu mới, **0/4** kỹ năng vượt qua, chứng minh mọi kỹ năng sinh tự động đều sẽ bị học vẹt nếu thiếu cổng này.
3. **Vòng lặp kín MCP (`0-LLM`, `\$0.00`):** Khởi chạy tiến trình thực `packages/mcp-server/src/cli.ts` qua `stdio` trên cả `RWA-B1` và `HOR-B1`: hệ thống tự xếp hạng đúng kỹ năng rủi ro nhất ở Top-1, xác định `PRODUCT_BUG` không gọi LLM, tự động xuất hồ sơ lỗi `DRAFT` hợp lệ schema (`BUG:cypress-rwa:170917871` và `BUG:horilla:58040835`), biên dịch lại đồ thị tri thức và nâng điểm rủi ro (+5 điểm) cho lần truy vấn kế tiếp trong khi vẫn cô lập tuyệt đối khỏi tập tri thức `CONFIRMED`.

---

## 4.7. Phân tích Lỗi Trung thực và Các Mối Đe dọa Tính Hợp lệ (Threats to Validity)

1. **Lực thống kê riêng của `git diff` so với No-Diff (`p = 0.250`):** Dù White-Box vượt Telemetry-Gated No-Diff tới `+18.7%` (`16/16` vs `13/16`, thắng tuyệt đối `3–0` trên các drift khó ở tầng server/template Django), cỡ mẫu `n = 16` drift chưa đủ đạt mức ý nghĩa hai phía `p < 0.05` riêng cho thành phần `git diff`. Đây là hạn chế cỡ mẫu được ghi nhận trung thực để mở rộng trong nghiên cứu tiếp theo.
2. **Độ phủ kỹ năng trên `RealGit-99`:** Tập kỹ năng hiện tại mô hình hóa `8` luồng trên `cypress-rwa` và `4` luồng cốt lõi trên `horilla` (chưa phủ hết các phân hệ Payroll, Attendance hay Recruitment). Do đó, mức giảm `98.5%` phản ánh cận trên theo độ phủ hiện có, dù hiệu quả lọc bỏ các commit CI/tài liệu/phụ thuộc mang tính tổng quát không phụ thuộc số lượng kỹ năng.
3. **Mở rộng adapter theo framework & thay đổi ngoài tệp nguồn:** Bộ Grounder tĩnh hiện có plugin cho React/Express/GraphQL và Django/HTMX; khi áp dụng sang Angular/Spring Boot hoặc Next.js App Router cần bổ sung plugin tương ứng (~150–250 LOC). Các thay đổi chỉ tác động CSS thuần, biến môi trường hoặc cờ cấu hình ngoài `codeRefs` nằm ngoài phạm vi phát hiện của `git diff`.
4. **Đánh đổi bảo thủ ở tầng Oracle:** Hệ thống ưu tiên an toàn tuyệt đối trước lỗi sản phẩm. Các lỗi thuần thẩm mỹ/bố cục không gắn postcondition sẽ không bị bắt; ngược lại, nếu lập trình viên cố ý đổi đúng chuỗi văn bản đang được kiểm chứng trong postcondition, hệ thống sẽ đánh dấu bảo thủ là `PRODUCT_BUG` để con người duyệt thay vì tự ý sửa mù.
5. **Độ nhạy theo họ LLM ở tác vụ tác giả hóa:** Trong khi tự phục hồi đạt `100%` ở cả 3 họ LLM, tác vụ tác giả hóa từ đầu vẫn phụ thuộc năng lực lập kế hoạch đa bước của mô hình (`DeepSeek-V3.2` và `GPT-4o-mini` đạt `2/2`, `Gemini-2.5-Flash` đạt `1/2`).
