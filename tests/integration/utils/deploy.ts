import {
  rpc as SorobanRpc,
  Keypair,
  TransactionBuilder,
  Operation,
  Address,
  Contract,
  xdr,
} from "@stellar/stellar-sdk";

export async function deployFreshContract(
  creator: Keypair,
  existingContractId: string,
  rpcUrl: string,
  networkPassphrase: string
): Promise<string> {
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: true });
  
  // 1. Get the WASM hash of the existing contract
  const contractInstance = new Contract(existingContractId);
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractInstance.address().toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  
  const res = await server.getLedgerEntries(ledgerKey);
  if (!res.entries || res.entries.length === 0) {
    throw new Error(`Contract ${existingContractId} not found`);
  }
  
  const entry = xdr.LedgerEntryData.fromXDR(res.entries[0].xdr, "base64");
  const instance = entry.contractData().val().instance();
  const wasmHash = instance.executable().wasmHash();

  // 2. Build deployment transaction
  let account;
  try {
    account = await server.getAccount(creator.publicKey());
  } catch (e) {
    throw new Error(`Account ${creator.publicKey()} not found. Ensure it is funded.`);
  }

  const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(creator.publicKey()),
        wasmHash: wasmHash,
      })
    )
    .setTimeout(60)
    .build();
    
  const preparedTx = await server.prepareTransaction(tx);
  preparedTx.sign(creator);
  
  // 3. Send and wait for completion
  const sendRes = await server.sendTransaction(preparedTx);
  if (sendRes.status === "ERROR") {
    throw new Error("Deploy failed: " + JSON.stringify(sendRes));
  }
  
  let txRes;
  while (true) {
    txRes = await server.getTransaction(sendRes.hash);
    if (txRes.status === "SUCCESS") break;
    if (txRes.status === "FAILED") {
      throw new Error("Deploy tx failed");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  
  // 4. Extract new contract ID from the result
  const resultVal = txRes.returnValue;
  if (!resultVal) {
    throw new Error("No return value from deploy transaction");
  }
  
  const newAddress = Address.fromScVal(resultVal);
  return newAddress.toString();
}
