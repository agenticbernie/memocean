# Thị trường và giả thuyết PMF của MemOcean

**TL;DR:** Nên kiểm chứng MemOcean như một lớp bàn giao tri thức có nguồn cho developer Avalanche, không như “AI memory đầu tiên”. Memory/rules và self-hosting đã giải quyết nhiều việc bằng Web2. Marketplace chỉ đáng xây tiếp nếu capsule giúp hoàn thành nhiệm vụ tốt hơn baseline Git rules và có người thực sự trả tiền.

**Baseline 17-11-2026:** chưa phỏng vấn, chưa có người dùng, doanh thu hoặc bằng chứng product–market fit (PMF — sản phẩm phù hợp nhu cầu thị trường). Tài liệu phân biệt **[Nguồn]** dữ kiện công bố, **[Giả thuyết]** nhận định sản phẩm và **[Thí nghiệm]** phép kiểm sắp chạy. Không suy số builder, deadline hoặc quy định UniHack từ tên cuộc thi. Avalanche ecosystem là định hướng product brief, eligibility/prize/submission rules cần BTC xác nhận.

Liên kết [kiến trúc](ARCHITECTURE.md), [database](DATABASE_SCHEMA.md), [contract](SMART_CONTRACT_SPEC.md), [MCP](MCP_SPEC.md), [roadmap](ROADMAP.md).

## 1. Vấn đề thật cần tách khỏi lời hứa marketing

### Handoff và lỗi lặp lại

**[Giả thuyết]** Trong phiên làm việc dài, kiến thức quan trọng thường nằm giữa transcript, issue, code review và quyết định của lead. Người đổi agent, máy hoặc project phải tìm lại: quy ước nào đang có hiệu lực, anti-pattern nào vừa gây lỗi, ví dụ nào đã test. Dump toàn log làm nhiễu và dễ lộ secret. MemOcean chọn distilled **Rules, Anti-patterns, Few-shot Examples**, có scope/time/importance/evidence, thay vì lưu vô hạn mọi câu nói.

**[Nguồn]** Các công cụ đã có project memory/rules và context persistence. Claude Code hỗ trợ CLAUDE.md và auto memory; Cursor hỗ trợ rules/AGENTS.md. Git chia sẻ file rules tốt, review được, không cần blockchain. Đây là bằng chứng vấn đề có người quan tâm, **không** phải bằng chứng họ cần một nhà cung cấp mới hoặc sẽ mua capsule.

**[Nguồn nhu cầu rộng, không capsule demand]** Stack Overflow Survey2025 báo78,5% người trả lời câu dùng AI đã dùng AI,83,8% dùng hoặc dự định;45,7% distrust so32,7% trust;66% gặp output “gần đúng”,45,2% thấy debug AI code tốn thời gian hơn. Mẫu từng câu khác nhau:33.662 usage,33.244 trust,31.476 frustrations. Methodology có49.009 responses/177 quốc gia, fieldwork29-05 đến23-06-2025, tuyển chủ yếu qua kênh Stack Overflow và tự chọn; không đại diện thị trường hoặc causal productivity. Stack Overflow độc lập với MemOcean nhưng có lợi ích thương mại knowledge sharing.

**[Nguồn đối chứng có thời hạn]** METR10-07-2025 đo16 developers giàu kinh nghiệm/246 tasks với early2025 tools, thấy mất thời gian hơn19%; chính trang đã đánh dấu kết quả cũ. Update24-02-2026 gồm57 developers/143 repos/>800 tasks: returning cohort thời gian -18% (CI -38% đến+9%), new cohort -4% (CI -15% đến+9%). Cả hai khoảng tin cậy chứa zero, có selection/task-withholding bias; không ước lượng đáng tin lợi ích hiện tại. Không dùng study cũ bảo AI nay luôn chậm hoặc study mới chứng minh capsule giúp nhanh. Benchmark MemOcean phải đo task thật so Git rules/docs, không lấy mức dùng AI làm willingness-to-pay.

