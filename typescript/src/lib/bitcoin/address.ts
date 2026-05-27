import { address as btcjsaddress, payments } from "bitcoinjs-lib"
import { Hex } from "../utils"
import { BitcoinHashUtils } from "./hash"
import { BitcoinNetwork, toBitcoinJsLibNetwork } from "./network"

/**
 * Creates the Bitcoin address from the public key. Supports SegWit (P2WPKH) and
 * Legacy (P2PKH) formats.
 * @param publicKey Compressed public key used to derive the Bitcoin address.
 * @param bitcoinNetwork Target Bitcoin network.
 * @param witness Flag to determine address format: true for SegWit (P2WPKH)
 *        and false for Legacy (P2PKH). Default is true.
 * @returns The derived Bitcoin address.
 */
function publicKeyToAddress(
  publicKey: Hex,
  bitcoinNetwork: BitcoinNetwork,
  witness: boolean = true
): string {
  const network = toBitcoinJsLibNetwork(bitcoinNetwork)

  if (witness) {
    // P2WPKH (SegWit)
    return payments.p2wpkh({ pubkey: publicKey.toBuffer(), network }).address!
  } else {
    // P2PKH (Legacy)
    return payments.p2pkh({ pubkey: publicKey.toBuffer(), network }).address!
  }
}

/**
 * Converts a public key hash into a P2PKH/P2WPKH address.
 * @param publicKeyHash Public key hash that will be encoded.
 * @param witness If true, a witness public key hash will be encoded and
 *        P2WPKH address will be returned. Returns P2PKH address otherwise
 * @param bitcoinNetwork Network the address should be encoded for.
 * @returns P2PKH or P2WPKH address encoded from the given public key hash.
 * @throws Throws an error if network is not supported.
 */
function publicKeyHashToAddress(
  publicKeyHash: Hex,
  witness: boolean,
  bitcoinNetwork: BitcoinNetwork
): string {
  const hash = publicKeyHash.toBuffer()
  const network = toBitcoinJsLibNetwork(bitcoinNetwork)
  return witness
    ? payments.p2wpkh({ hash, network }).address!
    : payments.p2pkh({ hash, network }).address!
}

/**
 * Converts a P2PKH, P2WPKH, or P2TR address into a wallet public key hash.
 * For P2TR, returns the compatibility alias:
 * `HASH160(0x02 || xOnlyOutputKey)`.
 * @param address P2PKH, P2WPKH, or P2TR address that will be decoded.
 * @param bitcoinNetwork Network the address should be decoded for.
 * @returns Public key hash decoded from the address.
 */
function addressToPublicKeyHash(
  address: string,
  bitcoinNetwork: BitcoinNetwork
): Hex {
  const network = toBitcoinJsLibNetwork(bitcoinNetwork)

  try {
    // Try extracting hash from P2PKH address.
    return Hex.from(payments.p2pkh({ address: address, network }).hash!)
  } catch (err) {}

  try {
    // Try extracting hash from P2WPKH address.
    return Hex.from(payments.p2wpkh({ address: address, network }).hash!)
  } catch (err) {}

  try {
    // Try extracting Taproot output key and deriving compatibility alias.
    const outputKey = addressToTaprootOutputKey(address, bitcoinNetwork)
    return taprootOutputKeyToWalletPublicKeyHash(outputKey)
  } catch (err) {}

  // If neither of them succeeded, throw an error.
  throw new Error(
    "Address must be P2PKH or P2WPKH or P2TR valid for given network"
  )
}

/**
 * Converts a Taproot x-only output key into a P2TR bech32m address.
 * @param outputKey 32-byte Taproot output key.
 * @param bitcoinNetwork Network the address should be encoded for.
 * @returns P2TR address encoded from the given output key.
 */
