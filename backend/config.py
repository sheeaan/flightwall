"""
Configuration management for FlightWall.

Loads settings from environment variables with sensible defaults.
All configuration is centralized here to avoid magic strings scattered
throughout the codebase.
"""

import os
from dataclasses import dataclass
from typing import Optional, Tuple

from dotenv import load_dotenv

load_dotenv()


def _parse_location(value: str) -> Optional[Tuple[float, float]]:
    """Parse 'lat,lon' string into tuple, or None if empty/invalid."""
    if not value:
        return None
    try:
        lat, lon = value.split(',')
        return (float(lat.strip()), float(lon.strip()))
    except (ValueError, AttributeError):
        return None


@dataclass(frozen=True)
class OpenSkyConfig:
    """OpenSky API configuration."""
    username: Optional[str] = os.getenv('OPENSKY_USERNAME') or None
    password: Optional[str] = os.getenv('OPENSKY_PASSWORD') or None
    base_url: str = 'https://opensky-network.org/api'

    @property
    def is_authenticated(self) -> bool:
        return bool(self.username and self.password)

    @property
    def rate_limit_seconds(self) -> int:
        # Authenticated users can poll more frequently
        return 5 if self.is_authenticated else 10


@dataclass(frozen=True)
class DatabaseConfig:
    """Database configuration."""
    url: str = os.getenv('DATABASE_URL', 'sqlite:///flightwall.db')

    @property
    def is_sqlite(self) -> bool:
        return self.url.startswith('sqlite')


@dataclass(frozen=True)
class IngestionConfig:
    """Data ingestion settings."""
    poll_interval: int = int(os.getenv('POLL_INTERVAL_SECONDS', '10'))
    default_radius_km: float = float(os.getenv('DEFAULT_RADIUS_KM', '250'))

    # Batch processing settings - treat like financial tick data
    batch_size: int = 100  # Max aircraft per batch insert
    stale_threshold_seconds: int = 60  # Mark data stale after this


@dataclass(frozen=True)
class CacheConfig:
    """In-memory cache settings."""
    ttl_seconds: int = int(os.getenv('CACHE_TTL_SECONDS', '5'))
    max_entries: int = 500  # Max cached flight states


@dataclass(frozen=True)
class RetentionConfig:
    """Data retention policy."""
    hours: int = int(os.getenv('RETENTION_HOURS', '24'))
    cleanup_interval_minutes: int = 30  # How often to run cleanup


@dataclass(frozen=True)
class AviationStackConfig:
    """AviationStack API configuration for flight route data."""
    api_key: Optional[str] = os.getenv('AVIATIONSTACK_API_KEY') or None

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)


@dataclass(frozen=True)
class AppConfig:
    """Main application configuration."""
    opensky: OpenSkyConfig
    database: DatabaseConfig
    ingestion: IngestionConfig
    cache: CacheConfig
    retention: RetentionConfig
    aviationstack: AviationStackConfig

    # User location (None = auto-detect via IP)
    user_location: Optional[Tuple[float, float]]

    # Flask settings
    secret_key: str
    debug: bool


def load_config() -> AppConfig:
    """Load and validate all configuration."""
    return AppConfig(
        opensky=OpenSkyConfig(),
        database=DatabaseConfig(),
        ingestion=IngestionConfig(),
        cache=CacheConfig(),
        retention=RetentionConfig(),
        aviationstack=AviationStackConfig(),
        user_location=_parse_location(os.getenv('USER_LOCATION', '')),
        secret_key=os.getenv('SECRET_KEY', 'dev-key-change-in-prod'),
        debug=os.getenv('FLASK_DEBUG', '0') == '1',
    )


# Singleton instance
config = load_config()
