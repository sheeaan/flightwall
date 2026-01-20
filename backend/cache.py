"""
In-memory cache for low-latency telemetry queries.

Provides a time-aware cache for flight state data, enabling:
- Sub-millisecond read access for API endpoints
- Automatic expiration of stale entries
- Thread-safe operations for concurrent access

Design rationale:
The cache sits between the API layer and database, storing the most
recent flight states in memory. Since telemetry data updates every
5-10 seconds, a short TTL (5 seconds) ensures freshness while
dramatically reducing database load during high-frequency polling
from multiple frontend clients.

Memory budget: ~500 flights × ~1KB per flight = ~500KB max
"""

import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Dict, List, Any

from backend.config import config
from backend.models import FlightState
from backend.models.base import SessionLocal
from backend.ingestion.aircraft_db import AircraftLookup, AIRCRAFT_TYPES

logger = logging.getLogger(__name__)


@dataclass
class CachedFlightState:
    """
    Cached flight state with display-ready fields.

    Combines database state with aircraft lookup data
    and pre-computed display values.
    """
    # Core identification
    icao24: str
    callsign: str
    aircraft_type: Optional[str]
    aircraft_type_desc: Optional[str]
    operator: Optional[str]

    # Position
    latitude: Optional[float]
    longitude: Optional[float]
    distance_km: Optional[float]

    # Telemetry (raw SI units)
    altitude_m: Optional[float]
    velocity_mps: Optional[float]
    heading: Optional[float]
    vertical_rate_mps: Optional[float]

    # Telemetry (display units)
    altitude_ft: Optional[int]
    flight_level: Optional[str]
    speed_kts: Optional[int]
    vertical_rate_fpm: Optional[int]

    # Status
    on_ground: bool
    flight_phase: str

    # Analytics
    speed_trend: Optional[str]
    altitude_trend: Optional[str]
    is_anomaly: bool

    # Timestamps
    last_contact: Optional[int]
    updated_at: datetime

    # Cache metadata
    cached_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict for API responses."""
        return {
            'icao24': self.icao24,
            'callsign': self.callsign,
            'aircraft_type': self.aircraft_type,
            'aircraft_type_desc': self.aircraft_type_desc,
            'operator': self.operator,
            'position': {
                'latitude': self.latitude,
                'longitude': self.longitude,
                'distance_km': round(self.distance_km, 1) if self.distance_km else None,
            },
            'telemetry': {
                'altitude_ft': self.altitude_ft,
                'flight_level': self.flight_level,
                'speed_kts': self.speed_kts,
                'heading': self.heading,
                'vertical_rate_fpm': self.vertical_rate_fpm,
            },
            'status': {
                'on_ground': self.on_ground,
                'flight_phase': self.flight_phase,
            },
            'analytics': {
                'speed_trend': self.speed_trend,
                'altitude_trend': self.altitude_trend,
                'is_anomaly': self.is_anomaly,
            },
            'timestamps': {
                'last_contact': self.last_contact,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            },
        }

    def to_ticker_dict(self) -> dict:
        """
        Minimal representation for ticker display.

        Optimized for the single-flight focus display mode.
        """
        return {
            'icao24': self.icao24,
            'callsign': self.callsign,
            'type': self.aircraft_type or 'UNKN',
            'type_description': self.aircraft_type_desc,
            'operator': self.operator,
            'altitude_ft': self.altitude_ft,
            'flight_level': self.flight_level,
            'speed_kts': self.speed_kts,
            'heading': self.heading,
            'vertical_rate_fpm': self.vertical_rate_fpm,
            'flight_phase': self.flight_phase,
            'distance_km': round(self.distance_km, 1) if self.distance_km else None,
            'is_anomaly': self.is_anomaly,
        }


class FlightCache:
    """
    Thread-safe in-memory cache for flight states.

    Provides fast read access to current flight data with
    automatic refresh from database.
    """

    def __init__(
        self,
        ttl_seconds: int = None,
        max_entries: int = None,
    ):
        self.ttl_seconds = ttl_seconds or config.cache.ttl_seconds
        self.max_entries = max_entries or config.cache.max_entries

        self._cache: Dict[str, CachedFlightState] = {}
        self._lock = threading.RLock()
        self._last_refresh: float = 0

        # Aircraft lookup for type enrichment
        self._aircraft_lookup = AircraftLookup()

        # Statistics
        self._hits = 0
        self._misses = 0

    def get(self, icao24: str) -> Optional[CachedFlightState]:
        """
        Get cached flight state by ICAO24.

        Returns None if not cached or expired.
        """
        icao24 = icao24.lower()

        with self._lock:
            if icao24 in self._cache:
                entry = self._cache[icao24]
                age = time.time() - entry.cached_at
                if age < self.ttl_seconds:
                    self._hits += 1
                    return entry
                else:
                    # Expired
                    del self._cache[icao24]

        self._misses += 1
        return None

    def get_all(self) -> List[CachedFlightState]:
        """
        Get all cached entries.

        Returns list sorted by distance (closest first).
        Note: We don't filter by TTL here since refresh_from_database()
        replaces the entire cache atomically. This prevents flicker
        between ingestion cycles.
        """
        with self._lock:
            result = list(self._cache.values())

        # Sort by distance
        result.sort(key=lambda x: x.distance_km if x.distance_km else float('inf'))

        return result

    def get_airborne(self) -> List[CachedFlightState]:
        """Get only airborne (not on ground) flights."""
        return [f for f in self.get_all() if not f.on_ground]

    def refresh_from_database(self) -> int:
        """
        Refresh cache from database.

        Loads all current flight states and enriches with
        aircraft type data.

        Returns count of flights loaded.
        """
        with SessionLocal() as session:
            flights = session.query(FlightState).all()

        new_cache = {}
        for flight in flights:
            cached = self._enrich_flight(flight)
            new_cache[flight.icao24] = cached

        with self._lock:
            self._cache = new_cache
            self._last_refresh = time.time()

        logger.debug(f'Cache refreshed with {len(new_cache)} flights')
        return len(new_cache)

    def _enrich_flight(self, flight: FlightState) -> CachedFlightState:
        """
        Convert database FlightState to enriched CachedFlightState.

        Adds aircraft type data and pre-computes display values.
        """
        # Look up aircraft info
        aircraft_info = self._aircraft_lookup.get(
            flight.icao24,
            flight.callsign
        )

        # Get type description
        type_desc = None
        if aircraft_info.type_code:
            type_desc = AIRCRAFT_TYPES.get(aircraft_info.type_code)

        return CachedFlightState(
            icao24=flight.icao24,
            callsign=flight.display_callsign,
            aircraft_type=aircraft_info.type_code,
            aircraft_type_desc=type_desc,
            operator=aircraft_info.operator_icao or aircraft_info.operator,

            latitude=flight.latitude,
            longitude=flight.longitude,
            distance_km=flight.distance_km,

            altitude_m=flight.baro_altitude,
            velocity_mps=flight.velocity,
            heading=flight.heading_display,
            vertical_rate_mps=flight.vertical_rate,

            altitude_ft=flight.altitude_ft,
            flight_level=flight.flight_level,
            speed_kts=flight.speed_kts,
            vertical_rate_fpm=flight.vertical_rate_fpm,

            on_ground=flight.on_ground,
            flight_phase=flight.flight_phase,

            speed_trend=flight.speed_trend,
            altitude_trend=flight.altitude_trend,
            is_anomaly=flight.is_anomaly,

            last_contact=flight.last_contact,
            updated_at=flight.updated_at,
        )

    def update(self, flight: FlightState) -> None:
        """Update cache with a single flight state."""
        cached = self._enrich_flight(flight)

        with self._lock:
            self._cache[flight.icao24] = cached

            # Evict if over capacity
            if len(self._cache) > self.max_entries:
                self._evict_oldest()

    def _evict_oldest(self) -> None:
        """Remove oldest entries when over capacity."""
        entries = sorted(
            self._cache.items(),
            key=lambda x: x[1].cached_at
        )
        # Remove oldest 10%
        to_remove = max(1, len(entries) // 10)
        for icao24, _ in entries[:to_remove]:
            del self._cache[icao24]

    def invalidate(self, icao24: str) -> None:
        """Remove specific entry from cache."""
        icao24 = icao24.lower()
        with self._lock:
            self._cache.pop(icao24, None)

    def clear(self) -> None:
        """Clear entire cache."""
        with self._lock:
            self._cache.clear()

    @property
    def stats(self) -> dict:
        """Get cache statistics."""
        with self._lock:
            return {
                'entries': len(self._cache),
                'hits': self._hits,
                'misses': self._misses,
                'hit_rate': self._hits / (self._hits + self._misses) if (self._hits + self._misses) > 0 else 0,
                'last_refresh': self._last_refresh,
            }


# Singleton instance
flight_cache = FlightCache()
