"""
Analytics module for FlightWall.

Provides time-series analysis of aircraft telemetry data using NumPy.
Designed with patterns from quantitative finance:
- Rolling window calculations
- Trend detection
- Anomaly identification
- Statistical summaries
"""

from backend.analytics.telemetry_analysis import (
    TelemetryAnalyzer,
    FlightAnalytics,
    TrendDirection,
)

__all__ = [
    'TelemetryAnalyzer',
    'FlightAnalytics',
    'TrendDirection',
]