### Cross-machine/team không đơn giản là “không có sync”

- Git rules đã sync qua máy và team khi cùng repo, có merge/review/history. Một SaaS memory API cũng có thể dùng chung nhiều client.
- Memory cục bộ/user preference có thể khác project policy; sync mọi thứ có thể **gây lỗi**, lộ dữ liệu hoặc kéo kiến thức cũ sang project mới.
- “Team memory” cần permission, ai duyệt, người rời team, thời hạn và conflict resolution. Một shared vector collection chưa đủ.
- MemOcean có giá trị nếu giảm công sức **curation, provenance, retrieval theo project/time và reuse có license**. Không nên cạnh tranh chỉ bằng “lưu lại prompt”.

## 2. ICP và beachhead

ICP — ideal customer profile — là nhóm có vấn đề đủ thường xuyên và quyền quyết định dùng/mua.

| Vai trò | Công việc cần hoàn thành | Vì sao thử / vì sao từ chối |
|---|---|---|
| Senior/tech lead | Chuyển lessons đã review thành rules cho agent/team | Có chuẩn chất lượng; có thể chỉ cần Git và không muốn gửi IP ra ngoài |
| OSS maintainer | Đóng gói pitfalls/working examples theo version | Có nguồn công khai, license cần rõ; không muốn tăng support burden |
| Indie builder/vibe coder | Ship app và tránh lỗi nền tảng lặp lại | Dễ thử nhưng ngân sách thấp, cần proof hơn claims |
| Startup team nhỏ | Onboard người/agent mới, kiểm soát sai sót | Có subscription buyer; security/data ownership có thể chặn |

**Beachhead đề xuất:** developer đang build dApp Avalanche và cần workflow Fuji → chuẩn bị production: chain/network config, deployment, wallet/auth, event-indexing, review access/reorg. Capsule đầu tiên phải là kinh nghiệm **đã kiểm bằng bài tập**, không repack docs chính thức trả phí. Không bán capsule “bảo đảm smart contract an toàn”.

**Buyer/job-to-be-done:** “Khi agent mới vào repo dApp, tôi muốn áp dụng quyết định đã duyệt và tránh lỗi từng mắc, để hoàn thành thay đổi có nguồn kiểm chứng mà không đọc lại cả lịch sử.” Lead trả subscription cho private memory/inference; builder mua một version capsule nếu nó giải quyết task đang cần. Seller là expert có evidence + quyền phân phối, không phải mọi người upload raw log.

**Không nhắm trước:** tổ chức đòi zero knowledge/end-to-end encrypted search, regulated PII, generic enterprise knowledge search, mọi blockchain hoặc agent tự học hoàn toàn. Kiến trúc escrow/index hiện tại không đáp ứng những promise này.

## 3. Competitive baseline theo nguồn

So sánh tính năng dựa trên tài liệu công khai, truy cập **17-11-2026**, không phải test benchmark. “Khác” không có nghĩa vendor không thể bổ sung. Không suy lock-in từ việc có hosted plan.

