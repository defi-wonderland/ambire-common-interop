import { Hex } from 'viem'

import {
  createAggregator,
  createCrossChainProvider,
  OrderStatus,
  OrderTrackerFactory,
  PROTOCOLS,
  LIFI_INTENTS_ORDER_SERVER_URL,
  type Aggregator,
  type QuoteRequest
} from '@wonderland/interop-cross-chain'

import SwapAndBridgeProviderApiError from '../../classes/SwapAndBridgeProviderApiError'
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
import { mapQuoteToRoute, toSdkProviderId, toSwapAndBridgeToken } from './helpers'

const ORDER_STATUS_TO_ROUTE_STATUS: Record<OrderStatus, SwapAndBridgeRouteStatus> = {
  [OrderStatus.Finalized]: 'completed',
  [OrderStatus.Failed]: 'refunded',
  [OrderStatus.Refunded]: 'refunded',
  [OrderStatus.Created]: null,
  [OrderStatus.Pending]: null,
  [OrderStatus.Executed]: null,
  [OrderStatus.Settled]: null,
  [OrderStatus.Executing]: null,
  [OrderStatus.Settling]: null
}

/**
 * SwapProvider adapter for the interop SDK's Aggregator. Replaces the LiFi +
 * Socket parallel executor when the useInteropSdk feature flag is enabled.
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

  /**
   * Returns the chains supported by the SDK's underlying providers.
   * Derived from the keys of the asset discovery response.
   */
  async getSupportedChains(): Promise<SwapAndBridgeSupportedChain[]> {
    const assets = await this.aggregator.discoverAssets()
    const chains = Object.keys(assets.tokensByChain).map((chainId) => ({
      chainId: Number(chainId)
    }))
    this.supportedChains = chains
    return chains
  }

  async getToTokenList({
    toChainId
  }: {
    fromChainId: number
    toChainId: number
  }): Promise<SwapAndBridgeToToken[]> {
    const assets = await this.aggregator.discoverAssets()
    const addresses = assets.tokensByChain[toChainId] ?? []
    const metadata = assets.tokenMetadata[toChainId] ?? {}

    return addresses.reduce<SwapAndBridgeToToken[]>((tokens, addr) => {
      const info = metadata[addr]
      if (!info?.symbol) return tokens
      tokens.push(toSwapAndBridgeToken(info, toChainId))
      return tokens
    }, [])
  }

  async getToken({
    address,
    chainId
  }: {
    address: string
    chainId: number
  }): Promise<SwapAndBridgeToToken | null> {
    const assets = await this.aggregator.discoverAssets()
    const info = assets.tokenMetadata[chainId]?.[address.toLowerCase()]
    if (!info) return null

    return toSwapAndBridgeToken(info, chainId)
  }

  /**
   * Attaches txData/approvalData to each route so startRoute() can read them
   * without a second API call (Socket pattern).
   */
  async quote(params: ProviderQuoteParams): Promise<SwapAndBridgeQuote> {
    const request: QuoteRequest = {
      user: params.userAddress,
      input: {
        chainId: params.fromChainId,
        assetAddress: params.fromTokenAddress,
        amount: params.fromAmount.toString()
      },
      output: {
        chainId: params.toChainId,
        assetAddress: params.toTokenAddress
      }
    }

    let result
    try {
      result = await this.aggregator.getQuotes(request)
    } catch (e) {
      throw new SwapAndBridgeProviderApiError(e instanceof Error ? e.message : String(e))
    }

    const { quotes, errors } = result
    const [firstQuote, ...restQuotes] = quotes
    if (!firstQuote) {
      throw new SwapAndBridgeProviderApiError(errors[0]?.errorMsg ?? 'No routes available')
    }

    if (!params.fromAsset) {
      throw new SwapAndBridgeProviderApiError('Missing fromAsset for quote')
    }

    const fromAssetToken: SwapAndBridgeToToken = {
      symbol: params.fromAsset.symbol,
      name: params.fromAsset.symbol,
      chainId: params.fromChainId,
      address: params.fromTokenAddress,
      icon: '',
      decimals: params.fromAsset.decimals
    }
    const toAssetToken: SwapAndBridgeToToken = params.toAsset ?? {
      symbol: '',
      name: '',
      chainId: params.toChainId,
      address: params.toTokenAddress,
      icon: '',
      decimals: 18
    }

    const firstRoute = mapQuoteToRoute(firstQuote, fromAssetToken, toAssetToken, params)
    const routes = [
      firstRoute,
      ...restQuotes.map((q) => mapQuoteToRoute(q, fromAssetToken, toAssetToken, params))
    ]

    return {
      fromAsset: fromAssetToken,
      fromChainId: params.fromChainId,
      toAsset: toAssetToken,
      toChainId: params.toChainId,
      selectedRoute: undefined,
      selectedRouteSteps: firstRoute.steps,
      routes
    }
  }

  /**
   * Reads the tx data and approval requirements that were attached during
   * quote() (Socket pattern), so this is a pure mapping and never makes a
   * second SDK call.
   */
  async startRoute(route: SwapAndBridgeRoute): Promise<SwapAndBridgeSendTxRequest> {
    if (!route.txData) {
      throw new SwapAndBridgeProviderApiError(
        'Route is missing txData; signature-only quotes are rejected at quote time'
      )
    }
    return {
      activeRouteId: route.routeId,
      approvalData: route.approvalData
        ? {
            allowanceTarget: route.approvalData.spenderAddress,
            approvalTokenAddress: route.approvalData.tokenAddress,
            minimumApprovalAmount: route.approvalData.amount,
            owner: route.approvalData.userAddress
          }
        : null,
      chainId: route.txData.chainId,
      txData: route.txData.data,
      txTarget: route.txData.to,
      userTxIndex: route.currentUserTxIndex,
      value: route.txData.value
    }
  }

  async getRouteStatus({
    txHash,
    fromChainId,
    providerId
  }: {
    txHash: string
    fromChainId: number
    toChainId: number
    bridge?: string
    providerId: string
  }): Promise<SwapAndBridgeRouteStatus> {
    try {
      const order = await this.aggregator.getOrderStatus({
        txHash: txHash as Hex,
        providerId: toSdkProviderId(providerId),
        originChainId: fromChainId
      })
      return ORDER_STATUS_TO_ROUTE_STATUS[order.status]
    } catch {
      return null
    }
  }
}
