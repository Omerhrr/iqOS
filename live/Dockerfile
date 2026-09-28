# iqOS live sidecar - bridges the trading-core kernel to IQ Option via the
# iqair library. Optional service: only needed when you turn on LIVE mode.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY iqair_sidecar.py ./
# .iq_session (the persisted broker session) is written next to the script -
# mount a volume there so a container recreate doesn't force a re-login.
ENV SIDECAR_HOST=0.0.0.0
# Unusual internal port on purpose - not the default 8788 used in
# local/Windows dev.
ENV SIDECAR_PORT=47313
EXPOSE 47313
CMD ["python", "iqair_sidecar.py"]
