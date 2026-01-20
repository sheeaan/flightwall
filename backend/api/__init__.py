"""
API module for FlightWall.

Provides REST endpoints for:
- Flight data (current states, individual flights)
- Analytics and metrics
- System status
"""

from backend.api.flights import flights_bp
from backend.api.metrics import metrics_bp

__all__ = ['flights_bp', 'metrics_bp']
