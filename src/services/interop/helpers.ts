import { Token as LiFiToken } from '@lifi/types'
import { getAddress } from 'ethers'

import {
  getSignatureSteps,
  getTransactionSteps,
  isApprovalStep,
  type DiscoveredAssetInfo,
  type ExecutableQuote
} from '@wonderland/interop-cross-chain'

import {
  ProviderQuoteParams,
  SwapAndBridgeRoute,
  SwapAndBridgeToToken
} from '../../interfaces/swapAndBridge'
import { generateUuid } from '../../utils/uuid'

export function toSwapAndBridgeToken(
  info: DiscoveredAssetInfo,
  chainId: number
): SwapAndBridgeToToken {
  return {
    symbol: info.symbol,
    name: info.symbol,
    chainId,
    address: getAddress(info.address),
    icon: '',
    decimals: info.decimals
  }
}

/**
 * Ambire's SwapAndBridgeRoute models a single fromAsset/toAsset, while the SDK
 * schema allows multi-input/output quotes (for future Universal Balance flows).
 * Reject any quote we can't represent faithfully instead of silently dropping data.
 */
function getSinglePreviewIO(quote: ExecutableQuote) {
  const [input, ...restIn] = quote.preview.inputs
  const [output, ...restOut] = quote.preview.outputs
  if (!input || !output || restIn.length !== 0 || restOut.length !== 0) {
    throw new Error(
      `Ambire adapter expects single-input/output quotes, got ${quote.preview.inputs.length} inputs / ${quote.preview.outputs.length} outputs`
    )
  }
  return { input, output }
}

export function mapQuoteToRoute(
  quote: ExecutableQuote,
  fromAsset: SwapAndBridgeToToken,
  toAsset: SwapAndBridgeToToken,
  params: ProviderQuoteParams
): SwapAndBridgeRoute {
  const { input, output } = getSinglePreviewIO(quote)
  const isSameChain = params.fromChainId === params.toChainId

  const sendSteps = getTransactionSteps(quote.order).filter((s) => !isApprovalStep(s))
  const sigSteps = getSignatureSteps(quote.order)
  const allowances = quote.order.checks?.allowances ?? []

  const [txStep, ...restSends] = sendSteps
  const [allowance, ...restAllowances] = allowances
  if (restSends.length !== 0 || restAllowances.length !== 0) {
    throw new Error(
      `Ambire adapter expects at most 1 send tx and 1 allowance per quote, got ${sendSteps.length} sends / ${allowances.length} allowances`
    )
  }
  // SwapAndBridgeRoute has no field for signature payloads — drop signature-only quotes until EFI-894.
  if (sigSteps.length !== 0) {
    throw new Error(
      `Signature-based quotes are not supported yet (got ${sigSteps.length} signature steps from ${quote._providerId})`
    )
  }

  const toToken: LiFiToken = {
    address: toAsset.address,
    chainId: toAsset.chainId,
    symbol: toAsset.symbol,
    decimals: toAsset.decimals,
    name: toAsset.symbol,
    logoURI: '',
    priceUSD: '0',
    coinKey: '' as LiFiToken['coinKey']
  }

  return {
    providerId: 'interop',
    routeId: quote.quoteId ?? generateUuid(),
    currentUserTxIndex: 0,
    fromChainId: params.fromChainId,
    toChainId: params.toChainId,
    userAddress: params.userAddress,
    isOnlySwapRoute: isSameChain,
    fromAmount: input.amount,
    toAmount: output.amount,
    // Carries the SDK provider id through to getRouteStatus() via the
    // bridge param of the route status check.
    usedBridgeNames: [quote._providerId],
    userTxs: [],
    sender: params.userAddress,
    steps: [
      {
        chainId: fromAsset.chainId,
        fromAmount: input.amount,
        fromAsset,
        minAmountOut: output.amount,
        protocol: {
          name: quote._providerId,
          displayName: quote._providerId,
          icon: ''
        },
        toAmount: output.amount,
        toAsset,
        type: isSameChain ? 'swap' : 'middleware',
        userTxIndex: 0
      }
    ],
    // Pass undefined through when the SDK doesn't have a USD value for this
    // input/output, instead of displaying a misleading $0. The downstream UI
    // components handle undefined with their own `|| 0` fallback.
    inputValueInUsd: (input.amountUsd === undefined
      ? undefined
      : Number(input.amountUsd)) as unknown as number,
    outputValueInUsd: (output.amountUsd === undefined
      ? undefined
      : Number(output.amountUsd)) as unknown as number,
    serviceTime: quote.eta ?? 0,
    rawRoute: '' as never,
    toToken,
    disabled: false,
    withConvenienceFee: false,
    txData: txStep
      ? {
          data: txStep.transaction.data,
          to: txStep.transaction.to,
          value: txStep.transaction.value ?? '0',
          chainId: txStep.chainId
        }
      : undefined,
    approvalData: allowance
      ? {
          amount: allowance.required,
          tokenAddress: allowance.tokenAddress,
          spenderAddress: allowance.spender,
          userAddress: allowance.owner
        }
      : undefined
  }
}
