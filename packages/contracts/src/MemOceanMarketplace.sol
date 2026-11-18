// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MemOceanMarketplace
/// @notice Lists immutable capsule versions and sells non-transferable access records for AVAX.
/// @dev Purchase proceeds are pull credits; this contract does not deliver plaintext or IP ownership.
contract MemOceanMarketplace is Ownable2Step, Pausable, ReentrancyGuard {
    uint16 public constant MAX_FEE_BPS = 1_000;
    uint16 public constant FEE_DENOMINATOR = 10_000;
    uint16 public constant SUPPORTED_COMMITMENT_VERSION = 1;
    uint256 public constant MAX_IRYS_ID_BYTES = 512;
    bytes32 public constant CAPSULE_ROOT_DOMAIN = keccak256("MemOceanCapsuleRoot:v1");

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

    event VersionListed(
        uint256 indexed listingId,
        bytes32 indexed capsuleRoot,
        address indexed seller,
        bytes16 capsuleUuid,
        uint32 version,
        uint256 priceWei,
        uint16 feeBps,
        address feeRecipient,
        uint16 commitmentVersion,
        string cipherIrysId,
        string manifestIrysId,
        bytes32 cipherSha256,
        bytes32 manifestSha256,
        bytes32 plainCommitment,
        bytes32 licenseSha256
    );
    event PriceUpdated(uint256 indexed listingId, uint256 oldPriceWei, uint256 newPriceWei);
    event Delisted(uint256 indexed listingId);
    event Purchased(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 paidWei,
        uint256 sellerWei,
        uint256 platformWei
    );
    event Withdrawn(address indexed recipient, address indexed to, uint256 amountWei);
    event DefaultFeeUpdated(uint16 feeBps, address feeRecipient);
    event RootTransferProposed(bytes32 indexed capsuleRoot, address indexed nextOwner);
    event RootOwnershipTransferred(
        bytes32 indexed capsuleRoot,
        address indexed previousOwner,
        address indexed nextOwner
    );
    event SurplusSwept(address indexed to, uint256 amountWei);

    uint256 private _nextListingId = 1;
    uint16 public defaultFeeBps = MAX_FEE_BPS;
    address public defaultFeeRecipient;
    uint256 public totalLiabilities;

    mapping(uint256 listingId => Listing listing) private _listings;
    mapping(bytes32 capsuleRoot => mapping(uint32 version => uint256 listingId)) public listingOf;
    mapping(address recipient => uint256 amount) public credits;
    mapping(address buyer => mapping(uint256 listingId => bool purchased)) private _purchased;
    mapping(bytes32 capsuleRoot => address account) public rootOwner;
    mapping(bytes32 capsuleRoot => address account) public initialSeller;
    mapping(bytes32 capsuleRoot => bytes16 uuid) public rootUuid;
    mapping(bytes32 capsuleRoot => uint32 version) public latestVersion;
    mapping(bytes32 capsuleRoot => address account) public pendingRootOwner;

    constructor(address initialOwner, address initialFeeRecipient) Ownable(initialOwner) {
        if (initialOwner == address(0) || initialFeeRecipient == address(0)) revert InvalidInput();
        defaultFeeRecipient = initialFeeRecipient;
    }

    function listVersion(VersionInput calldata input) external returns (uint256 listingId) {
        _requireMarketplaceNotPaused();
        _validateInput(input);

        address currentRootOwner = rootOwner[input.capsuleRoot];
        if (currentRootOwner == address(0)) {
            if (input.version != 1) revert InvalidVersion();
            if (input.capsuleRoot != deriveCapsuleRoot(msg.sender, input.capsuleUuid)) {
                revert RootDerivationMismatch();
            }
            rootOwner[input.capsuleRoot] = msg.sender;
            initialSeller[input.capsuleRoot] = msg.sender;
            rootUuid[input.capsuleRoot] = input.capsuleUuid;
        } else {
            if (currentRootOwner != msg.sender) revert Unauthorized();
            if (rootUuid[input.capsuleRoot] != input.capsuleUuid) revert InvalidInput();
            uint32 currentVersion = latestVersion[input.capsuleRoot];
            if (currentVersion == type(uint32).max || input.version != currentVersion + 1) {
                revert InvalidVersion();
            }
        }

        if (listingOf[input.capsuleRoot][input.version] != 0) revert InvalidVersion();
        listingId = _nextListingId++;
        listingOf[input.capsuleRoot][input.version] = listingId;
        latestVersion[input.capsuleRoot] = input.version;

        Listing storage listing = _listings[listingId];
        listing.capsuleRoot = input.capsuleRoot;
        listing.capsuleUuid = input.capsuleUuid;
        listing.version = input.version;
        listing.commitmentVersion = input.commitmentVersion;
        listing.seller = msg.sender;
        listing.feeRecipient = defaultFeeRecipient;
        listing.feeBps = defaultFeeBps;
        listing.priceWei = input.priceWei;
        listing.active = true;
        listing.cipherIrysId = input.cipherIrysId;
        listing.manifestIrysId = input.manifestIrysId;
        listing.cipherSha256 = input.cipherSha256;
        listing.manifestSha256 = input.manifestSha256;
        listing.plainCommitment = input.plainCommitment;
        listing.licenseSha256 = input.licenseSha256;

        emit VersionListed(
            listingId,
            input.capsuleRoot,
            msg.sender,
            input.capsuleUuid,
            input.version,
            input.priceWei,
            defaultFeeBps,
            defaultFeeRecipient,
            input.commitmentVersion,
            input.cipherIrysId,
            input.manifestIrysId,
            input.cipherSha256,
            input.manifestSha256,
            input.plainCommitment,
            input.licenseSha256
        );
    }

    function updatePrice(uint256 listingId, uint256 newPriceWei) external {
        _requireMarketplaceNotPaused();
        Listing storage listing = _requireListing(listingId);
        if (msg.sender != listing.seller) revert Unauthorized();
        if (!listing.active) revert ListingInactive();
        if (newPriceWei == 0) revert InvalidInput();
        uint256 oldPriceWei = listing.priceWei;
        listing.priceWei = newPriceWei;
        emit PriceUpdated(listingId, oldPriceWei, newPriceWei);
    }

    function delist(uint256 listingId) external {
        Listing storage listing = _requireListing(listingId);
        if (msg.sender != listing.seller && msg.sender != owner()) revert Unauthorized();
        if (!listing.active) revert ListingInactive();
        listing.active = false;
        emit Delisted(listingId);
    }

    function purchase(uint256 listingId, uint256 expectedPriceWei) external payable {
        _requireMarketplaceNotPaused();
        Listing storage listing = _requireListing(listingId);
        if (!listing.active) revert ListingInactive();
        if (expectedPriceWei != listing.priceWei) {
            revert PriceChanged(expectedPriceWei, listing.priceWei);
        }
        if (msg.value != expectedPriceWei) revert IncorrectPayment(expectedPriceWei, msg.value);
        if (_purchased[msg.sender][listingId]) revert AlreadyPurchased();
        if (msg.sender == listing.seller) revert InvalidInput();

        _purchased[msg.sender][listingId] = true;
        uint256 platformWei = Math.mulDiv(msg.value, listing.feeBps, FEE_DENOMINATOR);
        uint256 sellerWei = msg.value - platformWei;
        credits[listing.seller] += sellerWei;
        credits[listing.feeRecipient] += platformWei;
        totalLiabilities += msg.value;

        emit Purchased(listingId, msg.sender, listing.seller, msg.value, sellerWei, platformWei);
    }

    function hasPurchased(address buyer, uint256 listingId) external view returns (bool) {
        return _purchased[buyer][listingId];
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _requireListing(listingId);
    }

    function deriveCapsuleRoot(address initialSeller_, bytes16 capsuleUuid) public view returns (bytes32) {
        return keccak256(
            abi.encode(CAPSULE_ROOT_DOMAIN, uint256(block.chainid), address(this), initialSeller_, capsuleUuid)
        );
    }

    function transferRootOwnership(bytes32 capsuleRoot, address nextOwner) external {
        if (rootOwner[capsuleRoot] == address(0)) revert InvalidInput();
        if (msg.sender != rootOwner[capsuleRoot]) revert Unauthorized();
        if (nextOwner == address(0) || nextOwner == msg.sender) revert InvalidInput();
        pendingRootOwner[capsuleRoot] = nextOwner;
        emit RootTransferProposed(capsuleRoot, nextOwner);
    }

    function acceptRootOwnership(bytes32 capsuleRoot) external {
        if (pendingRootOwner[capsuleRoot] != msg.sender) revert Unauthorized();
        address previousOwner = rootOwner[capsuleRoot];
        rootOwner[capsuleRoot] = msg.sender;
        delete pendingRootOwner[capsuleRoot];
        emit RootOwnershipTransferred(capsuleRoot, previousOwner, msg.sender);
    }

    function withdraw(address payable to) external nonReentrant {
        if (to == address(0)) revert InvalidInput();
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        credits[msg.sender] = 0;
        totalLiabilities -= amount;
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();

        emit Withdrawn(msg.sender, to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setDefaultFee(uint16 feeBps, address feeRecipient) external onlyOwner {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient == address(0)) revert InvalidInput();
        defaultFeeBps = feeBps;
        defaultFeeRecipient = feeRecipient;
        emit DefaultFeeUpdated(feeBps, feeRecipient);
    }

    function sweepSurplus(address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidInput();
        uint256 balance = address(this).balance;
        if (balance <= totalLiabilities) revert NoSurplus();
        uint256 amount = balance - totalLiabilities;
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit SurplusSwept(to, amount);
    }

    receive() external payable {
        revert InvalidInput();
    }

    fallback() external payable {
        revert InvalidInput();
    }

    function _validateInput(VersionInput calldata input) private pure {
        if (
            input.capsuleRoot == bytes32(0) || input.capsuleUuid == bytes16(0) || input.priceWei == 0
                || input.commitmentVersion != SUPPORTED_COMMITMENT_VERSION || input.cipherSha256 == bytes32(0)
                || input.manifestSha256 == bytes32(0) || input.plainCommitment == bytes32(0)
                || input.licenseSha256 == bytes32(0)
        ) revert InvalidInput();
        uint256 cipherIdLength = bytes(input.cipherIrysId).length;
        uint256 manifestIdLength = bytes(input.manifestIrysId).length;
        if (
            cipherIdLength == 0 || cipherIdLength > MAX_IRYS_ID_BYTES || manifestIdLength == 0
                || manifestIdLength > MAX_IRYS_ID_BYTES
        ) revert InvalidInput();
        if (input.version == 0) revert InvalidVersion();
    }

    function _requireMarketplaceNotPaused() private view {
        if (paused()) revert MarketplacePaused();
    }

    function _requireListing(uint256 listingId) private view returns (Listing storage listing) {
        if (listingId == 0 || listingId >= _nextListingId) revert UnknownListing();
        listing = _listings[listingId];
    }
}
