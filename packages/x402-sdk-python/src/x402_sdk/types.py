"""
x402 SDK — Shared type definitions mirroring @x402/types.

All monetary amounts are represented as strings in the asset's smallest unit
(e.g., stroops for USDC, 1e-7 precision).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Literal, Optional

# ── Stellar / Payment Types ─────────────────

StellarNetwork = Literal['testnet', 'mainnet', 'futurenet']
"""Supported Stellar networks."""

PaymentAsset = Literal['USDC', 'XLM']
"""Supported payment assets."""

StellarAddress = str
"""Stellar account / public key (G...)."""

TxHash = str
"""Transaction hash on Stellar (hex)."""

PaymentStatus = Literal['pending', 'confirmed', 'failed', 'refunded', 'expired']
"""Payment status."""

PricingModel = Literal['flat', 'per_token']
"""Pricing model for a route."""


# ── x402 Protocol Types ──────────────────────

@dataclass
class Quote:
    """A price quote returned in a 402 Payment Required response."""

    id: str
    """Unique quote ID (UUID)."""

    route: str
    """The route/model being requested."""

    pricingModel: PricingModel
    """The pricing model used."""

    amount: str
    """Price in the asset's smallest unit (e.g., stroops for USDC)."""

    asset: PaymentAsset
    """Payment asset required."""

    paymentAddress: StellarAddress
    """Destination Stellar address for payment."""

    network: StellarNetwork
    """Stellar network."""

    expiresAt: int
    """Unix timestamp when this quote expires."""

    statusUrl: str
    """URL to check payment status."""

    assetIssuer: Optional[str] = None
    """Stellar asset issuer (for USDC, e.g. GA5ZSEJYB37JRC5AV...)."""

    memo: Optional[str] = None
    """Memo required for the payment (if any)."""

    estimatedMaxTokens: Optional[int] = None
    """For per-token pricing: estimated max tokens this quote covers."""

    perTokenPrice: Optional[str] = None
    """For per-token pricing: price per token in smallest unit."""


@dataclass
class PaymentRequiredResponse:
    """The 402 Payment Required response body."""

    status: int = 402
    message: str = 'Payment Required'
    quote: Optional[Quote] = None
    instructions: Optional[str] = None
    docs: Optional[str] = None


@dataclass
class PaymentVerification:
    """Payment verification result from the gateway."""

    verified: bool
    txHash: TxHash
    payerAddress: StellarAddress
    amount: str
    asset: PaymentAsset
    ledger: int
    timestamp: int
    failureReason: Optional[str] = None


@dataclass
class PaymentReceipt:
    """A payment receipt issued after verification."""

    id: str
    quoteId: str
    txHash: TxHash
    payerAddress: StellarAddress
    amount: str
    asset: PaymentAsset
    route: str
    status: PaymentStatus
    verifiedAt: str
    ledger: int
    actualCost: Optional[str] = None
    tokensUsed: Optional[int] = None


# ── LLM / Proxy Types ────────────────────────

@dataclass
class ChatMessage:
    """A single message in a chat completion request."""

    role: Literal['system', 'user', 'assistant', 'function']
    content: str
    name: Optional[str] = None


@dataclass
class ChatCompletionRequest:
    """OpenAI-compatible chat completion request."""

    model: str
    messages: list[ChatMessage]
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    top_p: Optional[float] = None
    frequency_penalty: Optional[float] = None
    presence_penalty: Optional[float] = None
    stream: Optional[bool] = None
    stop: Optional[str | list[str]] = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        d: dict[str, Any] = {'model': self.model, 'messages': []}
        for msg in self.messages:
            m: dict[str, Any] = {'role': msg.role, 'content': msg.content}
            if msg.name:
                m['name'] = msg.name
            d['messages'].append(m)
        for key in ('temperature', 'max_tokens', 'top_p',
                     'frequency_penalty', 'presence_penalty', 'stream', 'stop'):
            val = getattr(self, key, None)
            if val is not None:
                d[key] = val
        return d


