# MemOcean — Đặc tả marketplace trên Avalanche

> **TL;DR:** Mỗi listing bán quyền sử dụng một phiên bản capsule bất biến, không bán NFT hay quyền sở hữu trí tuệ. Người mua trả đúng giá bằng AVAX; contract ghi quyền truy cập và tự phân bổ 90% cho seller, 10% cho platform bằng số dư rút sau. Giải mã vẫn phụ thuộc máy chủ MemOcean.

**Trạng thái:** thiết kế tham chiếu ngày 17-11-2026; chưa có contract, deployment, địa chỉ hay giao dịch thật. File này chỉ đặc tả interface và hành vi, không phải Solidity implementation hoặc báo cáo audit. Xem [kiến trúc](ARCHITECTURE.md), [database](DATABASE_SCHEMA.md), [MCP](MCP_SPEC.md), [lộ trình](ROADMAP.md).

## 1. Phạm vi và danh tính

| Khái niệm | Quyết định v1 |
|---|---|
| `capsuleRoot` | `bytes32` sender/deployment-bound commitment của UUID v4; một root có nhiều version, xem derivation bên dưới |
| `version` | `uint32`, tăng đơn điệu trong một root, bắt đầu từ 1 |
| `listingId` | `uint256`, ID tuần tự duy nhất trong một deployment; ánh xạ đúng một root + version |
| Quyền mua | Khóa `(buyer wallet, listingId)`, không chuyển nhượng; version mới không tự nằm trong quyền cũ |
| Quota thử | Ngoài chain: tối đa **3 câu hỏi suốt đời / user / capsuleRoot**, không reset khi đổi version, API key hay phiên |
| License | Văn bản license bất biến được hash trong manifest; mua không chuyển copyright, không bảo đảm seller có quyền pháp lý |
| Thanh toán | AVAX native; không token riêng, không ERC-20, không NFT, không bridge |
| Cộng tác viên | Không chia nhiều collaborator trong v1; seller tự xử lý ngoài platform |

Một người có thể chứng minh nhiều wallet nhưng chỉ có một user ứng dụng. DB ràng buộc wallet đã xác thực; quota theo user không đồng nghĩa chống Sybil. Contract không biết user hay tenant. Không được dùng user ID/email làm root công khai.

### Mạng đích

Fuji dùng chain ID **43113**, C-Chain RPC `https://api.avax-test.network/ext/bc/C/rpc`, explorer `https://explorer-test.avax.network/c-chain`. Mainnet C-Chain **43114** chỉ là tương lai, không được tái sử dụng cấu hình Fuji. Nguồn chính thức và mốc xác minh được tổng hợp ở cuối file. Fuji AVAX là tài sản test, không chứng minh doanh thu thương mại.

Backend và web phải khóa cả `chainId`, `contractAddress`, `deploymentBlock`, `deploymentBlockHash` và `contractCodeHash` trong bản ghi deployment. Không chấp nhận log chỉ vì trùng event signature. `listingId = 1` ở deployment khác là tài sản khác.

## 2. Cam kết dữ liệu, không đưa bí mật lên chain

Pipeline chuẩn ở [ARCHITECTURE.md](ARCHITECTURE.md): sanitize → duyệt → canonicalize JSON theo RFC 8785 → encrypt → upload Irys → xác minh receipt/bytes → index → list. Không được list khi upload chỉ mới accepted.

- `cipherSha256`: SHA-256 của đúng bytes ciphertext envelope upload; envelope bao gồm nonce, authentication tag, crypto format, không chứa DEK rõ.
- `manifestSha256`: SHA-256 của canonical public manifest, có canonical capsule UUID, deployment-bound onchain root, initialSeller, version, schema version, cipher hash, license hash, tác giả khai báo và chính sách preview. Không hash manifest tự chứa chính hash của nó. Manifest được canonicalize trước uploads, bind ciphertext bằng digest chứ không chứa Irys IDs chưa biết; hai IDs lưu ngoài manifest trong DB/chain. Không có vòng phụ thuộc hash/transaction ID.
- `plainCommitment`: `SHA256(randomSalt32 || canonicalPlaintextBytes)`, không phải hash thuần của plaintext ngắn dễ đoán. Salt ở encrypted payload, không công khai. Dùng audit sau giải mã; không chứng minh nội dung đúng.
- `commitmentVersion = 1` khóa thuật toán/encoding. Hash là `bytes32`; Irys ID là **string**, giữ nguyên văn bản đúng SDK trả về, không ép ID thành `bytes32` hoặc mặc định một độ dài.
- `manifestIrysId` và `cipherIrysId` là hai ID riêng. Manifest công khai không được chứa PII, key, câu trả lời trả phí hay full corpus. Gateway có thể chậm; hash vẫn cần kiểm tra trên bytes tải lại.

