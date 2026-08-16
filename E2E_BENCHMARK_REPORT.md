# Báo cáo E2E Benchmark — Codebase Cognitive Memory trên project thực tế

> **Cập nhật 2026-08-16 — xem `E2E_BENCHMARK_MULTI_REPO.md`.** Lần chạy sau
> (2 repo: zod + lodash-es) phát hiện metric xếp hạng của báo cáo này đo nhầm:
> `buildContext` sắp xếp `sourceFiles` theo **thứ tự alphabet** sau khi cắt
> top-K, nên MRR/hit@1 ở §4 đang đo vị trí alphabet chứ không phải độ liên
> quan. Đo lại theo thứ tự traversal thật: MRR 0,34 vs grep 0,34 — **hoà, không
> phải "+15%"**. Các số recall và toàn bộ §3, §5 không bị ảnh hưởng.

**Ngày chạy:** 2026-08-11 · **Môi trường:** sandbox Linux, Node 22.22, Postgres 16 + pgvector 0.6 (local) · **Nhánh code:** `claude/e2e-benchmark-setup-yvnqj5` (base: M9, toàn bộ roadmap M0–M9 đã hoàn thành) · **Harness:** `eval/e2e-benchmark/` · **Dữ liệu thô:** `eval/e2e-benchmark/results/*.json`

## 1. Câu hỏi benchmark trả lời

Toàn bộ test/eval hiện có của repo đều chạy trên fixture tự viết. Benchmark này trả lời câu hỏi mà chúng không trả lời được: **hệ thống memory này có thực sự giúp ích khi gặp một codebase thật, chưa từng thấy, hay không?**

Ba lớp đo, từ trong ra ngoài:

1. **Ingest** — pipeline extraction → Postgres → embedding có chạy nổi trên code thật không, mất bao lâu, bắt được bao nhiêu?
2. **Chất lượng retrieval** — với 12 câu hỏi developer thực tế, `runPipeline(question)` có trỏ đúng file chứa câu trả lời không, so với baseline grep từ khóa (thứ một agent không có memory sẽ làm)?
3. **Độ hữu dụng với agent thật** — cùng một agent `claude` headless, cùng model, cùng tools, trả lời cùng câu hỏi trong repo zod, **có vs không có** memory context: độ chính xác, số turns, thời gian, chi phí khác nhau thế nào?

## 2. Test project & phương pháp

