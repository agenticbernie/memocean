// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MemOceanMarketplace} from "../src/MemOceanMarketplace.sol";

interface Vm {
    function prank(address msgSender) external;
    function deal(address account, uint256 newBalance) external;
    function chainId(uint256 newChainId) external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
}

contract RejectingReceiver {
    function withdrawFrom(MemOceanMarketplace marketplace) external {
        marketplace.withdraw(payable(address(this)));
    }

    receive() external payable {
        revert("receiver rejects AVAX");
    }
}

contract ReentrantReceiver {
    MemOceanMarketplace public marketplace;
    uint256 public targetListingId;
    uint256 public targetPrice;
    bool public nestedWithdrawSucceeded;
    bool public nestedPurchaseSucceeded;
    bool public nestedSweepSucceeded;

    function createListing(MemOceanMarketplace market, bytes16 uuid, uint256 price)
        external
        returns (uint256 listingId)
    {
        marketplace = market;
        MemOceanMarketplace.VersionInput memory input = MemOceanMarketplace.VersionInput({
            capsuleRoot: market.deriveCapsuleRoot(address(this), uuid),
            capsuleUuid: uuid,
            version: 1,
            commitmentVersion: 1,
            cipherIrysId: "cipher-reentrant",
            manifestIrysId: "manifest-reentrant",
            cipherSha256: keccak256("cipher"),
            manifestSha256: keccak256("manifest"),
            plainCommitment: keccak256("plain"),
            licenseSha256: keccak256("license"),
            priceWei: price
        });
        listingId = market.listVersion(input);
    }

    function configure(uint256 listingId, uint256 price) external {
        targetListingId = listingId;
        targetPrice = price;
    }

    function withdrawCredits() external {
        marketplace.withdraw(payable(address(this)));
    }

    receive() external payable {
        (bool withdrawSuccess,) = address(marketplace).call(
            abi.encodeWithSignature("withdraw(address)", payable(address(this)))
        );
        nestedWithdrawSucceeded = withdrawSuccess;

        (bool purchaseSuccess,) = address(marketplace).call{value: targetPrice}(
            abi.encodeWithSignature("purchase(uint256,uint256)", targetListingId, targetPrice)
        );
        nestedPurchaseSucceeded = purchaseSuccess;

        (bool sweepSuccess,) = address(marketplace).call(
            abi.encodeWithSignature("sweepSurplus(address)", payable(address(this)))
        );
        nestedSweepSucceeded = sweepSuccess;
    }
}

contract ForceEther {
    constructor() payable {}

    function force(address payable recipient) external {
        selfdestruct(recipient);
    }
}

