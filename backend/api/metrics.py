"""
Metrics and analytics API endpoints.

Provides endpoints for:
- GET /api/metrics/fleet - Fleet-wide statistics
- GET /api/metrics/status - System status and health
- GET /api/metrics/location - Get/set observer location
"""

import logging
import time
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request, current_app

from backend.cache import flight_cache
from backend.analytics import TelemetryAnalyzer
from backend.config import config

logger = logging.getLogger(__name__)

metrics_bp = Blueprint('metrics', __name__, url_prefix='/api/metrics')


@metrics_bp.route('/fleet', methods=['GET'])
def get_fleet_metrics():
    """
    Get aggregate statistics for all tracked aircraft.

    Returns:
    - Aircraft count by flight phase
    - Altitude distribution statistics
    - Speed distribution statistics
    - Anomaly counts
    """
    start_time = time.perf_counter()

    analyzer = TelemetryAnalyzer()
    stats = analyzer.get_fleet_statistics()

    # Add cache stats
    cache_stats = flight_cache.stats

    query_time_ms = (time.perf_counter() - start_time) * 1000

    return jsonify({
        'fleet': stats,
        'cache': cache_stats,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'query_time_ms': round(query_time_ms, 2),
    })


@metrics_bp.route('/status', methods=['GET'])
def get_system_status():
    """
    Get system health and status information.

    Returns:
    - Ingestion pipeline status
    - Database connectivity
    - Cache statistics
    - Configuration info
    """
    start_time = time.perf_counter()

    # Get pipeline stats if available
    pipeline = current_app.config.get('INGESTION_PIPELINE')
    pipeline_stats = pipeline.stats if pipeline else {'running': False}

    # Check database connectivity
    db_ok = True
    try:
        from sqlalchemy import text
        from backend.models.base import SessionLocal
        with SessionLocal() as session:
            session.execute(text('SELECT 1'))
    except Exception as e:
        db_ok = False
        logger.error(f'Database health check failed: {e}')

    # Get observer location
    observer = current_app.config.get('OBSERVER_LOCATION')

    query_time_ms = (time.perf_counter() - start_time) * 1000

    return jsonify({
        'status': 'healthy' if (db_ok and pipeline_stats.get('running')) else 'degraded',
        'database': {
            'connected': db_ok,
            'type': 'sqlite' if config.database.is_sqlite else 'postgresql',
        },
        'ingestion': pipeline_stats,
        'cache': flight_cache.stats,
        'observer': {
            'location': observer,
            'radius_km': config.ingestion.default_radius_km,
        },
        'config': {
            'poll_interval': config.ingestion.poll_interval,
            'retention_hours': config.retention.hours,
            'opensky_authenticated': config.opensky.is_authenticated,
        },
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'query_time_ms': round(query_time_ms, 2),
    })


@metrics_bp.route('/location', methods=['GET', 'POST'])
def observer_location():
    """
    Get or set the observer location.

    GET: Returns current observer location
    POST: Set new observer location
        Body: {"latitude": float, "longitude": float}

    The observer location is used to:
    - Filter flights by radius
    - Calculate distance to each aircraft
    """
    if request.method == 'GET':
        location = current_app.config.get('OBSERVER_LOCATION')
        return jsonify({
            'location': {
                'latitude': location[0] if location else None,
                'longitude': location[1] if location else None,
            },
            'radius_km': config.ingestion.default_radius_km,
            'source': 'configured' if location else 'none',
        })

    # POST - set new location
    data = request.get_json()
    if not data:
        return jsonify({'error': 'JSON body required'}), 400

    lat = data.get('latitude')
    lon = data.get('longitude')

    if lat is None or lon is None:
        return jsonify({'error': 'latitude and longitude required'}), 400

    try:
        lat = float(lat)
        lon = float(lon)
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid latitude or longitude'}), 400

    # Validate ranges
    if not (-90 <= lat <= 90):
        return jsonify({'error': 'Latitude must be between -90 and 90'}), 400
    if not (-180 <= lon <= 180):
        return jsonify({'error': 'Longitude must be between -180 and 180'}), 400

    # Update app config and pipeline
    current_app.config['OBSERVER_LOCATION'] = (lat, lon)

    pipeline = current_app.config.get('INGESTION_PIPELINE')
    if pipeline:
        pipeline.set_observer_location(lat, lon)
        logger.info(f'Observer location updated to ({lat}, {lon})')

    return jsonify({
        'success': True,
        'location': {
            'latitude': lat,
            'longitude': lon,
        },
        'message': 'Observer location updated',
    })


@metrics_bp.route('/location/auto', methods=['POST'])
def auto_detect_location():
    """
    Auto-detect observer location using IP geolocation.

    Uses the geocoder library to determine approximate location
    based on the client's IP address.
    """
    try:
        import geocoder
        g = geocoder.ip('me')

        if not g.ok or not g.latlng:
            return jsonify({
                'success': False,
                'error': 'Could not determine location from IP',
            }), 500

        lat, lon = g.latlng

        # Update app config and pipeline
        current_app.config['OBSERVER_LOCATION'] = (lat, lon)

        pipeline = current_app.config.get('INGESTION_PIPELINE')
        if pipeline:
            pipeline.set_observer_location(lat, lon)

        logger.info(f'Auto-detected location: ({lat}, {lon}) in {g.city}, {g.country}')

        return jsonify({
            'success': True,
            'location': {
                'latitude': lat,
                'longitude': lon,
            },
            'details': {
                'city': g.city,
                'region': g.state,
                'country': g.country,
            },
            'message': 'Location auto-detected from IP',
        })

    except ImportError:
        return jsonify({
            'success': False,
            'error': 'geocoder library not available',
        }), 500
    except Exception as e:
        logger.error(f'Location auto-detect failed: {e}')
        return jsonify({
            'success': False,
            'error': str(e),
        }), 500
