"""
x402-sdk — Python client SDK for the x402 LLM Gateway.

Pay-per-request LLM gateway with stablecoin micropayments on Stellar.
Automatically handles the 402 → pay → retry flow.
"""

from __future__ import annotations

from .client import X402Client, create_x402_client
from .types import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionStreamChunk,
    ChatMessage,
    CostInfo,
    PaymentAsset,
    PaymentReceipt,
    PaymentRequiredResponse,
    PaymentVerification,
    Quote,
    StellarNetwork,
    X402CallResult,
    X402ClientConfig,
    X402StreamResult,
)
from .wallet import (
    BuildPaymentOptions,
    BuiltPayment,
    build_payment_transaction,
    create_horizon_server,
    generate_keypair,
    get_horizon_url,
    get_network_passphrase,
)

__all__ = [
    # Client
    'X402Client',
    'create_x402_client',
    'X402ClientConfig',
    # Types
    'Quote',
    'PaymentRequiredResponse',
    'PaymentVerification',
    'PaymentReceipt',
    'ChatCompletionRequest',
    'ChatCompletionResponse',
    'ChatCompletionStreamChunk',
    'ChatMessage',
    'CostInfo',
    'X402CallResult',
    'X402StreamResult',
    'PaymentAsset',
    'StellarNetwork',
    # Wallet
    'BuildPaymentOptions',
    'BuiltPayment',
    'build_payment_transaction',
    'create_horizon_server',
    'generate_keypair',
    'get_horizon_url',
    'get_network_passphrase',
]

try:
    from .langchain_adapter import X402ChatModel as X402ChatModel
    __all__ += ['X402ChatModel']
except ImportError:
    pass