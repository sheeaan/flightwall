"""
Aircraft database loader and lookup utilities.

Maps ICAO24 hex addresses to aircraft metadata (type, operator, registration).
Data can come from:
1. OpenSky aircraft database CSV (recommended, ~500MB)
2. Embedded fallback data for common aircraft

Usage:
    from backend.ingestion.aircraft_db import AircraftLookup

    lookup = AircraftLookup()
    info = lookup.get('a0b1c2')
    print(info.type_code)  # 'B738'
"""

import csv
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Dict

from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.models import Aircraft
from backend.models.base import SessionLocal

logger = logging.getLogger(__name__)


@dataclass
class AircraftInfo:
    """Aircraft information from lookup."""
    icao24: str
    registration: Optional[str] = None
    type_code: Optional[str] = None
    type_description: Optional[str] = None
    operator: Optional[str] = None
    operator_icao: Optional[str] = None
    operator_callsign: Optional[str] = None


# Common airline ICAO codes and callsigns for display enrichment
AIRLINE_INFO: Dict[str, tuple] = {
    # (ICAO code, Callsign, Full name)
    'AAL': ('AAL', 'AMERICAN', 'American Airlines'),
    'DAL': ('DAL', 'DELTA', 'Delta Air Lines'),
    'UAL': ('UAL', 'UNITED', 'United Airlines'),
    'SWA': ('SWA', 'SOUTHWEST', 'Southwest Airlines'),
    'JBU': ('JBU', 'JETBLUE', 'JetBlue Airways'),
    'ASA': ('ASA', 'ALASKA', 'Alaska Airlines'),
    'FFT': ('FFT', 'FRONTIER', 'Frontier Airlines'),
    'NKS': ('NKS', 'SPIRIT WINGS', 'Spirit Airlines'),
    'ACA': ('ACA', 'AIR CANADA', 'Air Canada'),
    'WJA': ('WJA', 'WESTJET', 'WestJet'),
    'BAW': ('BAW', 'SPEEDBIRD', 'British Airways'),
    'DLH': ('DLH', 'LUFTHANSA', 'Lufthansa'),
    'AFR': ('AFR', 'AIRFRANS', 'Air France'),
    'KLM': ('KLM', 'KLM', 'KLM Royal Dutch'),
    'UAE': ('UAE', 'EMIRATES', 'Emirates'),
    'QFA': ('QFA', 'QANTAS', 'Qantas'),
    'ANA': ('ANA', 'ALL NIPPON', 'All Nippon Airways'),
    'JAL': ('JAL', 'JAPAN AIR', 'Japan Airlines'),
    'CPA': ('CPA', 'CATHAY', 'Cathay Pacific'),
    'SIA': ('SIA', 'SINGAPORE', 'Singapore Airlines'),
}


