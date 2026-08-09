from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class X402Error(RuntimeError):
    """Raised when an x402 payment or gateway flow fails."""


@dataclass(frozen=True)
class PaymentQuote:
    id: str
    route: str
    pricing_model: str
    amount: str
    asset: str
    payment_address: str
    network: str
    expires_at: int
    status_url: str
    asset_issuer: str | None = None
    memo: str | None = None
    estimated_max_tokens: int | None = None
    per_token_price: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PaymentQuote":
        return cls(
            id=str(data["id"]),
            route=str(data["route"]),
            pricing_model=str(data.get("pricingModel", data.get("pricing_model", "flat"))),
            amount=str(data["amount"]),
            asset=str(data["asset"]),
            asset_issuer=data.get("assetIssuer") or data.get("asset_issuer"),
            payment_address=str(data.get("paymentAddress", data.get("payment_address", ""))),
            memo=data.get("memo"),
            expires_at=int(data.get("expiresAt", data.get("expires_at", 0))),
            network=str(data["network"]),
            status_url=str(data.get("statusUrl", data.get("status_url", ""))),
            estimated_max_tokens=data.get("estimatedMaxTokens")
            or data.get("estimated_max_tokens"),
            per_token_price=data.get("perTokenPrice") or data.get("per_token_price"),
        )


@dataclass(frozen=True)
class PaymentReceipt:
    id: str
    quote_id: str
    tx_hash: str
    payer_address: str
    amount: str
    asset: str
    route: str
    status: str
    verified_at: str
    ledger: int
    actual_cost: str | None = None
    tokens_used: int | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PaymentReceipt":
        return cls(
            id=str(data["id"]),
            quote_id=str(data.get("quoteId", data.get("quote_id", ""))),
            tx_hash=str(data.get("txHash", data.get("tx_hash", ""))),
            payer_address=str(data.get("payerAddress", data.get("payer_address", ""))),
            amount=str(data["amount"]),
            asset=str(data["asset"]),
            route=str(data["route"]),
            status=str(data["status"]),
            verified_at=str(data.get("verifiedAt", data.get("verified_at", ""))),
            ledger=int(data.get("ledger", 0)),
            actual_cost=data.get("actualCost") or data.get("actual_cost"),
            tokens_used=data.get("tokensUsed") or data.get("tokens_used"),
        )


@dataclass(frozen=True)
class X402CallResult:
    response: dict[str, Any]
    receipt: PaymentReceipt | None = None

