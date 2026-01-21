"""
PositionHistory model - time-series telemetry storage.

This is the analytical backbone of the system. Every position update
is recorded here, enabling:
- Rolling window calculations (like financial tick data)
- Trend detection and analysis
- Flight path reconstruction
- Anomaly detection via statistical analysis

Schema optimized for:
- Fast batch inserts (append-only pattern)
- Efficient time-range queries per aircraft
- Rolling window aggregations
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import String, Float, Integer, DateTime, Boolean, Index
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base


class PositionHistory(Base):
    """
    Historical telemetry records for time-series analysis.

    One row per (aircraft, timestamp) observation. Designed for high-volume
    writes and analytical queries. This table grows continuously and requires
    periodic cleanup based on retention policy.

    The schema deliberately denormalizes some data (like callsign) to avoid
    joins in time-critical analytical queries - a common pattern in
    time-series databases.
    """

    __tablename__ = 'position_history'

    # Surrogate primary key for efficient inserts
    # Using Integer for SQLite compatibility (autoincrement only works with INTEGER)
    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
        comment='Surrogate key'
    )

    # Aircraft identifier - not a foreign key to avoid insert overhead
    icao24: Mapped[str] = mapped_column(
        String(6),
        nullable=False,
        index=True,
        comment='ICAO24 hex address'
    )

    # Denormalized callsign for query convenience
    callsign: Mapped[Optional[str]] = mapped_column(
        String(8),
        nullable=True,
        comment='Callsign at time of observation'
    )

    # Timestamp - the critical dimension for time-series queries
    # Using integer Unix timestamp for efficient comparisons and indexing
    timestamp: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        index=True,
        comment='Unix timestamp of observation'
    )

    # Position (WGS84)
    latitude: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Latitude in decimal degrees'
    )

    longitude: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Longitude in decimal degrees'
    )

    # Altitude
    baro_altitude: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Barometric altitude in meters'
    )

    geo_altitude: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Geometric altitude in meters'
    )

    # Velocity
    velocity: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Ground speed in m/s'
    )

    true_track: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='True track in degrees'
    )

    vertical_rate: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Vertical rate in m/s'
    )

    # Status
    on_ground: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        comment='Aircraft on ground'
    )

    # Data quality
    position_source: Mapped[Optional[int]] = mapped_column(
        Integer,
        nullable=True,
        comment='Position source type'
    )

    # Distance from observer at time of observation
    distance_km: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Distance from observer in km'
    )

    # Record creation time (for cleanup queries)
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        index=True,
        comment='Record creation time'
    )

    # Indexes optimized for time-series query patterns
    __table_args__ = (
        # Primary analytical query: get history for one aircraft in time range
        # This composite index is critical for rolling window calculations
        Index(
            'ix_position_history_icao_time',
            'icao24', 'timestamp',
            # Descending timestamp for "most recent N" queries
        ),

        # Cleanup query: find old records to delete
        Index('ix_position_history_cleanup', 'created_at'),

        # Spatial + time query: aircraft near a point in time window
        Index(
            'ix_position_history_spatial_time',
            'latitude', 'longitude', 'timestamp'
        ),
    )

    def __repr__(self) -> str:
        return f'<PositionHistory {self.icao24} @ {self.timestamp}>'

    # -------------------------------------------------------------------------
    # Unit conversion helpers (same as FlightState)
    # -------------------------------------------------------------------------

    @property
    def altitude_ft(self) -> Optional[int]:
        """Barometric altitude in feet."""
        if self.baro_altitude is None:
            return None
        return int(self.baro_altitude * 3.28084)

    @property
    def speed_kts(self) -> Optional[int]:
        """Ground speed in knots."""
        if self.velocity is None:
            return None
        return int(self.velocity * 1.94384)

    @property
    def vertical_rate_fpm(self) -> Optional[int]:
        """Vertical rate in feet per minute."""
        if self.vertical_rate is None:
            return None
        return int(self.vertical_rate * 196.85)


# -------------------------------------------------------------------------
# Query helpers for common time-series operations
# -------------------------------------------------------------------------

def get_retention_cutoff_timestamp(hours: int) -> int:
    """
    Calculate Unix timestamp for retention cutoff.

    Records older than this should be deleted.
    """
    cutoff = datetime.now(timezone.utc).timestamp() - (hours * 3600)
    return int(cutoff)