Không đưa private memory, API key, DEK, KEK, salt kín, session token, plaintext chunk hay licensee PII lên chain. Public metadata có thể bị copy vĩnh viễn. `verify_provenance` xác nhận commitment, storage bytes và receipt; không phải công chứng quyền tác giả hoặc kiểm định chân lý.

## 3. Interface Solidity tham chiếu

Compiler mục tiêu `^0.8.24`, OpenZeppelin 5.x là lựa chọn cần khóa patch và kiểm tra tương thích khi triển khai. Đoạn dưới là **interface**, không phải implementation. Type `bytes32` xuất ra API là chuỗi hex 0x + 64 ký tự. Wei truyền REST/JSON bằng chuỗi thập phân.

```solidity
interface IMemOceanMarketplace {
    struct VersionInput {
        bytes32 capsuleRoot;
        bytes16 capsuleUuid;
        uint32 version;
        uint16 commitmentVersion;
        string cipherIrysId;
        string manifestIrysId;
        bytes32 cipherSha256;
        bytes32 manifestSha256;
        bytes32 plainCommitment;
        bytes32 licenseSha256;
        uint256 priceWei;
    }
    struct Listing {
        bytes32 capsuleRoot;
        bytes16 capsuleUuid;
        uint32 version;
        uint16 commitmentVersion;
        address seller;
        address feeRecipient;
        uint16 feeBps;
        uint256 priceWei;
        bool active;
        string cipherIrysId;
        string manifestIrysId;
        bytes32 cipherSha256;
        bytes32 manifestSha256;
        bytes32 plainCommitment;
        bytes32 licenseSha256;
    }

    function listVersion(VersionInput calldata input) external returns (uint256 listingId);
    function updatePrice(uint256 listingId, uint256 newPriceWei) external;
    function delist(uint256 listingId) external;
    function purchase(uint256 listingId, uint256 expectedPriceWei) external payable;
    function hasPurchased(address buyer, uint256 listingId) external view returns (bool);
    function getListing(uint256 listingId) external view returns (Listing memory);
    function listingOf(bytes32 capsuleRoot, uint32 version) external view returns (uint256);
    function rootOwner(bytes32 capsuleRoot) external view returns (address);
    function initialSeller(bytes32 capsuleRoot) external view returns (address);
    function rootUuid(bytes32 capsuleRoot) external view returns (bytes16);
    function deriveCapsuleRoot(address initialSeller_, bytes16 capsuleUuid) external view returns (bytes32);
    function latestVersion(bytes32 capsuleRoot) external view returns (uint32);
    function credits(address recipient) external view returns (uint256);
    function totalLiabilities() external view returns (uint256);
    function withdraw(address payable to) external;
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function setDefaultFee(uint16 feeBps, address feeRecipient) external;
    function transferRootOwnership(bytes32 capsuleRoot, address nextOwner) external;
    function acceptRootOwnership(bytes32 capsuleRoot) external;
    function sweepSurplus(address payable to) external;

    event VersionListed(uint256 indexed listingId, bytes32 indexed capsuleRoot,
        address indexed seller, bytes16 capsuleUuid, uint32 version, uint256 priceWei,
        uint16 feeBps, address feeRecipient, uint16 commitmentVersion,
        string cipherIrysId, string manifestIrysId, bytes32 cipherSha256,
        bytes32 manifestSha256, bytes32 plainCommitment, bytes32 licenseSha256);
    event PriceUpdated(uint256 indexed listingId, uint256 oldPriceWei, uint256 newPriceWei);
    event Delisted(uint256 indexed listingId);
    event Purchased(uint256 indexed listingId, address indexed buyer,
        address indexed seller, uint256 paidWei, uint256 sellerWei, uint256 platformWei);
    event Withdrawn(address indexed recipient, address indexed to, uint256 amountWei);
    event DefaultFeeUpdated(uint16 feeBps, address feeRecipient);
    event RootTransferProposed(bytes32 indexed capsuleRoot, address indexed nextOwner);
    event RootOwnershipTransferred(bytes32 indexed capsuleRoot, address indexed previousOwner,
        address indexed nextOwner);
    event SurplusSwept(address indexed to, uint256 amountWei);
    event Paused(address account);
    event Unpaused(address account);

    error Unauthorized();
    error InvalidInput();
    error UnknownListing();
    error InvalidVersion();
    error RootDerivationMismatch();
    error ListingInactive();
    error MarketplacePaused();
    error PriceChanged(uint256 expected, uint256 actual);
    error IncorrectPayment(uint256 expected, uint256 received);
    error AlreadyPurchased();
    error NothingToWithdraw();
    error TransferFailed();
    error FeeTooHigh();
    error NoSurplus();
}
```

