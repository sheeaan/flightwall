"""
FlightWall Flask Application.

Main entry point for the web application. Initializes:
- Database schema
- Ingestion pipeline
- Cache refresh loop
- API routes
- Static file serving

Usage:
    python -m backend.app

Or with gunicorn:
    gunicorn backend.app:create_app()
"""

import logging
import os
import sys
import threading
import time

from flask import Flask, send_from_directory
from flask_cors import CORS

from backend.config import config
from backend.models import init_db
from backend.models.base import SessionLocal
from backend.api import flights_bp, metrics_bp
from backend.cache import flight_cache
from backend.ingestion import IngestionPipeline
from backend.analytics import TelemetryAnalyzer

# Configure logging
logging.basicConfig(
    level=logging.DEBUG if config.debug else logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
logger = logging.getLogger(__name__)


def create_app(start_ingestion: bool = True) -> Flask:
    """
    Application factory for Flask.

    Args:
        start_ingestion: Whether to start the background ingestion pipeline.
                        Set to False for testing.

    Returns:
        Configured Flask application instance.
    """
    # Create Flask app
    app = Flask(
        __name__,
        static_folder='../frontend',
        static_url_path='',
    )

    # Configuration
    app.config['SECRET_KEY'] = config.secret_key

    # Enable CORS for API endpoints
    CORS(app, resources={r'/api/*': {'origins': '*'}})

    # Initialize database
    logger.info('Initializing database...')
    init_db()

    # Register API blueprints
    app.register_blueprint(flights_bp)
    app.register_blueprint(metrics_bp)

    # Determine observer location
    observer_location = config.user_location
    if not observer_location:
        # Try auto-detection
        try:
            import geocoder
            g = geocoder.ip('me')
            if g.ok and g.latlng:
                observer_location = tuple(g.latlng)
                logger.info(f'Auto-detected location: {observer_location} ({g.city}, {g.country})')
        except Exception as e:
            logger.warning(f'Location auto-detect failed: {e}')

    app.config['OBSERVER_LOCATION'] = observer_location

    # Initialize ingestion pipeline
    if start_ingestion and observer_location:
        pipeline = IngestionPipeline(observer_location=observer_location)

        # Register callback to refresh cache after each ingestion
        def on_ingestion_update(count: int):
            flight_cache.refresh_from_database()
            # Periodically run analytics
            if pipeline._fetch_count % 6 == 0:  # Every minute at 10s polling
                try:
                    analyzer = TelemetryAnalyzer()
                    analyzer.update_flight_states_with_analytics()
                except Exception as e:
                    logger.error(f'Analytics update failed: {e}')

        pipeline.add_update_callback(on_ingestion_update)

        # Start background ingestion
        pipeline.start_background()
        app.config['INGESTION_PIPELINE'] = pipeline

        logger.info(f'Ingestion started for location {observer_location} with radius {config.ingestion.default_radius_km}km')
    elif not observer_location:
        logger.warning('No observer location configured. Set USER_LOCATION in .env or call /api/metrics/location/auto')
        app.config['INGESTION_PIPELINE'] = None

    # -------------------------------------------------------------------------
    # Frontend routes
    # -------------------------------------------------------------------------

    @app.route('/')
    def index():
        """Serve main map view."""
        return send_from_directory(app.static_folder, 'index.html')

    @app.route('/ticker')
    def ticker():
        """Serve ticker display view."""
        return send_from_directory(app.static_folder, 'ticker.html')

    @app.route('/health')
    def health():
        """Simple health check endpoint."""
        return {'status': 'ok'}

    # -------------------------------------------------------------------------
    # Error handlers
    # -------------------------------------------------------------------------

    @app.errorhandler(404)
    def not_found(e):
        return {'error': 'Not found'}, 404

    @app.errorhandler(500)
    def server_error(e):
        logger.error(f'Server error: {e}')
        return {'error': 'Internal server error'}, 500

    return app


def run_development_server():
    """Run the development server."""
    app = create_app()

    # Get port from environment or default
    port = int(os.environ.get('PORT', 5000))

    logger.info(f'Starting FlightWall on http://localhost:{port}')
    logger.info('Map view: http://localhost:{port}/')
    logger.info('Ticker view: http://localhost:{port}/ticker')

    app.run(
        host='0.0.0.0',
        port=port,
        debug=config.debug,
        use_reloader=False,  # Disable reloader to prevent duplicate pipeline threads
    )


if __name__ == '__main__':
    run_development_server()
