/** OpenAPI path definitions - extracted from openapi.ts to keep each file lean. */

export const paths = {
	"/health": {
		get: {
			summary: "Health Check",
			description: "Returns sync status, block heights, and database counts.",
			tags: ["Status"],
			responses: {
				"200": {
					description: "Health status",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/HealthResponse" },
						},
					},
				},
			},
		},
	},
	"/teaser": {
		get: {
			summary: "Public Stats",
			description: "Quick stats without authentication - for splash screens.",
			tags: ["Status"],
			responses: {
				"200": {
					description: "Basic stats",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/TeaserResponse" },
						},
					},
				},
			},
		},
	},
	"/mor/v1/capacity": {
		get: {
			summary: "Remaining Capacity",
			description:
				"Your remaining rate-limit capacity across all three windows (per-minute, day, month), plus your live MOR stake and wallet. Free to check: this endpoint reports quota without spending it (a per-IP budget still applies).",
			tags: ["Account"],
			security: [{ apiKey: [] }],
			responses: {
				"200": {
					description: "Remaining capacity",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									perMin: {
										type: "object",
										properties: {
											limit: { type: "integer", example: 10 },
											used: { type: "integer", example: 3 },
											remaining: { type: "integer", example: 7 },
											resetInSeconds: { type: "integer", example: 42 },
										},
									},
									today: {
										type: "object",
										properties: {
											limit: { type: "integer", example: 2000 },
											used: { type: "integer", example: 15 },
											remaining: { type: "integer", example: 1985 },
											resetsAt: { type: "string", format: "date-time" },
										},
									},
									month: {
										type: "object",
										properties: {
											limit: { type: "integer", example: 40000 },
											used: { type: "integer", example: 15 },
											remaining: { type: "integer", example: 39985 },
											resetsAt: { type: "string", format: "date-time" },
										},
									},
									stakeMor: { type: "number", example: 0 },
									wallet: { type: "string", nullable: true, example: "0x1234...abcd" },
								},
							},
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
				"429": {
					description:
						"Rate limited - the per-minute cap was reached. Retry-After header indicates when to retry.",
				},
			},
		},
	},
	"/mor/v1/all": {
		get: {
			summary: "Full Marketplace",
			description:
				"All providers with their bids (active + retracted), model names from chain.",
			tags: ["Marketplace"],
			security: [{ apiKey: [] }],
			responses: {
				"200": {
					description: "Full marketplace data",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/MarketplaceResponse" },
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
	"/mor/v1/providers": {
		get: {
			summary: "Provider List",
			description: "All registered providers with endpoint info.",
			tags: ["Marketplace"],
			security: [{ apiKey: [] }],
			responses: {
				"200": {
					description: "Provider list",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ProvidersResponse" },
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
	"/mor/v1/bids": {
		get: {
			summary: "All Bids",
			description: "All bids with model names and pricing.",
			tags: ["Marketplace"],
			security: [{ apiKey: [] }],
			responses: {
				"200": {
					description: "Bid list",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/BidsResponse" },
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
	"/mor/v1/models": {
		get: {
			summary: "Model Registry",
			description: "All registered models with human-readable names from chain.",
			tags: ["Models"],
			security: [{ apiKey: [] }],
			responses: {
				"200": {
					description: "Model list",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ModelsResponse" },
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
	"/mor/v1/models/{modelId}/detail": {
		get: {
			summary: "Model Detail",
			description:
				"The canonical-model picture: every on-chain listing of the model (grouped by normalized name, curated via models.canonical) aggregated - description, active bids with providers and pricing across all listings, session demand (totals, distinct consumers, 30-day daily series), per-provider reputation, the listing inventory with web/TEE capability flags, and the model family rollup.",
			tags: ["Models"],
			security: [{ apiKey: [] }],
			parameters: [
				{
					name: "modelId",
					in: "path",
					required: true,
					schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
					description: "The bytes32 model id.",
				},
			],
			responses: {
				"200": { description: "Model detail with signed provenance receipt" },
				"404": { description: "Model not found" },
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
	"/mor/v1/models/lookup": {
		get: {
			summary: "Model ID Lookup",
			description: "Mapping of model IDs to human-readable names.",
			tags: ["Models"],
			security: [{ apiKey: [] }],
			responses: {
				"200": {
					description: "Model ID → name mapping",
					content: {
						"application/json": {
							schema: {
								type: "object",
								additionalProperties: { type: "string" },
								example: { "0x972f711716...": "qwen3-235b:web" },
							},
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
	"/mor/v1/sessions": {
		get: {
			summary: "All Sessions",
			description: "Paginated list of all sessions (active + closed).",
			tags: ["Sessions"],
			security: [{ apiKey: [] }],
			parameters: [
				{
					name: "limit",
					in: "query",
					schema: { type: "integer", default: 100, maximum: 100, minimum: 1 },
					description:
						"Rows per page. Hard cap 100, server-enforced; higher values are clamped and the applied limit is echoed in pagination.limit.",
				},
				{
					name: "page",
					in: "query",
					schema: { type: "integer", default: 1, minimum: 1, maximum: 1000 },
					description: "1-based page number (max depth 1000).",
				},
				{
					name: "active",
					in: "query",
					schema: { type: "boolean" },
					description: "Filter active only",
				},
			],
			responses: {
				"200": {
					description: "Session list",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/SessionsResponse" },
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
	"/mor/v1/sessions/{wallet}": {
		get: {
			summary: "Wallet Sessions",
			description: "Sessions for a specific wallet address.",
			tags: ["Sessions"],
			security: [{ apiKey: [] }],
			parameters: [
				{
					name: "wallet",
					in: "path",
					required: true,
					schema: { type: "string" },
					description: "0x wallet address",
				},
			],
			responses: {
				"200": {
					description: "Wallet sessions",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/SessionsResponse" },
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
	"/mor/v1/sessions/analytics": {
		get: {
			summary: "Session Analytics",
			description: "Per-wallet analytics with claimable stake tracking.",
			tags: ["Sessions"],
			security: [{ apiKey: [] }],
			responses: {
				"200": {
					description: "Analytics data",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/AnalyticsResponse" },
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
	"/mor/v1/wallet/{wallet}": {
		get: {
			summary: "Wallet Detail",
			description: "Full wallet breakdown with ETH/MOR balances and session history.",
			tags: ["Sessions"],
			security: [{ apiKey: [] }],
			parameters: [
				{
					name: "wallet",
					in: "path",
					required: true,
					schema: { type: "string" },
					description: "0x wallet address",
				},
			],
			responses: {
				"200": {
					description: "Wallet detail",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/WalletDetailResponse" },
						},
					},
				},
				"401": { $ref: "#/components/responses/Unauthorized" },
				"402": { $ref: "#/components/responses/PaymentRequired" },
			},
		},
	},
};
