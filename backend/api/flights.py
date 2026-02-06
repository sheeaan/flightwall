"""
Flight data API endpoints.

Provides endpoints for:
- GET /api/flights - List all tracked flights
- GET /api/flights/<icao24> - Get single flight details
- GET /api/flights/ticker - Get next flight for ticker display
- GET /api/flights/history/<icao24> - Get position history for a flight
"""

import logging
import time
from datetime import datetime, timezone
from typing import Optional

from flask import Blueprint, jsonify, request

from backend.cache import flight_cache
from backend.models import FlightState, PositionHistory
from backend.models.base import SessionLocal
from backend.analytics import TelemetryAnalyzer
from backend.services.flight_info import flight_info_service

logger = logging.getLogger(__name__)

flights_bp = Blueprint('flights', __name__, url_prefix='/api/flights')

# Aircraft type code to full name mapping
AIRCRAFT_TYPES = {
    'A20N': 'Airbus A320neo',
    'A21N': 'Airbus A321neo',
    'A319': 'Airbus A319',
    'A320': 'Airbus A320',
    'A321': 'Airbus A321',
    'A332': 'Airbus A330-200',
    'A333': 'Airbus A330-300',
    'A338': 'Airbus A330-800neo',
    'A339': 'Airbus A330-900neo',
    'A343': 'Airbus A340-300',
    'A359': 'Airbus A350-900',
    'A35K': 'Airbus A350-1000',
    'A388': 'Airbus A380-800',
    'B712': 'Boeing 717-200',
    'B732': 'Boeing 737-200',
    'B733': 'Boeing 737-300',
    'B734': 'Boeing 737-400',
    'B735': 'Boeing 737-500',
    'B736': 'Boeing 737-600',
    'B737': 'Boeing 737-700',
    'B738': 'Boeing 737-800',
    'B739': 'Boeing 737-900',
    'B37M': 'Boeing 737 MAX 7',
    'B38M': 'Boeing 737 MAX 8',
    'B39M': 'Boeing 737 MAX 9',
    'B3XM': 'Boeing 737 MAX 10',
    'B744': 'Boeing 747-400',
    'B748': 'Boeing 747-8',
    'B752': 'Boeing 757-200',
    'B753': 'Boeing 757-300',
    'B762': 'Boeing 767-200',
    'B763': 'Boeing 767-300',
    'B764': 'Boeing 767-400',
    'B772': 'Boeing 777-200',
    'B773': 'Boeing 777-300',
    'B77L': 'Boeing 777-200LR',
    'B77W': 'Boeing 777-300ER',
    'B778': 'Boeing 777-8',
    'B779': 'Boeing 777-9',
    'B788': 'Boeing 787-8',
    'B789': 'Boeing 787-9',
    'B78X': 'Boeing 787-10',
    'CRJ2': 'Bombardier CRJ-200',
    'CRJ7': 'Bombardier CRJ-700',
    'CRJ9': 'Bombardier CRJ-900',
    'CRJX': 'Bombardier CRJ-1000',
    'E170': 'Embraer E170',
    'E175': 'Embraer E175',
    'E190': 'Embraer E190',
    'E195': 'Embraer E195',
    'E290': 'Embraer E190-E2',
    'E295': 'Embraer E195-E2',
    'E75L': 'Embraer E175 Long',
    'E75S': 'Embraer E175 Short',
    'DH8A': 'Dash 8-100',
    'DH8B': 'Dash 8-200',
    'DH8C': 'Dash 8-300',
    'DH8D': 'Dash 8-400',
    'AT43': 'ATR 42-300',
    'AT45': 'ATR 42-500',
    'AT46': 'ATR 42-600',
    'AT72': 'ATR 72-200',
    'AT75': 'ATR 72-500',
    'AT76': 'ATR 72-600',
    'MD80': 'McDonnell Douglas MD-80',
    'MD82': 'McDonnell Douglas MD-82',
    'MD83': 'McDonnell Douglas MD-83',
    'MD88': 'McDonnell Douglas MD-88',
    'MD90': 'McDonnell Douglas MD-90',
    'DC10': 'McDonnell Douglas DC-10',
    'MD11': 'McDonnell Douglas MD-11',
    'C208': 'Cessna Caravan',
    'C510': 'Cessna Citation Mustang',
    'C525': 'Cessna CitationJet',
    'C560': 'Cessna Citation V',
    'C680': 'Cessna Citation Sovereign',
    'C750': 'Cessna Citation X',
    'PC12': 'Pilatus PC-12',
    'PC24': 'Pilatus PC-24',
    'GLF4': 'Gulfstream G-IV',
    'GLF5': 'Gulfstream G-V',
    'GL5T': 'Gulfstream G500',
    'GL7T': 'Gulfstream G700',
    'GLEX': 'Bombardier Global Express',
    'CL30': 'Bombardier Challenger 300',
    'CL35': 'Bombardier Challenger 350',
    'LJ35': 'Learjet 35',
    'LJ45': 'Learjet 45',
    'LJ60': 'Learjet 60',
}


