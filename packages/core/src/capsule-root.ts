import { encodeAbiParameters, isAddress, keccak256, parseAbiParameters, toBytes, type Address, type Hex } from 'viem';

const ROOT_DOMAIN = keccak256(toBytes('MemOceanCapsuleRoot:v1'));
const ROOT_ABI = parseAbiParameters('bytes32 domain, uint256 chainId, address marketplace, address initialSeller, bytes16 capsuleUuid');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CapsuleRootInput {
  chainId: bigint | number | string;
  contractAddress: string;
  initialSeller: string;
  capsuleUuid: string;
}

/** Parse a canonical UUID v4 to its raw 16 network-order bytes (not UTF-8 or padded). */
export function capsuleUuidToBytes16(capsuleUuid: string): Hex {
  if (!UUID_V4.test(capsuleUuid)) throw new TypeError('Capsule UUID must be a canonical RFC 4122 version 4 UUID');
  return `0x${capsuleUuid.replaceAll('-', '').toLowerCase()}` as Hex;
}

/**
 * Derive the on-chain root using keccak256(abi.encode(domain, chainId,
 * marketplace, initialSeller, bytes16(uuidBytes))). This intentionally differs
 * from SHA-256 content commitments and does not zero-pad a UUID integer.
 */
export function deriveCapsuleRoot(input: CapsuleRootInput): Hex {
  const chainId = parseChainId(input.chainId);
  const marketplace = parseAddress(input.contractAddress, 'contract address');
  const initialSeller = parseAddress(input.initialSeller, 'initial seller');
  const capsuleUuid = capsuleUuidToBytes16(input.capsuleUuid);
  const encoded = encodeAbiParameters(ROOT_ABI, [ROOT_DOMAIN, chainId, marketplace, initialSeller, capsuleUuid]);
  return keccak256(encoded);
}

function parseChainId(value: bigint | number | string): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError('Chain ID must be a positive safe integer or exact integer string');
  }
  let chainId: bigint;
  try {
    chainId = BigInt(value);
  } catch (cause) {
    throw new TypeError('Chain ID must be a positive integer', { cause });
  }
  if (chainId <= 0n || chainId >= 1n << 256n) throw new TypeError('Chain ID is outside the uint256 range');
  return chainId;
}

function parseAddress(value: string, label: string): Address {
  if (!isAddress(value, { strict: false })) throw new TypeError(`Invalid ${label}`);
  return value.toLowerCase() as Address;
}
