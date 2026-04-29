import {
  createAggregator,
  createCrossChainProvider,
  OrderTrackerFactory,
  PROTOCOLS,
  LIFI_INTENTS_ORDER_SERVER_URL,
  type Aggregator
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

  // Implemented in EFI-892
  async getSupportedChains(): Promise<SwapAndBridgeSupportedChain[]> {
    return []
  }

  // Implemented in EFI-892
  async getToTokenList(_params: {
    fromChainId: number
    toChainId: number
  }): Promise<SwapAndBridgeToToken[]> {
    return []
  }

  // Implemented in EFI-892
  async getToken(_params: {
    address: string
    chainId: number
  }): Promise<SwapAndBridgeToToken | null> {
    return null
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
}