Admin ownership dùng chuyển giao hai bước; OpenZeppelin inherited accessors/events phải ghi ABI thực khi triển khai. Không giả định interface trên chứa toàn bộ ABI kế thừa. Địa chỉ admin tương lai nên là multisig, không upload wallet hoặc API hot key.

## 4. Hành vi bắt buộc

### Listing và root ownership

- `listVersion` không payable, chỉ chạy khi không pause. Root và capsuleUuid khác zero; ID strings dài 1–512 UTF-8 bytes; hash khác zero; commitment version hỗ trợ; giá > 0.
- First claim MUST verify `capsuleRoot == keccak256(abi.encode(keccak256("MemOceanCapsuleRoot:v1"), uint256(block.chainid), address(this), msg.sender, input.capsuleUuid))`; tạo version1, lưu immutable initialSeller=msg.sender và capsuleUuid. UUID là16raw network-order bytes, không string và không zero-pad root; dùng `abi.encode`, không `encodePacked`. Hash domain là Ethereum Keccak-256, khác SHA-256 commitments content.
- Front-runner copy root/UUID từ pending tx nhưng sender khác sẽ fail derivation; nếu tự derive thì ra root khác, không khóa seller hợp lệ. Random UUID **một mình không** bảo vệ namespace khi đã lộ trong mempool. Contract verifies derivation, không chỉ tin backend. Tx relayer không nằm v1; msg.sender chính seller được bind.
- Các version sau cần rootOwner hiện tại, UUID trùng rootUuid đã lưu và `latest+1`; root không rederive theo owner mới. Root transfer không đổi initialSeller/rootUuid. Claim chỉ chống namespace squatting bằng copied tx, **không** xác minh legal authorship/trademark/content rights. Catalog curated reject cùng capsule UUID bị seller khác copy thành root khác, dựa rights review chứ chain không biết plagiarism.
- Backend chỉ submit/list những root của seller đã ký SIWE và attestation manifest. Direct on-chain spam có thể tồn tại nhưng không tự vào catalog curated.
- Lưu seller tại thời điểm list, feeBps và feeRecipient tại thời điểm list. Root transfer hai bước chỉ đổi ai list version tương lai; không chuyển seller, credit hoặc license cũ.
- `updatePrice` chỉ seller của listing, khi không pause, listing vẫn active, giá > 0. Commitments, license, fee snapshot không đổi.
- `delist` chỉ seller hoặc admin để xử lý abuse; có thể thực hiện trong pause. Một listing delisted không relist; phát hành version mới nếu cần. Giá và hash cũ vẫn đọc được.

### Mua và phí

`purchase` kiểm tra theo thứ tự: không pause → listing tồn tại/active → `expectedPriceWei == currentPriceWei` → `msg.value == expectedPriceWei` → chưa mua. Self-purchase bị cấm để tránh inflate số buyer trong catalog (thống kê vẫn cần chống wallet phụ).

