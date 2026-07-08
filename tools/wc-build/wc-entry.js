// Browser entry: bundle @walletconnect/ethereum-provider into a single IIFE
// that the MorScan console self-serves under CSP (script-src 'self'). No CDN.
// esbuild bundles this to src/ui/vendor/wc-provider.txt (see package.json build:wc),
// which the worker imports as text and serves at GET /console/wc.js.
import { EthereumProvider } from "@walletconnect/ethereum-provider";
window.WalletConnectEthereumProvider = EthereumProvider;
