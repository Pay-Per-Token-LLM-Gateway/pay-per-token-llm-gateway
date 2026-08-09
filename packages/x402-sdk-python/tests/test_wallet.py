"""
Tests for x402_sdk wallet utilities.
"""

import pytest
from x402_sdk.wallet import (
    BuildPaymentOptions,
    get_horizon_url,
    get_network_passphrase,
    get_soroban_rpc_url,
)


class TestNetworkConfig:
    """Test network configuration helpers."""

    def test_get_horizon_url_mainnet(self):
        assert get_horizon_url('mainnet') == 'https://horizon.stellar.org'

    def test_get_horizon_url_testnet(self):
        assert get_horizon_url('testnet') == 'https://horizon-testnet.stellar.org'

    def test_get_horizon_url_futurenet(self):
        assert get_horizon_url('futurenet') == 'https://horizon-futurenet.stellar.org'

    def test_get_network_passphrase_mainnet(self):
        assert 'Public Global Stellar Network' in get_network_passphrase('mainnet')

    def test_get_network_passphrase_testnet(self):
        assert 'Test SDF Network' in get_network_passphrase('testnet')

    def test_get_network_passphrase_futurenet(self):
        assert 'Future Network' in get_network_passphrase('futurenet')

    def test_get_soroban_rpc_url(self):
        assert get_soroban_rpc_url('testnet') == 'https://soroban-testnet.stellar.org'


class TestBuildPaymentOptions:
    """Test BuildPaymentOptions dataclass."""

    def test_defaults(self):
        """Test default values."""
        opts = BuildPaymentOptions(
            sourceSecret='SABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
            destination='GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
            amount='100',
            asset='USDC',
            assetIssuer='GA5ZSEJYB37JRC5AV...',
        )
        assert opts.network == 'testnet'
        assert opts.horizonUrl is None
        assert opts.memo is None

    def test_custom_values(self):
        """Test custom values."""
        opts = BuildPaymentOptions(
            sourceSecret='S...',
            destination='G...',
            amount='50',
            asset='XLM',
            memo='quote-123',
            network='mainnet',
            horizonUrl='https://horizon.stellar.org',
        )
        assert opts.asset == 'XLM'
        assert opts.memo == 'quote-123'
        assert opts.network == 'mainnet'
        assert opts.horizonUrl == 'https://horizon.stellar.org'