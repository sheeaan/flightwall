"""
Aircraft model - static reference data for ICAO24 lookups.

Maps ICAO24 hex addresses to aircraft metadata (type, registration, etc.).
This data comes from external databases and is relatively static.
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import String, DateTime, Index
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base


class Aircraft(Base):
    """
    Static aircraft information keyed by ICAO24 hex address.

    The ICAO24 address is a globally unique identifier assigned to each
    aircraft transponder. It's the primary key we use to correlate
    real-time telemetry with aircraft metadata.

    Fields:
        icao24: 6-character hex address (e.g., 'a0b1c2')
        registration: Tail number (e.g., 'N12345')
        type_code: ICAO type designator (e.g., 'B738', 'A320')
        type_description: Human-readable type (e.g., 'Boeing 737-800')
        operator: Airline or owner name
        operator_icao: 3-letter ICAO airline code (e.g., 'UAL', 'DAL')
        operator_callsign: Airline callsign prefix (e.g., 'UNITED')
    """

    __tablename__ = 'aircraft'

    # Primary key - ICAO24 hex address (lowercase, 6 chars)
    icao24: Mapped[str] = mapped_column(
        String(6),
        primary_key=True,
        comment='ICAO24 hex transponder address'
    )

    # Registration / tail number
    registration: Mapped[Optional[str]] = mapped_column(
        String(10),
        nullable=True,
        index=True,
        comment='Aircraft registration (tail number)'
    )

    # Aircraft type information
    type_code: Mapped[Optional[str]] = mapped_column(
        String(4),
        nullable=True,
        index=True,
        comment='ICAO type designator (e.g., B738)'
    )

    type_description: Mapped[Optional[str]] = mapped_column(
        String(100),
        nullable=True,
        comment='Full aircraft type name'
    )

    # Operator information
    operator: Mapped[Optional[str]] = mapped_column(
        String(100),
        nullable=True,
        comment='Operator/airline name'
    )

    operator_icao: Mapped[Optional[str]] = mapped_column(
        String(3),
        nullable=True,
        index=True,
        comment='ICAO airline code (e.g., UAL)'
    )

    operator_callsign: Mapped[Optional[str]] = mapped_column(
        String(50),
        nullable=True,
        comment='Radio callsign prefix (e.g., UNITED)'
    )

    # Metadata
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        comment='Record creation timestamp'
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        comment='Last update timestamp'
    )

    # Indexes for common query patterns
    __table_args__ = (
        # Composite index for airline + type lookups
        Index('ix_aircraft_operator_type', 'operator_icao', 'type_code'),
    )

    def __repr__(self) -> str:
        return f'<Aircraft {self.icao24} {self.registration or "?"} {self.type_code or "?"}>'

    @property
    def display_type(self) -> str:
        """Return best available type identifier for display."""
        return self.type_code or 'UNKN'

    @property
    def display_operator(self) -> str:
        """Return best available operator identifier for display."""
        return self.operator_icao or self.operator or 'UNK'