contract MemOceanMarketplaceTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant seller = address(0xA11CE);
    address private constant buyer = address(0xB0B);
    address private constant attacker = address(0xBAD);
    address private constant feeRecipient = address(0xFEE);
    address private constant nextFeeRecipient = address(0xFEE2);

    MemOceanMarketplace private market;

    function setUp() public {
        market = new MemOceanMarketplace(address(this), feeRecipient);
        vm.deal(seller, 100 ether);
        vm.deal(buyer, 100 ether);
        vm.deal(attacker, 100 ether);
    }

    function testCapsuleRootBindsDomainChainContractSenderAndUuid() public {
        bytes16 uuid = bytes16(uint128(0x1234));
        bytes32 root = market.deriveCapsuleRoot(seller, uuid);
        assertEq(
            root,
            keccak256(abi.encode(market.CAPSULE_ROOT_DOMAIN(), block.chainid, address(market), seller, uuid))
        );
        assertTrue(root != market.deriveCapsuleRoot(attacker, uuid));
        assertTrue(root != market.deriveCapsuleRoot(seller, bytes16(uint128(0x1235))));

        uint256 originalChainId = block.chainid;
        vm.chainId(originalChainId + 1);
        assertTrue(root != market.deriveCapsuleRoot(seller, uuid));
        vm.chainId(originalChainId);

        MemOceanMarketplace otherDeployment = new MemOceanMarketplace(address(this), feeRecipient);
        assertTrue(root != otherDeployment.deriveCapsuleRoot(seller, uuid));
    }

    function testCopiedPendingRootCannotBeClaimedByFrontRunner() public {
        bytes16 uuid = bytes16(uint128(0x1234));
        MemOceanMarketplace.VersionInput memory input = _input(seller, uuid, 1, 1 ether);
        bytes32 intendedRoot = input.capsuleRoot;

        vm.expectRevert(MemOceanMarketplace.RootDerivationMismatch.selector);
        vm.prank(attacker);
        market.listVersion(input);

        assertEq(market.rootOwner(intendedRoot), address(0));
        vm.prank(seller);
        uint256 listingId = market.listVersion(input);
        assertEq(market.rootOwner(intendedRoot), seller);
        assertEq(market.initialSeller(intendedRoot), seller);
        assertEq(market.listingOf(intendedRoot, 1), listingId);

        MemOceanMarketplace.VersionInput memory attackerRootInput = _input(attacker, uuid, 1, 1 ether);
        assertTrue(attackerRootInput.capsuleRoot != intendedRoot);
        vm.prank(attacker);
        market.listVersion(attackerRootInput);
    }

    function testVersionSequenceAndRootUuidAreEnforced() public {
        bytes16 uuid = bytes16(uint128(0x4444));
        bytes32 root = market.deriveCapsuleRoot(seller, uuid);
        _list(seller, uuid, 1, 1 ether);

        MemOceanMarketplace.VersionInput memory wrongUuid = _input(seller, bytes16(uint128(0x4445)), 2, 1 ether);
        wrongUuid.capsuleRoot = root;
        vm.expectRevert(MemOceanMarketplace.InvalidInput.selector);
        vm.prank(seller);
        market.listVersion(wrongUuid);

        MemOceanMarketplace.VersionInput memory skipped = _input(seller, uuid, 3, 1 ether);
        skipped.capsuleRoot = root;
        vm.expectRevert(MemOceanMarketplace.InvalidVersion.selector);
        vm.prank(seller);
        market.listVersion(skipped);

        MemOceanMarketplace.VersionInput memory zeroVersion = _input(seller, uuid, 1, 1 ether);
        zeroVersion.capsuleRoot = root;
        zeroVersion.version = 0;
        vm.expectRevert(MemOceanMarketplace.InvalidVersion.selector);
        vm.prank(seller);
        market.listVersion(zeroVersion);

        MemOceanMarketplace.VersionInput memory next = _input(seller, uuid, 2, 1 ether);
        next.capsuleRoot = root;
        uint256 nextId = _listInput(seller, next);
        assertEq(market.latestVersion(root), uint32(2));
        assertEq(market.listingOf(root, 2), nextId);

        MemOceanMarketplace.VersionInput memory unauthorized = _input(attacker, uuid, 3, 1 ether);
        unauthorized.capsuleRoot = root;
        vm.expectRevert(MemOceanMarketplace.Unauthorized.selector);
        vm.prank(attacker);
        market.listVersion(unauthorized);
    }

    function testInputValidationRejectsZeroValuesUnsupportedCommitmentAndBadIds() public {
        bytes16 uuid = bytes16(uint128(0x55));
        MemOceanMarketplace.VersionInput memory input = _input(seller, uuid, 1, 1 ether);

        input.capsuleRoot = bytes32(0);
        _expectInvalidInput(seller, input);
        input = _input(seller, uuid, 1, 1 ether);
        input.capsuleUuid = bytes16(0);
        _expectInvalidInput(seller, input);
        input = _input(seller, uuid, 1, 0);
        _expectInvalidInput(seller, input);
        input = _input(seller, uuid, 1, 1 ether);
        input.commitmentVersion = 2;
        _expectInvalidInput(seller, input);
        input = _input(seller, uuid, 1, 1 ether);
        input.cipherSha256 = bytes32(0);
        _expectInvalidInput(seller, input);
        input = _input(seller, uuid, 1, 1 ether);
        input.manifestSha256 = bytes32(0);
        _expectInvalidInput(seller, input);
        input = _input(seller, uuid, 1, 1 ether);
        input.plainCommitment = bytes32(0);
        _expectInvalidInput(seller, input);
        input = _input(seller, uuid, 1, 1 ether);
        input.licenseSha256 = bytes32(0);
        _expectInvalidInput(seller, input);
        input = _input(seller, uuid, 1, 1 ether);
        input.cipherIrysId = "";
        _expectInvalidInput(seller, input);
        input = _input(seller, uuid, 1, 1 ether);
        input.manifestIrysId = string(new bytes(513));
        _expectInvalidInput(seller, input);
    }

    function testMetadataAndFeeSnapshotsSurvivePriceAndRootOwnerChanges() public {
        bytes16 uuid = bytes16(uint128(0x7777));
        bytes32 root = market.deriveCapsuleRoot(seller, uuid);
        uint256 firstId = _list(seller, uuid, 1, 1 ether);
        MemOceanMarketplace.Listing memory firstBefore = market.getListing(firstId);

        market.setDefaultFee(500, nextFeeRecipient);
        MemOceanMarketplace.VersionInput memory second = _input(seller, uuid, 2, 2 ether);
        second.capsuleRoot = root;
        uint256 secondId = _listInput(seller, second);
        MemOceanMarketplace.Listing memory secondListing = market.getListing(secondId);
        assertEq(secondListing.feeBps, 500);
        assertEq(secondListing.feeRecipient, nextFeeRecipient);

        vm.prank(seller);
        market.updatePrice(firstId, 3 ether);
        vm.prank(seller);
        market.transferRootOwnership(root, attacker);
        vm.prank(attacker);
        market.acceptRootOwnership(root);

        MemOceanMarketplace.Listing memory firstAfter = market.getListing(firstId);
        assertEq(firstAfter.capsuleRoot, firstBefore.capsuleRoot);
        assertEq(bytes32(firstAfter.capsuleUuid), bytes32(firstBefore.capsuleUuid));
        assertEq(firstAfter.version, firstBefore.version);
        assertEq(firstAfter.commitmentVersion, firstBefore.commitmentVersion);
        assertEq(firstAfter.seller, seller);
        assertEq(firstAfter.feeRecipient, feeRecipient);
        assertEq(firstAfter.feeBps, 1_000);
        assertEq(firstAfter.priceWei, 3 ether);
        assertEq(firstAfter.cipherIrysId, firstBefore.cipherIrysId);
        assertEq(firstAfter.manifestIrysId, firstBefore.manifestIrysId);
        assertEq(firstAfter.cipherSha256, firstBefore.cipherSha256);
        assertEq(firstAfter.manifestSha256, firstBefore.manifestSha256);
        assertEq(firstAfter.plainCommitment, firstBefore.plainCommitment);
        assertEq(firstAfter.licenseSha256, firstBefore.licenseSha256);
        assertEq(market.initialSeller(root), seller);
        assertEq(bytes32(market.rootUuid(root)), bytes32(uuid));
        assertEq(market.rootOwner(root), attacker);
        assertEq(market.deriveCapsuleRoot(seller, uuid), root);

        MemOceanMarketplace.VersionInput memory third = _input(attacker, uuid, 3, 1 ether);
        third.capsuleRoot = root;
        uint256 thirdId = _listInput(attacker, third);
        assertEq(market.getListing(thirdId).seller, attacker);
        assertEq(market.getListing(thirdId).feeBps, 500);
        assertEq(market.getListing(secondId).seller, seller);
    }

    function testRootOwnershipTransferIsTwoStepAndOnlyCurrentOwnerCanPropose() public {
        bytes16 uuid = bytes16(uint128(0x8888));
        bytes32 root = market.deriveCapsuleRoot(seller, uuid);
        _list(seller, uuid, 1, 1 ether);

        vm.expectRevert(MemOceanMarketplace.Unauthorized.selector);
        vm.prank(attacker);
        market.transferRootOwnership(root, buyer);

        vm.prank(seller);
        market.transferRootOwnership(root, attacker);
        assertEq(market.rootOwner(root), seller);
        assertEq(market.pendingRootOwner(root), attacker);

        vm.expectRevert(MemOceanMarketplace.Unauthorized.selector);
        vm.prank(buyer);
        market.acceptRootOwnership(root);
        vm.prank(attacker);
        market.acceptRootOwnership(root);
        assertEq(market.rootOwner(root), attacker);
        assertEq(market.pendingRootOwner(root), address(0));
    }

    function testPurchaseRequiresExactCurrentQuoteAndRejectsSelfOrDuplicate() public {
        bytes16 uuid = bytes16(uint128(0x9999));
        uint256 listingId = _list(seller, uuid, 1, 1_000);

        vm.expectRevert(
            abi.encodeWithSelector(MemOceanMarketplace.PriceChanged.selector, uint256(999), uint256(1_000))
        );
        vm.prank(buyer);
        market.purchase{value: 999}(listingId, 999);

        vm.expectRevert(
            abi.encodeWithSelector(MemOceanMarketplace.IncorrectPayment.selector, uint256(1_000), uint256(999))
        );
        vm.prank(buyer);
        market.purchase{value: 999}(listingId, 1_000);

        vm.expectRevert(
            abi.encodeWithSelector(MemOceanMarketplace.IncorrectPayment.selector, uint256(1_000), uint256(1_001))
        );
        vm.prank(buyer);
        market.purchase{value: 1_001}(listingId, 1_000);

        vm.expectRevert(MemOceanMarketplace.InvalidInput.selector);
        vm.prank(seller);
        market.purchase{value: 1_000}(listingId, 1_000);

        vm.expectRevert(MemOceanMarketplace.UnknownListing.selector);
        vm.prank(buyer);
        market.purchase{value: 1_000}(999, 1_000);

        vm.prank(buyer);
        market.purchase{value: 1_000}(listingId, 1_000);
        assertTrue(market.hasPurchased(buyer, listingId));
        assertEq(market.credits(seller), 900);
        assertEq(market.credits(feeRecipient), 100);
        assertEq(market.totalLiabilities(), 1_000);
        assertEq(address(market).balance, 1_000);

        vm.expectRevert(MemOceanMarketplace.AlreadyPurchased.selector);
        vm.prank(buyer);
        market.purchase{value: 1_000}(listingId, 1_000);
    }

    function testDelistingDoesNotErasePurchaseAccessAndIsAdminAvailable() public {
        bytes16 uuid = bytes16(uint128(0xA001));
        uint256 listingId = _list(seller, uuid, 1, 1 ether);
        vm.prank(buyer);
        market.purchase{value: 1 ether}(listingId, 1 ether);

        vm.prank(attacker);
        vm.expectRevert(MemOceanMarketplace.Unauthorized.selector);
        market.delist(listingId);
        market.delist(listingId);

        assertFalse(market.getListing(listingId).active);
        assertTrue(market.hasPurchased(buyer, listingId));
        vm.expectRevert(MemOceanMarketplace.ListingInactive.selector);
        vm.prank(attacker);
        market.purchase{value: 1 ether}(listingId, 1 ether);
    }

    function testFeeCapAndListingFeeSnapshot() public {
        vm.expectRevert(MemOceanMarketplace.FeeTooHigh.selector);
        market.setDefaultFee(1_001, nextFeeRecipient);
        market.setDefaultFee(0, nextFeeRecipient);

        bytes16 uuid = bytes16(uint128(0xA002));
        uint256 firstId = _list(seller, uuid, 1, 1_000);
        market.setDefaultFee(1_000, feeRecipient);
        vm.prank(buyer);
        market.purchase{value: 1_000}(firstId, 1_000);

        assertEq(market.getListing(firstId).feeBps, 0);
        assertEq(market.getListing(firstId).feeRecipient, nextFeeRecipient);
        assertEq(market.credits(nextFeeRecipient), 0);
        assertEq(market.credits(feeRecipient), 0);
        assertEq(market.credits(seller), 1_000);
    }

    function testRoundingAtOneWeiAndMaximumUintPaymentIsSafe() public {
        bytes16 uuid = bytes16(uint128(0xA003));
        uint256 oneWeiId = _list(seller, uuid, 1, 1);
        vm.prank(buyer);
        market.purchase{value: 1}(oneWeiId, 1);
        assertEq(market.credits(seller), 1);
        assertEq(market.credits(feeRecipient), 0);
        assertEq(market.totalLiabilities(), 1);

        vm.prank(seller);
        market.withdraw(payable(seller));

        MemOceanMarketplace.VersionInput memory maxInput = _input(attacker, bytes16(uint128(0xA004)), 1, type(uint256).max);
        uint256 maxListingId = _listInput(attacker, maxInput);
        vm.deal(buyer, type(uint256).max);
        uint256 platformShare = type(uint256).max / 10;
        vm.prank(buyer);
        market.purchase{value: type(uint256).max}(maxListingId, type(uint256).max);

        assertEq(market.credits(attacker), type(uint256).max - platformShare);
        assertEq(market.credits(feeRecipient), platformShare);
        assertEq(market.totalLiabilities(), type(uint256).max);
        assertEq(address(market).balance, type(uint256).max);
    }

    function testFuzzPurchaseSplitPreservesLiabilities(uint96 rawPrice, uint16 rawFeeBps) public {
        uint256 price = rawPrice == 0 ? 1 : uint256(rawPrice);
        uint16 feeBps = rawFeeBps % 1_001;
        market.setDefaultFee(feeBps, feeRecipient);
        bytes16 uuid = bytes16(uint128(uint256(rawPrice) + 1));
        uint256 listingId = _list(seller, uuid, 1, price);
        vm.deal(buyer, price);

        vm.prank(buyer);
        market.purchase{value: price}(listingId, price);

        uint256 expectedPlatform = price * feeBps / 10_000;
        uint256 expectedSeller = price - expectedPlatform;
        assertEq(market.credits(seller), expectedSeller);
        assertEq(market.credits(feeRecipient), expectedPlatform);
        assertEq(expectedSeller + expectedPlatform, price);
        assertEq(market.totalLiabilities(), price);
        assertTrue(address(market).balance >= market.totalLiabilities());
    }

    function testPauseBlocksTradingButAllowsDelistViewsAndWithdrawals() public {
        bytes16 uuid = bytes16(uint128(0xA005));
        uint256 listingId = _list(seller, uuid, 1, 1_000);
        vm.prank(buyer);
        market.purchase{value: 1_000}(listingId, 1_000);

        market.pause();
        assertTrue(market.paused());
        assertTrue(market.hasPurchased(buyer, listingId));
        assertEq(market.getListing(listingId).priceWei, 1_000);

        MemOceanMarketplace.VersionInput memory next = _input(seller, uuid, 2, 1_000);
        next.capsuleRoot = market.deriveCapsuleRoot(seller, uuid);
        vm.expectRevert(MemOceanMarketplace.MarketplacePaused.selector);
        vm.prank(seller);
        market.listVersion(next);

        vm.expectRevert(MemOceanMarketplace.MarketplacePaused.selector);
        vm.prank(seller);
        market.updatePrice(listingId, 2_000);

        vm.expectRevert(MemOceanMarketplace.MarketplacePaused.selector);
        vm.prank(attacker);
        market.purchase{value: 1_000}(listingId, 1_000);

        market.delist(listingId);
        assertFalse(market.getListing(listingId).active);
        vm.prank(seller);
        market.withdraw(payable(seller));
        assertEq(market.credits(seller), 0);
        assertEq(market.totalLiabilities(), 100);

        market.unpause();
        assertFalse(market.paused());
    }

    function testWithdrawUsesEffectsBeforeInteractionsAndRestoresCreditOnFailure() public {
        RejectingReceiver rejecting = new RejectingReceiver();
        market.setDefaultFee(1_000, address(rejecting));
        bytes16 uuid = bytes16(uint128(0xA006));
        uint256 listingId = _list(seller, uuid, 1, 1_000);
        vm.prank(buyer);
        market.purchase{value: 1_000}(listingId, 1_000);
        assertEq(market.credits(address(rejecting)), 100);

        (bool success,) = address(rejecting).call(
            abi.encodeWithSelector(RejectingReceiver.withdrawFrom.selector, market)
        );
        assertFalse(success);
        assertEq(market.credits(address(rejecting)), 100);
        assertEq(market.totalLiabilities(), 1_000);
        assertEq(address(market).balance, 1_000);

        vm.prank(seller);
        market.withdraw(payable(seller));
        assertEq(market.credits(seller), 0);
        assertEq(market.totalLiabilities(), 100);
    }

    function testReceiverCannotReenterWithdrawOrSurplusSweepButCanSafelyPurchase() public {
        ReentrantReceiver receiver = new ReentrantReceiver();
        MemOceanMarketplace reentrantMarket = new MemOceanMarketplace(address(receiver), feeRecipient);
        vm.deal(buyer, 1 ether);

        uint256 receiverListingId = receiver.createListing(reentrantMarket, bytes16(uint128(0xB001)), 1_000);
        uint256 cheapListingId = _listOn(reentrantMarket, seller, bytes16(uint128(0xB002)), 1, 1);
        receiver.configure(cheapListingId, 1);

        vm.prank(buyer);
        reentrantMarket.purchase{value: 1_000}(receiverListingId, 1_000);
        assertEq(reentrantMarket.credits(address(receiver)), 900);

        receiver.withdrawCredits();

        assertFalse(receiver.nestedWithdrawSucceeded());
        assertTrue(receiver.nestedPurchaseSucceeded());
        assertFalse(receiver.nestedSweepSucceeded());
        assertTrue(reentrantMarket.hasPurchased(address(receiver), cheapListingId));
        assertEq(reentrantMarket.credits(address(receiver)), 0);
        assertEq(address(receiver).balance, 899);
        assertEq(reentrantMarket.totalLiabilities(), 101);
        assertTrue(address(reentrantMarket).balance >= reentrantMarket.totalLiabilities());
    }

    function testForcedEtherIsOnlySurplusAndSweepCannotTouchLiabilities() public {
        bytes16 uuid = bytes16(uint128(0xA007));
        uint256 listingId = _list(seller, uuid, 1, 1_000);
        vm.prank(buyer);
        market.purchase{value: 1_000}(listingId, 1_000);
        assertEq(market.totalLiabilities(), 1_000);

        vm.deal(address(this), 1 ether);
        ForceEther forceEther = new ForceEther{value: 1 ether}();
        forceEther.force(payable(address(market)));
        assertEq(address(market).balance, 1 ether + 1_000);
        assertEq(market.totalLiabilities(), 1_000);

        uint256 beforeBalance = feeRecipient.balance;
        market.sweepSurplus(payable(feeRecipient));
        assertEq(feeRecipient.balance, beforeBalance + 1 ether);
        assertEq(address(market).balance, market.totalLiabilities());
        assertEq(market.credits(seller), 900);
        assertEq(market.credits(feeRecipient), 100);

        vm.expectRevert(MemOceanMarketplace.NoSurplus.selector);
        market.sweepSurplus(payable(feeRecipient));
    }

    function testDirectNativeTransferIsRejected() public {
        (bool success,) = address(market).call{value: 1} ("");
        assertFalse(success);
    }

    function testOnlyAdminCanPauseAndWithdrawRejectsZeroAddressOrEmptyCredit() public {
        vm.expectRevert();
        vm.prank(attacker);
        market.pause();

        vm.expectRevert(MemOceanMarketplace.InvalidInput.selector);
        vm.prank(seller);
        market.withdraw(payable(address(0)));

        vm.expectRevert(MemOceanMarketplace.NothingToWithdraw.selector);
        vm.prank(seller);
        market.withdraw(payable(seller));
    }

    function _input(address rootSeller, bytes16 uuid, uint32 version, uint256 price)
        private
        view
        returns (MemOceanMarketplace.VersionInput memory input)
    {
        input = MemOceanMarketplace.VersionInput({
            capsuleRoot: market.deriveCapsuleRoot(rootSeller, uuid),
            capsuleUuid: uuid,
            version: version,
            commitmentVersion: 1,
            cipherIrysId: "cipher-tx-id",
            manifestIrysId: "manifest-tx-id",
            cipherSha256: keccak256("cipher-bytes"),
            manifestSha256: keccak256("manifest-bytes"),
            plainCommitment: keccak256("salt-and-plaintext"),
            licenseSha256: keccak256("license-text"),
            priceWei: price
        });
    }

    function _list(address rootSeller, bytes16 uuid, uint32 version, uint256 price)
        private
        returns (uint256 listingId)
    {
        return _listInput(rootSeller, _input(rootSeller, uuid, version, price));
    }

    function _listInput(address rootSeller, MemOceanMarketplace.VersionInput memory input)
        private
        returns (uint256 listingId)
    {
        vm.prank(rootSeller);
        listingId = market.listVersion(input);
    }

    function _listOn(
        MemOceanMarketplace targetMarket,
        address rootSeller,
        bytes16 uuid,
        uint32 version,
        uint256 price
    ) private returns (uint256 listingId) {
        MemOceanMarketplace.VersionInput memory input = MemOceanMarketplace.VersionInput({
            capsuleRoot: targetMarket.deriveCapsuleRoot(rootSeller, uuid),
            capsuleUuid: uuid,
            version: version,
            commitmentVersion: 1,
            cipherIrysId: "cipher-tx-id",
            manifestIrysId: "manifest-tx-id",
            cipherSha256: keccak256("cipher-bytes"),
            manifestSha256: keccak256("manifest-bytes"),
            plainCommitment: keccak256("salt-and-plaintext"),
            licenseSha256: keccak256("license-text"),
            priceWei: price
        });
        vm.prank(rootSeller);
        listingId = targetMarket.listVersion(input);
    }

    function _expectInvalidInput(address rootSeller, MemOceanMarketplace.VersionInput memory input) private {
        vm.expectRevert(MemOceanMarketplace.InvalidInput.selector);
        vm.prank(rootSeller);
        market.listVersion(input);
    }

    function assertEq(uint256 actual, uint256 expected) private pure {
        assert(actual == expected);
    }

    function assertEq(address actual, address expected) private pure {
        assert(actual == expected);
    }

    function assertEq(bytes32 actual, bytes32 expected) private pure {
        assert(actual == expected);
    }

    function assertEq(string memory actual, string memory expected) private pure {
        assert(keccak256(bytes(actual)) == keccak256(bytes(expected)));
    }

    function assertTrue(bool condition) private pure {
        assert(condition);
    }

    function assertFalse(bool condition) private pure {
        assert(!condition);
    }
}
