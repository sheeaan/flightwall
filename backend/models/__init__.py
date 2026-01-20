"""
Database models for FlightWall.

Schema designed for time-series telemetry data with these priorities:
1. Fast ingestion (batch inserts)
2. Efficient time-range queries
3. Low-latency lookups by ICAO24
4. Rolling window analytics support
"""

from backend.models.base import Base, engine, SessionLocal, init_db, get_session
from backend.models.aircraft import Aircraft
from backend.models.flight_state import FlightState
from backend.models.position_history import PositionHistory, get_retention_cutoff_timestamp

__all__ = [
    'Base',
    'engine',
    'SessionLocal',
    'init_db',
    'get_session',
    'Aircraft',
    'FlightState',
    'PositionHistory',
    'get_retention_cutoff_timestamp',
]
