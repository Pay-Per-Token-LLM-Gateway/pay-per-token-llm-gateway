"""Typed data structures for the x402 wire protocol.

Mirrors the TypeScript types in ``@x402/types``
(``packages/types/src/index.ts`` in the gateway repository). All gateway
JSON payloads use camelCase keys; the dataclasses below parse them via
``from_dict`` while exposing Pythonic snake_case attribute names.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union

# Stellar network identifiers understood by the gateway.
StellarNetwork = str  # "testnet" | "futurenet" | "mainnet"
# Payment asset identifier.
PaymentAsset = str  # "USDC" | "XLM"
# Route pricing model.
PricingModel = str  # "flat" | "per_token"


@dataclass
class Quote:
    """A price quote returned inside a 402 Payment Required response."""

    id: str
    route: str
    pricingModel: PricingModel
    amount: str  # price in the asset's smallest unit (stroops)
    asset: PaymentAsset
    paymentAddress: str
    expiresAt: int  # unix timestamp (seconds)
    network: StellarNetwork
    statusUrl: str
    assetIssuer: Optional[str] = None
    memo: Optional[str] = None
    estimatedMaxTokens: Optional[int] = None
    perTokenPrice: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Quote":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class PaymentRequiredResponse:
    """The 402 Payment Required response body."""

    status: int
    message: str
    quote: Quote
    instructions: str
    docs: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PaymentRequiredResponse":
        return cls(
            status=data.get("status", 402),
            message=data.get("message", ""),
            quote=Quote.from_dict(data.get("quote", {})),
            instructions=data.get("instructions", ""),
            docs=data.get("docs", ""),
        )


@dataclass
class PaymentReceipt:
    """A payment receipt issued by the gateway after verification."""

    id: str
    quoteId: str
    txHash: str
    payerAddress: str
    amount: str
    asset: PaymentAsset
    route: str
    status: str
    verifiedAt: str
    ledger: int
    actualCost: Optional[str] = None
    tokensUsed: Optional[int] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PaymentReceipt":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class Cost:
    """Cost information returned alongside a successful call."""

    amount: str
    asset: PaymentAsset


@dataclass
class X402CallResult:
    """Result of the 402 → pay → retry flow for a non-streaming call."""

    success: bool
    response: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    receipt: Optional[PaymentReceipt] = None
    cost: Optional[Cost] = None


@dataclass
class X402StreamResult:
    """Result of the 402 → pay → retry flow for a streaming call.

    ``stream`` is a generator of OpenAI-compatible chat completion chunk
    dicts. If the gateway appends a trailing ``x402_receipt`` SSE event,
    ``receipt`` is updated with it once the stream has been fully consumed
    (the header receipt, if present, is available immediately).
    """

    success: bool
    stream: Optional[Any] = None
    error: Optional[str] = None
    _receipt_holder: Dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def receipt(self) -> Optional[PaymentReceipt]:
        return self._receipt_holder.get("receipt")

    @receipt.setter
    def receipt(self, value: Optional[PaymentReceipt]) -> None:
        self._receipt_holder["receipt"] = value

    @property
    def cost(self) -> Optional[Cost]:
        receipt = self.receipt
        if receipt is None:
            return None
        return Cost(amount=receipt.amount, asset=receipt.asset)


@dataclass
class X402ClientConfig:
    """Configuration for :class:`~x402_sdk.client.X402Client`.

    Mirrors ``X402ClientConfig`` in ``@x402/types``. Use ``secret_key``
    when the SDK may hold the signing key directly; use ``public_key`` +
    ``sign_transaction`` for external wallet signing.
    """

    gateway_url: str
    network: StellarNetwork = "testnet"
    default_asset: PaymentAsset = "USDC"
    secret_key: Optional[str] = None
    public_key: Optional[str] = None
    payment_timeout: int = 300_000
    sign_transaction: Optional[Callable[[str], str]] = None
    horizon_url: Optional[str] = None  # override the per-network default (tests)
    http_client: Optional[Any] = None  # injectable httpx.Client (tests)