| Giải pháp | Điểm mạnh/khả năng đã công bố | Hạn chế với job này / giả thuyết khoảng trống | Điều MemOcean phải chứng minh |
|---|---|---|---|
| [Mem0](https://docs.mem0.ai/) | Memory API, open-source/self-hosted; raw get_all có pagination và export theo schema | Export/permission/curation workflow tùy cấu hình; không được nói “không export” | Một capsule có evidence và task eval tốt hơn chỉ memory retrieval |
| [Zep](https://help.getzep.com/) + [Graphiti](https://github.com/getzep/graphiti) | Context/temporal knowledge graph; Graphiti open-source | Hosted Zep và OSS Graphiti không phải cùng feature set/operational model | Project/time semantics, effort curation và chi phí đo thực |
| [LangMem](https://langchain-ai.github.io/langmem/) | SDK tạo/quản lý memory, tích hợp workflow/store | Là building block; team tự làm product/security/retrieval governance | Giảm integration burden đủ để đáng trả tiền, không chỉ wrapper |
| [PromptBase](https://promptbase.com/) | Marketplace prompts, có supply/demand cho tài sản prompt | Prompt listing không đồng nhất versioned evidence-backed capsule; không được suy toàn bộ buyer cần RAG/MCP | Try-before-buy theo task và sync version license tạo thêm giá trị |
| [Claude Code memory](https://code.claude.com/docs/en/memory) | CLAUDE.md + auto memory, project/user scope | Cross-tool governance cần người thiết kế; không thiếu memory cơ bản | Retrieval có ACL/time + citations giúp hơn file rules |
| [Cursor rules](https://docs.cursor.com/context/rules) | Git-shareable rules, AGENTS.md, scoped instruction context | Curation/version compatibility vẫn cần owner; nhiều use case đã đủ | Không tăng setup friction quá lợi ích |
| Git rules + docs + tự host PG/vector | Rẻ, reviewable, portable, kiểm soát dữ liệu | Team chịu ingestion/auth/eval/ops; có thể hoàn toàn chấp nhận được | Total effort và outcomes tốt hơn baseline này |

Mem0 OSS Apache-2.0 có thể self-host nhưng default model APIs không mặc định local-only; hosted get_all cần đi hết pagination mới lấy đủ records. Schema-driven export là transformed output, không hứa lossless backup/restore. Zep managed và Graphiti Apache-2.0 không đồng nhất; temporal/provenance không tự xác nhận fact ngoài đời. LangMem MIT có namespace/store primitives; InMemoryStore mất sau restart, production cần DB-backed store. Namespace không là chuẩn semantic portability xuyên vendor.

PromptBase help/fees hiện công bố marketplace20%, seller referral0% theo điều kiện attribution30ngày, custom jobs10%; listing free. Đây là nguồn mô tả model kinh doanh, không phải GMV/conversion của họ hoặc demand capsule của ta. Buyer nhận license, không chuyển copyright. MemOcean đề xuất10% độc lập, không sao chép fee như market validation.

Không có so sánh vendor pricing tuyệt đối vì model/storage/plan thay đổi. Cần benchmark cùng corpus, user permissions, task và ngân sách. MemOcean không cần thắng mọi chiều; nếu Git rules tốt tương đương, nên export Git thay vì ép marketplace.

## 4. Web2 làm tốt phần nào, crypto đáng dùng ở đâu?

Web2 giải quyết memory/retrieval/auth/versioning/backup rất tốt bằng PostgreSQL, object storage, keys và APIs. Mua capsule có thể thực hiện qua payment provider thông thường. Blockchain **không bắt buộc** cho PMF private memory.

Giá trị crypto có thể độc lập với model provider:

1. **Public payment receipt + automatic revenue allocation:** on-chain AVAX purchase, seller/platform credits rút sau; không dựa vào một CSV payout riêng.
2. **Version commitment:** buyer đối chiếu ciphertext/manifest digest với version đã trả tiền, kể cả catalog đổi nội dung.
3. **Storage durability lựa chọn:** Irys hiện mô tả permanent Publish Ledger với ingress proofs/funding, tách với storage term30ngày/1năm và devnet≈60ngày. Protocol có permanent mode là fact đã có nguồn; SDK selection/finalized verification/funding của MemOcean vẫn là blocking spike, upload ID không chứng minh Publish inclusion.

Giới hạn không được che: hash đúng không có nghĩa tri thức đúng; timestamp không chứng minh tác giả gốc; license không tự chuyển copyright; permanent không đồng nghĩa available mọi lúc; central server vẫn giữ key escrow và index plaintext; buyer đọc được có thể copy. Fuji test AVAX không phải paid conversion bằng tiền thật. Nếu nhóm chỉ cần private memory hoặc không dùng ví, cung cấp export và cân nhắc payment Web2 là pivot hợp lý.

## 5. Sản phẩm tối thiểu và chất lượng supply

Ba trụ cột không bỏ: **distilled private memory → cited RAG → purchased capsule sync MCP**. Demo chỉ cần một project, một capsule chất lượng và hai wallet; không cần hàng trăm listing, token hoặc recommender.

Acceptance quality cho một capsule thử nghiệm:

- Tác giả xác nhận quyền phân phối nguồn/code và license; provenance locator có thể review.
- Rules scoped, anti-patterns có correction/exception, few-shot có kết quả đúng/sai giải thích được.
- Có ít nhất 3 task độc lập đánh giá được, version/software assumptions rõ; không chỉ độ dài corpus.
- Không secret/PII, không trả phí cho tư liệu OSS trái license; attribution/redistribution obligations theo nguồn.
- Preview nhỏ là derivative duyệt riêng, không entire corpus. Trial tối đa3 câu/user/root, không bypass khi đổi version/key.
- Có known limitations và update policy; mua pin version, không hứa cập nhật miễn phí mọi version.

Cold start: team tự curate 1–3 capsules với expert partner có consent, làm concierge onboarding và task comparison. Không seed review/fake sale hoặc dùng ví team tự mua để công bố traction. Marketplace GMV team-demo phải ghi “testnet demonstration”. Một kho lớn nội dung AI chưa review là liability hơn là lợi thế supply.

## 6. Funnel “100 builders” là kế hoạch, không traction

**Có hai mục tiêu riêng:** cohort khám phá100 người và mục tiêu supply100 distinct builders, mỗi người có ≥1 vetted published capsule. Cohort discovery không được thay thế mục tiêu100 publishers.

### 6.1 Cohort discovery ban đầu

**[Thí nghiệm/giả định]** Cohort đầu là **100 người được mời có chủ đích**, không 100 registrations hay active users. Mỗi người gán một role chính để tránh double-count: 40 indie/vibe builders, 30 seniors/leads, 20 startup developers, 10 OSS maintainers. Nhóm role có thể overlap ngoài thống kê cohort.

| Bước | Target giả định | Tỷ lệ giả định, không quan sát |
|---|---:|---:|
| Mời đủ điều kiện, có task Avalanche | 100 | Denominator cố định |
| Phản hồi | 40 | 40% được mời |
| Phỏng vấn problem-first | 25 | 25% được mời |
| Hoàn thành task comparison | 12 | 12% được mời |
| Tự dùng lại trong 7 ngày | 8 | 8% được mời |
| Dùng lại tuần 2 trong task thật | 4 | 4% được mời |
| Chấp nhận thử trả tiền thật hợp pháp sau demo | 2 | 2% được mời; Fuji không tính |

Đây là ngưỡng học hỏi ban đầu, không forecast conversion đáng tin. Nếu chỉ reach được cohort khác thì báo denominator thực và selection bias. Kênh: maintainer introductions có consent, Avalanche developer communities tuân rules, office hours, bài viết task teardown có evidence, GitHub discussions liên quan — không spam issues hoặc scrape email.

Workload giả định: 100 outreach cá nhân ×8 phút ≈13 giờ; 25 interviews ×30 phút + notes ≈19 giờ; 12 task tests ×60 phút + chuẩn bị ≈18 giờ; onboarding/follow-up ≈15 giờ; tổng gần **65 giờ** trước engineering. Một team nhỏ nên chia hai tuần discovery và giới hạn số concierge slots. Ghi cả người từ chối, không chỉ testimonials hài lòng.

### 6.2 Thu hút100 builders thực sự đóng gói và xuất bản capsule

**[Giả thuyết kế hoạch, không traction]** Sau gates chất lượng/retention của pilot, nhắm **100 user suppliers riêng biệt có ≥1 capsule approved + artifact verified/indexed + listing published**, không100 invitations,100 wallets hay100 drafts. Catalog count và publisher count tách riêng; capsule do cùng seller tạo10 version vẫn một publisher. Team-seeded capsule không tính vào100 independent publishers. Timeline giả định12–16 tuần sau demo, điều chỉnh theo budget/evidence, không deadline hackathon.

| Supply funnel | Target giả định | Conversion giả định |
|---|---:|---:|
| Qualified personalized supplier outreach | 1.000 | Denominator |
| Có interest + quyền đối với nguồn | 400 | 40% outreach |
| Hoàn thành draft theo template | 200 | 50% interested |
| Qua review hoặc hoàn thành vòng sửa | 140 | 70% drafts |
| ≥1 vetted published capsule / distinct builder | **100** | 71,4% reviewed;10% outreach |

Các tỷ lệ chưa được kiểm chứng. Triển khai wave10→30→100, chỉ tăng wave nếu chất lượng và workload đo được; không ép100 bằng auto-publish. Supply mix mục tiêu:60 Avalanche builders có workflow thực,20 leads/consultants,20 OSS maintainers liên quan; không gán người ngoài hệ sinh thái vào Avalanche traction chỉ vì tạo wallet.

Workload giả định:1.000 outreach×6phút=100giờ;200 draft onboarding×30phút=100giờ;140 review×90phút=210giờ; sửa bài/support/takedown dự phòng90giờ, tổng **500 giờ**. Hai curator làm20giờ/tuần/người cần khoảng12,5tuần chưa tính engineering. Chi phí permanent publication, reviewer capacity và incentive budget phải có owner; grant/subsidized publishing được ghi riêng, không tính organic willingness-to-pay. Thưởng cho task quality/reuse evidence, không thưởng số ví/listing vô nghĩa.

Acquisition offer: template+office hours, review miễn phí wave đầu có cap, attribution/license rõ, demo task để seller chứng minh expertise,90% sale credits và referral links không thay economics on-chain. Không trả “yield” hoặc token incentive. Supplier có thể export artifact/schema và rời catalog; perpetual copyright/usage obligations vẫn theo license.

### 6.3 Growth loop Avalanche đo được

**Task reuse thành công → seller có thu nhập thật/rating theo task → seller referral expert mới → thêm capsule tích hợp Avalanche đã test → builder mới hoàn thành integration → reuse tiếp.** Đo bằng unique independent users/publishers, successful task reuse, referrals→activated builder, independent paid buyers, repeat60day và seller net receipts sau gas. Có thể đo repository/demo integration khi user đồng ý; không đồng nhất wallet-created hoặc testnet tx count với ecosystem adoption. Mục tiêu đề xuất100 publishers cung cấp ≥20 tested Avalanche integration recipes, mỗi recipe có task rubric/version. Đếm phần vượt baseline docs/Git, không đếm copy docs. Nếu reuse/seller income không xuất hiện, loop chưa hoạt động dù đủ100 publisher.

## 7. Business model và unit economics

- Capsule sale: **90% seller / 10% platform**, snapshot theo listing; không collaborator split v1. Platform không dùng upload wallet làm treasury. Gas do buyer trả, withdrawal gas do recipient trả; UI minh bạch.
- Subscription private memory/team: trả cho inference, embeddings, managed DB/ops và giới hạn sử dụng. Capsule fee nhỏ không tự nuôi free inference không giới hạn.
- Không token, staking hoặc yield. Không dùng giá AVAX tăng làm luận điểm sustainability.

Công thức theo tháng (USD quy đổi tại thời điểm đo, ghi nguồn tỷ giá):

`contribution = subscription receipts + 0.10 × capsule GMV − generation tokens − embedding tokens − storage upload/funding − managed infra allocation − payment/support/abuse costs`.

Gas nếu platform sponsor phải thêm vào chi phí; không bỏ qua preview queries, retries, failed uploads hoặc reindex. AVAX volatility làm fee USD biến động; có thể quote giá tham khảo fiat nhưng on-chain settle chính xác wei. Refund pháp lý/payment policy và refund contract là hai vấn đề khác; v1 contract không có automatic purchase refund.

**SaaS worked hypothesis:** thử19 USD/user/tháng, không phải giá vendor hoặc willingness-to-pay đã xác nhận. Giả định inference+embeddings3 USD, index/storage0,80 USD, observability0,70 USD, support1 USD =5,50 USD/user; contribution13,50 USD≈71% trước CAC, thuế và fixed engineering. Chi phí cố định giả định200 USD/tháng cần `ceil(200/13,5)=15` paid users hòa vốn phần fixed; nếu heavy usage tăng variable cost lên15 USD thì contribution còn4 USD và cần50 users. Đo token input/output/cache/retry thực, embedding tokens, index growth và support giờ; cap usage/BYOK option theo nhu cầu. Permanent publish quota/charge riêng, không unlimited trọn đời từ subscription một tháng.

**Marketplace + trial-conversion breakeven hypothesis:** AOV20 USD equivalent → fee10%=2 USD, giả định variable cost mỗi sale (gas/storage subsidy/support/dispute reserve)0,35 USD →1,65 USD contribution trước trial/acquisition/fixed. Nếu mỗi trial user dùng cả3 questions, cost mỗi question0,02 USD →0,06 USD/trial user; conversion `p` có expected net `1,65p−0,06`. Hòa vốn riêng trial khi `p≥0,06/1,65≈3,64%`; conversion5% cho1.000 trial users tạo50 sales/1.000 USD GMV/100 USD fee, sale costs17,50 USD + trial costs60 USD →22,50 USD trước fixed/CAC. Nếu acquisition0,50 USD/trial user, cần `p≥(0,06+0,50)/1,65≈33,94%`, khó hơn nhiều. Đây là **hypothetical costs**, không actual chain/storage/model quote; same-user repeat và abuse phải đo. Với AOV5 USD, fee0,50 USD chỉ còn0,15 USD nếu sale cost0,35, cần40% conversion để trả0,06 USD trial — low-price fee không nuôi inference miễn phí.

AVAX/fiat quote có TTL đề xuất60giây, hiển thị tỷ giá nguồn/thời điểm và slippage; exact wei/expected price do contract khóa. Token/gas/storage costs trả trước có thể biến động; không hứa gas cố định hay phiếu Fuji có giá trị USD. Không sponsor inference/transactions vô hạn; global cap và per-user budget chống abuse bắt buộc.

Capsule có thể bán rất hiếm nhưng tốn review/support nhiều. Theo dõi cost per successful reused task, không chỉ cost per API call; support hours/seller và key recovery cũng là COGS — chi phí phục vụ. Một paid pilot có repeated use và contribution dương đáng giá hơn GMV testnet cao.

## 8. PMF experiments, kill và pivot

| Thí nghiệm | Thiết kế | Continue / kill-pivot threshold đề xuất |
|---|---|---|
| Problem interviews | 25 người, hỏi task gần nhất, artifact thật, workaround và phí tổn; không pitch trước | Nếu <8/25 có handoff/repeated-error pain gần đây và workaround đáng kể, thu hẹp ICP hoặc dừng memory positioning |
| Task A/B crossover | 12 người; task tương đương, random order: Git rules/docs baseline vs MemOcean; rubric blind nếu được | Cần ≥20% median giảm thời gian hoặc ≥30% giảm lỗi rubric, chất lượng không tệ hơn; nếu không, pivot export/curation tool |
| Privacy/setup test | Đo thời gian connect project + approve first memory, lý do bỏ | >50% bỏ vì trust/setup: giảm integration, local-only/export baseline, không thêm marketplace features |
| Capsule quality/willingness | Cho thử3 câu, hỏi mua cho task thật, không coi “thích” là payment | Ít nhất 2 independent buyers chấp nhận paid pilot; nếu chỉ private memory có giá trị, tách marketplace khỏi revenue thesis |
| Repeat use | 7/14/28-day task-based cohort, exclude team/demo | Nếu <4/12 quay lại tuần2 không do nhắc liên tục, chưa có retention signal |
| Supply economics | 3 expert partners, ghi giờ curate/support và license friction | Nếu review cost không thể thu hồi và chất lượng không tăng, bỏ open marketplace; dùng curated service |

Ngưỡng là decision rules ban đầu, không statistical proof. Sample nhỏ/crossover có learning effects; ghi confidence, task difficulty và AI familiarity. Không chỉnh rubric sau thấy kết quả để “đạt PMF”. PMF mạnh hơn cần retention dài hạn, paid renewals, organic referrals và economics ổn qua nhiều cohort.

## 9. Sổ nguồn và khoảng trống chứng cứ

Nguồn công khai để kiểm tra luận điểm; truy cập **17-11-2026**. Ngày bài không có thì ghi n.d., không bịa ngày phát hành.

- [Stack Overflow Developer Survey 2025 — AI](https://survey.stackoverflow.co/2025/ai/) (2025): self-reported use/trust/friction, không đại diện riêng Avalanche và không đo willingness to buy capsule.
- [Stack Overflow methodology2025](https://survey.stackoverflow.co/2025/methodology/) — sample/self-selection limitations.
- [METR update24-02-2026](https://metr.org/blog/2026-02-24-uplift-update/) — không dùng study2025 đơn lẻ để khẳng định hiệu suất hiện tại.
- [METR — Early-2025 AI experienced open-source developer study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) (10-07-2025): context/task-dependent productivity counterevidence; không suy mọi AI chậm hơn.
- [Claude Code memory](https://code.claude.com/docs/en/memory), [Cursor rules](https://docs.cursor.com/context/rules) (n.d.): memory/rules đã tồn tại, Git-shareable workflows cần công nhận.
- [Mem0 open-source/self-hosting](https://docs.mem0.ai/open-source/overview), [Mem0 get all](https://docs.mem0.ai/api-reference/memory/get-all-memories), [Mem0 export](https://docs.mem0.ai/platform/features/memory-export) (n.d.): khả năng và deployment tùy sản phẩm, không claim lock-in tuyệt đối.
- [Zep](https://help.getzep.com/), [Graphiti](https://github.com/getzep/graphiti), [LangMem](https://langchain-ai.github.io/langmem/), [PromptBase](https://promptbase.com/) (n.d.): feature descriptions, không benchmark hay market-share evidence.
- [Irys storage ledgers](https://docs.irys.xyz/protocol-mechanics/storage-ledgers), [verifiability/trust model](https://docs.irys.xyz/architecture-overview/verifiability-and-trust-model), [data lifecycle](https://docs.irys.xyz/architecture-overview/data-lifecycle), [mutability](https://docs.irys.xyz/onchain-storage/mutability), [supported tokens](https://docs.irys.xyz/onchain-storage/supported-tokens) (n.d.): permanence/term, acceptance vs durable state, AVAX payments không biến Irys thành Avalanche chain.
- [PromptBase fees](https://promptbase.com/help/fees), [referrals](https://promptbase.com/help/referral-links), [terms](https://promptbase.com/tandcs) (n.d.): commerce/licensing facts, không phải PMF cho MemOcean.
- [Mem0 exporting cookbook](https://docs.mem0.ai/cookbooks/essentials/exporting-memories), [Zep/Graphiti overview](https://help.getzep.com/graphiti/graphiti/overview), [LangMem namespaces](https://langchain-ai.github.io/langmem/guides/dynamically_configure_namespaces/) (n.d.).
- [USCO/USPTO NFT study](https://www.copyright.gov/policy/nft-study/) (2024 study page): existing IP law vẫn áp dụng, receipt không chuyển copyright. Không phải tư vấn luật Việt Nam; chưa đọc toàn PDF để suy chi tiết pháp lý.

**Chưa có:** interview transcripts có consent, task benchmark, paid buyers, verified unit costs, hackathon rules/deadline, capsule legal review. Tất cả là deliverables cần thu trong [ROADMAP.md](ROADMAP.md), không được thay bằng slide số đẹp.
