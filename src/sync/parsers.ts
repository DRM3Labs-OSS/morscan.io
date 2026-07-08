/**
 * Sync Parsers & RPC Helpers - barrel re-export.
 *
 * Implementation split across:
 *   - parsers-rpc.ts  selectors, endpoint pool, batched eth_call infrastructure
 *   - parsers-abi.ts  pure ABI decoders + hex utilities
 *
 * Existing imports from './parsers' (or '../sync/parsers') keep working.
 */

export {
	SELECTORS,
	RPC_ENDPOINTS,
	type RpcResponse,
	ethCall,
	ethCallBatch,
	ethCallBatchChecked,
} from "./parsers-rpc";

export {
	padUint256,
	hexToString,
	padAddress,
	parseProviderResult,
	parseArrayResult,
	parseBidResult,
	parseSessionResult,
	parseModelResult,
} from "./parsers-abi";
