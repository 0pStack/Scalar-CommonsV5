// Dev-chain helper: fund one or more //Alice-derived agent keys so the reference agent can register.
// Usage: SCALAR_WS=ws://127.0.0.1:9955 node scripts/fund-dev.mjs //Alice//ref-provider [//Alice//ref-buyer ...]
// Only for dev chains where //Alice is funded. Never point this at a public network.
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { isLoopbackWs } from '../dist/loopback.js'; // run `npm run build` first

const ws = process.env.SCALAR_WS ?? 'ws://127.0.0.1:9944';
if (!isLoopbackWs(ws)) throw new Error(`refusing to fund on non-loopback ${ws}`);
const amount = BigInt(process.env.FUND_CMN ?? '1500') * 1_000_000_000_000n;
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws) });
const keyring = new Keyring({ type: 'sr25519' });
const alice = keyring.addFromUri('//Alice');
for (const uri of process.argv.slice(2)) {
  const to = keyring.addFromUri(uri).address;
  await new Promise((resolve, reject) => {
    api.tx.balances.transferKeepAlive(to, amount).signAndSend(alice, ({ status, dispatchError }) => {
      if (dispatchError) reject(new Error(dispatchError.toString()));
      else if (status.isInBlock) resolve();
    }).catch(reject);
  });
  console.log(`funded ${uri} -> ${to} (${amount} plancks)`);
}
await api.disconnect();
