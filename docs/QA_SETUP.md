# QA setup — Ambire + Interop SDK

Build the Ambire extension locally against the `ambire-common-interop` fork
to test cross-chain swaps via LiFi Intents and Bungee.

## Steps

```bash
# 1. Clone the upstream extension
git clone https://github.com/AmbireTech/extension.git ambire-extension
cd ambire-extension

# 2. Replace the ambire-common submodule with our fork
rm -rf src/ambire-common
git clone -b feat/interop-sdk https://github.com/defi-wonderland/ambire-common-interop.git src/ambire-common

# 3. Add the SDK dep (modifies package.json/yarn.lock locally, do not commit)
yarn add @wonderland/interop-cross-chain@0.10.0

# 4. Set up .env (placeholder values, no real secrets)
cp src/ambire-common/docs/qa.env .env

# 5. Install and build
yarn setup
# `:generate-policy` regenerates the LavaMoat allowlist to include the new
# SDK deps. Without it, the extension throws "Policy does not allow importing"
# at runtime.
yarn build:web:webkit:generate-policy
```

## Load in Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select `ambire-extension/build/webkit-prod/`

## Verify

Open a cross-chain swap (e.g. 10 USDC Base → USDC Arbitrum). Routes should
come from **LiFi Intents** or **Bungee** (not classic LiFi or Socket).
