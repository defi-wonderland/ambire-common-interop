import { describe, it, expect, jest, beforeEach } from '@jest/globals'

const BASE_CHAIN_ID = 8453
const ARB_CHAIN_ID = 42161
const OTHER_CHAIN_ID = 1

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const UNKNOWN_TOKEN = '0xabc'

const USER_ADDRESS = '0xd550780b24C8c25ef1471773498dcb63eF415298'
const SPENDER_ADDRESS = '0xspender'
const TX_DATA = '0xdeadbeef'

const INPUT_AMOUNT = '10000000'
const OUTPUT_AMOUNT = '9987350'

const mockDiscoverAssets = jest.fn()
const mockGetOrderStatus = jest.fn()
const mockGetQuotes = jest.fn()

jest.mock('@wonderland/interop-cross-chain', () => ({
  createAggregator: () => ({
    discoverAssets: mockDiscoverAssets,
    getOrderStatus: mockGetOrderStatus,
    getQuotes: mockGetQuotes
  }),
  createCrossChainProvider: () => ({}),
  getTransactionSteps: (order: { steps: { kind: string }[] }) =>
    order.steps.filter((s) => s.kind === 'transaction'),
  getSignatureSteps: (order: { steps: { kind: string }[] }) =>
    order.steps.filter((s) => s.kind === 'signature'),
  isApprovalStep: (s: { kind: string; category?: string }) =>
    s.kind === 'transaction' && s.category === 'approval',
  OrderTrackerFactory: class {},
  PROTOCOLS: { LIFI_INTENTS: 'lifi-intents', BUNGEE: 'bungee' },
  LIFI_INTENTS_ORDER_SERVER_URL: 'http://localhost',
  OrderStatus: {
    Created: 'created',
    Pending: 'pending',
    Executed: 'executed',
    Settled: 'settled',
    Executing: 'executing',
    Settling: 'settling',
    Finalized: 'finalized',
    Failed: 'failed',
    Refunded: 'refunded'
  }
}))

import { InteropSwapProvider } from './interopSwapProvider'

const baseAssets = {
  tokensByChain: { [ARB_CHAIN_ID]: [USDC_ARB] },
  tokenMetadata: {
    [ARB_CHAIN_ID]: {
      [USDC_ARB]: { address: USDC_ARB, symbol: 'USDC', decimals: 6, providers: ['bungee'] }
    }
  }
}

const buildQuoteParams = (overrides = {}) => ({
  fromAsset: { symbol: 'USDC', decimals: 6, priceIn: [{ baseCurrency: 'usd', price: 1 }] } as any,
  fromChainId: BASE_CHAIN_ID,
  fromTokenAddress: USDC_BASE,
  toAsset: null,
  toChainId: ARB_CHAIN_ID,
  toTokenAddress: USDC_ARB,
  fromAmount: BigInt(INPUT_AMOUNT),
  userAddress: USER_ADDRESS,
  sort: 'output' as const,
  isWrapOrUnwrap: false,
  accountNativeBalance: 0n,
  nativeSymbol: 'ETH',
  ...overrides
})

const buildQuote = (overrides = {}) => ({
  _providerId: 'bungee',
  quoteId: 'quote-1',
  preview: {
    inputs: [{ amount: INPUT_AMOUNT }],
    outputs: [{ amount: OUTPUT_AMOUNT }]
  },
  order: {
    steps: [
      {
        kind: 'transaction',
        chainId: BASE_CHAIN_ID,
        transaction: { to: SPENDER_ADDRESS, data: TX_DATA, value: '0' }
      }
    ],
    checks: {
      allowances: [
        {
          chainId: BASE_CHAIN_ID,
          tokenAddress: USDC_BASE,
          owner: USER_ADDRESS,
          spender: SPENDER_ADDRESS,
          required: INPUT_AMOUNT
        }
      ]
    }
  },
  eta: 30,
  ...overrides
})

