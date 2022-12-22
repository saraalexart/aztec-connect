import { EthAddress, GrumpkinAddress } from '@aztec/barretenberg/address';
import { AssetValue } from '@aztec/barretenberg/asset';
import { TxId } from '@aztec/barretenberg/tx_id';
import { CoreSdkInterface } from '../core_sdk/index.js';
import { ProofOutput, proofOutputToProofTx } from '../proofs/index.js';
import { Signer } from '../signer/index.js';
import { createTxRefNo } from './create_tx_ref_no.js';

export class WithdrawController {
  private readonly requireFeePayingTx: boolean;
  private proofOutputs: ProofOutput[] = [];
  private feeProofOutputs: ProofOutput[] = [];
  private txIds: TxId[] = [];
  private created = Date.now();

  constructor(
    public readonly userId: GrumpkinAddress,
    private readonly userSigner: Signer,
    public readonly assetValue: AssetValue,
    public readonly fee: AssetValue,
    public readonly recipient: EthAddress,
    private readonly core: CoreSdkInterface,
  ) {
    if (!assetValue.value) {
      throw new Error('Value must be greater than 0.');
    }

    this.requireFeePayingTx = !!fee.value && fee.assetId !== assetValue.assetId;
  }

  public async createProof() {
    const { assetId, value } = this.assetValue;
    const privateInput = value + (!this.requireFeePayingTx ? this.fee.value : BigInt(0));
    const spendingPublicKey = this.userSigner.getPublicKey();
    const spendingKeyRequired = !spendingPublicKey.equals(this.userId);

    const proofInputs = await this.core.createPaymentProofInputs(
      this.userId,
      assetId,
      BigInt(0),
      value,
      privateInput,
      BigInt(0),
      BigInt(0),
      this.userId,
      spendingKeyRequired,
      this.recipient,
      spendingPublicKey,
      2,
    );

    const txRefNo = this.requireFeePayingTx || proofInputs.length > 1 ? createTxRefNo() : 0;

    if (this.requireFeePayingTx) {
      const feeProofInputs = await this.core.createPaymentProofInputs(
        this.userId,
        this.fee.assetId,
        BigInt(0),
        BigInt(0),
        this.fee.value,
        BigInt(0),
        BigInt(0),
        this.userId,
        spendingKeyRequired,
        undefined,
        spendingPublicKey,
        2,
      );
      this.feeProofOutputs = [];
      for (const proofInput of feeProofInputs) {
        proofInput.signature = await this.userSigner.signMessage(proofInput.signingData);
        this.feeProofOutputs.push(await this.core.createPaymentProof(proofInput, txRefNo));
      }
    }

    {
      const proofOutputs: ProofOutput[] = [];
      for (const proofInput of proofInputs) {
        proofInput.signature = await this.userSigner.signMessage(proofInput.signingData);
        proofOutputs.push(await this.core.createPaymentProof(proofInput, txRefNo));
      }
      this.proofOutputs = proofOutputs;
    }
  }

  public exportProofTxs() {
    if (!this.proofOutputs.length) {
      throw new Error('Call createProof() first.');
    }

    return [...this.proofOutputs, ...this.feeProofOutputs].map(proofOutputToProofTx);
  }

  public async send() {
    if (!this.proofOutputs.length) {
      throw new Error('Call createProof() first.');
    }

    this.txIds = await this.core.sendProofs([...this.proofOutputs, ...this.feeProofOutputs], [], {
      from: 'withdraw_controller',
      fee: {
        ...this.fee,
        value: this.fee.value.toString(),
      },
      created: this.created,
    });
    return this.txIds[this.proofOutputs.length - 1];
  }

  public getTxIds() {
    if (!this.txIds.length) {
      throw new Error(`Call ${!this.proofOutputs.length ? 'createProof()' : 'send()'} first.`);
    }

    return this.txIds;
  }

  public async awaitSettlement(timeout?: number) {
    if (!this.txIds.length) {
      throw new Error(`Call ${!this.proofOutputs.length ? 'createProof()' : 'send()'} first.`);
    }

    await Promise.all(this.txIds.map(txId => this.core.awaitSettlement(txId, timeout)));
  }
}
