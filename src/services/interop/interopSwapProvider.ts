import { getAddress } from 'ethers'

import {
  createAggregator,
  createCrossChainProvider,
  OrderTrackerFactory,
  PROTOCOLS,
  LIFI_INTENTS_ORDER_SERVER_URL,
  type Aggregator,
  type DiscoveredAssets
} from '@wonderland/interop-cross-chain'

import {
  ProviderQuoteParams,
  SwapAndBridgeQuote,
  SwapAndBridgeRoute,
  SwapAndBridgeRouteStatus,
  SwapAndBridgeSendTxRequest,
  SwapAndBridgeSupportedChain,
  SwapAndBridgeToToken,
  SwapProvider
} from '../../interfaces/swapAndBridge'

/**
 * SwapProvider adapter that routes cross-chain operations through the
 * interop SDK's Aggregator. Implements Ambire's SwapProvider interface
 * so it can replace the existing LiFi + Socket parallel executor when
 * the useInteropSdk feature flag is enabled.
 *
 * Uses LiFi Intents and Bungee as underlying providers via the SDK.
 */
export class InteropSwapProvider implements SwapProvider {
  id: string = 'interop'

  name: string = 'Interop'

  isHealthy: boolean | null = null

  supportedChains: SwapAndBridgeSupportedChain[] | null = null

  private aggregator: Aggregator

  private discoveredAssets: DiscoveredAssets | null = null

  constructor() {
    const providers = [
      createCrossChainProvider(PROTOCOLS.LIFI_INTENTS, {
        orderServerUrl: LIFI_INTENTS_ORDER_SERVER_URL,
        providerId: 'lifi-intents'
      }),
      createCrossChainProvider(PROTOCOLS.BUNGEE, {
        providerId: 'bungee'
      })
    ]

    this.aggregator = createAggregator({
      providers,
      trackerFactory: new OrderTrackerFactory({})
    })
  }

  updateHealth(): void {
    this.isHealthy = null
  }

  resetHealth(): void {
    this.isHealthy = null
  }

  /**
   * Returns the chains supported by the SDK's underlying providers.
   * Derived from the keys of the asset discovery response.
   */
  async getSupportedChains(): Promise<SwapAndBridgeSupportedChain[]> {
    const assets = await this.getDiscoveredAssets()
    const chains = Object.keys(assets.tokensByChain).map((chainId) => ({
      chainId: Number(chainId)
    }))
    this.supportedChains = chains
    return chains
  }

  /**
   * Returns the tokens available on `toChainId`. The `fromChainId` is
   * accepted for interface compatibility but ignored — the SDK validates
   * route feasibility at quote time, not from the token list.
   */
  async getToTokenList({
    toChainId
  }: {
    fromChainId: number
    toChainId: number
  }): Promise<SwapAndBridgeToToken[]> {
    const assets = await this.getDiscoveredAssets()
    const addresses = assets.tokensByChain[toChainId] ?? []
    const metadata = assets.tokenMetadata[toChainId] ?? {}

    return addresses.reduce<SwapAndBridgeToToken[]>((tokens, addr) => {
      const info = metadata[addr]
      if (!info?.symbol) return tokens
      tokens.push({
        symbol: info.symbol,
        name: info.symbol,
        chainId: toChainId,
        address: safeGetAddress(info.address),
        icon: '',
        decimals: info.decimals
      })
      return tokens
    }, [])
  }

  /**
   * Looks up a single token by address and chain in the discovered assets.
   * Returns null when not found, matching how the parallel executor expects
   * providers to behave when they don't recognize a token.
   */
  async getToken({
    address,
    chainId
  }: {
    address: string
    chainId: number
  }): Promise<SwapAndBridgeToToken | null> {
    const assets = await this.getDiscoveredAssets()
    const info = assets.tokenMetadata[chainId]?.[address.toLowerCase()]
    if (!info) return null

    return {
      symbol: info.symbol,
      name: info.symbol,
      chainId,
      address: safeGetAddress(info.address),
      icon: '',
      decimals: info.decimals
    }
  }

  // Implemented in EFI-893
  async quote(_params: ProviderQuoteParams): Promise<SwapAndBridgeQuote> {
    return {
      fromAsset: { symbol: '', name: '', chainId: 0, address: '', decimals: 0 },
      fromChainId: 0,
      toAsset: { symbol: '', name: '', chainId: 0, address: '', decimals: 0 },
      toChainId: 0,
      selectedRoute: undefined,
      selectedRouteSteps: [],
      routes: []
    }
  }

  // Implemented in EFI-894
  async startRoute(_route: SwapAndBridgeRoute): Promise<SwapAndBridgeSendTxRequest> {
    throw new Error('Not implemented')
  }

  // Implemented in EFI-895
  async getRouteStatus(_params: {
    txHash: string
    fromChainId: number
    toChainId: number
    bridge?: string
    providerId: string
  }): Promise<SwapAndBridgeRouteStatus> {
    return null
  }

  private async getDiscoveredAssets(): Promise<DiscoveredAssets> {
    if (!this.discoveredAssets) {
      this.discoveredAssets = await this.aggregator.discoverAssets()
    }
    return this.discoveredAssets
  }
}

function safeGetAddress(address: string): string {
  try {
    return getAddress(address)
  } catch {
    return address
  }
}
