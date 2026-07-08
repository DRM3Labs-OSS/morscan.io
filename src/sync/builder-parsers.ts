/**
 * Builder Staking Parsers - barrel re-export.
 *
 * Implementation split across:
 *   - builder-parsers-rpc.ts     selectors + eth_call against the BuildersV4 contract
 *   - builder-parsers-decode.ts  pure ABI decoders + hex/padding utilities
 *
 * Existing imports from './builder-parsers' keep working.
 */

export { BUILDER_SELECTORS, ethCallBuilder } from "./builder-parsers-rpc";

export {
	padBytes32,
	padAddress,
	parseAllSubnetsData,
	parseAllSubnetsDataV4,
	parseSubnetsData,
	parseBuilderStakeEvent,
	parseBuilderClaimEvent,
	parseSubnetCreatedEvent,
	parseSubnetStruct,
	parseSubnetMetadata,
} from "./builder-parsers-decode";
