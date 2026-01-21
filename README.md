# FlightWall

A real-time flight telemetry and analytics system that turns your computer into a live aviation display.

![flight-telemetry](https://github.com/user-attachments/assets/6c72bbcf-a347-49cf-93e8-aac69f4c959b)

FlightWall started as a personal project born out of two interests colliding: plane spotting and real-time data systems.

Living directly under the approach path of Toronto Pearson International Airport, I always wanted an ambient display that showed what was flying overhead. Something closer to an airport departure board or radar wall than a traditional dashboard. At the same time, I was increasingly interested in how production telemetry systems ingest, normalize, and analyze fast-moving data streams.

FlightWall is the result of exploring both.

---

## How It Started

It was a noon picnic with friends; just food, conversation, and a gazebo providing shade from the summer sun. A plane passed overhead, and without thinking, I looked up and said, "That's a 747-400 coming in from Frankfurt."

Someone laughed. A few called cap. But when we checked FlightRadar24, there it was: a Lufthansa 747-400, inbound from Frankfurt.

That was the first time I pulled this trick, and their reactions made me realize how strange it must seem from the outside. But there's no secret ability here, just years of living directly under Toronto Pearson's approach path and paying attention to what most people tune out.

You start to notice patterns. The silhouette of a 747 is unmistakable with that iconic hump. A widebody Airbus has a different stance than a Boeing. Liveries become familiar: the blue tail of WestJet, the red maple leaf of Air Canada, Lufthansa's yellow and blue. And flight paths tell their own story. Planes approaching from the east are usually coming from Europe. From the north? Likely Asia or the west coast. The direction alone narrows it down before you even see the aircraft.

I never set out to memorize this. It just accumulated, plane by plane, flight by flight, from glancing at FlightRadar24 occasionally and looking up whenever something flew over. Eventually, the sky stopped being background noise.

And that's really why I built FlightWall.

Most people see a plane and barely register it. But once you start paying attention, every aircraft becomes something more: a vessel carrying hundreds of people, each on their own journey. Someone's flying home after years abroad. Someone else is about to start a new life in a new country. A family is headed on vacation; another is reuniting for the first time in years. The plane isn't just an object crossing the sky. It's a snapshot of dozens of human stories, all suspended at 35,000 feet for a few hours.

FlightWall is my way of surfacing that. A quiet display that answers the question I find myself asking every time something flies overhead: *Where did you come from? Where are you going?*

---

## Project Overview

FlightWall ingests live ADS-B aircraft telemetry from the OpenSky Network and processes it through a low-latency, production-style data pipeline. Unstructured JSON state vectors are validated, normalized into relational schemas, and stored in a time-series–friendly format designed for fast reads and analytical queries.

The system is intentionally designed to resemble real-world data engineering workflows rather than a toy visualization:
- Concurrent aircraft streams
- Ingestion batching
- Indexed queries
- In-memory caching for hot data
- Analytics layered on top of raw telemetry

The backend exposes this data through a Flask-based REST API, while the frontend presents it in two viewing modes optimized for either interaction or passive, always-on display.

---

## Why This Project Exists

FlightWall focuses on the engineering challenges behind real-time telemetry systems:

- Designing a high-throughput ingestion pipeline for live ADS-B data
- Transforming unstructured positional JSON into normalized relational schemas
- Optimizing query performance across dozens of concurrent aircraft streams
- Treating aviation telemetry as time-series data (similar to financial tick data)
- Building displays optimized for fast, repeated reads rather than heavy interaction

The goal was to prioritize **data correctness, performance, and analytical depth** over visual novelty, while still building something enjoyable to look at.

---

## Display Modes

- **Map View**
  An interactive Leaflet-based map showing nearby aircraft in real time. Individual flights can be clicked to inspect altitude, speed, heading, callsign, and historical movement.

- **Ticker View**
  A minimal, airport-style display designed for passive viewing. Flights rotate automatically, surfacing key telemetry in a format inspired by flight information boards and radar walls.

The ticker view is the heart of the project; something that can run fullscreen on a secondary monitor or dedicated display.

---

## Technical Highlights

- **Streaming Ingestion**
  Polls the OpenSky API at configurable intervals and batches writes to minimize database contention.

- **JSON → Relational Modeling**
  Normalizes unstructured ADS-B state vectors into indexed relational tables optimized for read-heavy workloads.

- **Time-Series Analytics**
  Uses NumPy to compute rolling averages, detect short-term trends, and flag anomalous behavior in altitude and velocity data.

- **Low-Latency Reads**
  Combines database indexing with an in-memory cache to achieve sub-millisecond access for frequently requested telemetry.

- **Instrumentation & Metrics**
  API responses include timing metadata to track query and ingestion performance over time.

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  OpenSky API    │────▶│ Ingestion Layer  │────▶│  SQLite/PG DB   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                         │
                               ▼                         ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │  Analytics Layer │◀────│ Position History│
                        │     (NumPy)      │     │  (Time-Series)  │
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

The architecture is intentionally modular so components can be swapped or scaled independently as the project evolves.

---

## Quick Start

### Prerequisites

- Python 3.10+
- OpenSky Network account (free): https://opensky-network.org

### Installation

```bash
cd flightwall

python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

pip install -r requirements.txt
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```
OPENSKY_USERNAME=your_username
OPENSKY_PASSWORD=your_password
```

### Run

```bash
python -m backend.app
```

Open:
- http://localhost:5000 → Map view
- http://localhost:5000/ticker → Ticker display

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/flights` | List all tracked flights |
| `GET /api/flights/<icao24>` | Retrieve a single flight |
| `GET /api/flights/ticker` | Current ticker flight |
| `GET /api/flights/history/<icao24>` | Position history |
| `GET /api/metrics/fleet` | Fleet-level analytics |
| `GET /api/metrics/status` | System health & latency |
| `POST /api/metrics/location/auto` | Auto-detect user location |

---

## Database Design

**FlightState (Hot Table)**
Stores the latest state per aircraft. Updated via upserts during ingestion.

**PositionHistory (Time-Series)**
Append-only table for historical telemetry, indexed by `(icao24, timestamp)`.

**Aircraft (Lookup)**
Static ICAO24 → aircraft metadata mapping.

This separation keeps real-time reads fast while preserving historical data for analytics.

---

## Analytics

Aircraft telemetry is treated like financial tick data:

- Rolling averages over sliding windows
- Short-term trend detection via linear regression
- Z-score–based anomaly detection for outliers in speed and altitude

The analytics layer is intentionally lightweight but extensible.

---

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_SECONDS` | 10 | OpenSky polling frequency |
| `DEFAULT_RADIUS_KM` | 250 | Observation radius |
| `RETENTION_HOURS` | 24 | Data retention window |
| `CACHE_TTL_SECONDS` | 5 | Cache lifetime |

---

## Project Status

FlightWall is still an evolving project. The current implementation serves as a foundation for experimenting with more advanced ingestion strategies, richer analytics, and alternate display surfaces.

My end goal is to run this on a Raspberry Pi 3 Model B+ connected to a dedicated LED ticker or monitor. A conversation-starter piece for my home that shows what's flying overhead in real time. I'm excited to develop this software prototype into a hardware one as well.

---

## License

MIT
