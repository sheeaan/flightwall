"""
External integration services.

Handles third-party API calls with caching, rate limiting, and
graceful degradation when services are unavailable.
"""

from backend.services.flight_info import FlightInfoService, FlightRouteInfo, flight_info_service

__all__ = ['FlightInfoService', 'FlightRouteInfo', 'flight_info_service']
