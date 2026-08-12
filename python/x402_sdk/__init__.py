"""x402-sdk — Python SDK for the x402 payment protocol.

Automatic 402 → pay → retry for LLM gateways, with Stellar payment
execution and optional LangChain integration. Mirrors the TypeScript
``@x402/sdk``.
"""

from .client import X402Client, create_x402_client
from .stellar import (
    build_payment_envelope,
    get_horizon_url,
    load_account,
    pay_quote,
    stroops_to_units,
    submit_transaction,
    units_to_stroops,
    wait_for_confirmation,
)
from .types import (
    Cost,
    PaymentReceipt,
    PaymentRequiredResponse,
    Quote,
    X402CallResult,
    X402ClientConfig,
    X402StreamResult,
)

try:  # Optional LangChain integration (requires the "langchain" extra).
    from .langchain import X402ChatModel  # noqa: F401
except ImportError:  # pragma: no cover
    pass

__all__ = [
    "X402Client",
    "create_x402_client",
    "X402ClientConfig",
    "Quote",
    "PaymentRequiredResponse",
    "PaymentReceipt",
    "Cost",
    "X402CallResult",
    "X402StreamResult",
    "pay_quote",
    "build_payment_envelope",
    "load_account",
    "submit_transaction",
    "wait_for_confirmation",
    "get_horizon_url",
    "stroops_to_units",
    "units_to_stroops",
    "X402ChatModel",
]

__version__ = "0.1.0"