def get_aircraft_full_name(code: str) -> Optional[str]:
    """Get full aircraft name from IATA/ICAO code."""
    if not code:
        return None
    code = code.upper()
    return AIRCRAFT_TYPES.get(code)

# Ticker rotation state (tracks which flight to show next)
_ticker_state = {
    'index': 0,
    'last_rotation': 0,
    'rotation_interval': 8,  # seconds per flight
}


@flights_bp.route('', methods=['GET'])
def list_flights():
    """
    List all currently tracked flights.

    Query parameters:
    - airborne_only: boolean, filter to airborne flights (default true)
    - limit: int, max results to return (default 100)
    - sort: string, sort field (distance|altitude|speed, default distance)
    - include_routes: boolean, include cached route info (default true)

    Response includes query timing for latency awareness.
    Routes are included only if already cached (no API calls made here).
    """
    start_time = time.perf_counter()

    # Parse query parameters
    airborne_only = request.args.get('airborne_only', 'true').lower() == 'true'
    limit = min(int(request.args.get('limit', 100)), 500)
    sort_by = request.args.get('sort', 'distance')
    include_routes = request.args.get('include_routes', 'true').lower() == 'true'

    # Get flights from cache
    if airborne_only:
        flights = flight_cache.get_airborne()
    else:
        flights = flight_cache.get_all()

    # Sort
    if sort_by == 'altitude':
        flights.sort(key=lambda x: x.altitude_ft or 0, reverse=True)
    elif sort_by == 'speed':
        flights.sort(key=lambda x: x.speed_kts or 0, reverse=True)
    # Default: sorted by distance (already from cache)

    # Apply limit
    flights = flights[:limit]

    # Convert to dicts and optionally include cached routes
    flight_dicts = []
    for f in flights:
        flight_dict = f.to_dict()

        # Add cached route info if available (no API calls)
        if include_routes:
            route_info = flight_info_service.get_cached_route(f.callsign)
            if route_info:
                flight_dict['route'] = {
                    'origin': route_info.origin_iata,
                    'destination': route_info.destination_iata,
                }

        flight_dicts.append(flight_dict)

    query_time_ms = (time.perf_counter() - start_time) * 1000

    return jsonify({
        'flights': flight_dicts,
        'count': len(flight_dicts),
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'query_time_ms': round(query_time_ms, 2),
    })


