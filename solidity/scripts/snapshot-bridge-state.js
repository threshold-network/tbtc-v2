/* eslint-disable no-console */
const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')

async function main() {
  const rpc = process.env.SEPOLIA_CHAIN_API_URL || 'https://ethereum-sepolia.publicnode.com'
  const provider = new ethers.providers.JsonRpcProvider(rpc)

  const BRIDGE = process.env.BRIDGE_ADDRESS || '0x9b1a7fE5a16A15F2f9475C5B231750598b113403'
  const PROXY_ADMIN = process.env.BRIDGE_PROXY_ADMIN_ADDRESS || '0x39f60B25C4598Caf7e922d6fC063E9002db45845'
  const NETWORK = 'sepolia'

  const iface = new ethers.utils.Interface([
    'function governance() view returns (address)',
    'function depositParameters() view returns (uint64,uint64,uint64,uint32)',
    'function redemptionParameters() view returns (uint64,uint64,uint64,uint64,uint32,uint96,uint32)',
    'function movingFundsParameters() view returns (uint64,uint64,uint32,uint32,uint96,uint32,uint16,uint64,uint32,uint96,uint32)',
    'function walletParameters() view returns (uint32,uint64,uint64,uint64,uint32,uint64,uint32)',
    'function treasury() view returns (address)',
    'function contractReferences() view returns (address,address,address,address)',
    'event AuthorizedBalanceIncreaserUpdated(address indexed increaser, bool authorized)',
    'event VaultStatusUpdated(address indexed vault, bool isTrusted)',
    'event SpvMaintainerStatusUpdated(address indexed spvMaintainer, bool isTrusted)'
  ])

  const own = new ethers.utils.Interface(['function owner() view returns (address)'])

  // Implementation from EIP-1967 slot
  const EIP1967_SLOT = '0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC'
  const implRaw = await provider.getStorageAt(BRIDGE, EIP1967_SLOT)
  const bridgeImplementation = ethers.utils.getAddress('0x' + implRaw.slice(26))

  const bridge = new ethers.Contract(BRIDGE, iface, provider)
  const [governance, dep, red, mov, wal, treasury, refs] = await Promise.all([
    bridge.governance(),
    bridge.depositParameters(),
    bridge.redemptionParameters(),
    bridge.movingFundsParameters(),
    bridge.walletParameters(),
    bridge.treasury(),
    bridge.contractReferences(),
  ])

  // gather allowlist/trust sets from events (best-effort)
  const fromBlock = 0
  const authorizedControllers = []
  const controllers = new Map()
  try {
    const logs = await provider.getLogs({ address: BRIDGE, topics: [iface.getEventTopic('AuthorizedBalanceIncreaserUpdated')], fromBlock, toBlock: 'latest' })
    for (const log of logs) {
      const { args } = iface.parseLog(log)
      const inc = ethers.utils.getAddress(args.increaser)
      if (args.authorized) controllers.set(inc, true)
      else controllers.delete(inc)
    }
    for (const [address, authorized] of controllers.entries()) {
      if (authorized) authorizedControllers.push({ address, authorized: true })
    }
  } catch (e) {
    // ignore
  }

  const trustedVaults = []
  const vaults = new Map()
  try {
    const logs = await provider.getLogs({ address: BRIDGE, topics: [iface.getEventTopic('VaultStatusUpdated')], fromBlock, toBlock: 'latest' })
    for (const log of logs) {
      const { args } = iface.parseLog(log)
      const v = ethers.utils.getAddress(args.vault)
      if (args.isTrusted) vaults.set(v, true)
      else vaults.delete(v)
    }
    for (const [address, trusted] of vaults.entries()) {
      if (trusted) trustedVaults.push({ address, trusted: true })
    }
  } catch (e) {
    // ignore
  }

  const spvMaintainers = []
  const spvs = new Map()
  try {
    const logs = await provider.getLogs({ address: BRIDGE, topics: [iface.getEventTopic('SpvMaintainerStatusUpdated')], fromBlock, toBlock: 'latest' })
    for (const log of logs) {
      const { args } = iface.parseLog(log)
      const s = ethers.utils.getAddress(args.spvMaintainer)
      if (args.isTrusted) spvs.set(s, true)
      else spvs.delete(s)
    }
    for (const [address, trusted] of spvs.entries()) {
      if (trusted) spvMaintainers.push({ address, trusted: true })
    }
  } catch (e) {
    // ignore
  }

  // proxy admin owner
  let proxyAdminOwner = undefined
  try {
    const raw = await provider.call({ to: PROXY_ADMIN, data: own.encodeFunctionData('owner', []) })
    ;[proxyAdminOwner] = own.decodeFunctionResult('owner', raw)
  } catch (e) { /* ignore */ }

  const snapshot = {
    label: 'post-governance-transfer',
    network: NETWORK,
    timestamp: new Date().toISOString(),
    bridgeAddress: BRIDGE,
    bridgeImplementation,
    bridgeGovernance: governance,
    proxyAdmin: PROXY_ADMIN,
    depositParameters: {
      depositDustThreshold: dep[0].toString(),
      depositTreasuryFeeDivisor: dep[1].toString(),
      depositTxMaxFee: dep[2].toString(),
      depositRevealAheadPeriod: dep[3].toString(),
    },
    redemptionParameters: {
      redemptionDustThreshold: red[0].toString(),
      redemptionTreasuryFeeDivisor: red[1].toString(),
      redemptionTxMaxFee: red[2].toString(),
      redemptionTxMaxTotalFee: red[3].toString(),
      redemptionTimeout: red[4].toString(),
      redemptionTimeoutSlashingAmount: red[5].toString(),
      redemptionTimeoutNotifierRewardMultiplier: red[6].toString(),
    },
    movingFundsParameters: {
      movingFundsTxMaxTotalFee: mov[0].toString(),
      movingFundsDustThreshold: mov[1].toString(),
      movingFundsTimeoutResetDelay: mov[2].toString(),
      movingFundsTimeout: mov[3].toString(),
      movingFundsTimeoutSlashingAmount: mov[4].toString(),
      movingFundsTimeoutNotifierRewardMultiplier: mov[5].toString(),
      movingFundsCommitmentGasOffset: mov[6].toString(),
      movedFundsSweepTxMaxTotalFee: mov[7].toString(),
      movedFundsSweepTimeout: mov[8].toString(),
      movedFundsSweepTimeoutSlashingAmount: mov[9].toString(),
      movedFundsSweepTimeoutNotifierRewardMultiplier: mov[10].toString(),
    },
    walletParameters: {
      walletCreationPeriod: wal[0].toString(),
      walletCreationMinBtcBalance: wal[1].toString(),
      walletCreationMaxBtcBalance: wal[2].toString(),
      walletClosureMinBtcBalance: wal[3].toString(),
      walletMaxAge: wal[4].toString(),
      walletMaxBtcTransfer: wal[5].toString(),
      walletClosingPeriod: wal[6].toString(),
    },
    treasury,
    authorizedControllers,
    trustedVaults,
    spvMaintainers,
  }

  const outFile = process.env.SNAPSHOT_OUTFILE || path.resolve(__dirname, '../deployments/sepolia/bridge-upgrade.json')
  let existing = []
  if (fs.existsSync(outFile)) {
    try {
      const raw = fs.readFileSync(outFile, 'utf8')
      const parsed = JSON.parse(raw)
      existing = Array.isArray(parsed) ? parsed : [parsed]
    } catch { existing = [] }
  }
  existing.push(snapshot)
  fs.writeFileSync(outFile, JSON.stringify(existing, null, 2))
  console.log(`Snapshot appended to ${outFile}`)
  console.log(JSON.stringify(snapshot, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })

