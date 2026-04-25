FROM ghcr.io/home-assistant/home-assistant:stable

# Intel iHD VAAPI userspace driver. The base HA image ships ffmpeg
# with QSV/VAAPI codecs compiled in but no runtime .so driver — every
# -hwaccel qsv / -hwaccel vaapi call fails with "Failed to initialise
# VAAPI connection: -1 (unknown libva error)". Adding this fixes it.
#
# iHD is correct for Gen11+ Intel iGPUs (Ice Lake onward); i965 was
# abandoned at Kaby Lake and would silently produce green frames on
# the UHD 770 (Alder Lake) we're targeting.
RUN apk add --no-cache intel-media-driver

# Skip libva's auto-detect probe — we know which driver we want.
ENV LIBVA_DRIVER_NAME=iHD