@flights_bp.route('/<icao24>', methods=['GET'])
def get_flight(icao24: str):
    """
    Get detailed information for a single flight.

    Includes analytics if available.
    Includes route information (origin/destination) if available.
    """
    start_time = time.perf_counter()
    icao24 = icao24.lower()

    # Try cache first
    cached = flight_cache.get(icao24)

    if cached:
        result = cached.to_dict()

        # Add analytics if requested
        if request.args.get('include_analytics', 'false').lower() == 'true':
            analyzer = TelemetryAnalyzer()
            analytics = analyzer.analyze_flight(icao24)
            if analytics:
                result['analytics_detail'] = {
                    'total_samples': analytics.total_samples,
                    'window_samples': analytics.window_samples,
                    'altitude': _stats_to_dict(analytics.altitude),
                    'speed': _stats_to_dict(analytics.speed),
                    'vertical_rate': _stats_to_dict(analytics.vertical_rate),
                    'anomaly_reasons': analytics.anomaly_reasons,
                }

        # Add route information (origin/destination airports)
        route_info = flight_info_service.get_route_info(cached.callsign)
        if route_info:
            result['route'] = {
                'origin': route_info.origin_iata,
                'origin_icao': route_info.origin_icao,
                'origin_name': route_info.origin_name,
                'destination': route_info.destination_iata,
                'destination_icao': route_info.destination_icao,
                'destination_name': route_info.destination_name,
                'scheduled_arrival': route_info.scheduled_arrival.isoformat() if route_info.scheduled_arrival else None,
                'status': route_info.status,
            }
            # Use airline name from route if available
            if route_info.airline_name:
                result['airline_name'] = route_info.airline_name
                result['airline_icao'] = route_info.airline_icao

        query_time_ms = (time.perf_counter() - start_time) * 1000
        result['query_time_ms'] = round(query_time_ms, 2)

        return jsonify(result)

    # Fallback to database
    with SessionLocal() as session:
        flight = session.query(FlightState).filter(
            FlightState.icao24 == icao24
        ).first()

        if flight:
            result = {
                'icao24': flight.icao24,
                'callsign': flight.display_callsign,
                'position': {
                    'latitude': flight.latitude,
                    'longitude': flight.longitude,
                },
                'telemetry': {
                    'altitude_ft': flight.altitude_ft,
                    'speed_kts': flight.speed_kts,
                    'heading': flight.heading_display,
                    'vertical_rate_fpm': flight.vertical_rate_fpm,
                },
            }

            # Add route information (origin/destination airports)
            route_info = flight_info_service.get_route_info(flight.callsign)
            if route_info:
                result['route'] = {
                    'origin': route_info.origin_iata,
                    'origin_icao': route_info.origin_icao,
                    'origin_name': route_info.origin_name,
                    'destination': route_info.destination_iata,
                    'destination_icao': route_info.destination_icao,
                    'destination_name': route_info.destination_name,
                    'scheduled_arrival': route_info.scheduled_arrival.isoformat() if route_info.scheduled_arrival else None,
                    'status': route_info.status,
                }
                if route_info.airline_name:
                    result['airline_name'] = route_info.airline_name
                    result['airline_icao'] = route_info.airline_icao

            query_time_ms = (time.perf_counter() - start_time) * 1000
            result['query_time_ms'] = round(query_time_ms, 2)
            return jsonify(result)

    return jsonify({'error': 'Flight not found'}), 404


