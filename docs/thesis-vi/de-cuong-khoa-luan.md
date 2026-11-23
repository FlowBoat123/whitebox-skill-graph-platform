# Đề cương Chi tiết Khóa luận Tốt nghiệp (5 Chương)

**Đề tài đề xuất (Tiếng Việt):**
*Xây dựng Nền tảng Đồ thị Kỹ năng Hộp trắng Khả tổ hợp kết hợp Đồ thị Tri thức Lỗi cho Kiểm thử Web Tự phục hồi An toàn không dùng LLM khi Chạy lại*

**Tên đề tài tiếng Anh (song hành bài báo IEEE):**
*White-Box Composable Skill Graphs with Defect Knowledge Feedback for Safe, Zero-LLM-Replay Web Verification*

---

## Bản đồ cấu trúc 5 chương (ánh xạ 1-1 tới mã nguồn & dữ liệu thực nghiệm)

### Chương 1 — Tổng quan và Đặt bài toán (~8–10 trang)
- **1.1. Bối cảnh và tính cấp thiết:** Chi phí bảo trì kiểm thử đầu-cuối (E2E) trên ứng dụng Web hiện đại (SPA React/GraphQL, MPA Django/HTMX).
- **1.2. Mâu thuẫn giữa hai hướng tiếp cận hiện nay:**
  - *Script tĩnh (Playwright/Cypress):* Nhanh, chi phí bằng 0, nhưng dễ vỡ khi giao diện thay đổi nhãn/nút bấm (`SKILL_DRIFT`).
  - *Tác tử LLM thuần (Pure-LLM Web Agent) & Black-Box Self-Healer:* Thích nghi động, nhưng chậm gấp ~20×, tốn chi phí token lặp lại mỗi lần chạy và đặc biệt nguy hiểm vì hiện tượng **False Healing** (tự ý làm yếu/xóa assertion để biến bug thật thành xanh).
- **1.3. Mục tiêu nghiên cứu & Câu hỏi nghiên cứu (`RQ1`–`RQ5`).**
- **1.4. Phạm vi và đóng góp chính của khóa luận:** 4 đóng góp kỹ thuật & thực nghiệm.
- **1.5. Bố cục khóa luận.**

### Chương 2 — Cơ sở Lý thuyết và Công trình Liên quan (~12–15 trang)
- **2.1. Kiểm thử giao diện Web tự phục hồi (Self-Healing UI Testing):** WATER (2011), VISTA (2018), các bộ chọn ngữ nghĩa (Playwright Semantic Locators).
- **2.2. Tác tử Web dựa trên Mô hình Ngôn ngữ Lớn:** WebArena, Mind2Web, SeeAct và bài toán hoàn vốn chi phí suy luận trong CI/CD.
- **2.3. Lựa chọn Kiểm thử Hồi quy (Regression Test Selection — RTS):** Ekstazi, STARTS và khoảng trống khi đưa RTS lên tầng E2E đa ngôn ngữ.
- **2.4. Đồ thị Tri thức Lỗi (Defect Knowledge Graph) và Giao thức MCP (Model Context Protocol):** Khái niệm provenance isolation (`DRAFT` vs `CONFIRMED`), JSON-RPC 2.0 stdio transport.
- **2.5. Cơ sở kiểm định thống kê thực nghiệm:** Khoảng tin cậy Wilson 95%, kiểm định chính xác McNemar (ghép cặp), Fisher's Exact, Mann-Whitney $U$ và kích thước hiệu ứng Cliff's $\delta$.

### Chương 3 — Thiết kế Kiến trúc và Phương pháp Đề xuất (~18–22 trang)
*(Chèn Hình 1: `docs/ieee-paper/figures/fig1-architecture.png`)*
- **3.1. Mô hình hình thức hóa Đồ thị Kỹ năng Khả tổ hợp ($G_S$) & Lập kế hoạch điều kiện tiên quyết (Precondition DAG Planner):**
  - Mã nguồn đối chiếu: `contracts/skill-graph/skill.schema.json`, `packages/skill-graph/src/planner.ts`, `validator.ts`.
- **3.2. Bộ ánh xạ Tĩnh Route-to-Code không dùng LLM (`0-LLM` Static Grounder):**
  - Kiến trúc plugin: `TsWebRouteGrounder` (React Router + Express + GraphQL + 1-hop import) và `DjangoRouteGrounder` (`urls.py`/`include()`, `.as_view()`, kế thừa CBV 2 bước, `form_class`, template theo thứ tự ưu tiên theme).
  - Mã nguồn đối chiếu: `packages/skill-graph/src/grounder.ts`.
- **3.3. Bộ phân định Lỗi 3 chiều dựa trên Telemetry & Oracle (`3-Way Telemetry Gate`):**
  - Phân tách chặt `VERIFIED_PASS` / `SKILL_DRIFT` / `PRODUCT_BUG` (HTTP 5xx, JS `pageerror`, kiểm chứng postcondition DOM/URL/API).
  - Mã nguồn đối chiếu: `packages/skill-graph/src/executor.ts`.
- **3.4. Tự phục hồi Hộp trắng Giới hạn (`k ≤ 2`) và Chốt Chặn Tuyệt đối (`0-LLM Refusal`):**
  - Cơ chế tiêm scoped `git diff` + bất biến giữ nguyên cấu trúc postcondition + vòng lặp phản hồi verifier tối đa `k = 2`.
  - Mã nguồn đối chiếu: `packages/skill-graph/src/healer.ts`, `impact.ts`.