function taprootOutputKeyToAddress(
  outputKey: Hex,
  bitcoinNetwork: BitcoinNetwork
): string {
  const outputKeyBuffer = outputKey.toBuffer()
  if (outputKeyBuffer.length !== 32) {
    throw new Error("Taproot output key must be 32-byte")
  }

  return btcjsaddress.toBech32(
    outputKeyBuffer,
    1,
    toBitcoinJsLibNetwork(bitcoinNetwork).bech32
  )
}

/**
 * Converts a P2TR bech32m address into a Taproot x-only output key.
 * @param address P2TR address to decode.
 * @param bitcoinNetwork Network the address should be decoded for.
 * @returns 32-byte Taproot output key.
 */
function addressToTaprootOutputKey(
  address: string,
  bitcoinNetwork: BitcoinNetwork
): Hex {
  const network = toBitcoinJsLibNetwork(bitcoinNetwork)
  const decodedAddress = btcjsaddress.fromBech32(address)

  if (
    decodedAddress.prefix !== network.bech32 ||
    decodedAddress.version !== 1 ||
    decodedAddress.data.length !== 32
  ) {
    throw new Error("Address must be P2TR valid for given network")
  }

  return Hex.from(decodedAddress.data)
}

/**
 * Converts a Taproot x-only output key to the bridge compatibility alias:
 * HASH160(0x02 || xOnlyOutputKey).
 * @param outputKey 32-byte Taproot output key.
 * @returns 20-byte compatibility alias used by legacy interfaces.
 */
function taprootOutputKeyToWalletPublicKeyHash(outputKey: Hex): Hex {
  const outputKeyBuffer = outputKey.toBuffer()
  if (outputKeyBuffer.length !== 32) {
    throw new Error("Taproot output key must be 32-byte")
  }

  return BitcoinHashUtils.computeHash160(
    Hex.from(Buffer.concat([Buffer.from([0x02]), outputKeyBuffer]))
  )
}

/**
 * Converts an address to the respective output script.
 * @param address BTC address.
 * @param bitcoinNetwork Bitcoin network corresponding to the address.
 * @returns The output script not prepended with length.
 */
function addressToOutputScript(
  address: string,
  bitcoinNetwork: BitcoinNetwork
): Hex {
  const network = toBitcoinJsLibNetwork(bitcoinNetwork)

  try {
    return Hex.from(btcjsaddress.toOutputScript(address, network))
  } catch (error) {
    const outputKey = addressToTaprootOutputKey(address, bitcoinNetwork)
    return Hex.from(
      Buffer.concat([Buffer.from([0x51, 0x20]), outputKey.toBuffer()])
    )
  }
}

/**
 * Converts an output script to the respective network-specific address.
 * @param script The output script not prepended with length.
 * @param bitcoinNetwork Bitcoin network the address should be produced for.
 * @returns The Bitcoin address.
 */
function outputScriptToAddress(
  script: Hex,
  bitcoinNetwork: BitcoinNetwork = BitcoinNetwork.Mainnet
): string {
  const scriptBuffer = script.toBuffer()

  // Taproot (P2TR): OP_1 (0x51) + push32 (0x20) + 32-byte key.
  if (
    scriptBuffer.length === 34 &&
    scriptBuffer[0] === 0x51 &&
    scriptBuffer[1] === 0x20
  ) {
    return taprootOutputKeyToAddress(
      Hex.from(scriptBuffer.subarray(2)),
      bitcoinNetwork
    )
  }

  return btcjsaddress.fromOutputScript(
    scriptBuffer,
    toBitcoinJsLibNetwork(bitcoinNetwork)
  )
}

/**
 * Utility functions allowing to perform Bitcoin address conversions.
 */
export const BitcoinAddressConverter = {
  publicKeyToAddress,
  publicKeyHashToAddress,
  addressToPublicKeyHash,
  taprootOutputKeyToAddress,
  addressToTaprootOutputKey,
  taprootOutputKeyToWalletPublicKeyHash,
  addressToOutputScript,
  outputScriptToAddress,
}