Trong cùng transaction: đánh dấu đã mua; `platformWei = paidWei * feeBps / 10000` làm tròn xuống; `sellerWei = paidWei - platformWei`; cộng hai `credits`; tăng `totalLiabilities` đúng `paidWei`; emit `Purchased`. **Không gửi AVAX đến seller ngay trong purchase.** V1 default và cap đều **1000 bps = 10%**; 90% còn lại là seller share. Admin chỉ có thể chọn 0–1000 bps cho listing tương lai, không sửa fee của listing đã tồn tại. Default recipient mới cũng không tác động listing cũ.

Giá tăng giữa lúc ký và mining phải revert `PriceChanged`, không âm thầm thu thêm. Giá giảm cũng revert để người dùng xác nhận quote mới. Không refund phần dư vì mọi giá trị dư bị reject. Web hiển thị gas ngoài giá. Không affiliate/collaborator split trong v1.

### Rút tiền và surplus

`withdraw(to)` chỉ rút toàn bộ credit của `msg.sender`, `to != address(0)`, vẫn chạy khi pause. Áp dụng checks-effects-interactions và `nonReentrant`: ghi credit = 0, giảm liability rồi low-level call; nếu call lỗi revert cả transaction. Người nhận malicious không chặn người khác mua hay rút. Recipient contract có thể chọn địa chỉ nhận khác.

`receive`/fallback từ chối gửi trực tiếp; vẫn có AVAX bị ép gửi theo cơ chế EVM. Bất biến: `address(this).balance >= totalLiabilities`; admin chỉ `sweepSurplus(balance - totalLiabilities)` khi dương, nonReentrant. Không có admin drain credits. Upload funding wallet tách biệt, không giữ tiền bán hàng.

### Pause và quyền cũ

Pause khóa `listVersion`, `updatePrice`, `purchase`; không khóa view, delist, withdraw hay chứng minh quyền cũ. `hasPurchased` không phụ thuộc active/paused. Đổi giá, delist, đổi root owner và fee không thu hồi license cũ. Khi backend đang sự cố, chain quyền vẫn tồn tại nhưng giải mã có thể tạm ngừng: đây là rủi ro escrow, không phải permissionless delivery.

## 5. Purchase → giải mã → MCP

1. Buyer bind wallet bằng challenge SIWE dùng nonce một lần, domain/URI/chain/expiry đúng.
2. Web lấy quote, gọi contract qua wagmi/viem, chờ receipt. Không cho client tự đánh dấu paid.
3. Indexer xác minh chain/deployment, block hash, event, `hasPurchased` và policy finality. Mốc demo đề xuất 3 confirmations **không phải khẳng định finality tuyệt đối**; spike phải chọn accepted/finalized RPC semantics khả dụng.
4. DB lưu event/order `observed → confirmed`; entitlement version-pinned `active`. Log uniqueness `(chain_id, contract_address, tx_hash, log_index)`; replay không tạo hai entitlement.
5. User đã xác thực wallet mới yêu cầu access. Backend kiểm tra entitlement không revoked/reorged, unwrap DEK server-side, kiểm tra hash và trả corpus qua ACL hoặc đưa vào private MCP library. Không đổi owner capsule hoặc copy license giữa tenant ngầm.
6. Worker kiểm tra block hash lại sau confirmation; nếu reorg thì event/order `orphaned`, entitlement `suspended`, hủy cache và recheck chain. Giao dịch đã giải mã không thể thu hồi bytes khỏi buyer.

RAG chỉ dùng purchased corpus sau authorization. User rời tenant không làm mất license thuộc user, nhưng private tenant project integration bị gỡ. Thiết kế v1 license thuộc user được bind wallet; tenant chỉ là nơi người đó lưu integration, không phải license chuyển nhượng cho mọi đồng nghiệp.

## 6. Mối đe dọa và giới hạn

