/**
 * OpenAPI 3.1 Schema definitions for MorScan API
 */

export const schemas = {
	SyncMetadata: {
		type: "object",
		properties: {
			currentBlock: { type: "integer", description: "Latest block on chain" },
			syncedBlock: { type: "integer", description: "Last synced block" },
			blocksBehind: { type: "integer", description: "How many blocks behind" },
			lastSyncTs: { type: "string", format: "date-time" },
			timestamp: { type: "string", format: "date-time" },
		},
	},
	HealthResponse: {
		type: "object",
		properties: {
			status: { type: "string", enum: ["healthy", "degraded"] },
			currentBlock: { type: "integer" },
			syncedBlock: { type: "integer" },
			blocksBehind: { type: "integer" },
			providers: { type: "integer" },
			bids: { type: "integer" },
			sessions: { type: "integer" },
			activeSessions: { type: "integer" },
		},
	},
	TeaserResponse: {
		type: "object",
		properties: {
			providers: { type: "integer" },
			bids: { type: "integer" },
			activeSessions: { type: "integer" },
			totalSessions: { type: "integer" },
			morStaked: { type: "integer", description: "Total MOR staked in active sessions" },
		},
	},
	Provider: {
		type: "object",
		properties: {
			address: { type: "string", description: "0x provider address" },
			endpoint: { type: "string", description: "Provider RPC endpoint" },
			stake: { type: "string", description: "Provider stake in wei" },
			bidCount: { type: "integer", description: "Active bid count" },
			retractedBidCount: { type: "integer", description: "Retracted bid count" },
			bids: { type: "array", items: { $ref: "#/components/schemas/Bid" } },
			retractedBids: {
				type: "array",
				items: { $ref: "#/components/schemas/RetractedBid" },
			},
		},
	},
	Bid: {
		type: "object",
		properties: {
			bidId: { type: "string", description: "bytes32 bid ID" },
			provider: { type: "string" },
			modelId: { type: "string", description: "bytes32 model ID" },
			model: { type: "string", description: "Human-readable model name" },
			tags: { type: "array", items: { type: "string" } },
			pricePerSecond: { type: "string", description: "Price in wei per second" },
			priceMorPerDay: { type: "string", description: "Price in MOR per day" },
			priceMorPerWeek: { type: "string", description: "Price in MOR per week" },
		},
	},
	RetractedBid: {
		type: "object",
		properties: {
			bidId: { type: "string" },
			model: { type: "string" },
			priceMorPerDay: { type: "string" },
			retractedAt: { type: "integer", description: "Unix timestamp when retracted" },
		},
	},
	Session: {
		type: "object",
		properties: {
			sessionId: { type: "string" },
			user: { type: "string", description: "User wallet address" },
			provider: { type: "string" },
			bidId: { type: "string" },
			modelId: { type: "string" },
			model: { type: "string" },
			stake: { type: "string", description: "Staked amount in wei" },
			stakeMor: { type: "number", description: "Staked amount in MOR" },
			isActive: { type: "boolean" },
			openedAt: { type: "integer" },
			closedAt: { type: "integer", nullable: true },
			endsAt: { type: "integer" },
		},
	},
	MarketplaceResponse: {
		allOf: [
			{ $ref: "#/components/schemas/SyncMetadata" },
			{
				type: "object",
				properties: {
					providers: { type: "array", items: { $ref: "#/components/schemas/Provider" } },
				},
			},
		],
	},
	ProvidersResponse: {
		allOf: [
			{ $ref: "#/components/schemas/SyncMetadata" },
			{
				type: "object",
				properties: {
					providers: { type: "array", items: { $ref: "#/components/schemas/Provider" } },
				},
			},
		],
	},
	BidsResponse: {
		allOf: [
			{ $ref: "#/components/schemas/SyncMetadata" },
			{
				type: "object",
				properties: {
					bids: { type: "array", items: { $ref: "#/components/schemas/Bid" } },
				},
			},
		],
	},
	ModelsResponse: {
		allOf: [
			{ $ref: "#/components/schemas/SyncMetadata" },
			{
				type: "object",
				properties: {
					models: {
						type: "array",
						items: {
							type: "object",
							properties: {
								modelId: { type: "string" },
								name: { type: "string" },
								tags: { type: "array", items: { type: "string" } },
							},
						},
					},
				},
			},
		],
	},
	SessionsResponse: {
		allOf: [
			{ $ref: "#/components/schemas/SyncMetadata" },
			{
				type: "object",
				properties: {
					sessions: { type: "array", items: { $ref: "#/components/schemas/Session" } },
					total: { type: "integer" },
				},
			},
		],
	},
	AnalyticsResponse: {
		allOf: [
			{ $ref: "#/components/schemas/SyncMetadata" },
			{
				type: "object",
				properties: {
					wallets: {
						type: "array",
						items: {
							type: "object",
							properties: {
								wallet: { type: "string" },
								activeSessions: { type: "integer" },
								totalSessions: { type: "integer" },
								totalStakedMor: { type: "number" },
							},
						},
					},
				},
			},
		],
	},
	WalletDetailResponse: {
		allOf: [
			{ $ref: "#/components/schemas/SyncMetadata" },
			{
				type: "object",
				properties: {
					wallet: { type: "string" },
					ethBalance: { type: "string" },
					morBalance: { type: "string" },
					activeSessions: { type: "integer" },
					totalSessions: { type: "integer" },
					sessions: { type: "array", items: { $ref: "#/components/schemas/Session" } },
				},
			},
		],
	},
};
