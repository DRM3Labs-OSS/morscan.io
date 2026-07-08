/**
 * UI Handlers - barrel re-export
 *
 * All existing imports like `from './handlers/ui'` or `from '../handlers/ui'`
 * resolve here and continue to work unchanged.
 */

export {
	handleAppPage,
	handleApiPage,
	handleAnalyticsTabPage,
	handleProviderDetailPage,
	handleWalletDetailPage,
	getCachedPrice,
	getStatBarData,
	extractPage,
	morStat,
	escJs,
	safeJson,
	pathToTab,
	HTML_HEADERS,
	JSON_HEADERS,
} from "./compute";

export {
	handleBuilderPage,
	handleBuilderCalcPage,
	handleBuilderApiPage,
	handleBuilderSubnetPage,
} from "./builder";

export {
	handleLandingPage,
	handleTermsPage,
	handlePrivacyPage,
	handleContributePage,
	handleStakePage,
	handleHoldersPage,
	handlePoolsPage,
	handleAboutPage,
	handleVerifyPage,
	handle404,
} from "./pages";

export {
	handleOgImage,
	handleSubnetOg,
	handlePageOg,
	handleDrm3IconBlack,
	handleDrm3IconTransparent,
	handleMorscanIcon,
	handleFont,
} from "./assets";