- **Target:** [zod](https://github.com/colinhacks/zod) v4 — `packages/zod/src/v4/{classic,core}`, 29 file production TypeScript, ~42.000 dòng. Một thư viện thật, phổ biến, không liên quan gì đến fixture của repo này.
- **Bộ câu hỏi:** 12 câu hỏi kiểu developer ("email validation regex nằm ở đâu?", "z.coerce.number() hoạt động thế nào?"...), mỗi câu được gán nhãn tay 1–2 file ground-truth **sau khi tự kiểm tra source zod** (xem `eval/e2e-benchmark/src/tasks.ts`).
- **Metric retrieval:** recall@10, MRR, hit@1 trên danh sách `sourceFiles` của `AgentContext` trả về, so với baseline tìm kiếm từ khóa naive trên cùng tập file.
- **Hai biến thể traversal reasoner:** heuristic (ngưỡng điểm §11, không LLM) và **Claude thật** (`claude -p`, model haiku, 1 call/depth level đúng thiết kế spec §10).
- **Agent comparison:** 6 câu hỏi × 2 điều kiện, `claude -p` (haiku) với tools Read/Grep/Glob, cwd = repo zod. Điều kiện `memory` được tiêm rendered `AgentContext` vào prompt. Chấm tự động: câu trả lời có nêu đúng file/symbol ground-truth không.

**Giới hạn phương pháp (đọc trước khi tin số):** n=12 câu hỏi trên 1 codebase, mỗi cấu hình chạy 1 lần — đủ để thấy xu hướng, không đủ ý nghĩa thống kê. Embedding là **fake hash-embedder** (token-overlap) vì môi trường không có embedding API thật — leg vector yếu hơn thực tế có thể đạt. 2 experience episodic được seed **tổng hợp** (đánh dấu `[synthetic]`) chỉ để chứng minh đường đọc episodic hoạt động e2e.

## 3. Kết quả lớp 1 — Ingest trên code thật

| Chỉ số | Giá trị |
|---|---|
| File parse được | 29 |
| Nodes / edges ghi vào Postgres | 371 / 834 |
| Phân loại node | 29 file, 326 function, 6 class, 10 method |
| Thời gian: extract / persist / index embedding | 2,9s / 0,9s / 2,2s (**tổng ~6,5s**) |

Pipeline extraction → event log → embedding **chạy trọn vẹn, không lỗi, nhanh** trên codebase lạ.

**Phát hiện quan trọng nhất của cả benchmark nằm ở đây:** zod v4 định nghĩa hầu hết schema qua pattern `export const X = $constructor(...)` và arrow function — extractor MVP (chỉ bắt `function`/`class`/`method` khai báo trực tiếp) **không nhìn thấy chúng**. 42k dòng code → chỉ 6 class. Những gì không thành node thì traversal không bao giờ với tới được — đây là trần recall của toàn hệ thống (thấy rõ ở lớp 2).

## 4. Kết quả lớp 2 — Chất lượng retrieval (12 câu hỏi)

Tổng hợp (recall@10 / MRR / hit@1 / latency trung bình):

| Cấu hình | Recall@10 | MRR | Hit@1 | Latency | Context (chars) |
|---|---|---|---|---|---|
| **Hệ thống — heuristic reasoner** | 0,79 | **0,38** | **0,25** | 31ms | 4.450 |
| **Hệ thống — Claude reasoner thật** | 0,79 | **0,39** | **0,25** | 34.988ms | **1.703** |
| Baseline grep từ khóa | **0,83** | 0,33 | 0,08 | 3ms | — |

Chi tiết từng task (heuristic vs baseline):

| Task | Sys R@10 | Base R@10 | Sys MRR | Base MRR |
|---|---|---|---|---|
| email-regex | **0,00** | 1,00 | 0,00 | 1,00 |
| coerce | 1,00 | 1,00 | **1,00** | 0,20 |
| discriminated-union | 1,00 | 1,00 | 0,14 | 0,17 |
| to-json-schema | **1,00** | 0,50 | 0,20 | 0,20 |
| safe-parse | 1,00 | 1,00 | 0,33 | 0,50 |
| error-map | **0,00** | 0,50 | 0,00 | 0,50 |
| registry-meta | 1,00 | 1,00 | 0,25 | 0,17 |
| string-checks | 1,00 | 1,00 | 0,20 | 0,25 |
| iso-datetime | **1,00** | 0,50 | **1,00** | 0,13 |
| standard-schema | 0,50 | 0,50 | 0,11 | 0,13 |
| pipe-transform | 1,00 | 1,00 | 0,33 | 0,50 |
| from-json-schema | 1,00 | 1,00 | **1,00** | 0,25 |

Đọc kết quả:

- **Hệ thống KHÔNG thắng grep về recall** (0,79 vs 0,83). Trên codebase có tên file mô tả tốt như zod, grep từ khóa đơn giản đã là baseline rất mạnh.
- **Hệ thống thắng về xếp hạng**: MRR +15%, hit@1 gấp 3 lần (0,25 vs 0,08) — khi tìm thấy, nó đặt file đúng lên đầu tốt hơn.
- **2/12 task fail hoàn toàn (email-regex, error-map) đều cùng một nguyên nhân:** file ground-truth (`regexes.ts`, `errors.ts`, `config.ts`) chứa toàn `export const` — không có node nào đại diện nội dung của chúng trong graph, seed lexical trỏ sang file khác và traversal không có cạnh nào dẫn tới. **Trần coverage của extractor trực tiếp thành trần recall.** Đây không phải lỗi retrieval — nó tìm đúng trong những gì graph có.
- **Claude reasoner thật không tăng recall** (đúng như thiết kế — nó chỉ quyết định expand/skip trong những gì được offer) nhưng **cắt 62% nhiễu khỏi context** (1,7k vs 4,4k chars) nhờ skip các nhánh không liên quan. 21 call, 0 lỗi parse, ~20s/call — giao thức "một call LLM mỗi depth level" của spec §10 hoạt động đúng và ổn định với LLM thật. Đổi lại latency 35s/câu hỏi vs 31ms.
- Retrieval lexical (pg_trgm) trên câu hỏi ngôn ngữ tự nhiên có seed khá nhiễu — ví dụ "discriminated **union**" match cả function `g**uid**` vì trigram trùng. Leg vector với embedding thật sẽ gánh phần này tốt hơn fake embedder.
- Episodic memory nổi lên đúng trong context ở 6/12 task (các task chạm `schemas.ts`/`checks.ts` có seed experience) — đường đọc episodic hoạt động e2e.

## 5. Kết quả lớp 3 — Agent thật, có vs không có memory

6 câu hỏi × 2 điều kiện, cùng model (haiku), cùng tools, cùng repo. Context tiêm vào là bản của biến thể Claude-reasoner (bản gọn):

| | Bare (không memory) | **Memory** | Chênh lệch |
|---|---|---|---|
| Độ chính xác file (mean) | 0,83 | 0,83 | **bằng nhau** |
| Độ chính xác symbol (mean) | 1,00 | 1,00 | bằng nhau |
| Số turns trung bình | 10,3 | **7,3** | **−29%** |
| Thời gian trung bình | 28,7s | **21,1s** | **−27%** |
| Tổng chi phí 6 câu | $0,585 | **$0,404** | **−31%** |

Từng task (turns bare → memory):

| Task | Bare | Memory | Ghi chú |
|---|---|---|---|
| registry-meta | 11 | **2** | context trỏ thẳng `registries.ts` — agent trả lời gần như tức thì |
| discriminated-union | 17 | **4** | giảm 4× số turns |
| safe-parse | 6 | **3** | giảm một nửa |
| standard-schema | 7 | **5** | giảm nhẹ |
| email-regex | 7 | 11 | **memory phản tác dụng** — context trỏ nhầm hướng (đúng task hệ thống fail ở lớp 2), agent mất thêm turns kiểm chứng |
| coerce | 14 | 19 | tương tự — context nhiễu làm agent xác minh thêm |

Đọc kết quả:

- **Độ chính xác cuối không đổi** — một agent có tools tự tìm ra câu trả lời trên codebase này dù có memory hay không (zod dễ grep). Giá trị của memory ở đây **không phải đúng hơn, mà là rẻ hơn và nhanh hơn**: −29% turns, −31% chi phí.
- **Tương quan rõ với chất lượng retrieval:** 4 task retrieval tốt → tăng tốc mạnh (có task giảm 5× số turns); 2 task retrieval kém → **chậm hơn** bare. Memory context sai là *nợ*, không phải tài sản — agent phải trả thêm turns để gỡ.
- Suy ra: cải thiện recall của lớp dưới (extractor coverage) sẽ chuyển thẳng thành tiết kiệm chi phí ở lớp agent.

## 6. Kết luận: có tác dụng trong đời thực không?

**Có — nhưng đúng ở chỗ nó được thiết kế để có, và với các điều kiện rõ ràng.**

Những gì benchmark chứng minh được:

1. **Toàn pipeline sống sót với code thật, không chỉnh sửa gì** — clone zod, 6,5s ingest, `runPipeline` trả `AgentContext` hợp lệ cho cả 12 câu hỏi, tích hợp LLM thật vào traversal chạy đúng giao thức, 0 lỗi. Với một hệ thống build hoàn toàn bằng agent tự trị qua 9 milestone, đây không phải điều hiển nhiên.
2. **Giá trị thực tế đo được: giảm ~30% chi phí/thời gian/turns cho agent** khi retrieval trúng — và retrieval trúng 10/12 task. Nhân con số này với hàng nghìn task agent/tháng thì đây là giá trị thật.
3. **Xếp hạng tốt hơn grep** (hit@1 ×3) — đúng vai trò "đưa chỗ đúng lên đầu" của một memory layer.

Những gì nó chưa làm được (trung thực):

1. **Chưa vượt grep về recall** trên codebase dễ grep. Lợi thế thật sự của graph memory (câu hỏi đa bước, codebase lớn nhiều repo, tri thức tích lũy qua session) nằm ngoài phạm vi benchmark 1 codebase này.
2. **Trần cứng là extractor coverage:** không bắt `export const` arrow function / pattern `$constructor` → 2/12 task fail từ gốc. Đây là điểm đáng sửa nhất toàn hệ thống hiện nay.
3. **Hai lớp "cognitive" nhất chưa được kiểm chứng thật:** semantic promotion chưa có nguồn LLM-observation thật, episodic mới chạy với experience tổng hợp. Giá trị dài hạn của hệ thống nằm ở hai lớp này — benchmark theo session dài là bước tiếp theo tự nhiên.
4. Retrieval đang dựa gần như hoàn toàn vào lexical leg + tên file; cần embedding thật để đánh giá đúng leg vector.

### Khuyến nghị ưu tiên (theo tác động đo được)

1. **Mở rộng extractor bắt `export const` arrow/call-expression** (sửa 2/12 task fail → recall dự kiến ~0,95, và giảm nốt 2 case memory-phản-tác-dụng ở lớp agent).
2. **Wire một embedding provider thật** (interface đã có sẵn, chỉ thiếu provider) và đo lại leg vector.
3. **Sinh `summary` cho node bằng LLM lúc ingest** — embedding text hiện chỉ có tên + đường dẫn, quá nghèo để leg vector hữu ích.
4. Dùng Claude reasoner có chọn lọc: bật khi cần context gọn (tiết kiệm 62% tokens phía agent), tắt khi cần latency (heuristic 31ms đã đủ cho recall ngang bằng).

## 7. Tái lập kết quả

```bash
git clone --depth 1 https://github.com/colinhacks/zod.git /tmp/zod
export ZOD_DIR=/tmp/zod
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"
bash scripts/setup-dev-db.sh && pnpm install && pnpm migrate && pnpm build

pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:ingest
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run                      # heuristic
BENCH_REASONER=claude pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run # LLM reasoner
BENCH_CONTEXTS=$PWD/eval/e2e-benchmark/results/contexts-system-claude.json \
  pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:agent                   # cần claude CLI
```

Toàn bộ số liệu trong báo cáo đọc từ `eval/e2e-benchmark/results/` (commit kèm nhánh này): `ingest.json`, `run-system-heuristic.json`, `run-system-claude.json`, `contexts-*.json`, `agent-compare.json`.