# Common aircraft type codes
AIRCRAFT_TYPES: Dict[str, str] = {
    'A318': 'Airbus A318',
    'A319': 'Airbus A319',
    'A320': 'Airbus A320',
    'A321': 'Airbus A321',
    'A332': 'Airbus A330-200',
    'A333': 'Airbus A330-300',
    'A339': 'Airbus A330-900neo',
    'A346': 'Airbus A340-600',
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
    'B744': 'Boeing 747-400',
    'B748': 'Boeing 747-8',
    'B752': 'Boeing 757-200',
    'B753': 'Boeing 757-300',
    'B762': 'Boeing 767-200',
    'B763': 'Boeing 767-300',
    'B764': 'Boeing 767-400',
    'B772': 'Boeing 777-200',
    'B77L': 'Boeing 777-200LR',
    'B77W': 'Boeing 777-300ER',
    'B788': 'Boeing 787-8',
    'B789': 'Boeing 787-9',
    'B78X': 'Boeing 787-10',
    'CRJ2': 'Bombardier CRJ-200',
    'CRJ7': 'Bombardier CRJ-700',
    'CRJ9': 'Bombardier CRJ-900',
    'CRJX': 'Bombardier CRJ-1000',
    'E135': 'Embraer ERJ-135',
    'E145': 'Embraer ERJ-145',
    'E170': 'Embraer E170',
    'E175': 'Embraer E175',
    'E190': 'Embraer E190',
    'E195': 'Embraer E195',
    'E75L': 'Embraer E175 (Long Wing)',
    'E75S': 'Embraer E175 (Short Wing)',
    'MD11': 'McDonnell Douglas MD-11',
    'MD80': 'McDonnell Douglas MD-80',
    'MD82': 'McDonnell Douglas MD-82',
    'MD83': 'McDonnell Douglas MD-83',
    'MD88': 'McDonnell Douglas MD-88',
    'MD90': 'McDonnell Douglas MD-90',
    'AT43': 'ATR 42-300',
    'AT45': 'ATR 42-500',
    'AT72': 'ATR 72',
    'AT76': 'ATR 72-600',
    'DH8A': 'Dash 8-100',
    'DH8B': 'Dash 8-200',
    'DH8C': 'Dash 8-300',
    'DH8D': 'Dash 8-400',
    'C208': 'Cessna 208 Caravan',
    'C172': 'Cessna 172 Skyhawk',
    'C182': 'Cessna 182 Skylane',
    'C210': 'Cessna 210 Centurion',
    'C25A': 'Cessna Citation CJ2',
    'C25B': 'Cessna Citation CJ3',
    'C25C': 'Cessna Citation CJ4',
    'C510': 'Cessna Citation Mustang',
    'C525': 'Cessna CitationJet',
    'C560': 'Cessna Citation V',
    'C680': 'Cessna Citation Sovereign',
    'C750': 'Cessna Citation X',
    'PC12': 'Pilatus PC-12',
    'PC24': 'Pilatus PC-24',
    'GL5T': 'Bombardier Global 5000',
    'GL7T': 'Bombardier Global 7500',
    'GLEX': 'Bombardier Global Express',
    'GLF4': 'Gulfstream G-IV',
    'GLF5': 'Gulfstream G-V',
    'GLF6': 'Gulfstream G650',
    'G280': 'Gulfstream G280',
    'H25B': 'Hawker 800',
    'LJ35': 'Learjet 35',
    'LJ45': 'Learjet 45',
    'LJ60': 'Learjet 60',
    'FA50': 'Dassault Falcon 50',
    'F900': 'Dassault Falcon 900',
    'F2TH': 'Dassault Falcon 2000',
}


def extract_airline_from_callsign(callsign: Optional[str]) -> Optional[str]:
    """
    Extract airline ICAO code from callsign.

    Callsigns typically start with 3-letter airline code followed by flight number.
    E.g., 'UAL839' -> 'UAL', 'DAL1234' -> 'DAL'
    """
    if not callsign or len(callsign) < 3:
        return None

    # Extract first 3 characters as potential airline code
    prefix = callsign[:3].upper()

    # Check if it's a known airline
    if prefix in AIRLINE_INFO:
        return prefix

    # Try to find by matching beginning (some callsigns use 2 letters)
    for code in AIRLINE_INFO:
        if callsign.upper().startswith(code):
            return code

    return None


