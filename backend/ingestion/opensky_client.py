"""
OpenSky Network API client.

Handles communication with the OpenSky REST API, including:
- Authentication (optional but recommended for higher rate limits)
- Bounding box queries for geographic filtering
- Rate limiting compliance
- Error handling and retries

OpenSky state vector format (array indices):
0: icao24          - ICAO24 hex address
1: callsign        - Callsign (8 chars max)
2: origin_country  - Country of registration
3: time_position   - Unix timestamp of last position update
4: last_contact    - Unix timestamp of last message
5: longitude       - WGS84 longitude
6: latitude        - WGS84 latitude
7: baro_altitude   - Barometric altitude (meters)
8: on_ground       - Boolean
9: velocity        - Ground speed (m/s)
10: true_track     - Track angle (degrees, 0=north)
11: vertical_rate  - Vertical rate (m/s)
12: sensors        - Sensor IDs (array)
13: geo_altitude   - Geometric altitude (meters)
14: squawk         - Transponder code
15: spi            - Special position indicator
16: position_source - 0=ADS-B, 1=ASTERIX, 2=MLAT, 3=FLARM
"""

import logging
import time
from dataclasses import dataclass
from typing import Optional, List, Tuple, Any

import requests
from requests.auth import HTTPBasicAuth

from backend.config import config

logger = logging.getLogger(__name__)


@dataclass
class BoundingBox:
    """
    Geographic bounding box for API queries.

    OpenSky expects: lamin, lomin, lamax, lomax
    (latitude min, longitude min, latitude max, longitude max)
    """
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float

    @classmethod
    def from_center_radius(
        cls,
        center_lat: float,
        center_lon: float,
        radius_km: float
    ) -> 'BoundingBox':
        """
        Create bounding box from center point and radius.

        Uses approximate conversion: 1 degree ≈ 111 km at equator.
        Adjusts for latitude to account for longitude convergence.
        """
        # Approximate degrees per km
        lat_delta = radius_km / 111.0
        # Longitude degrees vary by latitude
        lon_delta = radius_km / (111.0 * abs(cos_deg(center_lat)))

        return cls(
            lat_min=center_lat - lat_delta,
            lat_max=center_lat + lat_delta,
            lon_min=center_lon - lon_delta,
            lon_max=center_lon + lon_delta,
        )

    def to_params(self) -> dict:
        """Convert to OpenSky API query parameters."""
        return {
            'lamin': self.lat_min,
            'lamax': self.lat_max,
            'lomin': self.lon_min,
            'lomax': self.lon_max,
        }


def cos_deg(degrees: float) -> float:
    """Cosine of angle in degrees."""
    import math
    return math.cos(math.radians(degrees))


@dataclass
class StateVector:
    """
    Parsed state vector from OpenSky API.

    Normalizes the raw array format into a typed dataclass.
    All values may be None if not reported by the aircraft.
    """
    icao24: str
    callsign: Optional[str]
    origin_country: Optional[str]
    time_position: Optional[int]
    last_contact: Optional[int]
    longitude: Optional[float]
    latitude: Optional[float]
    baro_altitude: Optional[float]
    on_ground: bool
    velocity: Optional[float]
    true_track: Optional[float]
    vertical_rate: Optional[float]
    geo_altitude: Optional[float]
    squawk: Optional[str]
    spi: bool
    position_source: Optional[int]

    @classmethod
    def from_array(cls, arr: List[Any]) -> Optional['StateVector']:
        """
        Parse OpenSky state vector array into StateVector object.

        Returns None if the array is malformed or missing required fields.
        """
        if not arr or len(arr) < 17:
            return None

        icao24 = arr[0]
        if not icao24 or not isinstance(icao24, str):
            return None

        # Normalize callsign (strip whitespace, handle None)
        callsign = arr[1]
        if callsign:
            callsign = callsign.strip() or None

        return cls(
            icao24=icao24.lower(),  # Normalize to lowercase
            callsign=callsign,
            origin_country=arr[2],
            time_position=arr[3],
            last_contact=arr[4],
            longitude=arr[5],
            latitude=arr[6],
            baro_altitude=arr[7],
            on_ground=bool(arr[8]),
            velocity=arr[9],
            true_track=arr[10],
            vertical_rate=arr[11],
            geo_altitude=arr[13],
            squawk=arr[14],
            spi=bool(arr[15]),
            position_source=arr[16],
        )

    def has_position(self) -> bool:
        """Check if this state has valid position data."""
        return self.latitude is not None and self.longitude is not None


