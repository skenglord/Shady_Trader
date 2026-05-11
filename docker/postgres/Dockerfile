FROM postgres:15-alpine

# Copy initialization scripts
COPY docker/postgres/init.sql /docker-entrypoint-initdb.d/

# Copy custom configuration if needed
# COPY docker/postgres/postgresql.conf /etc/postgresql/postgresql.conf

# Expose PostgreSQL port
EXPOSE 5432

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD pg_isready -U postgres -d shady_trader

# Default command is handled by base image