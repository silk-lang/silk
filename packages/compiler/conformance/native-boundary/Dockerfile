FROM mirror.gcr.io/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
# Freeze package indexes as well as versions so security updates cannot remove a pinned supply.
RUN rm /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260907T000000Z bookworm main' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260907T000000Z bookworm-updates main' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260907T000000Z bookworm-security main' \
    > /etc/apt/sources.list
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc=4:12.2.0-3 gcc-12=12.2.0-14+deb12u1 \
    libc6=2.36-9+deb12u14 libc6-dev=2.36-9+deb12u14 \
    binutils=2.40-2 linux-libc-dev=6.1.180-1 \
    && rm -rf /var/lib/apt/lists/*
