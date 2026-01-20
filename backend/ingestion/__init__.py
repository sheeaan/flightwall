"""
Data ingestion module for FlightWall.

Handles polling OpenSky API, parsing state vectors, and loading
into the relational database.
"""

from backend.ingestion.opensky_client import OpenSkyClient
from backend.ingestion.pipeline import IngestionPipeline

__all__ = ['OpenSkyClient', 'IngestionPipeline']