class OpenSkyClient:
    """
    Client for OpenSky Network API.

    Handles:
    - GET requests to /states/all endpoint
    - Optional authentication for higher rate limits
    - Bounding box filtering
    - Rate limiting (internal tracking)
    """

    def __init__(
        self,
        username: Optional[str] = None,
        password: Optional[str] = None,
        base_url: str = 'https://opensky-network.org/api',
    ):
        self.base_url = base_url
        self.auth = None
        if username and password:
            self.auth = HTTPBasicAuth(username, password)
            logger.info('OpenSky client initialized with authentication')
        else:
            logger.warning('OpenSky client running without authentication (lower rate limits)')

        self.session = requests.Session()
        self.last_request_time: float = 0
        self._min_interval = 5.0 if self.auth else 10.0

    @classmethod
    def from_config(cls) -> 'OpenSkyClient':
        """Create client from application configuration."""
        return cls(
            username=config.opensky.username,
            password=config.opensky.password,
            base_url=config.opensky.base_url,
        )

    def _wait_for_rate_limit(self) -> None:
        """
        Enforce minimum interval between requests.

        OpenSky rate limits:
        - Anonymous: ~10 seconds between requests
        - Authenticated: ~5 seconds between requests
        """
        elapsed = time.time() - self.last_request_time
        if elapsed < self._min_interval:
            sleep_time = self._min_interval - elapsed
            logger.debug(f'Rate limiting: sleeping {sleep_time:.1f}s')
            time.sleep(sleep_time)

    def get_states(
        self,
        bbox: Optional[BoundingBox] = None,
        icao24: Optional[List[str]] = None,
    ) -> Tuple[int, List[StateVector]]:
        """
        Fetch current state vectors from OpenSky.

        Args:
            bbox: Optional bounding box to filter by geography
            icao24: Optional list of specific ICAO24 addresses to query

        Returns:
            Tuple of (api_timestamp, list of StateVectors)
            api_timestamp is the OpenSky server time for this snapshot

        Raises:
            requests.RequestException on network/API errors
        """
        self._wait_for_rate_limit()

        url = f'{self.base_url}/states/all'
        params = {}

        if bbox:
            params.update(bbox.to_params())

        if icao24:
            # OpenSky accepts comma-separated ICAO24 list
            params['icao24'] = ','.join(icao24)

        logger.debug(f'Fetching states: {url} params={params}')

        try:
            response = self.session.get(
                url,
                params=params,
                auth=self.auth,
                timeout=30,
            )
            self.last_request_time = time.time()

            response.raise_for_status()
            data = response.json()

        except requests.exceptions.Timeout:
            logger.error('OpenSky API timeout')
            raise
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 429:
                logger.warning('OpenSky rate limit exceeded')
            else:
                logger.error(f'OpenSky API error: {e.response.status_code}')
            raise
        except requests.exceptions.RequestException as e:
            logger.error(f'OpenSky request failed: {e}')
            raise

        # Parse response
        api_time = data.get('time', int(time.time()))
        states_raw = data.get('states') or []

        logger.info(f'Received {len(states_raw)} state vectors from OpenSky')

        # Parse each state vector
        states = []
        for arr in states_raw:
            sv = StateVector.from_array(arr)
            if sv and sv.has_position():
                states.append(sv)

        logger.debug(f'Parsed {len(states)} valid state vectors with positions')

        return api_time, states

    def get_states_by_location(
        self,
        center_lat: float,
        center_lon: float,
        radius_km: float,
    ) -> Tuple[int, List[StateVector]]:
        """
        Fetch states within radius of a center point.

        Convenience method that constructs bounding box from center + radius.
        """
        bbox = BoundingBox.from_center_radius(center_lat, center_lon, radius_km)
        return self.get_states(bbox=bbox)
