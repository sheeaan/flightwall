"""
Time-series telemetry analysis using NumPy.

This module treats aircraft telemetry like financial tick data, applying
quantitative analysis techniques:

1. Rolling Windows: Moving averages and statistics (like price MAs)
2. Trend Detection: Linear regression on sliding windows (like trend lines)
3. Anomaly Detection: Z-score based outlier identification (like volatility spikes)
4. Rate of Change: First derivatives for acceleration analysis

Key design principles:
- All calculations use NumPy for vectorized performance
- Designed for streaming data (incremental updates)
- Memory-efficient sliding window approach
- Configurable window sizes and thresholds

Performance note:
For 50+ aircraft with 10-second polling over 24 hours, each aircraft
generates ~8,640 data points. NumPy handles this efficiently with
O(n) memory and O(1) amortized update cost for rolling calculations.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional, List, Dict, Tuple

import numpy as np
from sqlalchemy import select, desc

from backend.models import PositionHistory, FlightState
from backend.models.base import SessionLocal
from backend.config import config

logger = logging.getLogger(__name__)


class TrendDirection(str, Enum):
    """Trend direction classification."""
    INCREASING = 'increasing'
    STABLE = 'stable'
    DECREASING = 'decreasing'
    UNKNOWN = 'unknown'


@dataclass
class RollingStats:
    """
    Rolling window statistics for a single metric.

    Similar to technical indicators in finance:
    - mean: Simple Moving Average (SMA)
    - std: Rolling standard deviation (volatility)
    - min/max: Bollinger-band-like bounds
    """
    mean: float
    std: float
    min_val: float
    max_val: float
    count: int
    trend: TrendDirection = TrendDirection.UNKNOWN


@dataclass
class FlightAnalytics:
    """
    Complete analytics for a single flight.

    Contains rolling statistics, trends, and anomaly flags
    computed from historical telemetry data.
    """
    icao24: str
    callsign: Optional[str]
    computed_at: datetime

    # Sample counts
    total_samples: int
    window_samples: int

    # Rolling statistics for key metrics
    altitude: Optional[RollingStats] = None
    speed: Optional[RollingStats] = None
    vertical_rate: Optional[RollingStats] = None
    heading: Optional[RollingStats] = None

    # Trend analysis
    altitude_trend: TrendDirection = TrendDirection.UNKNOWN
    speed_trend: TrendDirection = TrendDirection.UNKNOWN

    # Anomaly flags
    is_altitude_anomaly: bool = False
    is_speed_anomaly: bool = False
    is_vertical_rate_anomaly: bool = False

    # Anomaly details
    anomaly_reasons: List[str] = field(default_factory=list)

    @property
    def has_anomaly(self) -> bool:
        """Check if any anomaly flag is set."""
        return (
            self.is_altitude_anomaly or
            self.is_speed_anomaly or
            self.is_vertical_rate_anomaly
        )


class TelemetryAnalyzer:
    """
    Analyzes aircraft telemetry time-series data.

    Uses NumPy for efficient vectorized calculations on historical
    position data. Designed for real-time streaming updates.

    Configuration:
    - window_seconds: Rolling window size (default 300 = 5 minutes)
    - min_samples: Minimum data points for valid statistics (default 5)
    - anomaly_z_threshold: Z-score threshold for anomaly detection (default 2.5)
    - trend_threshold: Slope threshold for trend classification
    """

    def __init__(
        self,
        window_seconds: int = 300,
        min_samples: int = 5,
        anomaly_z_threshold: float = 2.5,
        trend_threshold: float = 0.1,
    ):
        self.window_seconds = window_seconds
        self.min_samples = min_samples
        self.anomaly_z_threshold = anomaly_z_threshold
        self.trend_threshold = trend_threshold

        # Cache for repeated queries
        self._cache: Dict[str, Tuple[datetime, FlightAnalytics]] = {}
        self._cache_ttl_seconds = 10

    def analyze_flight(self, icao24: str) -> Optional[FlightAnalytics]:
        """
        Compute analytics for a single aircraft.

        Fetches recent history from database and computes rolling
        statistics, trends, and anomaly detection.
        """
        icao24 = icao24.lower()

        # Check cache
        if icao24 in self._cache:
            cached_time, cached_result = self._cache[icao24]
            age = (datetime.now(timezone.utc) - cached_time).total_seconds()
            if age < self._cache_ttl_seconds:
                return cached_result

        # Fetch historical data
        history = self._fetch_history(icao24)
        if not history or len(history) < self.min_samples:
            logger.debug(f'Insufficient history for {icao24}: {len(history) if history else 0} samples')
            return None

        # Convert to NumPy arrays
        timestamps = np.array([h.timestamp for h in history], dtype=np.float64)
        altitudes = np.array([h.baro_altitude for h in history], dtype=np.float64)
        speeds = np.array([h.velocity for h in history], dtype=np.float64)
        vertical_rates = np.array([h.vertical_rate for h in history], dtype=np.float64)
        headings = np.array([h.true_track for h in history], dtype=np.float64)

        # Get window of recent data
        now = datetime.now(timezone.utc).timestamp()
        window_mask = timestamps >= (now - self.window_seconds)

        # Compute analytics
        callsign = history[-1].callsign if history else None

        analytics = FlightAnalytics(
            icao24=icao24,
            callsign=callsign,
            computed_at=datetime.now(timezone.utc),
            total_samples=len(history),
            window_samples=int(window_mask.sum()),
        )

        # Compute rolling stats for each metric
        analytics.altitude = self._compute_rolling_stats(
            altitudes, window_mask, 'altitude'
        )
        analytics.speed = self._compute_rolling_stats(
            speeds, window_mask, 'speed'
        )
        analytics.vertical_rate = self._compute_rolling_stats(
            vertical_rates, window_mask, 'vertical_rate'
        )
        analytics.heading = self._compute_rolling_stats(
            headings, window_mask, 'heading'
        )

        # Compute trends
        analytics.altitude_trend = self._compute_trend(
            timestamps[window_mask],
            altitudes[window_mask],
        )
        analytics.speed_trend = self._compute_trend(
            timestamps[window_mask],
            speeds[window_mask],
        )

        # Detect anomalies
        self._detect_anomalies(
            analytics,
            altitudes, speeds, vertical_rates,
            window_mask,
        )

        # Update cache
        self._cache[icao24] = (datetime.now(timezone.utc), analytics)

        return analytics

    def _fetch_history(self, icao24: str) -> List[PositionHistory]:
        """
        Fetch position history for an aircraft.

        Returns records from the retention window, ordered by timestamp.
        """
        cutoff = int(datetime.now(timezone.utc).timestamp()) - config.retention.hours * 3600

        with SessionLocal() as session:
            stmt = (
                select(PositionHistory)
                .where(PositionHistory.icao24 == icao24)
                .where(PositionHistory.timestamp >= cutoff)
                .order_by(PositionHistory.timestamp.asc())
            )
            result = session.execute(stmt).scalars().all()
            return list(result)

    def _compute_rolling_stats(
        self,
        values: np.ndarray,
        window_mask: np.ndarray,
        metric_name: str,
    ) -> Optional[RollingStats]:
        """
        Compute rolling statistics for a metric within the window.

        Handles NaN values and insufficient data gracefully.
        """
        # Apply window mask
        windowed = values[window_mask]

        # Filter out NaN/None values
        valid = windowed[~np.isnan(windowed)]

        if len(valid) < self.min_samples:
            return None

        return RollingStats(
            mean=float(np.mean(valid)),
            std=float(np.std(valid)),
            min_val=float(np.min(valid)),
            max_val=float(np.max(valid)),
            count=len(valid),
        )

    def _compute_trend(
        self,
        timestamps: np.ndarray,
        values: np.ndarray,
    ) -> TrendDirection:
        """
        Determine trend direction using linear regression.

        Similar to trend line analysis in technical analysis.
        Returns trend based on slope of best-fit line.
        """
        # Filter out NaN values
        valid_mask = ~np.isnan(values)
        t = timestamps[valid_mask]
        v = values[valid_mask]

        if len(t) < self.min_samples:
            return TrendDirection.UNKNOWN

        # Normalize timestamps to avoid numerical issues
        t_normalized = t - t[0]

        # Linear regression: v = slope * t + intercept
        # Using numpy polyfit for efficiency
        try:
            slope, _ = np.polyfit(t_normalized, v, 1)
        except np.linalg.LinAlgError:
            return TrendDirection.UNKNOWN

        # Normalize slope by value range for comparison
        value_range = np.ptp(v)  # peak-to-peak
        if value_range > 0:
            normalized_slope = slope / value_range
        else:
            normalized_slope = 0

        # Classify trend
        if normalized_slope > self.trend_threshold:
            return TrendDirection.INCREASING
        elif normalized_slope < -self.trend_threshold:
            return TrendDirection.DECREASING
        else:
            return TrendDirection.STABLE

    def _detect_anomalies(
        self,
        analytics: FlightAnalytics,
        altitudes: np.ndarray,
        speeds: np.ndarray,
        vertical_rates: np.ndarray,
        window_mask: np.ndarray,
    ) -> None:
        """
        Detect anomalies using Z-score method.

        Flags data points that deviate significantly from historical mean.
        Similar to detecting price spikes in financial data.
        """
        # Get most recent values
        latest_alt = altitudes[-1] if len(altitudes) > 0 else np.nan
        latest_speed = speeds[-1] if len(speeds) > 0 else np.nan
        latest_vrate = vertical_rates[-1] if len(vertical_rates) > 0 else np.nan

        # Altitude anomaly check
        if analytics.altitude and not np.isnan(latest_alt):
            if analytics.altitude.std > 0:
                z_score = abs(latest_alt - analytics.altitude.mean) / analytics.altitude.std
                if z_score > self.anomaly_z_threshold:
                    analytics.is_altitude_anomaly = True
                    analytics.anomaly_reasons.append(
                        f'Altitude deviation: {latest_alt:.0f}m (z={z_score:.1f})'
                    )

        # Speed anomaly check
        if analytics.speed and not np.isnan(latest_speed):
            if analytics.speed.std > 0:
                z_score = abs(latest_speed - analytics.speed.mean) / analytics.speed.std
                if z_score > self.anomaly_z_threshold:
                    analytics.is_speed_anomaly = True
                    analytics.anomaly_reasons.append(
                        f'Speed deviation: {latest_speed:.0f}m/s (z={z_score:.1f})'
                    )

        # Vertical rate anomaly (sudden changes)
        if analytics.vertical_rate and not np.isnan(latest_vrate):
            # For vertical rate, we care about sudden large values
            vrate_threshold = 15.0  # ~3000 fpm - unusual outside of takeoff/landing
            if abs(latest_vrate) > vrate_threshold:
                # Check if this is unexpected based on history
                if analytics.vertical_rate.std > 0:
                    z_score = abs(latest_vrate - analytics.vertical_rate.mean) / analytics.vertical_rate.std
                    if z_score > self.anomaly_z_threshold:
                        analytics.is_vertical_rate_anomaly = True
                        analytics.anomaly_reasons.append(
                            f'Vertical rate spike: {latest_vrate:.1f}m/s (z={z_score:.1f})'
                        )

    def analyze_all_active(self) -> Dict[str, FlightAnalytics]:
        """
        Analyze all currently active flights.

        Returns dict mapping icao24 -> FlightAnalytics.
        """
        with SessionLocal() as session:
            # Get all active flight icao24s
            stmt = select(FlightState.icao24).where(FlightState.on_ground == False)
            icao24s = session.execute(stmt).scalars().all()

        results = {}
        for icao24 in icao24s:
            analytics = self.analyze_flight(icao24)
            if analytics:
                results[icao24] = analytics

        logger.info(f'Analyzed {len(results)} active flights')
        return results

    def update_flight_states_with_analytics(self) -> int:
        """
        Update FlightState table with analytics results.

        Computes analytics for all active flights and updates
        the trend and anomaly fields in the database.

        Returns count of updated records.
        """
        analytics_map = self.analyze_all_active()

        if not analytics_map:
            return 0

        updated = 0
        with SessionLocal() as session:
            for icao24, analytics in analytics_map.items():
                # Map trend enum to string for storage
                speed_trend = analytics.speed_trend.value if analytics.speed_trend else None
                altitude_trend = analytics.altitude_trend.value if analytics.altitude_trend else None

                session.query(FlightState).filter(
                    FlightState.icao24 == icao24
                ).update({
                    'speed_trend': speed_trend,
                    'altitude_trend': altitude_trend,
                    'is_anomaly': analytics.has_anomaly,
                })
                updated += 1

            session.commit()

        logger.info(f'Updated {updated} flight states with analytics')
        return updated

    def get_fleet_statistics(self) -> dict:
        """
        Compute aggregate statistics across all tracked aircraft.

        Returns summary metrics for the entire observable fleet.
        """
        with SessionLocal() as session:
            # Get all active flight data
            stmt = select(FlightState).where(FlightState.on_ground == False)
            flights = session.execute(stmt).scalars().all()

        if not flights:
            return {
                'count': 0,
                'altitude': None,
                'speed': None,
                'by_phase': {},
            }

        # Extract metrics
        altitudes = [f.baro_altitude for f in flights if f.baro_altitude is not None]
        speeds = [f.velocity for f in flights if f.velocity is not None]

        # Count by flight phase
        phase_counts = {}
        for f in flights:
            phase = f.flight_phase or 'unknown'
            phase_counts[phase] = phase_counts.get(phase, 0) + 1

        # Count anomalies
        anomaly_count = sum(1 for f in flights if f.is_anomaly)

        return {
            'count': len(flights),
            'altitude': {
                'mean': float(np.mean(altitudes)) if altitudes else None,
                'min': float(np.min(altitudes)) if altitudes else None,
                'max': float(np.max(altitudes)) if altitudes else None,
                'std': float(np.std(altitudes)) if altitudes else None,
            },
            'speed': {
                'mean': float(np.mean(speeds)) if speeds else None,
                'min': float(np.min(speeds)) if speeds else None,
                'max': float(np.max(speeds)) if speeds else None,
                'std': float(np.std(speeds)) if speeds else None,
            },
            'by_phase': phase_counts,
            'anomaly_count': anomaly_count,
        }