- **3.5. Tác giả hóa Kỹ năng Đa tầng Nhận biết Modal & Cổng Tổng quát hóa (`0-LLM` Fresh-Data Gate):**
  - Ưu tiên điều khiển `[MODAL]`, chờ HTMX hydrate, tự đóng tour overlay (`Driver.js`/`Intro.js`/`Shepherd.js`), tham số hóa `{{param}}` và ép chạy lại không LLM trên dữ liệu mới.
  - Mã nguồn đối chiếu: `packages/skill-graph/src/author.ts`.
- **3.6. Hợp nhất Vòng lặp kín với Đồ thị Tri thức Lỗi & Máy chủ MCP cục bộ:**
  - Mở rộng schema `:py:`, `:template:`, `SKILL_GRAPH_VERIFIER` (`contracts/knowledge/`).
  - Cầu nối xuất `DRAFT` bug & `PROPOSED` guardrail (`knowledge-bridge.ts`), không bao giờ tự nâng cấp thành `CONFIRMED`.
  - Bộ chọn kiểm thử theo rủi ro & lan truyền lỗi anh em (`defect-aware-impact.ts`).
  - Máy chủ MCP JSON-RPC 2.0 `stdio` không phụ thuộc ngoài (`packages/mcp-server/`).

### Chương 4 — Triển khai, Thực nghiệm và Đánh giá Hệ thống (~20–25 trang)
*(Bản thảo chi tiết đã soạn sẵn tại [chuong-4-thuc-nghiem-danh-gia.md](file:///c:/Users/ADMIN/Music/defect-intelligence-platform/docs/thesis-vi/chuong-4-thuc-nghiem-danh-gia.md), chèn đầy đủ Hình 2–5 và Bảng I–V.)*
- **4.1. Môi trường triển khai & 2 ứng dụng nguồn mở đối chứng (`cypress-realworld-app` và `horilla`).**
- **4.2. Thiết kế bộ benchmark (`EvoBench-48`, `RealGit-99`, Bảng 3 họ LLM) & kiểm soát công bằng.**
- **4.3. Kết quả `RQ1` — Hoàn vốn chi phí & Độ trễ (Hình 2, Bảng I).**
- **4.4. Kết quả `RQ2` — Phân loại lỗi, Tự phục hồi & Độ an toàn trên `EvoBench-48` (Hình 3, Bảng II).**
- **4.5. Kết quả `RQ3` — Khả năng tổng quát hóa đa mô hình trên 3 họ LLM (Hình 4, Bảng III).**
- **4.6. Kết quả `RQ4` — Khả năng ứng dụng thực tế trên 99 commit Git thật `RealGit-99` (Hình 5a, Bảng IV).**
- **4.7. Kết quả `RQ5` — Đánh giá từng thành phần Phase A (Static Grounding, Modal Authoring) và Phase B (Vòng lặp kín MCP & Lan truyền lỗi anh em) (Hình 5b, Bảng V).**
- **4.8. Phân tích lỗi trung thực & Các mối đe dọa tính hợp lệ (Threats to Validity).**

### Chương 5 — Kết luận và Hướng Phát triển (~4–6 trang)
- **5.1. Tổng kết kết quả đạt được so với mục tiêu đề ra.**
- **5.2. Hạn chế còn tồn tại.**
- **5.3. Hướng nghiên cứu và phát triển tiếp theo:** Mở rộng adapter cho Angular/Spring Boot/Next.js App Router, kết hợp dynamic coverage cho route cấu hình động, mở rộng đánh giá trên kho mã doanh nghiệp > 200 kỹ năng.

---

## Lộ trình hoàn thiện đề xuất (từ nay đến Bảo vệ Tháng 6 năm sau)

| Giai đoạn | Công việc chính | Sản phẩm đầu ra |
|---|---|---|
| **Đã hoàn thành** | Thiết kế, lập trình, kiểm thử đơn vị (517 tests), benchmark live `EvoBench-48` + `RealGit-99` + 3 LLM + MCP closed-loop + 5 hình vẽ IEEE + bản thảo bài báo `main.tex` & Chương 4 tiếng Việt | Kho mã hoàn chỉnh, `docs/ieee-paper/`, `docs/thesis-vi/` |
| **Tháng 1–2** | Tải `docs/ieee-paper/` lên Overleaf, điền thông tin tác giả/GVHD, gửi GVHD phản biện bản thảo bài báo IEEE | Bản thảo bài báo sẵn sàng nộp hội nghị (RIVF / KSE / ASE / ICSME / ISSRE) |
| **Tháng 3–4** | Viết hoàn thiện Chương 1, 2, 3, 5 của Khóa luận theo khung đề cương trên (ghép thẳng Chương 4 và Hình 1–5) | Bản thảo đầy đủ Khóa luận tốt nghiệp (~65–80 trang) |
| **Tháng 5** | Hiệu chỉnh theo góp ý GVHD, chuẩn bị slide bảo vệ (15–18 slide) và tập dượt kịch bản Demo offline 5 phút | Quyển Khóa luận bản in + Slide + Demo mượt |
| **Tháng 6** | Bảo vệ Khóa luận trước Hội đồng (chạy `scripts/skill-graph-defense-demo.ts` offline `0-LLM` tại chỗ) | Bảo vệ thành công |
