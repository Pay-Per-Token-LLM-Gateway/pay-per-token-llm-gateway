import requests
from typing import Dict, Any, Optional
from stellar_sdk import Keypair, TransactionBuilder, Network, Server

class X402Client:
    def __init__(self, gateway_url: str, stellar_secret: str, network: str = "TESTNET"):
        self.gateway_url = gateway_url.rstrip('/')
        self.keypair = Keypair.from_secret(stellar_secret)
        self.network = Network.TESTNET_NETWORK_PASSPHRASE if network.upper() == "TESTNET" else Network.PUBLIC_NETWORK_PASSPHRASE
        self.server = Server("https://horizon-testnet.stellar.org" if network.upper() == "TESTNET" else "https://horizon.stellar.org")

    def _sign_and_submit_payment(self, quote: Dict[str, Any]) -> str:
        # Simplification: in real SDK we'd check if we use escrow or do a real tx
        # Here we default to returning an escrow payer address for the new backend
        return self.keypair.public_key

    def post(self, path: str, json: Dict[str, Any], stream: bool = False) -> requests.Response:
        url = f"{self.gateway_url}{path}"
        headers = {"x-payer-address": self.keypair.public_key}
        
        resp = requests.post(url, json=json, headers=headers, stream=stream)
        if resp.status_code == 402:
            quote = resp.json()
            # Escrow verification via the new verify endpoint
            verify_resp = requests.post(f"{self.gateway_url}/x402/verify", json={
                "quoteId": quote["id"],
                "escrowPayerAddress": self.keypair.public_key
            })
            if verify_resp.status_code == 200:
                # Retry original request with payment receipt
                receipt = verify_resp.json()
                headers["x-payment-receipt"] = receipt["txHash"]
                return requests.post(url, json=json, headers=headers, stream=stream)
            else:
                raise Exception(f"Payment verification failed: {verify_resp.text}")
        return resp