class AircraftLookup:
    """
    In-memory aircraft lookup with database backing.

    Maintains a cache of recently looked-up aircraft for performance.
    Falls back to database for uncached entries.
    """

    def __init__(self, cache_size: int = 1000):
        self._cache: Dict[str, AircraftInfo] = {}
        self._cache_size = cache_size

    def get(self, icao24: str, callsign: Optional[str] = None) -> AircraftInfo:
        """
        Look up aircraft by ICAO24 address.

        Returns AircraftInfo with whatever data is available.
        Enriches with airline info if callsign provided.
        """
        icao24 = icao24.lower()

        # Check cache
        if icao24 in self._cache:
            return self._cache[icao24]

        # Query database
        with SessionLocal() as session:
            aircraft = session.query(Aircraft).filter(
                Aircraft.icao24 == icao24
            ).first()

            if aircraft:
                info = AircraftInfo(
                    icao24=icao24,
                    registration=aircraft.registration,
                    type_code=aircraft.type_code,
                    type_description=aircraft.type_description,
                    operator=aircraft.operator,
                    operator_icao=aircraft.operator_icao,
                    operator_callsign=aircraft.operator_callsign,
                )
            else:
                # Create minimal info
                info = AircraftInfo(icao24=icao24)

        # Enrich with airline info from callsign if available
        if callsign and not info.operator_icao:
            airline_code = extract_airline_from_callsign(callsign)
            if airline_code and airline_code in AIRLINE_INFO:
                airline = AIRLINE_INFO[airline_code]
                info.operator_icao = airline[0]
                info.operator_callsign = airline[1]
                info.operator = airline[2]

        # Update cache
        if len(self._cache) >= self._cache_size:
            # Simple cache eviction: clear oldest half
            keys = list(self._cache.keys())
            for key in keys[:len(keys) // 2]:
                del self._cache[key]

        self._cache[icao24] = info

        return info

    def get_type_description(self, type_code: str) -> Optional[str]:
        """Get human-readable aircraft type description."""
        return AIRCRAFT_TYPES.get(type_code.upper())

    def clear_cache(self) -> None:
        """Clear the lookup cache."""
        self._cache.clear()


def load_aircraft_csv(csv_path: Path, batch_size: int = 5000) -> int:
    """
    Load aircraft data from CSV into database.

    Expected CSV format (OpenSky aircraft database):
    icao24,registration,manufacturericao,manufacturername,model,typecode,
    serialnumber,linenumber,icaoaircrafttype,operator,operatorcallsign,
    operatoricao,operatoriata,owner,testreg,registered,reguntil,status,
    built,firstflightdate,seatconfiguration,engines,modes,adsb,acars,notes,categoryDescription

    Returns count of records loaded.
    """
    if not csv_path.exists():
        logger.error(f'Aircraft CSV not found: {csv_path}')
        return 0

    logger.info(f'Loading aircraft data from {csv_path}')
    loaded = 0
    batch = []

    with open(csv_path, 'r', encoding='utf-8', errors='ignore') as f:
        reader = csv.DictReader(f)

        for row in reader:
            icao24 = row.get('icao24', '').strip().lower()
            if not icao24 or len(icao24) != 6:
                continue

            record = {
                'icao24': icao24,
                'registration': row.get('registration', '').strip() or None,
                'type_code': row.get('typecode', '').strip() or None,
                'type_description': row.get('model', '').strip() or None,
                'operator': row.get('operator', '').strip() or None,
                'operator_icao': row.get('operatoricao', '').strip() or None,
                'operator_callsign': row.get('operatorcallsign', '').strip() or None,
            }

            batch.append(record)

            if len(batch) >= batch_size:
                _insert_batch(batch)
                loaded += len(batch)
                logger.info(f'Loaded {loaded} aircraft records...')
                batch = []

        # Insert remaining
        if batch:
            _insert_batch(batch)
            loaded += len(batch)

    logger.info(f'Loaded {loaded} total aircraft records')
    return loaded


def _insert_batch(records: list) -> None:
    """Batch insert/upsert aircraft records."""
    with SessionLocal() as session:
        for record in records:
            stmt = sqlite_insert(Aircraft).values(**record)
            stmt = stmt.on_conflict_do_update(
                index_elements=['icao24'],
                set_={
                    'registration': stmt.excluded.registration,
                    'type_code': stmt.excluded.type_code,
                    'type_description': stmt.excluded.type_description,
                    'operator': stmt.excluded.operator,
                    'operator_icao': stmt.excluded.operator_icao,
                    'operator_callsign': stmt.excluded.operator_callsign,
                }
            )
            session.execute(stmt)
        session.commit()