| Rủi ro | Biện pháp / giới hạn |
|---|---|
| Seller bán nội dung đánh cắp | Human review, attestation, license record, takedown catalog; chain không xác định chủ sở hữu hợp pháp |
| Hash khớp nhưng nội dung sai | Quality benchmark, provenance nguồn, phiên bản; immutable không có nghĩa true |
| Metadata chứa script/prompt injection | Escape UI; không thực thi, không fetch URL tùy ý; capsule là dữ liệu không có quyền system |
| Mất KEK/DEK | Backup mã hóa + restore drill; chain và Irys không tự khôi phục key |
| API operator đọc dữ liệu | Escrow trung tâm được công bố; v1 không zero knowledge; embeddings/index cũng có rủi ro riêng |
| Buyer sao chép corpus | License + chế tài hợp đồng ngoài chain; mã hóa không phải DRM sau giải mã |
| Admin compromise | Multisig, fee cap, no overwrite/no drain; catalog có thể dừng, contract không thể bảo đảm API sống |
| RPC giả log / fork | Nhiều RPC khi nghi vấn, block hash reconciliation, deployment binding, chain reads |

## 7. Test và invariant trước triển khai

**Unit/property tests bắt buộc:**

- Root zero, UUID zero/mismatch, copied pending root claim từ attacker, wrong deployment/chain/domain/ABI encoding; expected sender root succeeds và attacker-derived root khác; root transfer giữ derivation ban đầu; version 0/skip/repeat, ID quá dài, unsupported commitment, giá 0, unauthorized update/delist/transfer đều revert.
- Hash/ID/version/license immutable qua mọi admin action; root ownership transfer không sửa listing cũ.
- Mua đúng giá, sai giá, dư/thiếu tiền, trùng mua, self-buy, listing unknown/delisted/paused.
- Rounding ở 1 wei và giá cực trị; `sellerWei + platformWei == paidWei` luôn đúng; overflow không silent.
- Fuzz nhiều người mua và rút: `sum(credits) == totalLiabilities`; balance không nhỏ hơn liabilities.
- Malicious receiver reenter `withdraw`/`purchase`/`sweepSurplus`, receiver revert; không mất credit, không khóa buyer khác.
- Fee thay đổi không sửa snapshot; pause không vô hiệu hóa purchased access hoặc withdrawals.
- Forced AVAX chỉ tạo surplus, không tăng credit; sweep không chạm liability.
- Indexer replay log, duplicate receipt, restart, reorg và wrong-deployment event đều xử lý idempotent.

**Evidence cần có:** ABI + compiler/dependency lock, bytecode hash, deployment receipt, explorer link thật, hai wallet test, gas measurements, event reconciliation và threat-model review. Chưa có evidence nào ở baseline tài liệu. Production cần audit độc lập, incident runbook, review license và key escrow; hackathon demo không thay thế các bước đó.

## 8. Nguồn và mức chứng cứ

Các URL dưới dùng làm nguồn kỹ thuật; ngày truy cập/xác minh cuối: **17-11-2026**. Chi tiết deployment vẫn phải kiểm tra lại trước chạy.

- [Avalanche: Primary Network networks](https://build.avax.network/docs/quick-start/networks) — chain IDs, RPC và explorer; nguồn chính thức.
- [OpenZeppelin: PullPayment / withdrawal pattern](https://docs.openzeppelin.com/contracts/4.x/api/security#PullPayment) — giải thích pattern, **không** đề xuất import class 4.x vào dependency 5.x.
- [OpenZeppelin Contracts 5.x utilities](https://docs.openzeppelin.com/contracts/5.x/api/utils) — ReentrancyGuard/Pausable; kiểm tra path/patch thực khi implement.
- [Avalanche consensus](https://build.avax.network/docs/primary-network/avalanche-consensus) — accepted transaction có irreversible acceptance với probabilistic safety; không hứa hard subsecond SLA.
- [Solidity withdrawal pattern](https://docs.soliditylang.org/en/latest/common-patterns.html#withdrawal-from-contracts) — effects-before-external-call/pull withdrawal.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) — JSON Canonicalization Scheme, xuất bản 06-2020.
- [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361) — Sign-In with Ethereum; wallet authentication, không phải license ownership.

**Đề xuất nội bộ, không phải vendor facts:** fee 10%, giới hạn metadata, 3-confirmation demo policy, central escrow và toàn bộ interface ở trên.