@dataclass
class Choice:
    """A single choice in a chat completion response."""

    index: int
    message: ChatMessage
    finish_reason: str


@dataclass
class Usage:
    """Token usage information."""

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


@dataclass
class ChatCompletionResponse:
    """OpenAI-compatible chat completion response."""

    id: str
    object: str = 'chat.completion'
    created: int = 0
    model: str = ''
    choices: list[Choice] = field(default_factory=list)
    usage: Optional[Usage] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> 'ChatCompletionResponse':
        """Deserialize from a dictionary."""
        choices = []
        for c in data.get('choices', []):
            msg_data = c.get('message', {})
            choices.append(Choice(
                index=c.get('index', 0),
                message=ChatMessage(
                    role=msg_data.get('role', 'assistant'),
                    content=msg_data.get('content', ''),
                    name=msg_data.get('name'),
                ),
                finish_reason=c.get('finish_reason', ''),
            ))
        usage_data = data.get('usage')
        usage = Usage(**usage_data) if usage_data else None
        return cls(
            id=data.get('id', ''),
            object=data.get('object', 'chat.completion'),
            created=data.get('created', 0),
            model=data.get('model', ''),
            choices=choices,
            usage=usage,
        )


# ── SSE Streaming Types ──────────────────────

@dataclass
class ChoiceDelta:
    """Partial message delta for streaming."""

    role: Optional[str] = None
    content: Optional[str] = None


@dataclass
class StreamChoice:
    """A streaming choice with a delta."""

    index: int
    delta: ChoiceDelta
    finish_reason: Optional[str] = None


@dataclass
class ChatCompletionStreamChunk:
    """A single SSE chunk in a streaming chat completion response."""

    id: str
    object: str = 'chat.completion.chunk'
    created: int = 0
    model: str = ''
    choices: list[StreamChoice] = field(default_factory=list)
    usage: Optional[Usage] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> 'ChatCompletionStreamChunk':
        """Deserialize from a dictionary."""
        choices = []
        for c in data.get('choices', []):
            delta_data = c.get('delta', {})
            choices.append(StreamChoice(
                index=c.get('index', 0),
                delta=ChoiceDelta(
                    role=delta_data.get('role'),
                    content=delta_data.get('content'),
                ),
                finish_reason=c.get('finish_reason'),
            ))
        usage_data = data.get('usage')
        usage = Usage(**usage_data) if usage_data else None
        return cls(
            id=data.get('id', ''),
            object=data.get('object', 'chat.completion.chunk'),
            created=data.get('created', 0),
            model=data.get('model', ''),
            choices=choices,
            usage=usage,
        )


# ── SDK Types ────────────────────────────────

@dataclass
class X402ClientConfig:
    """Configuration for the x402 client SDK."""

    gatewayUrl: str
    """Gateway base URL (e.g., https://gateway.example.com)."""

    network: StellarNetwork = 'testnet'
    """Stellar network to use."""

    defaultAsset: PaymentAsset = 'USDC'
    """Default asset for payment."""

    secretKey: Optional[str] = None
    """Secret key for signing transactions (client-side only)."""

    paymentTimeout: int = 300_000
    """Maximum time to wait for payment confirmation (ms)."""


@dataclass
class CostInfo:
    """Cost information for a completed request."""

    amount: str
    asset: PaymentAsset


@dataclass
class X402CallResult:
    """Result of the 402 → pay → retry flow (non-streaming)."""

    success: bool
    response: Optional[ChatCompletionResponse] = None
    receipt: Optional[PaymentReceipt] = None
    error: Optional[str] = None
    cost: Optional[CostInfo] = None


@dataclass
class X402StreamResult:
    """Result of a streaming 402 → pay → retry flow."""

    success: bool
    stream: Optional[AsyncGenerator[ChatCompletionStreamChunk, None]] = None
    receipt: Optional[PaymentReceipt] = None
    error: Optional[str] = None
    cost: Optional[CostInfo] = None