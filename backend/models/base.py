"""
SQLAlchemy base configuration and session management.

Uses SQLAlchemy 2.0 style with type hints and declarative base.
Designed to be portable between SQLite (dev) and PostgreSQL (prod).
"""

from contextlib import contextmanager
from typing import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session

from backend.config import config


class Base(DeclarativeBase):
    """Base class for all models."""
    pass


# Create engine with configuration appropriate for the database type
engine_kwargs = {
    'echo': config.debug,  # Log SQL in debug mode
}

if config.database.is_sqlite:
    # SQLite-specific optimizations for time-series workloads
    engine_kwargs['connect_args'] = {'check_same_thread': False}

engine = create_engine(config.database.url, **engine_kwargs)


# Enable SQLite optimizations via PRAGMA statements
if config.database.is_sqlite:
    @event.listens_for(engine, 'connect')
    def set_sqlite_pragma(dbapi_connection, connection_record):
        """
        Configure SQLite for better write performance.

        WAL mode allows concurrent reads during writes - critical for
        a system that's constantly ingesting while serving queries.
        """
        cursor = dbapi_connection.cursor()
        # Write-Ahead Logging for concurrent access
        cursor.execute('PRAGMA journal_mode=WAL')
        # Synchronous=NORMAL balances safety and speed
        cursor.execute('PRAGMA synchronous=NORMAL')
        # Larger cache for time-series queries
        cursor.execute('PRAGMA cache_size=-64000')  # 64MB
        # Enable foreign keys
        cursor.execute('PRAGMA foreign_keys=ON')
        cursor.close()


# Session factory
SessionLocal = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,  # Avoid lazy loading issues
)


@contextmanager
def get_session() -> Generator[Session, None, None]:
    """
    Context manager for database sessions.

    Usage:
        with get_session() as session:
            session.query(...)

    Automatically handles commit/rollback and session cleanup.
    """
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def init_db() -> None:
    """
    Initialize database schema.

    Creates all tables if they don't exist. For production,
    use Alembic migrations instead.
    """
    Base.metadata.create_all(bind=engine)
