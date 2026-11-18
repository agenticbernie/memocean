import { createConfig, http } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { avalancheFuji } from 'wagmi/chains';
import compiledMarketplaceAbi from '../../../packages/contracts/abi/MemOceanMarketplace.json';
import type { Abi } from 'viem';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();
const connectors = projectId
  ? [injected(), walletConnect({ projectId, showQrModal: true })]
  : [injected()];

export const FUJI_CHAIN_ID = 43113;
export const fujiConfig = createConfig({
  chains: [avalancheFuji],
  connectors,
  transports: {
    [avalancheFuji.id]: http(import.meta.env.VITE_AVALANCHE_RPC_URL?.trim() || undefined, { retryCount: 1 }),
  },
  ssr: false,
});

export const marketplaceAddress = import.meta.env.VITE_MARKETPLACE_ADDRESS?.trim() as `0x${string}` | undefined;
export const marketplaceChainId = Number(import.meta.env.VITE_CHAIN_ID || FUJI_CHAIN_ID);
export const marketplaceAbi = compiledMarketplaceAbi as unknown as Abi;
export const marketplaceAbiAvailable = Array.isArray(compiledMarketplaceAbi) && compiledMarketplaceAbi.some((item: unknown) => {
  if (!item || typeof item !== 'object') return false;
  const entry = item as { type?: unknown; name?: unknown };
  return entry.type === 'function' && entry.name === 'purchase';
});