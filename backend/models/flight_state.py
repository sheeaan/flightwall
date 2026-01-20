"""
FlightState model - current state of tracked aircraft.

This table represents the latest known state of each aircraft we're tracking.
It's a "hot" table that gets updated frequently during ingestion and queried
constantly by the API layer.

Design notes:
- One row per aircraft (upsert pattern)
- Indexed for fast lookups by icao24, callsign, and location
- Includes computed fields for display (flight phase, etc.)
"""

from datetime import datetime
from enum import Enum
from typing import Optional

from sqlalchemy import String, Float, Integer, DateTime, Boolean, Index, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.models.base import Base


class FlightPhase(str, Enum):
    """
    Detected flight phase based on telemetry analysis.

    Determined by vertical rate and altitude patterns:
    - GROUND: On ground (on_ground=True or altitude < 500ft AGL)
    - CLIMB: Positive vertical rate > 500 fpm
    - CRUISE: Stable altitude (vertical rate < ±200 fpm)
    - DESCENT: Negative vertical rate < -500 fpm
    - UNKNOWN: Insufficient data
    """
    GROUND = 'ground'
    CLIMB = 'climb'
    CRUISE = 'cruise'
    DESCENT = 'descent'
    UNKNOWN = 'unknown'


class FlightState(Base):
    """
    Current state of a tracked aircraft.

    This is the primary table for real-time queries. Updated via upsert
    on each ingestion cycle. One row per unique ICAO24 address.

    Telemetry fields mirror OpenSky state vector format but with
    standardized units and additional computed fields.
    """

    __tablename__ = 'flight_states'

    # Primary key - ICAO24 hex address
    icao24: Mapped[str] = mapped_column(
        String(6),
        primary_key=True,
        comment='ICAO24 hex transponder address'
    )

    # Foreign key to aircraft static data (optional - may not have lookup data)
    # Note: Not enforced as FK to allow flights without aircraft DB entries

    # Identification
    callsign: Mapped[Optional[str]] = mapped_column(
        String(8),
        nullable=True,
        index=True,
        comment='Flight callsign (e.g., UAL839)'
    )

    origin_country: Mapped[Optional[str]] = mapped_column(
        String(50),
        nullable=True,
        comment='Country of aircraft registration'
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

    # Altitude - we store both barometric and geometric
    baro_altitude: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Barometric altitude in meters'
    )

    geo_altitude: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Geometric (GPS) altitude in meters'
    )

    # Velocity and direction
    velocity: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Ground speed in m/s'
    )

    true_track: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='True track (heading) in degrees (0-360)'
    )

    vertical_rate: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Vertical rate in m/s (positive=climb)'
    )

    # Status flags
    on_ground: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        comment='Aircraft is on ground'
    )

    squawk: Mapped[Optional[str]] = mapped_column(
        String(4),
        nullable=True,
        comment='Transponder squawk code'
    )

    spi: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        comment='Special Position Identification flag'
    )

    # Data quality indicators
    position_source: Mapped[Optional[int]] = mapped_column(
        Integer,
        nullable=True,
        comment='Position source: 0=ADS-B, 1=ASTERIX, 2=MLAT, 3=FLARM'
    )

    # Timestamps
    time_position: Mapped[Optional[int]] = mapped_column(
        Integer,
        nullable=True,
        comment='Unix timestamp of last position update'
    )

    last_contact: Mapped[Optional[int]] = mapped_column(
        Integer,
        nullable=True,
        comment='Unix timestamp of last message received'
    )

    # Computed fields (updated during ingestion)
    flight_phase: Mapped[str] = mapped_column(
        String(10),
        default=FlightPhase.UNKNOWN.value,
        comment='Detected flight phase'
    )

    distance_km: Mapped[Optional[float]] = mapped_column(
        Float,
        nullable=True,
        comment='Distance from observer in km'
    )

    # Analytics indicators (populated by analytics layer)
    speed_trend: Mapped[Optional[str]] = mapped_column(
        String(20),
        nullable=True,
        comment='Speed trend: increasing/stable/decreasing'
    )

    altitude_trend: Mapped[Optional[str]] = mapped_column(
        String(20),
        nullable=True,
        comment='Altitude trend: climbing/level/descending'
    )

    is_anomaly: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        comment='Flagged as anomalous by analytics'
    )

    # Record timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        comment='First seen timestamp'
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        index=True,  # Index for cleanup queries
        comment='Last update timestamp'
    )

    # Indexes for query patterns
    __table_args__ = (
        # Spatial queries (find aircraft near a point)
        Index('ix_flight_states_location', 'latitude', 'longitude'),
        # Active flights query
        Index('ix_flight_states_active', 'on_ground', 'updated_at'),
    )

    def __repr__(self) -> str:
        return f'<FlightState {self.icao24} {self.callsign or "?"} @ {self.baro_altitude or 0:.0f}m>'

    # -------------------------------------------------------------------------
    # Display helpers - convert to human-friendly units
    # -------------------------------------------------------------------------

    @property
    def altitude_ft(self) -> Optional[int]:
        """Barometric altitude in feet."""
        if self.baro_altitude is None:
            return None
        return int(self.baro_altitude * 3.28084)

    @property
    def flight_level(self) -> Optional[str]:
        """Flight level string (e.g., 'FL350')."""
        alt_ft = self.altitude_ft
        if alt_ft is None or alt_ft < 18000:
            return None
        return f'FL{alt_ft // 100}'

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

    @property
    def heading_display(self) -> Optional[int]:
        """Heading rounded to nearest degree."""
        if self.true_track is None:
            return None
        return int(self.true_track) % 360

    @property
    def display_callsign(self) -> str:
        """Callsign for display, with fallback."""
        return (self.callsign or '').strip() or self.icao24.upper()

    @property
    def is_stale(self) -> bool:
        """Check if data is stale (no update in 60+ seconds)."""
        if self.last_contact is None:
            return True
        return (datetime.utcnow().timestamp() - self.last_contact) > 60
