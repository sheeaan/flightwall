"""
Flight information service - enriches flights with route data.

Integrates with external APIs to get:
- Origin/destination airports
- Flight schedules
- Estimated arrival times

Uses caching to minimize API calls and respect rate limits.
"""

import logging
import os
import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Tuple
import threading

import requests

from backend.config import config

logger = logging.getLogger(__name__)


@dataclass
class FlightRouteInfo:
    """Route information for a flight."""
    flight_number: str
    airline_name: Optional[str] = None
    airline_iata: Optional[str] = None
    airline_icao: Optional[str] = None
    origin_iata: Optional[str] = None
    origin_icao: Optional[str] = None
    origin_name: Optional[str] = None
    destination_iata: Optional[str] = None
    destination_icao: Optional[str] = None
    destination_name: Optional[str] = None
    scheduled_departure: Optional[datetime] = None
    scheduled_arrival: Optional[datetime] = None
    status: Optional[str] = None  # scheduled, active, landed, etc.
    aircraft_iata: Optional[str] = None  # e.g., "A21N"
    aircraft_icao: Optional[str] = None  # e.g., "A21N"
    aircraft_registration: Optional[str] = None  # e.g., "N74532"


class FlightInfoService:
    """
    Service to fetch flight route information from external APIs.

    Currently supports:
    - AviationStack (free tier: 100 requests/month)

    Implements aggressive caching to stay within rate limits.
    """

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or config.aviationstack.api_key
        self.base_url = 'http://api.aviationstack.com/v1'

        # Cache: callsign -> (FlightRouteInfo, timestamp)
        self._cache: Dict[str, Tuple[Optional[FlightRouteInfo], float]] = {}
        self._cache_ttl = 3600  # 1 hour cache
        self._lock = threading.RLock()

        # Rate limiting
        self._last_request_time = 0
        self._min_request_interval = 2.0  # seconds between requests

        # Track API usage
        self._requests_today = 0
        self._max_requests_per_day = 90  # Leave buffer from 100 limit

        # Demo mode - use mock data when API is unavailable
        self.demo_mode = os.getenv('ROUTE_DEMO_MODE', 'false').lower() == 'true'

        if not self.api_key:
            logger.warning('AviationStack API key not configured - route lookups disabled')

        if self.demo_mode:
            logger.info('Route service running in DEMO MODE with mock data')

    def get_cached_route(self, callsign: str) -> Optional[FlightRouteInfo]:
        """
        Get route info ONLY from cache (no API call).

        Useful for populating lists without burning API quota.
        Returns None if not in cache.
        """
        if not callsign:
            return None
        callsign = callsign.strip().upper()
        return self._get_cached(callsign)

    def _generate_mock_route(self, callsign: str) -> Optional[FlightRouteInfo]:
        """Generate realistic mock route data for demo purposes."""
        # Common North American airports for realistic demo
        airports = [
            ('JFK', 'KJFK', 'John F Kennedy Intl'),
            ('LAX', 'KLAX', 'Los Angeles Intl'),
            ('ORD', 'KORD', "Chicago O'Hare Intl"),
            ('DFW', 'KDFW', 'Dallas Fort Worth Intl'),
            ('DEN', 'KDEN', 'Denver Intl'),
            ('ATL', 'KATL', 'Hartsfield-Jackson Atlanta Intl'),
            ('SFO', 'KSFO', 'San Francisco Intl'),
            ('SEA', 'KSEA', 'Seattle-Tacoma Intl'),
            ('BOS', 'KBOS', 'Boston Logan Intl'),
            ('MIA', 'KMIA', 'Miami Intl'),
            ('YYZ', 'CYYZ', 'Toronto Pearson Intl'),
            ('YUL', 'CYUL', 'Montreal Trudeau Intl'),
            ('YVR', 'CYVR', 'Vancouver Intl'),
            ('LHR', 'EGLL', 'London Heathrow'),
            ('CDG', 'LFPG', 'Paris Charles de Gaulle'),
        ]

        # Use callsign hash for consistent random selection
        seed = hash(callsign) % 1000
        random.seed(seed)

        origin = random.choice(airports)
        dest = random.choice([a for a in airports if a != origin])

        # Extract airline from callsign
        airline_icao = callsign[:3] if len(callsign) >= 3 else 'UNK'
        airline_names = {
            'AAL': 'American Airlines', 'DAL': 'Delta Air Lines', 'UAL': 'United Airlines',
            'SWA': 'Southwest Airlines', 'JBU': 'JetBlue Airways', 'ASA': 'Alaska Airlines',
            'ACA': 'Air Canada', 'WJA': 'WestJet', 'BAW': 'British Airways',
            'AFR': 'Air France', 'DLH': 'Lufthansa', 'SKW': 'SkyWest Airlines',
            'RPA': 'Republic Airways', 'ENY': 'Envoy Air', 'EDV': 'Endeavor Air',
            'FDX': 'FedEx Express', 'UPS': 'UPS Airlines',
        }

        return FlightRouteInfo(
            flight_number=callsign,
            airline_name=airline_names.get(airline_icao, 'Demo Airline'),
            airline_icao=airline_icao,
            origin_iata=origin[0],
            origin_icao=origin[1],
            origin_name=origin[2],
            destination_iata=dest[0],
            destination_icao=dest[1],
            destination_name=dest[2],
            status='active',
        )

    def get_route_info(self, callsign: str) -> Optional[FlightRouteInfo]:
        """
        Get route information for a flight by callsign.

        Callsigns are typically formatted as:
        - ICAO format: AAL839 (American Airlines flight 839)
        - IATA format: AA839

        Returns cached data if available, otherwise fetches from API.
        In demo mode, returns mock data.
        """
        if not callsign:
            return None

        callsign = callsign.strip().upper()

        # Check cache first
        cached = self._get_cached(callsign)
        if cached is not None:
            logger.debug(f'Route cache hit for {callsign}: {cached}')
            return cached

        # Demo mode - return mock data
        if self.demo_mode:
            mock_route = self._generate_mock_route(callsign)
            self._set_cached(callsign, mock_route)
            logger.debug(f'Demo route for {callsign}: {mock_route.origin_iata} -> {mock_route.destination_iata}')
            return mock_route

        # If no API key, return None
        if not self.api_key:
            logger.warning(f'No AviationStack API key configured, cannot lookup route for {callsign}')
            return None

        # Rate limit check
        if self._requests_today >= self._max_requests_per_day:
            logger.warning('Daily API limit reached, skipping lookup')
            return None

        # Fetch from API
        logger.info(f'Fetching route info from AviationStack for {callsign}')
        route_info = self._fetch_from_api(callsign)

        if route_info:
            logger.info(f'Got route for {callsign}: {route_info.origin_iata} -> {route_info.destination_iata}')
        else:
            logger.info(f'No route data found for {callsign}')

        # Cache result (even if None, to avoid repeated failed lookups)
        self._set_cached(callsign, route_info)

        return route_info

    def _get_cached(self, callsign: str) -> Optional[FlightRouteInfo]:
        """Get cached route info if not expired."""
        with self._lock:
            if callsign in self._cache:
                info, timestamp = self._cache[callsign]
                if time.time() - timestamp < self._cache_ttl:
                    return info
                else:
                    del self._cache[callsign]
        return None  # Not in cache or expired

    def _set_cached(self, callsign: str, info: Optional[FlightRouteInfo]) -> None:
        """Cache route info."""
        with self._lock:
            self._cache[callsign] = (info, time.time())

            # Limit cache size
            if len(self._cache) > 500:
                # Remove oldest entries
                sorted_items = sorted(self._cache.items(), key=lambda x: x[1][1])
                for key, _ in sorted_items[:100]:
                    del self._cache[key]

    def _fetch_from_api(self, callsign: str) -> Optional[FlightRouteInfo]:
        """Fetch flight info from AviationStack API."""
        # Respect rate limiting
        elapsed = time.time() - self._last_request_time
        if elapsed < self._min_request_interval:
            time.sleep(self._min_request_interval - elapsed)

        try:
            # Extract flight number from callsign
            # AAL839 -> AA839 (convert ICAO to IATA for better API matching)
            flight_iata = self._callsign_to_flight_number(callsign)

            params = {
                'access_key': self.api_key,
                'flight_iata': flight_iata,
            }

            logger.debug(f'Fetching flight info for {flight_iata}')

            response = requests.get(
                f'{self.base_url}/flights',
                params=params,
                timeout=10
            )
            self._last_request_time = time.time()
            self._requests_today += 1

            if response.status_code != 200:
                logger.warning(f'AviationStack API error: {response.status_code}')
                return None

            data = response.json()

            if 'error' in data:
                logger.warning(f'AviationStack API error: {data["error"]}')
                return None

            flights = data.get('data', [])
            if not flights:
                logger.debug(f'No flight data found for {callsign}')
                return None

            # Use first matching flight
            flight = flights[0]

            return FlightRouteInfo(
                flight_number=flight_iata,
                airline_name=flight.get('airline', {}).get('name'),
                airline_iata=flight.get('airline', {}).get('iata'),
                airline_icao=flight.get('airline', {}).get('icao'),
                origin_iata=flight.get('departure', {}).get('iata'),
                origin_icao=flight.get('departure', {}).get('icao'),
                origin_name=flight.get('departure', {}).get('airport'),
                destination_iata=flight.get('arrival', {}).get('iata'),
                destination_icao=flight.get('arrival', {}).get('icao'),
                destination_name=flight.get('arrival', {}).get('airport'),
                scheduled_departure=self._parse_datetime(
                    flight.get('departure', {}).get('scheduled')
                ),
                scheduled_arrival=self._parse_datetime(
                    flight.get('arrival', {}).get('scheduled')
                ),
                status=flight.get('flight_status'),
                aircraft_iata=flight.get('aircraft', {}).get('iata'),
                aircraft_icao=flight.get('aircraft', {}).get('icao'),
                aircraft_registration=flight.get('aircraft', {}).get('registration'),
            )

        except requests.RequestException as e:
            logger.error(f'Failed to fetch flight info: {e}')
            return None
        except Exception as e:
            logger.error(f'Error parsing flight info: {e}')
            return None

    def _callsign_to_flight_number(self, callsign: str) -> str:
        """
        Convert ICAO callsign to IATA flight number.

        Examples:
        - AAL839 -> AA839
        - DAL1234 -> DL1234
        - UAL567 -> UA567
        """
        # Common ICAO to IATA mappings
        icao_to_iata = {
            'AAL': 'AA',  # American Airlines
            'DAL': 'DL',  # Delta
            'UAL': 'UA',  # United
            'SWA': 'WN',  # Southwest
            'JBU': 'B6',  # JetBlue
            'ASA': 'AS',  # Alaska
            'FFT': 'F9',  # Frontier
            'NKS': 'NK',  # Spirit
            'ACA': 'AC',  # Air Canada
            'WJA': 'WS',  # WestJet
            'BAW': 'BA',  # British Airways
            'DLH': 'LH',  # Lufthansa
            'AFR': 'AF',  # Air France
            'KLM': 'KL',  # KLM
            'UAE': 'EK',  # Emirates
            'QFA': 'QF',  # Qantas
            'ANA': 'NH',  # All Nippon
            'JAL': 'JL',  # Japan Airlines
            'CPA': 'CX',  # Cathay Pacific
            'SIA': 'SQ',  # Singapore
            'SKW': 'OO',  # SkyWest
            'RPA': 'YX',  # Republic
            'ENY': 'MQ',  # Envoy
            'FDX': 'FX',  # FedEx
            'UPS': '5X',  # UPS
        }

        if len(callsign) >= 3:
            prefix = callsign[:3]
            if prefix in icao_to_iata:
                return icao_to_iata[prefix] + callsign[3:]

        # If no mapping found, return as-is
        return callsign

    def _parse_datetime(self, dt_str: Optional[str]) -> Optional[datetime]:
        """Parse datetime string from API."""
        if not dt_str:
            return None
        try:
            # AviationStack uses ISO format
            return datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
        except ValueError:
            return None

    def get_estimated_arrival(
        self,
        destination_iata: str,
        current_distance_km: float,
        current_speed_kts: float,
        scheduled_arrival: Optional[datetime] = None,
    ) -> Optional[datetime]:
        """
        Estimate arrival time based on current telemetry.

        Uses simple distance/speed calculation with adjustment
        for typical approach patterns.
        """
        if not current_speed_kts or current_speed_kts < 50:
            return scheduled_arrival

        # Convert speed to km/h
        speed_kmh = current_speed_kts * 1.852

        # Estimate time to destination (add 10% for approach)
        hours_remaining = (current_distance_km / speed_kmh) * 1.1

        eta = datetime.now(timezone.utc) + timedelta(hours=hours_remaining)

        return eta

    @property
    def stats(self) -> dict:
        """Get service statistics."""
        with self._lock:
            return {
                'cache_size': len(self._cache),
                'requests_today': self._requests_today,
                'api_configured': bool(self.api_key),
            }


# Singleton instance
flight_info_service = FlightInfoService()