describe('InteropSwapProvider', () => {
  beforeEach(() => {
    mockDiscoverAssets.mockReset()
    mockDiscoverAssets.mockResolvedValue(baseAssets as never)
    mockGetQuotes.mockReset()
  })

  it('looks up tokens by lowercase address', async () => {
    const provider = new InteropSwapProvider()
    const token = await provider.getToken({
      address: USDC_ARB.toUpperCase(),
      chainId: ARB_CHAIN_ID
    })
    expect(token?.symbol).toBe('USDC')
  })

  it('skips tokens with empty symbols in getToTokenList', async () => {
    mockDiscoverAssets.mockResolvedValueOnce({
      tokensByChain: { [BASE_CHAIN_ID]: [UNKNOWN_TOKEN] },
      tokenMetadata: {
        [BASE_CHAIN_ID]: {
          [UNKNOWN_TOKEN]: { address: UNKNOWN_TOKEN, symbol: '', decimals: 18, providers: [] }
        }
      }
    } as never)
    const provider = new InteropSwapProvider()
    const tokens = await provider.getToTokenList({
      fromChainId: OTHER_CHAIN_ID,
      toChainId: BASE_CHAIN_ID
    })
    expect(tokens).toEqual([])
  })

  describe('getRouteStatus', () => {
    const params = {
      txHash: '0xdeadbeef',
      fromChainId: 1,
      toChainId: 42161,
      providerId: 'lifi-intents'
    }

    beforeEach(() => {
      mockGetOrderStatus.mockReset()
    })

    it.each([
      ['finalized', 'completed'],
      ['failed', 'refunded'],
      ['refunded', 'refunded'],
      ['pending', null],
      ['executed', null],
      ['settled', null]
    ])('maps SDK status %s to %s', async (sdkStatus, expected) => {
      mockGetOrderStatus.mockResolvedValueOnce({ status: sdkStatus } as never)
      const provider = new InteropSwapProvider()
      const status = await provider.getRouteStatus(params)
      expect(status).toBe(expected)
    })

    it('returns null on SDK error so the controller keeps polling silently', async () => {
      mockGetOrderStatus.mockRejectedValueOnce(new Error('rpc down') as never)
      const provider = new InteropSwapProvider()
      await expect(provider.getRouteStatus(params)).resolves.toBeNull()
    })

    it('forwards txHash, providerId and fromChainId as originChainId', async () => {
      mockGetOrderStatus.mockResolvedValueOnce({ status: 'pending' } as never)
      const provider = new InteropSwapProvider()
      await provider.getRouteStatus(params)
      expect(mockGetOrderStatus).toHaveBeenCalledWith({
        txHash: '0xdeadbeef',
        providerId: 'lifi-intents',
        originChainId: 1
      })
    })
  })

  describe('quote', () => {
    it('throws when the SDK returns no routes', async () => {
      mockGetQuotes.mockResolvedValue({
        quotes: [],
        errors: [{ errorMsg: 'unsupported route' }]
      } as never)
      const provider = new InteropSwapProvider()
      await expect(provider.quote(buildQuoteParams())).rejects.toThrow('unsupported route')
    })

    it('attaches txData and approvalData to the route from the order', async () => {
      mockGetQuotes.mockResolvedValue({ quotes: [buildQuote()], errors: [] } as never)
      const provider = new InteropSwapProvider()
      const result = await provider.quote(buildQuoteParams())
      const [route] = result.routes
      if (!route) throw new Error('expected at least one route')
      expect(route.txData).toEqual({
        data: TX_DATA,
        to: SPENDER_ADDRESS,
        value: '0',
        chainId: BASE_CHAIN_ID
      })
      expect(route.approvalData).toEqual({
        amount: INPUT_AMOUNT,
        tokenAddress: USDC_BASE,
        spenderAddress: SPENDER_ADDRESS,
        userAddress: USER_ADDRESS
      })
    })
  })
})
