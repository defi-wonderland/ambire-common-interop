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
    console.log('[interop] InteropSwapProvider constructor, building providers')
    const providers = [
      createCrossChainProvider(PROTOCOLS.LIFI_INTENTS, {
        orderServerUrl: LIFI_INTENTS_ORDER_SERVER_URL,
        providerId: 'lifi-intents'
      }),
      createCrossChainProvider(PROTOCOLS.BUNGEE, {
        providerId: 'bungee'
      })
    ]
    console.log('[interop] providers:', providers.map((p) => p.getProviderId()))

    this.aggregator = createAggregator({
      providers,
      trackerFactory: new OrderTrackerFactory({})
    })
    console.log('[interop] aggregator created')
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
    console.log('[interop] getSupportedChains: calling discoverAssets')
    const assets = await this.aggregator.discoverAssets()
    const chainKeys = Object.keys(assets.tokensByChain)
    console.log('[interop] getSupportedChains: discoverAssets returned chains', chainKeys)
    const chains = chainKeys.map((chainId) => ({
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
    console.log('[interop] getToTokenList: toChainId', toChainId)
    const assets = await this.aggregator.discoverAssets()
    const addresses = assets.tokensByChain[toChainId] ?? []
    const metadata = assets.tokenMetadata[toChainId] ?? {}
    console.log('[interop] getToTokenList: addresses count', addresses.length, 'for chain', toChainId)

    let droppedNoSymbol = 0
    const result = addresses.reduce<SwapAndBridgeToToken[]>((tokens, addr) => {
      const info = metadata[addr]
      if (!info?.symbol) {
        droppedNoSymbol += 1
        return tokens
      }
      tokens.push(toSwapAndBridgeToken(info, toChainId))
      return tokens
    }, [])
    console.log(
      '[interop] getToTokenList: returning',
      result.length,
      'tokens for chain',
      toChainId,
      '(dropped',
      droppedNoSymbol,
      'with empty symbol)'
    )
    return result
  }

  async getToken({
    address,
    chainId
  }: {
    address: string
    chainId: number
  }): Promise<SwapAndBridgeToToken | null> {
    console.log('[interop] getToken:', { chainId, address })
    const assets = await this.aggregator.discoverAssets()
    const info = assets.tokenMetadata[chainId]?.[address.toLowerCase()]
    if (!info) {
      console.log('[interop] getToken: NO info for', address, 'on chain', chainId)
      return null
    }
    console.log('[interop] getToken: found', {
      address: info.address,
      symbol: info.symbol,
      providers: info.providers
    })

    return toSwapAndBridgeToken(info, chainId)
  }

  /**
   * Attaches txData/approvalData to each route so startRoute() can read them
   * without a second API call (Socket pattern).
   */
  async quote(params: ProviderQuoteParams): Promise<SwapAndBridgeQuote> {
    console.log('[interop] quote: request', {
      fromChainId: params.fromChainId,
      fromTokenAddress: params.fromTokenAddress,
      toChainId: params.toChainId,
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromAmount.toString(),
      userAddress: params.userAddress
    })
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
      console.log('[interop] quote: calling aggregator.getQuotes')
      result = await this.aggregator.getQuotes(request)
      console.log('[interop] quote: aggregator returned', {
        quoteCount: result.quotes.length,
        errorCount: result.errors.length,
        providers: result.quotes.map((q) => q._providerId),
        errors: result.errors.map((e) => e.errorMsg ?? e.error?.message ?? 'unknown')
      })
    } catch (e) {
      console.log('[interop] quote: aggregator threw', e instanceof Error ? e.message : String(e))
      throw new SwapAndBridgeProviderApiError(e instanceof Error ? e.message : String(e))
    }

    const { quotes, errors } = result
    const [firstQuote, ...restQuotes] = quotes
    if (!firstQuote) {
      console.log('[interop] quote: no quotes received, throwing')
      throw new SwapAndBridgeProviderApiError(errors[0]?.errorMsg ?? 'No routes available')
    }

    if (!params.fromAsset) {
      console.log('[interop] quote: missing fromAsset, throwing')
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

    let firstRoute
    try {
      firstRoute = mapQuoteToRoute(firstQuote, fromAssetToken, toAssetToken, params)
      console.log('[interop] quote: firstRoute mapped from', firstQuote._providerId)
    } catch (e) {
      console.log(
        '[interop] quote: mapQuoteToRoute THREW on firstQuote',
        firstQuote._providerId,
        e instanceof Error ? e.message : String(e)
      )
      throw e
    }
    const routes = [
      firstRoute,
      ...restQuotes.map((q) => {
        try {
          return mapQuoteToRoute(q, fromAssetToken, toAssetToken, params)
        } catch (e) {
          console.log(
            '[interop] quote: mapQuoteToRoute THREW on restQuote',
            q._providerId,
            e instanceof Error ? e.message : String(e)
          )
          throw e
        }
      })
    ]
    console.log(
      '[interop] quote: returning',
      routes.length,
      'routes',
      routes.map((r) => `${r.providerId}:${r.toAmount}`)
    )

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
