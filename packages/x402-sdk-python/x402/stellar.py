import base64
from stellar_sdk import Server, Keypair, Network, TransactionBuilder, Asset, Payment
from stellar_sdk.exceptions import NotFoundError

def get_horizon_url(network: str) -> str:
    if network == "mainnet":
        return "https://horizon.stellar.org"
    elif network == "testnet":
        return "https://horizon-testnet.stellar.org"
    return "https://horizon-testnet.stellar.org"

def get_network_passphrase(network: str) -> str:
    if network == "mainnet":
        return Network.PUBLIC_NETWORK_PASSPHRASE
    return Network.TESTNET_NETWORK_PASSPHRASE

def build_payment_transaction(
    source_secret: str,
    destination: str,
    amount: str,
    asset: str,
    asset_issuer: str = None,
    network: str = "testnet"
):
    source_keypair = Keypair.from_secret(source_secret)
    server = Server(get_horizon_url(network))
    
    try:
        source_account = server.load_account(source_keypair.public_key)
    except NotFoundError:
        raise Exception(f"Account {source_keypair.public_key} not found on {network}")
        
    passphrase = get_network_passphrase(network)
    
    if asset == "XLM":
        stellar_asset = Asset.native()
    else:
        stellar_asset = Asset(asset, asset_issuer)
        
    tx = (
        TransactionBuilder(
            source_account=source_account,
            network_passphrase=passphrase,
            base_fee=100
        )
        .append_payment_op(
            destination=destination,
            asset=stellar_asset,
            amount=amount
        )
        .set_timeout(300)
        .build()
    )
    
    tx.sign(source_keypair)
    
    tx_hash = tx.hash().hex()
    tx_xdr = tx.to_xdr()
    
    # Submit to network
    response = server.submit_transaction(tx)
    return response['hash']

def verify_payment(tx_hash: str, network: str = "testnet"):
    server = Server(get_horizon_url(network))
    try:
        tx = server.transactions().transaction(tx_hash).call()
        return tx['successful']
    except Exception:
        return False
