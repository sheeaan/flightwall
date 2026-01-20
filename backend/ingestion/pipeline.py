"""
Ingestion pipeline - orchestrates data flow from OpenSky to database.

This module treats aircraft telemetry like financial tick data:
- High-frequency polling (configurable interval)
- Batch processing for efficiency
- Atomic database operations
- Time-series append pattern for history

Pipeline stages:
1. Fetch: Poll OpenSky API for state vectors
2. Enrich: Add computed fields (distance, flight phase)
3. Upsert: Update current state table
4. Append: Add to position history (time-series)
5. Cleanup: Remove stale data per retention policy
"""

import logging
import math
import threading
import time
from datetime import datetime, timezone
from typing import Optional, List, Tuple, Callable

from sqlalchemy import delete, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.config import config
from backend.models import FlightState, PositionHistory, get_retention_cutoff_timestamp
from backend.models.base import SessionLocal
from backend.models.flight_state import FlightPhase
from backend.ingestion.opensky_client import OpenSkyClient, StateVector

logger = logging.getLogger(__name__)


def haversine_distance(
    lat1: float, lon1: float,
    lat2: float, lon2: float
) -> float:
    """
    Calculate great-circle distance between two points in kilometers.

    Uses the Haversine formula for accuracy over short to medium distances.
    """
    R = 6371.0  # Earth radius in km

    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_lat / 2) ** 2 +
        math.cos(lat1_rad) * math.cos(lat2_rad) *
        math.sin(delta_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return R * c


def detect_flight_phase(
    on_ground: bool,
    vertical_rate: Optional[float],
    baro_altitude: Optional[float],
) -> FlightPhase:
    """
    Determine flight phase from telemetry.

    Logic:
    - on_ground=True → GROUND
    - altitude < 500m AND vertical_rate near zero → GROUND (taxiing)
    - vertical_rate > 2.5 m/s (~500 fpm) → CLIMB
    - vertical_rate < -2.5 m/s → DESCENT
    - otherwise → CRUISE

    Thresholds chosen to filter out noise in cruise conditions.
    """
    if on_ground:
        return FlightPhase.GROUND

    # Check for low altitude ground operations
    if baro_altitude is not None and baro_altitude < 500:
        if vertical_rate is None or abs(vertical_rate) < 1.0:
            return FlightPhase.GROUND

    if vertical_rate is None:
        return FlightPhase.UNKNOWN

    # ~500 fpm threshold for climb/descent detection
    if vertical_rate > 2.5:
        return FlightPhase.CLIMB
    elif vertical_rate < -2.5:
        return FlightPhase.DESCENT
    else:
        return FlightPhase.CRUISE


class IngestionPipeline:
    """
    Manages the data ingestion lifecycle.

    Coordinates fetching from OpenSky, enrichment, and database operations.
    Can run as a background thread for continuous polling.
    """

    def __init__(
        self,
        client: Optional[OpenSkyClient] = None,
        observer_location: Optional[Tuple[float, float]] = None,
        radius_km: Optional[float] = None,
    ):
        """
        Initialize the ingestion pipeline.

        Args:
            client: OpenSky API client (created from config if None)
            observer_location: (lat, lon) tuple for distance calculations
            radius_km: Query radius in kilometers
        """
        self.client = client or OpenSkyClient.from_config()
        self.observer_location = observer_location
        self.radius_km = radius_km or config.ingestion.default_radius_km

        # State tracking
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._last_fetch_time: float = 0
        self._fetch_count: int = 0
        self._error_count: int = 0

        # Callbacks for external integration
        self._on_update_callbacks: List[Callable[[int], None]] = []

    def set_observer_location(self, lat: float, lon: float) -> None:
        """Update the observer location for distance calculations."""
        self.observer_location = (lat, lon)
        logger.info(f'Observer location set to ({lat:.4f}, {lon:.4f})')

    def add_update_callback(self, callback: Callable[[int], None]) -> None:
        """
        Register callback to be invoked after each successful ingestion.

        Callback receives the count of aircraft updated.
        """
        self._on_update_callbacks.append(callback)

    def _enrich_state(self, sv: StateVector) -> dict:
        """
        Enrich a state vector with computed fields.

        Returns a dict ready for database insertion.
        """
        # Compute distance from observer
        distance_km = None
        if self.observer_location and sv.latitude and sv.longitude:
            distance_km = haversine_distance(
                self.observer_location[0], self.observer_location[1],
                sv.latitude, sv.longitude
            )

        # Detect flight phase
        phase = detect_flight_phase(
            sv.on_ground,
            sv.vertical_rate,
            sv.baro_altitude,
        )

        return {
            'icao24': sv.icao24,
            'callsign': sv.callsign,
            'origin_country': sv.origin_country,
            'latitude': sv.latitude,
            'longitude': sv.longitude,
            'baro_altitude': sv.baro_altitude,
            'geo_altitude': sv.geo_altitude,
            'velocity': sv.velocity,
            'true_track': sv.true_track,
            'vertical_rate': sv.vertical_rate,
            'on_ground': sv.on_ground,
            'squawk': sv.squawk,
            'spi': sv.spi,
            'position_source': sv.position_source,
            'time_position': sv.time_position,
            'last_contact': sv.last_contact,
            'flight_phase': phase.value,
            'distance_km': distance_km,
            'updated_at': datetime.now(timezone.utc),
        }

    def _batch_upsert_states(
        self,
        states: List[dict],
        session,
    ) -> int:
        """
        Batch upsert flight states using SQLite INSERT OR REPLACE.

        Returns count of rows affected.
        """
        if not states:
            return 0

        # SQLite upsert using INSERT ... ON CONFLICT
        for state in states:
            stmt = sqlite_insert(FlightState).values(**state)
            stmt = stmt.on_conflict_do_update(
                index_elements=['icao24'],
                set_={
                    'callsign': stmt.excluded.callsign,
                    'origin_country': stmt.excluded.origin_country,
                    'latitude': stmt.excluded.latitude,
                    'longitude': stmt.excluded.longitude,
                    'baro_altitude': stmt.excluded.baro_altitude,
                    'geo_altitude': stmt.excluded.geo_altitude,
                    'velocity': stmt.excluded.velocity,
                    'true_track': stmt.excluded.true_track,
                    'vertical_rate': stmt.excluded.vertical_rate,
                    'on_ground': stmt.excluded.on_ground,
                    'squawk': stmt.excluded.squawk,
                    'spi': stmt.excluded.spi,
                    'position_source': stmt.excluded.position_source,
                    'time_position': stmt.excluded.time_position,
                    'last_contact': stmt.excluded.last_contact,
                    'flight_phase': stmt.excluded.flight_phase,
                    'distance_km': stmt.excluded.distance_km,
                    'updated_at': stmt.excluded.updated_at,
                }
            )
            session.execute(stmt)

        return len(states)

    def _batch_insert_history(
        self,
        states: List[StateVector],
        api_time: int,
        session,
    ) -> int:
        """
        Batch insert position history records.

        This is the append-only time-series pattern - we never update
        historical records, only insert new ones.
        """
        if not states:
            return 0

        # Compute distance for each state
        records = []
        for sv in states:
            distance_km = None
            if self.observer_location and sv.latitude and sv.longitude:
                distance_km = haversine_distance(
                    self.observer_location[0], self.observer_location[1],
                    sv.latitude, sv.longitude
                )

            records.append({
                'icao24': sv.icao24,
                'callsign': sv.callsign,
                'timestamp': sv.time_position or api_time,
                'latitude': sv.latitude,
                'longitude': sv.longitude,
                'baro_altitude': sv.baro_altitude,
                'geo_altitude': sv.geo_altitude,
                'velocity': sv.velocity,
                'true_track': sv.true_track,
                'vertical_rate': sv.vertical_rate,
                'on_ground': sv.on_ground,
                'position_source': sv.position_source,
                'distance_km': distance_km,
            })

        # Bulk insert
        session.execute(
            PositionHistory.__table__.insert(),
            records
        )

        return len(records)

    def _cleanup_stale_data(self, session) -> Tuple[int, int]:
        """
        Remove stale data per retention policy.

        Returns (states_deleted, history_deleted).
        """
        now = datetime.now(timezone.utc)

        # Remove flight states not updated in stale_threshold_seconds
        stale_cutoff = now.timestamp() - config.ingestion.stale_threshold_seconds
        states_result = session.execute(
            delete(FlightState).where(
                FlightState.last_contact < stale_cutoff
            )
        )
        states_deleted = states_result.rowcount

        # Remove history older than retention period
        history_cutoff = get_retention_cutoff_timestamp(config.retention.hours)
        history_result = session.execute(
            delete(PositionHistory).where(
                PositionHistory.timestamp < history_cutoff
            )
        )
        history_deleted = history_result.rowcount

        if states_deleted or history_deleted:
            logger.info(
                f'Cleanup: removed {states_deleted} stale states, '
                f'{history_deleted} old history records'
            )

        return states_deleted, history_deleted

    def fetch_and_process(self) -> int:
        """
        Execute one ingestion cycle.

        Returns count of aircraft processed, or -1 on error.
        """
        if not self.observer_location:
            logger.warning('No observer location set, skipping fetch')
            return -1

        try:
            # Stage 1: Fetch from OpenSky
            api_time, states = self.client.get_states_by_location(
                self.observer_location[0],
                self.observer_location[1],
                self.radius_km,
            )

            if not states:
                logger.debug('No aircraft in range')
                return 0

            self._last_fetch_time = time.time()
            self._fetch_count += 1

            # Stage 2: Enrich and process in database transaction
            with SessionLocal() as session:
                # Enrich states with computed fields
                enriched = [self._enrich_state(sv) for sv in states]

                # Stage 3: Upsert current states
                self._batch_upsert_states(enriched, session)

                # Stage 4: Append to history
                self._batch_insert_history(states, api_time, session)

                # Stage 5: Cleanup (run periodically, not every cycle)
                if self._fetch_count % 30 == 0:  # Every ~5 minutes at 10s interval
                    self._cleanup_stale_data(session)

                session.commit()

            logger.info(f'Processed {len(states)} aircraft')

            # Notify callbacks
            for callback in self._on_update_callbacks:
                try:
                    callback(len(states))
                except Exception as e:
                    logger.error(f'Update callback error: {e}')

            return len(states)

        except Exception as e:
            self._error_count += 1
            logger.error(f'Ingestion error: {e}')
            return -1

    def run_continuous(self, interval: Optional[float] = None) -> None:
        """
        Run ingestion loop continuously.

        This method blocks - use start_background() for non-blocking.
        """
        interval = interval or config.ingestion.poll_interval
        self._running = True

        logger.info(f'Starting continuous ingestion (interval={interval}s)')

        while self._running:
            self.fetch_and_process()
            time.sleep(interval)

        logger.info('Ingestion stopped')

    def start_background(self, interval: Optional[float] = None) -> None:
        """Start ingestion in background thread."""
        if self._thread and self._thread.is_alive():
            logger.warning('Ingestion already running')
            return

        self._thread = threading.Thread(
            target=self.run_continuous,
            args=(interval,),
            daemon=True,
        )
        self._thread.start()
        logger.info('Background ingestion started')

    def stop(self) -> None:
        """Stop background ingestion."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
        logger.info('Ingestion stopped')

    @property
    def stats(self) -> dict:
        """Get ingestion statistics."""
        return {
            'fetch_count': self._fetch_count,
            'error_count': self._error_count,
            'last_fetch_time': self._last_fetch_time,
            'running': self._running,
        }
