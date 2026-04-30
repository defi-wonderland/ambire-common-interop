import { describe, it, expect, jest, beforeEach } from '@jest/globals'

const mockDiscoverAssets = jest.fn()

jest.mock('@wonderland/interop-cross-chain', () => ({
  createAggregator: () => ({
    discoverAssets: mockDiscoverAssets
  }),
  createCrossChainProvider: () => ({}),
  OrderTrackerFactory: class {},
  PROTOCOLS: { LIFI_INTENTS: 'lifi-intents', BUNGEE: 'bungee' },
  LIFI_INTENTS_ORDER_SERVER_URL: 'http://localhost'
}))

import { InteropSwapProvider } from './interopSwapProvider'

const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'

const baseAssets = {
  tokensByChain: { 42161: [USDC_ARB] },
  tokenMetadata: {
    42161: {
      [USDC_ARB]: { address: USDC_ARB, symbol: 'USDC', decimals: 6, providers: ['bungee'] }
    }
  }
}

describe('InteropSwapProvider', () => {
  beforeEach(() => {
    mockDiscoverAssets.mockReset()
    mockDiscoverAssets.mockResolvedValue(baseAssets as never)
  })

  it('caches discoverAssets between calls', async () => {
    const provider = new InteropSwapProvider()
    await provider.getSupportedChains()
    await provider.getToTokenList({ fromChainId: 1, toChainId: 42161 })
    await provider.getToken({ address: USDC_ARB, chainId: 42161 })
    expect(mockDiscoverAssets).toHaveBeenCalledTimes(1)
  })

  it('looks up tokens by lowercase address', async () => {
    const provider = new InteropSwapProvider()
    const token = await provider.getToken({
      address: USDC_ARB.toUpperCase(),
      chainId: 42161
    })
    expect(token?.symbol).toBe('USDC')
  })

  it('skips tokens with empty symbols in getToTokenList', async () => {
    mockDiscoverAssets.mockResolvedValueOnce({
      tokensByChain: { 8453: ['0xabc'] },
      tokenMetadata: {
        8453: { '0xabc': { address: '0xabc', symbol: '', decimals: 18, providers: [] } }
      }
    } as never)
    const provider = new InteropSwapProvider()
    const tokens = await provider.getToTokenList({ fromChainId: 1, toChainId: 8453 })
    expect(tokens).toEqual([])
  })
})
