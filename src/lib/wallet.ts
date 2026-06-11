import { WalletClient } from '@bsv/sdk'

export const wallet = new WalletClient('auto', 'crowd.bsvb.app')

let ownKey: string | undefined

export async function getOwnIdentityKey (): Promise<string> {
  if (ownKey == null) {
    await wallet.waitForAuthentication()
    ownKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
  }
  return ownKey
}
