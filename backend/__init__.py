"""
FlightWall Backend Package.

Real-time flight telemetry platform built with Flask, SQLAlchemy, and NumPy.

Modules:
    api/         REST endpoints for flight data, metrics, and system status
    models/      SQLAlchemy ORM models (FlightState, PositionHistory, Aircraft)
    ingestion/   OpenSky Network data pipeline with background polling
    analytics/   NumPy-based time-series analysis and anomaly detection
    services/    External API integrations (AviationStack route lookups)
    cache.py     Thread-safe in-memory cache for sub-millisecond API responses
    config.py    Centralized configuration from environment variables
"""

__version__ = '1.0.0'
