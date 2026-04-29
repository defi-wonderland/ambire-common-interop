import { describe, it, expect, jest } from '@jest/globals'

jest.mock('@wonderland/interop-cross-chain', () => ({
  createAggregator: () => ({}),
  createCrossChainProvider: () => ({}),
  OrderTrackerFactory: class {},
  PROTOCOLS: { LIFI_INTENTS: 'lifi-intents', BUNGEE: 'bungee' },
  LIFI_INTENTS_ORDER_SERVER_URL: 'http://localhost'
}))

import { InteropSwapProvider } from './interopSwapProvider'

describe('InteropSwapProvider', () => {
  it('instantiates with correct id and name', () => {
    const provider = new InteropSwapProvider()
    expect(provider.id).toBe('interop')
    expect(provider.name).toBe('Interop')
  })
})
