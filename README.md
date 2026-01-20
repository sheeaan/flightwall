# FlightWall

Real-time flight telemetry visualization system that transforms your computer into a live aviation display.

## Overview

FlightWall ingests real-time ADS-B data from the OpenSky Network, processes it through a streaming-style pipeline, and displays aircraft telemetry via two modes:

- **Map View**: Interactive Leaflet map with clickable aircraft markers
- **Ticker View**: Single-flight focus display designed for always-on viewing

## Technical Highlights

- **Streaming Ingestion**: Polls OpenSky API with configurable intervals, batches writes to SQLite
- **JSON → Relational**: Normalizes unstructured state vectors into indexed relational tables
- **Time-Series Analytics**: NumPy-based rolling windows, trend detection, and anomaly identification
- **Query Latency Tracking**: All API responses include timing metrics
- **In-Memory Cache**: Sub-millisecond reads for hot telemetry data

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  OpenSky API    │────▶│ Ingestion Layer  │────▶│  SQLite/PG DB   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                         │
                               ▼                         ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │  Analytics Layer │◀────│  Position Hx    │
                        │  (NumPy)         │     │  (Time-Series)  │
                        └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  Flask REST API  │
                        └──────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  Frontend Views  │
                        └──────────────────┘
```

## Quick Start

### 1. Prerequisites

- Python 3.10+
- OpenSky Network account (free): https://opensky-network.org

### 2. Installation

```bash
cd flightwall

# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your credentials
OPENSKY_USERNAME=your_username
OPENSKY_PASSWORD=your_password
```

### 4. Run

```bash
python -m backend.app
```

Open http://localhost:5000 for the map view, or http://localhost:5000/ticker for the ticker display.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/flights` | List all tracked flights |
| `GET /api/flights/<icao24>` | Get single flight details |
| `GET /api/flights/ticker` | Get current ticker flight |
| `GET /api/flights/history/<icao24>` | Get position history |
| `GET /api/metrics/fleet` | Fleet-wide statistics |
| `GET /api/metrics/status` | System health status |
| `POST /api/metrics/location/auto` | Auto-detect location |

## Database Schema

### FlightState (Hot Table)
Current state of tracked aircraft. Updated via upsert on each ingestion cycle.

### PositionHistory (Time-Series)
Append-only historical positions. Indexed by `(icao24, timestamp)` for efficient rolling window queries.

### Aircraft (Lookup)
Static ICAO24 → aircraft type mapping.

## Analytics

The analytics layer treats aircraft telemetry like financial tick data:

- **Rolling Averages**: 5-minute windows for altitude, speed
- **Trend Detection**: Linear regression on sliding windows
- **Anomaly Detection**: Z-score outlier identification (threshold: 2.5σ)

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_SECONDS` | 10 | API polling frequency |
| `DEFAULT_RADIUS_KM` | 250 | Observation radius |
| `RETENTION_HOURS` | 24 | Historical data retention |
| `CACHE_TTL_SECONDS` | 5 | Cache time-to-live |

## Project Structure

```
flightwall/
├── backend/
│   ├── app.py              # Flask application
│   ├── config.py           # Configuration management
│   ├── cache.py            # In-memory cache
│   ├── ingestion/
│   │   ├── opensky_client.py   # API client
│   │   ├── pipeline.py         # Ingestion orchestration
│   │   └── aircraft_db.py      # ICAO24 lookup
│   ├── models/
│   │   ├── aircraft.py         # Aircraft model
│   │   ├── flight_state.py     # Current state model
│   │   └── position_history.py # Time-series model
│   ├── analytics/
│   │   └── telemetry_analysis.py  # NumPy analytics
│   └── api/
│       ├── flights.py      # Flight endpoints
│       └── metrics.py      # Metrics endpoints
├── frontend/
│   ├── index.html          # Map view
│   ├── ticker.html         # Ticker view
│   ├── css/styles.css      # Styling
│   └── js/
│       ├── map.js          # Map logic
│       └── ticker.js       # Ticker logic
├── requirements.txt
└── .env.example
```

## Keyboard Shortcuts (Ticker View)

| Key | Action |
|-----|--------|
| `F` | Toggle fullscreen |
| `M` | Switch to map view |
| `Esc` | Exit fullscreen |

## License

MIT
