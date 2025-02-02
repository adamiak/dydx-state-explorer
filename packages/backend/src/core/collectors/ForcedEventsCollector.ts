import { decodeAssetId, ForcedAction } from '@explorer/encoding'
import { EthereumAddress, Hash256, StarkKey, Timestamp } from '@explorer/types'

import { BlockRange } from '../../model/BlockRange'
import { ForcedTransactionsRepository } from '../../peripherals/database/ForcedTransactionsRepository'
import { TransactionStatusRepository } from '../../peripherals/database/TransactionStatusRepository'
import { EthereumClient } from '../../peripherals/ethereum/EthereumClient'
import { getTransactionStatus } from '../getForcedTransactionStatus'
import { LogForcedTradeRequest, LogForcedWithdrawalRequest } from './events'

interface MinedTransaction {
  hash: Hash256
  data: ForcedAction
  blockNumber: number
  minedAt: Timestamp
}

export class ForcedEventsCollector {
  constructor(
    private readonly ethereumClient: EthereumClient,
    private readonly forcedTransactionsRepository: ForcedTransactionsRepository,
    private readonly transactionStatusRepository: TransactionStatusRepository,
    private readonly perpetualAddress: EthereumAddress,
    readonly _getMinedTransactions?: (
      blockRange: BlockRange
    ) => Promise<MinedTransaction[]>
  ) {
    this.getMinedTransactions =
      // eslint-disable-next-line @typescript-eslint/unbound-method
      _getMinedTransactions ?? this.getMinedTransactions
  }

  async collect(
    blockRange: BlockRange
  ): Promise<{ added: number; updated: number; ignored: number }> {
    const transactions = await this.getMinedTransactions(blockRange)
    const results = await Promise.all(
      transactions.map(async ({ hash, data, minedAt, blockNumber }) => {
        const transaction = await this.forcedTransactionsRepository.findByHash(
          hash
        )
        if (!transaction) {
          await this.forcedTransactionsRepository.add(
            { hash, data },
            null,
            minedAt,
            blockNumber
          )
          return 'added'
        }
        if (getTransactionStatus(transaction) === 'sent') {
          await this.transactionStatusRepository.updateIfWaitingToBeMined({
            hash,
            mined: {
              blockNumber,
              at: minedAt,
            },
          })
          return 'updated'
        }
        return 'ignored'
      })
    )
    return results.reduce(
      (acc, result) => ({ ...acc, [result]: acc[result] + 1 }),
      { added: 0, updated: 0, ignored: 0 }
    )
  }

  private async getMinedTransactions(
    blockRange: BlockRange
  ): Promise<MinedTransaction[]> {
    const logs = await this.ethereumClient.getLogsInRange(blockRange, {
      address: this.perpetualAddress.toString(),
      topics: [[LogForcedWithdrawalRequest.topic, LogForcedTradeRequest.topic]],
    })
    return Promise.all(
      logs.map(async (log) => {
        const event =
          LogForcedWithdrawalRequest.safeParseLog(log) ??
          LogForcedTradeRequest.parseLog(log)

        const block = await this.ethereumClient.getBlock(log.blockNumber)
        const blockNumber = log.blockNumber
        const hash = Hash256(log.transactionHash)
        const minedAt = Timestamp.fromSeconds(block.timestamp)
        const base = { hash, blockNumber, minedAt }

        switch (event.name) {
          case 'LogForcedWithdrawalRequest':
            return {
              ...base,
              data: {
                type: 'withdrawal',
                starkKey: StarkKey.from(event.args.starkKey),
                positionId: event.args.positionId.toBigInt(),
                amount: event.args.quantizedAmount.toBigInt(),
              },
            }
          case 'LogForcedTradeRequest':
            return {
              ...base,
              data: {
                type: 'trade',
                starkKeyA: StarkKey.from(event.args.starkKeyA),
                starkKeyB: StarkKey.from(event.args.starkKeyB),
                positionIdA: event.args.positionIdA.toBigInt(),
                positionIdB: event.args.positionIdB.toBigInt(),
                syntheticAssetId: decodeAssetId(event.args.syntheticAssetId),
                isABuyingSynthetic: event.args.isABuyingSynthetic,
                collateralAmount: event.args.collateralAmount.toBigInt(),
                syntheticAmount: event.args.syntheticAmount.toBigInt(),
                nonce: event.args.nonce.toBigInt(),
              },
            }
        }
      })
    )
  }
}