@flights_bp.route('/ticker', methods=['GET'])
def get_ticker_flight():
    """
    Get the next flight to display in ticker mode.

    Implements automatic rotation through airborne flights.
    Returns one flight at a time, cycling through all tracked flights.

    Query parameters:
    - rotation_interval: seconds between rotations (default 8)
    - max_distance: maximum distance in km to include (default 150)
    """
    start_time = time.perf_counter()

    rotation_interval = int(request.args.get('rotation_interval', 8))
    max_distance = float(request.args.get('max_distance', 150))
    _ticker_state['rotation_interval'] = rotation_interval

    # Get airborne flights within max distance
    all_flights = flight_cache.get_airborne()
    flights = [f for f in all_flights if f.distance_km is not None and f.distance_km <= max_distance]

    if not flights:
        return jsonify({
            'flight': None,
            'message': 'No aircraft in range',
            'total_count': 0,
        })

    # Check if we should rotate
    now = time.time()
    if now - _ticker_state['last_rotation'] >= rotation_interval:
        _ticker_state['index'] = (_ticker_state['index'] + 1) % len(flights)
        _ticker_state['last_rotation'] = now

    # Handle case where index is out of bounds (flights changed)
    if _ticker_state['index'] >= len(flights):
        _ticker_state['index'] = 0

    current_flight = flights[_ticker_state['index']]

    # Build response
    flight_data = current_flight.to_ticker_dict()

    # Enrich with route information if available
    route_info = flight_info_service.get_route_info(current_flight.callsign)
    if route_info:
        flight_data['route'] = {
            'origin': route_info.origin_iata,
            'origin_icao': route_info.origin_icao,
            'origin_name': route_info.origin_name,
            'destination': route_info.destination_iata,
            'destination_icao': route_info.destination_icao,
            'destination_name': route_info.destination_name,
            'scheduled_arrival': route_info.scheduled_arrival.isoformat() if route_info.scheduled_arrival else None,
            'status': route_info.status,
        }
        # Use airline name from route if available
        if route_info.airline_name:
            flight_data['airline_name'] = route_info.airline_name
            flight_data['airline_icao'] = route_info.airline_icao

        # Use aircraft type from AviationStack if OpenSky has unknown/missing type
        if route_info.aircraft_iata:
            aircraft_code = route_info.aircraft_iata
            flight_data['type'] = aircraft_code
            flight_data['type_description'] = get_aircraft_full_name(aircraft_code) or aircraft_code

    # Calculate estimated arrival if we have destination and telemetry
    if route_info and route_info.destination_iata and current_flight.speed_kts:
        eta = flight_info_service.get_estimated_arrival(
            route_info.destination_iata,
            current_flight.distance_km or 100,
            current_flight.speed_kts,
            route_info.scheduled_arrival,
        )
        if eta:
            flight_data['eta'] = eta.isoformat()
            # Also calculate minutes until arrival
            minutes_remaining = (eta - datetime.now(timezone.utc)).total_seconds() / 60
            flight_data['eta_minutes'] = max(0, int(minutes_remaining))

    query_time_ms = (time.perf_counter() - start_time) * 1000

    return jsonify({
        'flight': flight_data,
        'current_index': _ticker_state['index'],
        'total_count': len(flights),
        'next_rotation_in': max(0, rotation_interval - (now - _ticker_state['last_rotation'])),
        'query_time_ms': round(query_time_ms, 2),
    })


@flights_bp.route('/history/<icao24>', methods=['GET'])
def get_flight_history(icao24: str):
    """
    Get position history for a flight.

    Query parameters:
    - minutes: how many minutes of history (default 30, max 1440)
    - limit: max records to return (default 500)

    Returns time-series data suitable for charting.
    """
    start_time = time.perf_counter()
    icao24 = icao24.lower()

    minutes = min(int(request.args.get('minutes', 30)), 1440)
    limit = min(int(request.args.get('limit', 500)), 5000)

    cutoff = int(datetime.now(timezone.utc).timestamp()) - (minutes * 60)

    with SessionLocal() as session:
        history = session.query(PositionHistory).filter(
            PositionHistory.icao24 == icao24,
            PositionHistory.timestamp >= cutoff
        ).order_by(
            PositionHistory.timestamp.asc()
        ).limit(limit).all()

        # Convert to time-series format
        # IMPORTANT: All arrays must have the same length for frontend alignment
        data = {
            'timestamps': [],
            'altitudes': [],
            'speeds': [],
            'vertical_rates': [],
            'positions': [],
        }

        for h in history:
            data['timestamps'].append(h.timestamp)
            data['altitudes'].append(h.altitude_ft)
            data['speeds'].append(h.speed_kts)
            data['vertical_rates'].append(h.vertical_rate_fpm)
            # Always append position (even if null) to maintain array alignment
            if h.latitude is not None and h.longitude is not None:
                data['positions'].append([h.latitude, h.longitude])
            else:
                data['positions'].append(None)

    query_time_ms = (time.perf_counter() - start_time) * 1000

    return jsonify({
        'icao24': icao24,
        'history': data,
        'count': len(data['timestamps']),
        'minutes': minutes,
        'query_time_ms': round(query_time_ms, 2),
    })


def _stats_to_dict(stats) -> Optional[dict]:
    """Convert RollingStats to dict, or None if stats is None."""
    if stats is None:
        return None
    return {
        'mean': round(stats.mean, 2),
        'std': round(stats.std, 2),
        'min': round(stats.min_val, 2),
        'max': round(stats.max_val, 2),
        'count': stats.count,
    }
