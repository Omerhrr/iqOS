# iqOS live sidecar - bridges the trading-core kernel to IQ Option via the
# iqair library. Optional service: only needed when you turn on LIVE mode.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY iqair_sidecar.py ./
# The persisted broker session (.iq_session) is written to $SIDECAR_SESSION_DIR
# (compose sets /state) so the session can be volume-mounted WITHOUT shadowing
# this image's code - a volume over /app pins the FIRST deploy's
# iqair_sidecar.py in place and every rebuild silently runs stale code.
# Local dev (env unset) still writes next to the script.
ENV SIDECAR_HOST=0.0.0.0
# Unusual internal port on purpose - not the default 8788 used in
# local/Windows dev.
ENV SIDECAR_PORT=47313
# stdout is a pipe under Docker -> Python block-buffers it, so prints only
# surface after ~8KB (or never, if os._exit ends the process first). Every
# WATCHDOG line is written exactly at the moment the process is about to
# die - force it out immediately or docker logs shows NOTHING.
ENV PYTHONUNBUFFERED=1
EXPOSE 47313
CMD ["python", "iqair_sidecar.py"]
